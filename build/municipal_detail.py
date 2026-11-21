import json
import math
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from scipy.spatial import cKDTree
from shapely import transform, union_all
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.strtree import STRtree

import campus_region as region
import geo
from campus_bounds import footprint
from woodlot_survey import estate_crowns, estate_surface, landscape_plots, woodlots

OUT = region.OUT.with_name("municipal-detail.json")
CACHE = region.CACHE / "municipal"
SOURCES = {
    "lamps": ("Street_Light_Inventory/MapServer/0", "OBJECTID,Status,CartoSymbolType,RoadClass,PoleMaterial,Rotation"),
    "trees": ("Public_TreeInventory/MapServer/1", "OBJECTID,Diameter,CommonName,Botanical,Condition"),
    "fence": ("AdditionalTopographicalElements/MapServer/2", "OBJECTID,FeatureCode,Layer"),
    "hedge": ("AdditionalTopographicalElements/MapServer/3", "OBJECTID,FeatureCode"),
    "sidewalk": ("SidewalksDrivewaysParkingLots/MapServer/0", "OBJECTID,SidewalkType"),
    "driveway": ("SidewalksDrivewaysParkingLots/MapServer/1", "OBJECTID,FeatureCode"),
    "parking": ("SidewalksDrivewaysParkingLots/MapServer/2", "OBJECTID,ParkingLotEdgeType"),
}
SIZE = 96


def fetch(kind):
    service, fields = SOURCES[kind]
    CACHE.mkdir(parents=True,exist_ok=True)
    name=CACHE/f"{kind}.geojson"
    if not name.exists():
        params=dict(where="1=1",geometry=",".join(map(str,region.BBOX)),geometryType="esriGeometryEnvelope",
                    inSR=4326,outSR=4326,spatialRel="esriSpatialRelIntersects",orderByFields="OBJECTID",
                    outFields=fields,returnGeometry="true",resultRecordCount=1000,f="geojson")
        features=[]
        url=region.CITY+service+"/query"
        while True:
            response=requests.get(url,params={**params,"resultOffset":len(features)},timeout=60)
            response.raise_for_status()
            result=response.json()
            page=result["features"]
            features.extend(page)
            if not result.get("exceededTransferLimit") and len(page)<1000:
                break
            if not page:
                raise ValueError(f"Empty nonterminal {kind} result page")
        if not features or len({f["properties"]["OBJECTID"] for f in features})!=len(features):
            raise ValueError(f"Invalid {kind} inventory response")
        tmp=name.with_suffix(".tmp")
        tmp.write_text(json.dumps(features,separators=(",",":")))
        tmp.replace(name)
    return kind,json.loads(name.read_bytes())


def polygon(rings):
    arrays=[np.reshape(r,(-1,2)) for r in rings]
    return Polygon(arrays[0],arrays[1:]).buffer(0)


def lines(geometry):
    if geometry.is_empty:
        return
    if geometry.geom_type=="LineString":
        yield geometry
    elif hasattr(geometry,"geoms"):
        for part in geometry.geoms:
            yield from lines(part)


def sidewalk_pairs(features):
    segments=[]
    for feature in features:
        line=transform(shape(feature["geometry"]),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False)
        for part in lines(line):
            points=list(part.simplify(.10).coords)
            segments.extend(LineString([a,b]) for a,b in zip(points,points[1:]) if math.dist(a,b)>.25)
    return STRtree(segments)


def paired_slab(a,b,edges,roads):
    dx,dz=b[0]-a[0],b[1]-a[1]
    length=math.hypot(dx,dz)
    if length<.45:
        return None
    tx,tz=dx/length,dz/length
    nx,nz=-tz,tx
    if nx<-.001 or abs(nx)<=.001 and nz<0:
        nx,nz=-nx,-nz
    cx,cz=(a[0]+b[0])*.5,(a[1]+b[1])*.5
    probe=LineString([(cx+nx*1.05,cz+nz*1.05),(cx+nx*3.15,cz+nz*3.15)])
    best=None
    for j in edges.query(probe,predicate="intersects"):
        first,last=edges.geometries[j].coords
        vx,vz=last[0]-first[0],last[1]-first[1]
        span=math.hypot(vx,vz)
        if abs(vx*tx+vz*tz)<span*.975:
            continue
        across=nx*vz-nz*vx
        widths=[((first[0]-p[0])*vz-(first[1]-p[1])*vx)/across for p in (a,b)]
        if not all(1.05<=w<=3.15 for w in widths):
            continue
        if best and sum(widths)>=sum(best):
            continue
        match=[(p[0]+nx*w,p[1]+nz*w) for p,w in zip((a,b),widths)]
        progress=[((x-first[0])*vx+(z-first[1])*vz)/(span*span) for x,z in match]
        if min(progress)<-.10 or max(progress)>1.1:
            continue
        best=widths
    if not best:
        return None
    points=[a,b,(b[0]+nx*best[1],b[1]+nz*best[1]),(a[0]+nx*best[0],a[1]+nz*best[0])]
    if len(roads.query(Polygon(points),predicate="intersects")):
        return None
    return [round(v,2) for p in points for v in p]


def platform_furniture(furniture,network,amenities,core_detail):
    from campus_bounds import footprint
    site=footprint()
    existing=[(p[0],p[2],p[4]) for t in amenities['tiles'].values() for p in t.get('p',[])]
    existing.extend((f['kind'],f['x'],f['z']) for f in core_detail['features'])
    existing.extend((p[0],p[1],p[2]) for p in furniture['props'])
    streets=[LineString([(x,z) for x,_,z in way['points']]) for way in network['ways'] if way['kind']=='road']
    roads=STRtree(streets)
    elements=json.loads((region.CACHE/'map.json').read_bytes())['elements']
    nodes={e['id']:geo.to_grid(e['lat'],e['lon']) for e in elements if e['type']=='node'}
    for e in elements:
        tags=e.get('tags',{})
        if tags.get('shelter')!='yes' or tags.get('public_transport')!='platform':continue
        if e['type']=='node':
            point=Point(nodes[e['id']])
        elif e['type']=='way':
            points=[nodes[k] for k in e['nodes'] if k in nodes]
            if len(points)<2:continue
            point=LineString(points).centroid
        else:continue
        if not site.contains(point):continue
        road=streets[roads.nearest(point)]
        t=road.project(point)
        a,b=road.interpolate(max(0,t-1)),road.interpolate(min(road.length,t+1))
        yaw=math.atan2(-(b.y-a.y),b.x-a.x)
        if any(kind=='shelter' and math.hypot(x-point.x,z-point.y)<12 for kind,x,z in existing):continue
        x,z=point.x,point.y
        foot=road.interpolate(t)
        dx,dz=x-foot.x,z-foot.y
        distance=math.hypot(dx,dz)
        if distance<.5:continue
        if distance<5:
            x+=dx/distance*(5-distance)
            z+=dz/distance*(5-distance)
        if not site.contains(Point(x,z)):continue
        furniture['props'].append(['shelter',round(x,2),round(z,2),round(yaw,4),int(tags.get('bench')!='no')])
        existing.append(('shelter',x,z))


def surveyed_fences(features,network,amenities,footprints,roads,traces):
    campus=footprint().buffer(-.12).intersection(union_all([LineString(trace).buffer(5) for trace in traces]))
    observed=json.loads(OUT.with_name('ground-materials.json').read_bytes())['landcover']['observations']
    prior=[LineString([(a,b),(c,d)]).buffer(2) for a,b,c,d in observed['fences']]
    for tile in amenities['tiles'].values():
        for kind,_,x,_,z,X,_,Z in tile.get('l',[]):
            if kind=='fence':
                prior.append(LineString([(x,z),(X,Z)]).buffer(2))
    blockers=STRtree(prior+list(footprints.geometries)+list(roads.geometries)+[
        LineString([(p[0],p[2]) for p in way['points']]).buffer(.75,quad_segs=2)
        for way in network['ways'] if way['kind']!='road' and len(way['points'])>=2])
    result=[]
    for f in features:
        line=transform(shape(f['geometry']),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False).intersection(campus)
        if line.is_empty:continue
        hits=blockers.query(line,predicate='intersects')
        if len(hits):line=line.difference(union_all(blockers.geometries.take(hits)))
        for part in lines(line):
            if part.length<2:continue
            points=part.simplify(.12).segmentize(4).coords
            result.append([f['properties']['OBJECTID'],[round(v,2) for point in points for v in point]])
    return result


def build():
    with ThreadPoolExecutor(4) as pool:
        sources=dict(pool.map(fetch,SOURCES))
    sidewalk_edges=sidewalk_pairs(sources["sidewalk"])
    network=json.loads(OUT.with_name("drive-network.json").read_bytes())
    outer=json.loads(region.OUT.read_bytes())
    core=json.loads(OUT.with_name("drive-trees.json").read_bytes())
    amenities=json.loads(OUT.with_name("region-detail.json").read_bytes())
    bounds=network["bounds"]
    extent=box(*bounds)
    roads=STRtree([LineString([(p[0],p[2]) for p in w["points"]]).buffer(w["width"]/2+.45,quad_segs=2)
                   for w in network["ways"] if w["kind"]=="road" and w["points"]])
    footprints=STRtree([polygon([shell,*holes]) for shell,holes,*_ in outer["blocks"]]+
                       [polygon(r) for r in network["coreBuildings"]]+[polygon(r) for r in network["water"]])
    carriageways=[way for way in network["ways"] if way["kind"]=="road" and len(way["points"])>=2]
    axes=STRtree([LineString([(p[0],p[2]) for p in way["points"]]) for way in carriageways])
    lamp_refs=[(p[2],p[4]) for tile in amenities["tiles"].values() for p in tile.get("p",[]) if p[0] in ("street_lamp","traffic_signals")]
    lamps=cKDTree(lamp_refs)
    tree_refs=[(x,z) for x,_,z,*_ in outer["trees"]+core["trees"]]
    crowns=cKDTree(tree_refs)
    surface=region.lidar("dsm")-region.lidar("dtm")
    tiles=defaultdict(lambda:defaultdict(list))
    retired=Counter()
    emitted=Counter()
    records=Counter()

    def tile(x,z):
        return tiles[f"{math.floor(x/SIZE)}:{math.floor(z/SIZE)}"]

    def blocked(p):
        return len(roads.query(p,predicate="intersects")) or len(footprints.query(p,predicate="intersects"))

    def inferred_height(x,z,radius):
        offsets=radius*np.array([0,-1,.7,0,.7,1,-.7,0,-.7])
        bare=region.sample(surface,x+offsets,z+np.roll(offsets,2))
        return float(np.quantile(bare,.78))

    retired_hedges=set(json.loads(OUT.parents[1].joinpath("build/survey_ground.json").read_bytes())["retiredMunicipalHedges"])
    furniture=json.loads(Path(__file__).with_name("survey_furniture.json").read_bytes())
    furniture['conifers']=[]
    for x,z in furniture['observedConifers']:
        offsets=np.array([-1.,0.,1.])
        h=float(np.quantile(region.sample(surface,x+np.repeat(offsets,3),z+np.tile(offsets,3)),.78))
        furniture['conifers'].append([x,z,round(h,2),round(max(1.2,min(h*.30,4.6)),2),1])
    estate_height,estate_left,estate_top,estate_north=estate_surface()
    observed=[]
    for x,z,habit in furniture.pop('stemObservations'):
        if any(math.hypot(x-X,z-Z)<r for X,Z,r in furniture['clearStems']):continue
        if any(math.hypot(x-p[0],z-p[1])<1.80 for p in observed):continue
        h=inferred_height(x,z,2.1)
        if z>=estate_north:
            cx,cz=round(x-estate_left),round(z-estate_top)
            patch=estate_height[max(0,cz-2):cz+3,max(0,cx-2):cx+3]
            if patch.size:h=float(np.quantile(patch,.8))
        if habit=='s':
            h=float(np.clip(h,2.1,4.5))
        elif not 3.8<h<32:
            h=9.2 if habit=='c' else 8.4
        radii=[]
        if region.X0<x<region.X1 and region.Z0<z<region.Z1:
            for angle in np.arange(10)*math.tau/10:
                distances=np.arange(1.0,min(12,max(2,h*.64)),.5)
                canopy=region.sample(surface,x+distances*np.cos(angle),z+distances*np.sin(angle))
                gaps=np.flatnonzero((canopy<h*.34)|(canopy>h*1.7))
                radii.append(distances[gaps[0]] if gaps.size else distances[-1])
        r=float(np.clip(np.median(radii) if radii else h*.32,h*.16,h*(.35 if habit=='c' else .58)))
        observed.append([x,z,round(h,2),round(r,2),{'a':0,'b':10,'c':1,'s':8}[habit]])
    measured,low_plants=landscape_plots(furniture.pop('canopyPlots'),furniture.pop('shrubPlots'),surface,blocked,observed,furniture['clearStems'])
    furniture['datedTrees']=observed+measured
    furniture['datedShrubs']=low_plants
    furniture['styles']={}
    for feature in json.loads((region.CACHE/'map.json').read_bytes())['elements']:
        tags=feature.get('tags',{})
        if tags.get('amenity')=='bench' and tags.get('material') in ('metal','stone'):
            furniture['styles'][feature['id']]='stone' if tags['material']=='stone' else 'black-metal'
        elif tags.get('amenity')=='bicycle_parking' and tags.get('bicycle_parking'):
            furniture['styles'][feature['id']]=tags['bicycle_parking']
    for structure in furniture['siteStructures']:
        if len(structure)==8:
            ring=outer['blocks'][structure[7]][0]
            rect=Polygon(list(zip(ring[::2],ring[1::2]))).minimum_rotated_rectangle
            points=list(rect.exterior.coords)
            edges=[(math.dist(a,b),a,b) for a,b in zip(points,points[1:])]
            length,a,b=max(edges)
            structure[1:6]=[round(rect.centroid.x,3),round(rect.centroid.y,3),round(math.atan2(b[0]-a[0],b[1]-a[1]),4),round(min(edges)[0],3),round(length,3)]
    fences=surveyed_fences(sources.pop("fence"),network,amenities,footprints,roads,furniture["fenceTraces"])
    for kind,features in sources.items():
        for f in features:
            attrs=f["properties"]
            if kind=="hedge" and attrs["OBJECTID"] in retired_hedges:
                retired[kind]+=1
                continue
            raw=transform(shape(f["geometry"]),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False)
            if raw.geom_type=="Point":
                x,z=raw.x,raw.y
                if not extent.covers(raw) or blocked(raw):
                    retired[kind]+=1
                    continue
                if kind=="lamps":
                    symbol=(attrs["CartoSymbolType"] or "").lower()
                    if "future" in symbol or lamps.query((x,z))[0]<3 or "remov" in (attrs["Status"] or "").lower():
                        retired[kind]+=1
                        continue
                    arch=2 if "coach" in symbol or "post top" in symbol or "colonial" in symbol else 1 if "2 arm" in symbol or "2 head" in symbol else 0
                    h=5.5 if arch==2 else 10 if attrs["RoadClass"]=="Arterial" else 7.9
                    yaw=round(math.radians(float(attrs["Rotation"] or 0)),3)
                    if arch==0:
                        site=Point(x,z)
                        way=int(axes.nearest(site));axis=axes.geometries[way]
                        closest=axis.interpolate(axis.project(site))
                        dx,dz=closest.x-x,closest.y-z
                        distance=math.hypot(dx,dz)
                        if distance<=carriageways[way]['width']*.5+h+1.2 and dx*math.sin(yaw)+dz*math.cos(yaw)<-distance*.25:
                            yaw=round((yaw+math.pi)%math.tau,3)
                    tile(x,z)["lamps"].append([round(x,2),round(z,2),h,yaw,arch,attrs["PoleMaterial"]=="Wood"])
                else:
                    if crowns.query((x,z))[0]<4.6 or (attrs["Condition"] or "").lower() in ("dead","removed"):
                        retired[kind]+=1
                        continue
                    diam=max(3,min(float(attrs["Diameter"] or 18),140))
                    genus=(attrs["Botanical"] or "").split(" ")[0]
                    form=1 if genus in ("Picea","Abies","Tsuga") else 2 if genus=="Pinus" else 3 if genus in ("Thuja","Juniperus") else {"Salix":4,"Quercus":5,"Ulmus":6,"Gleditsia":7,"Tilia":8,"Acer":9,"Betula":11,"Populus":12,"Fraxinus":13,"Fagus":14}.get(genus,0)
                    evergreen=form in (1,2,3)
                    estimated=inferred_height(x,z,min(3.7,max(1.4,diam*.08)))
                    h=min(max(3.,2.2*math.sqrt(diam)),21.) if estimated<2 else min(estimated,27)
                    radius=max(.74,min(h*(.23 if evergreen else .32),.70+diam*.078,7.6))
                    tile(x,z)["trees"].append([round(x,2),round(z,2),round(h,1),round(radius,1),round(diam*.005,2),form,attrs["OBJECTID"]%1009])
                emitted[kind]+=1
                records[kind]+=1
                continue

            feature_lines=0
            clipped=raw.intersection(extent)
            nearby=roads.query(clipped,predicate="intersects")
            if len(nearby):
                clipped=clipped.difference(union_all(roads.geometries.take(nearby)))
            if kind=="hedge":
                nearby=footprints.query(clipped,predicate="intersects")
                if len(nearby):
                    clipped=clipped.difference(union_all(footprints.geometries.take(nearby)))
            for part in lines(clipped):
                if part.length<.8:
                    continue
                part=part.simplify(.13).segmentize(5.5)
                current_tile=None
                for a,b in zip(part.coords,list(part.coords)[1:]):
                    x,z=(a[0]+b[0])/2,(a[1]+b[1])/2
                    key=f"{math.floor(x/SIZE)}:{math.floor(z/SIZE)}"
                    if key!=current_tile:
                        coords=[round(a[0],2),round(a[1],2)]
                        row=[coords]
                        if kind=="hedge":
                            h=max(.65,min(2.4,inferred_height(x,z,.7)))
                            row.append(round(h,1))
                        tiles[key][kind].append(row)
                        feature_lines+=1
                        current_tile=key
                    coords.extend([round(b[0],2),round(b[1],2)])
                    if kind=="sidewalk":
                        slab=paired_slab(a,b,sidewalk_edges,roads)
                        if slab:
                            tiles[key]["slabs"].append(slab)
                            emitted["slabs"]+=1
            emitted[kind]+=feature_lines
            if feature_lines:
                records[kind]+=1

    data=dict(size=SIZE,bounds=bounds,tiles=tiles,counts=dict(records),segments=dict(emitted),
              sources={k:region.CITY+v[0] for k,v in SOURCES.items()},
              measured=["plan positions and boundaries","inventory diameter and species","LiDAR surface minus ground"],
              inferred=["lamp heights","foliage shapes","hedge widths and finishes","pavement edge profiles"])
    data["surveyFences"]=fences
    data["furniture"]=furniture
    platform_furniture(data["furniture"],network,amenities,json.loads(OUT.with_name("street-detail.json").read_bytes()))
    data["woodlots"]=woodlots(outer,core,tiles)
    data["woodlots"]["estates"]=estate_crowns()
    estate=data["woodlots"]["estates"]
    estate_index=cKDTree([p[:2] for p in estate])
    estate_site=footprint()
    for i,(x,z,h,r,form) in enumerate(estate):
        if len(estate_index.query_ball_point([x,z],12))<4:continue
        for j in range(2):
            angle=i*2.39996+j*2.7
            X=x+r*.69*math.cos(angle);Z=z+r*.69*math.sin(angle)
            if estate_site.contains(Point(X,Z)):
                data["woodlots"]["understory"].append([round(X,2),round(Z,2),round(.6+(i%8)*.12,2),1 if form==10 else 0])
    payload=json.dumps(data,separators=(",",":"),allow_nan=False)
    pending=OUT.with_suffix(".tmp")
    pending.write_text(payload)
    pending.replace(OUT)
    return data


def check(data):
    assert len(data["tiles"])>500 and set(data["sources"])==set(SOURCES)
    domain=box(*data["bounds"]).buffer(.03)
    counts=Counter()
    quadrants=set()
    sidewalks=0
    for k,tile in data["tiles"].items():
        tx,tz=map(int,k.split(":"))
        for kind,records in tile.items():
            for row in records:
                if kind in ("trees","lamps"):
                    assert all(np.isfinite(float(n)) for n in row)
                    x,z=row[:2]
                    assert domain.covers(Point(x,z))
                    assert math.floor(x/SIZE)==tx and math.floor(z/SIZE)==tz
                elif kind=="slabs":
                    polygon=Polygon(np.reshape(row,(-1,2)))
                    assert polygon.is_valid and .3<polygon.area<18
                    assert domain.buffer(3.17).covers(polygon)
                    sidewalks+=polygon.area
                else:
                    coords=np.asarray(row[0]).reshape(-1,2)
                    assert np.isfinite(coords).all() and len(coords)>1
                    assert domain.covers(LineString(coords))
                    for a,b in zip(coords,coords[1:]):
                        assert np.linalg.norm(a-b)<5.53
                counts[kind]+=1
        quadrants.add((tx>0,tz>0))
    woods=np.array(data['woodlots']['trees'])
    assert set(woods[:,4])=={3,5,10}
    height=region.sample(region.lidar('dsm')-region.lidar('dtm'),woods[:,0],woods[:,1])
    assert np.max(np.abs(height-woods[:,2]))<.18
    assert np.all((woods[:,3]>0)&(woods[:,3]<woods[:,2]*.5))
    assert cKDTree(woods[:,:2]).query(woods[:,:2],k=2)[0][:,1].min()>5.35
    assert len(data['woodlots']['bare'])>0
    park=np.array(data['woodlots']['park'])
    assert len(park)>0 and set(park[:,4])<= {3,10}
    park_height=region.sample(region.lidar('dsm')-region.lidar('dtm'),park[:,0],park[:,1])
    assert np.max(np.abs(park_height-park[:,2]))<.18
    assert cKDTree(park[:,:2]).query(park[:,:2],k=2)[0][:,1].min()>3.65
    estates=np.array(data['woodlots']['estates'])
    assert len(estates)>15 and np.all(estates[:,1]>=region.Z1)
    assert set(estates[:,4])=={1,10}
    fence_groups=data['surveyFences']
    assert len(fence_groups)>0
    fence_domain=footprint().buffer(.02)
    traced=[]
    for feature,coords in fence_groups:
        points=np.asarray(coords).reshape(-1,2)
        line=LineString(points)
        traced.append(line)
        assert feature>0 and len(points)>=2 and fence_domain.covers(line)
        assert np.linalg.norm(np.diff(points,axis=0),axis=1).max()<4.02
    fence_index=STRtree(traced)
    for anchor in ((328,1225),(-23,-125),(204,1190)):
        site=Point(anchor)
        assert site.distance(fence_index.geometries[fence_index.nearest(site)])<2
    fixtures=data['furniture']
    confirmed=union_all([LineString(trace).buffer(5.02) for trace in fixtures['fenceTraces']])
    assert all(confirmed.covers(line) for line in traced)
    assert len(set(map(tuple,fixtures['lamps'])))==len(fixtures['lamps'])
    original_lamps=set(map(tuple,json.loads(OUT.with_name('ground-materials.json').read_bytes())['landcover']['observations']['lamps']))
    measured_lamps={tuple(p[:2]) for p in fixtures['lamps']}
    for x,z,X,Z in fixtures['lampCorrections']:
        assert (x,z) in original_lamps and (X,Z) not in measured_lamps and 0<math.hypot(X-x,Z-z)<9
    assert {'bench','shelter','utility_cabinet','gate_booth'}<=set(p[0] for p in fixtures['props'])
    assert sidewalks>5500
    assert len(quadrants)==4 and dict(counts)==data["segments"]
    for k,n in {"lamps":300,"trees":800,"sidewalk":600,"parking":200,"driveway":2500,"hedge":900}.items():
        assert data["counts"][k]>=n
    print(f"{sidewalks:.0f} m² verified from paired sidewalk edges, {len(data['tiles'])} municipal detail tiles; unique mapped features {data['counts']}")


if __name__=="__main__":
    check(json.loads(OUT.read_bytes()) if "--check" in sys.argv else build())
