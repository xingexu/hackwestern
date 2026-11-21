import base64
import io
import json
import zlib

import numpy as np
from PIL import Image,ImageDraw
from scipy import ndimage
from shapely.geometry import Polygon

import campus_region as region
import geo
from ground_plantings import observations
from campus_context import context
from ground_observations import parking_and_woodland,paving_tone


def grass_vigor():
    pieces=Image.new('RGB',(768,768))
    for row in range(4):
        for col in range(4):
            with Image.open(region.CACHE/f'aerial-fine-{col}-{row}.jpg') as tile:
                pieces.paste(tile.resize((192,192),Image.Resampling.BOX),(192*col,192*row))
    r,g,b=np.array(pieces,dtype=np.float32).transpose(2,0,1)
    signal=ndimage.gaussian_filter(np.clip((2*g-r-b)/(r+g+b+1),-.02,.24),.9)
    grass=np.rint(np.clip((signal+.02)/.26,0,1)*255).astype(np.uint8)
    return dict(width=768,height=768,samples=base64.b64encode(zlib.compress(grass.tobytes(),8)).decode())


def game_cover(domain,network):
    from pavement_texture import pavement_detail
    from rasterio import Affine
    from rasterio.features import geometry_mask
    left,top,right,bottom=domain.bounds
    width,height=round((right-left)/.6),round((bottom-top)/.6)
    source=json.loads(region.OUT.with_name('surface-tiles.json').read_bytes())
    preview=Image.open(io.BytesIO(base64.b64decode(source['preview']))).getchannel('A')
    x0,z0,x1,z1=(region.X0,region.Z0,region.X1,region.Z1)
    field=np.array(preview.transform((width,height),Image.Transform.EXTENT,
        ((left-x0)/(x1-x0)*preview.width,(top-z0)/(z1-z0)*preview.height,
         (right-x0)/(x1-x0)*preview.width,(bottom-z0)/(z1-z0)*preview.height),Image.Resampling.BILINEAR))
    parking=ndimage.binary_opening((field>=102)&(field<=122),iterations=1)
    parking=ndimage.binary_closing(parking,iterations=2)
    ids,_=ndimage.label(parking)
    sizes=np.bincount(ids.ravel())
    parking=(ids>0)&(sizes[ids]>=20)
    raster=Image.fromarray(np.where(parking,5,0).astype(np.uint8))
    draw=ImageDraw.Draw(raster)
    def pixels(ring):
        points=np.asarray(ring).reshape(-1,2)
        return list(zip((points[:,0]-left)*width/(right-left),(points[:,1]-top)*height/(bottom-top)))
    def face(rings,label):
        draw.polygon(pixels(rings[0]),fill=label)
        for hole in rings[1:]:
            draw.polygon(pixels(hole),fill=0)
    osm=json.loads((region.CACHE/'map.json').read_bytes())['elements']
    nodes={e['id']:geo.to_grid(e['lat'],e['lon']) for e in osm if e['type']=='node'}
    sport=json.loads(region.OUT.parents[1].joinpath('build/survey_sports.json').read_bytes())
    pitches=[Polygon(r) for r in sport['synthetic']]
    gardens=[]
    polygons=[]
    for e in osm:
        if e['type']!='way' or len(e['nodes'])<4 or e['nodes'][0]!=e['nodes'][-1] or not all(n in nodes for n in e['nodes']):
            continue
        t=e.get('tags',{})
        ring=[nodes[n] for n in e['nodes']]
        if t.get('leisure')=='garden':
            gardens.append(Polygon(ring))
        kind=None
        if t.get('natural') in ('wood','scrub','heath') or t.get('landuse')=='forest':
            kind=2
        elif t.get('landuse') in ('grass','recreation_ground','meadow') or t.get('natural')=='grassland' or t.get('leisure') in ('park','garden'):
            kind=1
        elif t.get('natural') in ('sand','beach'):
            kind=10
        elif t.get('leisure')=='track':
            kind=7
        elif t.get('leisure')=='pitch':
            kind=9 if t.get('sport') in ('tennis','basketball') else 8
            if t.get('surface')=='grass' or (not t.get('sport') and t.get('surface') not in ('artificial_turf','tartan')):kind=1
        elif t.get('amenity')=='parking':
            kind=5
        elif t.get('landuse') in ('construction','brownfield') or t.get('surface') in ('gravel','sand','compacted'):
            kind=4
        if kind:
            p=Polygon(ring)
            if kind==8 and any(p.intersection(pitch).area>p.area*.5 for pitch in pitches):
                continue
            if p.area>1 and domain.intersects(p):
                polygons.append((kind,ring,t,p.area))
    polygons.sort(key=lambda r:((r[0] in (7,8,9)), -r[3]))
    for k,ring,t,area in polygons:
        face([ring],k)
    for a in network['areas']:
        if a['kind'] in ('parking','plaza','path','paved','platform','pedestrian','courtyard','service','driveway'):
            face(a['rings'],5 if a['kind']=='parking' else 3)
    for k,ring,t,area in polygons:
        if k not in (7,8,9):
            continue
        face([ring],k)
    ground_survey=json.loads(region.OUT.parents[1].joinpath('build/survey_ground.json').read_bytes())
    for patch in ground_survey['patches']:
        face(patch['rings'],patch['class'])
    for ring in network['water']:
        face(ring,6)
    transform=Affine.translation(left,top)*Affine.scale((right-left)/width,(bottom-top)/height)
    inside=geometry_mask([domain],out_shape=(height,width),transform=transform,invert=True)
    classes=np.where(inside,np.asarray(raster),255).astype(np.uint8)
    classes=parking_and_woodland(classes,[left,top,right,bottom],network)
    from parcel_surfaces import survey
    surfaces=survey()
    measured=surfaces.sample((left,top,right,bottom),(width,height))
    revisable=inside&np.isin(classes,[0,1,2,3,4,5,11])
    classes[revisable&(measured==5)]=5
    classes[revisable&np.isin(measured,[1,3])&np.isin(classes,[3,4,5])]=0
    courts=surfaces.sample((left,top,right,bottom),(width,height),confirmed_concrete=True)
    classes[revisable&courts]=3
    clusters,_=ndimage.label(classes==5)
    areas=np.bincount(clusters.ravel())*((right-left)/width)*((bottom-top)/height)
    verge=ndimage.maximum_filter(np.where(classes==5,0,classes),size=3)<=2
    classes[(clusters>0)&(areas[clusters]<1.6)&verge]=0
    from frontage_survey import material_grid
    frontage=material_grid((left,top,right,bottom),(width,height))
    certified=(frontage==5)|(np.isin(frontage,[1,2])&(measured==3))
    classes[revisable&certified]=3
    from sidewalk_ribbons import masks as sidewalk_ribbons
    ribbon=sidewalk_ribbons((left,top,right,bottom),(width,height))
    if ribbon is not None:classes[revisable&(ribbon==1)]=3
    for patch in ground_survey['patches']:
        shell,*holes=patch['rings']
        surveyed=geometry_mask([Polygon(shell,holes)],out_shape=classes.shape,transform=transform,invert=True)
        classes[surveyed&inside]=patch['class']
    for island in ground_survey['islands']:
        classes[geometry_mask([Polygon(island)],out_shape=classes.shape,transform=transform,invert=True)&inside]=1
    from kerb_islands import observed as kerbed_islands
    from rasterio.features import rasterize
    island_kind=rasterize(kerbed_islands(),out_shape=classes.shape,transform=transform,dtype='uint8')
    classes[inside&(island_kind>0)]=island_kind[inside&(island_kind>0)]
    revisable&=island_kind==0
    track=Polygon(sport['track'][0],sport['track'][1:])
    surround=geometry_mask([track.envelope.buffer(5)],out_shape=classes.shape,transform=transform,invert=True)
    classes[surround&(classes==7)]=3
    for label,geometry in [(8,Polygon(track.exterior)),(7,track),*[(8,pitch.buffer(-.8)) for pitch in pitches]]:
        surveyed=geometry_mask([geometry],out_shape=classes.shape,transform=transform,invert=True)
        classes[surveyed&inside]=label
    garden=geometry_mask(gardens,out_shape=classes.shape,transform=transform,invert=True)
    rr,cc=np.where(garden & inside & (classes<=2))
    x=left+(cc+.5)*(right-left)/width
    z=top+(rr+.5)*(bottom-top)/height
    canopy=region.sample(region.lidar('dsm')-region.lidar('dtm'),x,z)
    vigor=grass_vigor()
    growth=np.frombuffer(zlib.decompress(base64.b64decode(vigor['samples'])),np.uint8).reshape(768,768)
    survey=growth[((z-region.Z0)*768/(region.Z1-region.Z0)).astype(int),((x-region.X0)*768/(region.X1-region.X0)).astype(int)]
    shrub=(canopy>.42)&(canopy<2.4)&(survey>31)
    beds=np.zeros(classes.shape,bool)
    beds[rr[shrub],cc[shrub]]=True
    beds=ndimage.binary_closing(beds,iterations=1)&garden&(classes<=2)
    classes[beds]=11
    shrubs=[[round(px,2),round(pz,2),round(float(h),2)] for px,pz,h,keep,row,col in zip(x,z,canopy,shrub,rr,cc) if keep and row%2==0 and col%4==0]
    from river_banks import exposed_shore
    exposed_shore(classes,(left,top,right,bottom))
    best=np.zeros(classes.shape,np.float32)
    runner=np.zeros_like(best)
    primary=np.zeros(classes.shape,np.uint8)
    secondary=np.zeros_like(primary)
    for label in range(12):
        count=ndimage.gaussian_filter(((classes==label)|((classes==255)&(label==0))).astype(np.float32),1.85)
        first=count>best
        second=(count>runner)&~first
        secondary[first]=primary[first]
        runner[first]=best[first]
        primary[first]=label
        best[first]=count[first]
        secondary[second]=label
        runner[second]=count[second]
    weight=best/np.maximum(.0001,best+runner)
    weight=np.clip((weight-.30)/.40,0,1)
    weight=weight*weight*(3-2*weight)
    hard=np.isin(classes,[3,5,6,7])
    near=ndimage.binary_dilation(hard,iterations=4)
    primary[near]=classes[near]
    secondary[near]=classes[near]
    primary[primary==5]=0
    secondary[secondary==5]=0
    parking=classes==5
    boundary=ndimage.binary_dilation(parking)^ndimage.binary_erosion(parking)
    coverage=np.zeros_like(classes,np.float32)
    for off in [(x,z) for z in (.125,.375,.625,.875) for x in (.125,.375,.625,.875)]:
        subsample=surfaces.sample((left,top,right,bottom),(width,height),off)
        known=boundary&(subsample>0)&revisable
        coverage+=np.where(known,subsample==5,parking)
    parking_edge=np.rint(ndimage.gaussian_filter(coverage/16,.37)*255).astype(np.uint8)
    blends=np.stack([primary,secondary,np.rint(weight*255).astype(np.uint8),parking_edge],axis=-1)
    return {'pavementDetail':pavement_detail([left,top,right,bottom],network),'pavingTone':paving_tone([left,top,right,bottom],network,classes,courts),'observations':observations(domain,classes,[left,top,right,bottom]),'context':context(),'shrubs':shrubs,'vigor':vigor,'bounds':[left,top,right,bottom],'width':width,'height':height,'samples':base64.b64encode(zlib.compress(classes.tobytes(),8)).decode(),
            'transitions':base64.b64encode(zlib.compress(blends.tobytes(),8)).decode()}


def estate_coverage(classes):
    channels=[classes==2,np.isin(classes,[5,12]),classes==13]
    weights=np.stack([ndimage.gaussian_filter(mask.astype(np.float32),1.8,mode='nearest') for mask in channels],axis=-1)
    return base64.b64encode(zlib.compress(np.rint(weights*255).astype(np.uint8).tobytes(),8)).decode()


def estate_surfaces(domain,network):
    from rasterio import Affine
    from rasterio.features import geometry_mask, rasterize
    from shapely import get_parts, transform, union_all
    from shapely.geometry import LineString,box,shape
    import city_streets
    site=domain.difference(box(region.X0,region.Z0,region.X1,region.Z1))
    left,top,right,bottom=site.bounds
    bb=(geo.WEST+(left-2)/geo.METERS_PER_DEGREE_LON,geo.NORTH-(bottom+2)/geo.METERS_PER_DEGREE_LAT,
        geo.WEST+(right+2)/geo.METERS_PER_DEGREE_LON,geo.NORTH-(top-2)/geo.METERS_PER_DEGREE_LAT)
    bbox=','.join(map(str,bb))
    osm=json.loads(region.retrieve('platt-campus-edge.json',region.OSM,{'bbox':bbox}).read_bytes())['elements']
    nodes={e['id']:geo.to_grid(e['lat'],e['lon']) for e in osm if e['type']=='node'}
    ways=[(e,[(nodes[n]) for n in e['nodes']]) for e in osm if e['type']=='way' and all(k in nodes for k in e['nodes'])]
    areas={c:[] for c in ('building','forest','parking','walk','road')}
    for e,coords in ways:
        t=e.get('tags',{})
        if len(coords)<4 or coords[0]!=coords[-1]:
            continue
        kind='building' if t.get('building') else 'forest' if t.get('landuse')=='forest' else 'parking' if t.get('amenity')=='parking' else None
        if kind:
            piece=Polygon(coords).buffer(0).intersection(site)
            if piece.area>.01:
                areas[kind].append(piece)
    buildings=union_all(areas['building'])
    known={w['id']:w for w in network['ways']}
    lines=[]
    query={'geometry':bbox,'geometryType':'esriGeometryEnvelope','inSR':4326,'spatialRel':'esriSpatialRelIntersects','where':'1=1','returnIdsOnly':'true','f':'json'}
    ids=json.loads(region.retrieve('platt-campus-road-ids.json',city_streets.SOURCE+'/query',query).read_bytes())['objectIds']
    city=[]
    for oid in ids:
        params=dict(f='geojson',objectIds=str(oid),outSR=4326,outFields='OBJECTID,SurfaceType',geometryPrecision=7,maxAllowableOffset=.0000025)
        road=json.loads(region.retrieve(f'street-polygon-{oid}.geojson',city_streets.SOURCE+'/query',params).read_bytes())
        for item in road['features']:
            geom=transform(shape(item['geometry']),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False)
            city.append(geom.buffer(0).intersection(site))
    city=union_all(city)
    areas['road'].append(city)
    for e,coords in ways:
        t=e.get('tags',{})
        cls=t.get('highway')
        if cls not in ('service','footway','path','residential','pedestrian','living_street','cycleway'):
            continue
        kind='road' if cls in ('service','residential','living_street') else 'path'
        width=known.get(e['id'],{}).get('width',2.1 if kind=='path' else 3.6)
        for part in get_parts(LineString(coords).intersection(site).difference(buildings.buffer(.08))):
            if part.geom_type!='LineString' or part.length<.25:
                continue
            points=np.asarray(part.segmentize(3).coords).round(3).tolist()
            lines.append(dict(id=e['id'],kind=kind,width=width,material=t.get('surface','asphalt' if kind=='road' else 'concrete'),name=t.get('name',''),points=points))
            footprint=part.buffer(width/2,quad_segs=5).intersection(site)
            if kind=='road':
                if not city.is_empty:
                    footprint=footprint.difference(city.buffer(1.0))
                areas['road'].append(footprint)
            else:
                areas['walk'].append(footprint)
    width,height=round((right-left)*4),round((bottom-top)*4)
    projection=Affine.translation(left,top)*Affine.scale((right-left)/width,(bottom-top)/height)
    draw=[(site,0)]
    for key,n in [('forest',2),('parking',5),('walk',13),('road',12),('building',0)]:
        draw.extend((p,n) for p in areas[key] if not p.is_empty)
    cells=rasterize(draw,out_shape=(height,width),transform=projection,fill=255,dtype='uint8')
    inside=geometry_mask([site],out_shape=cells.shape,transform=projection,invert=True)
    from parcel_surfaces import survey
    measured=survey().sample([left,top,right,bottom],(width,height))
    revisable=inside&(cells!=12)
    cells[revisable&(measured==1)&np.isin(cells,(5,13))]=0
    cells[revisable&(measured==5)]=5
    cells[revisable&(measured==3)&(cells!=5)]=13
    from scipy.optimize import linear_sum_assignment
    from street_finishes import coverage,patches
    surface=json.loads(region.OUT.with_name('surface-tiles.json').read_bytes())
    terrain=json.loads(region.OUT.read_bytes())
    x=left+(np.arange(width)+.5)*(right-left)/width
    parent=coverage(surface['carriageway'])
    parent_row=np.array(parent)[-1,np.clip(((x-region.X0)*parent.width/(region.X1-region.X0)).astype(int),0,parent.width-1)]
    parent_walk=np.zeros(width,dtype=bool)
    for key,(x0,z0,x1,z1) in patches(terrain['xs'],terrain['zs']):
        selected=(x>=x0)&(x<x1)
        if not selected.any() or z1<top-.01:
            continue
        tile=np.array(Image.open(io.BytesIO(base64.b64decode(surface['finishes'][key]))))
        parent_walk[selected]=tile[-1,np.clip(((x[selected]-x0)*tile.shape[1]/(x1-x0)).astype(int),0,tile.shape[1]-1),2]>=128
    base=rasterize([(g,n) for g,n in draw if n not in (12,13)],out_shape=cells.shape,transform=projection,fill=255,dtype='uint8')
    original=cells.copy()
    def intervals(mask):
        ends=np.flatnonzero(np.diff(np.r_[0,mask.astype(int),0]))
        return ends.reshape(-1,2).astype(float)
    span=round(6*height/(bottom-top))
    cells[:span]=base[:span]
    for kind,reference in [(13,parent_walk),(12,parent_row>=128)]:
        src=intervals(reference&inside[0])
        for row in range(span):
            t=row/span
            t=t*t*(3-2*t)
            dest=intervals(original[row]==kind)
            matches={}
            matched=set()
            if len(src) and len(dest):
                distances=np.abs(src.mean(axis=1)[:,None]-dest.mean(axis=1)[None,:])
                ii,jj=linear_sum_assignment(distances)
                for i,j in zip(ii,jj):
                    if distances[i,j]<48:
                        matches[i]=j
                        matched.add(j)
            strips=[]
            for i,edge in enumerate(src):
                target=dest[matches[i]] if i in matches else np.full(2,edge.mean())
                strips.append(edge*(1-t)+target*t)
            strips.extend(np.full(2,d.mean())*(1-t)+d*t for i,d in enumerate(dest) if i not in matched)
            for a,b in strips:
                cells[row,round(a):round(b)]=kind
    for building in areas['building']:
        cells[geometry_mask([building],out_shape=cells.shape,transform=projection,invert=True)]=0
    assert np.array_equal((cells[0]==12)&inside[0],(parent_row>=128)&inside[0])
    cells[~inside]=255
    assert abs(np.count_nonzero(inside)*(right-left)*(bottom-top)/width/height-site.area)<4
    assert {2,5,12,13,255}<=set(np.unique(cells)) and len(lines)>=9
    return dict(bounds=[left,top,right,bottom],width=width,height=height,ways=lines,coverage=estate_coverage(cells),
                samples=base64.b64encode(zlib.compress(cells.tobytes(),8)).decode())
