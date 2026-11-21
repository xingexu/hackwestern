import json
from functools import lru_cache

import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import LineString,Polygon,box,shape

import campus_region as region
import geo
from campus_bounds import footprint
from kerb_islands import samples
from ortho_road_paint import pigment
from parcel_surfaces import cartography

OUT=region.OUT.parents[1]/'build/survey_frontages.json'
SIDEWALKS=region.CITY+'OpenData/OpenData_Transportation/MapServer/4/query'


def civic_walks(site):
    query=dict(f='geojson',where='1=1',geometry=','.join(map(str,region.BBOX)),geometryType='esriGeometryEnvelope',inSR=4326,outSR=4326,spatialRel='esriSpatialRelIntersects',outFields='OBJECTID,Material,Width',returnGeometry='true',orderByFields='OBJECTID')
    raw=json.loads(region.retrieve('frontage-sidewalk-centres.geojson',SIDEWALKS,query).read_bytes())
    output=[]
    for row in raw['features']:
        line=shapely.transform(shape(row['geometry']),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False)
        width=1.42 if row['properties'].get('Width')=='< 1.5m' else 1.78
        for part in shapely.get_parts(line.intersection(site)):
            if part.geom_type=='LineString' and part.length>2:output.append((part,width))
    return output


def draw_faces():
    site=footprint()
    network=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    layers=cartography(network,site)
    walks=civic_walks(site)
    records=[]
    for face in layers['faces'].geometries:
        if not 5<face.area<8600:continue
        if face.area<45 and face.length*face.length/face.area>150:continue
        rim=face.boundary
        def coverage(key):
            tree=layers[key]
            indices=tree.query(rim,predicate='dwithin',distance=.22)
            return rim.intersection(shapely.union_all(tree.geometries[indices]).buffer(.22,quad_segs=2)).length/rim.length if len(indices) else 0
        sidewalk=coverage('side')
        access=coverage('access')
        parking=coverage('rim')
        if max(sidewalk,access,parking)<.175:continue
        kernel=face.buffer(-.20)
        if kernel.is_empty:continue
        covered=layers['floors'].geometries[layers['floors'].query(kernel,predicate='intersects')]
        if len(covered):
            kernel=kernel.difference(shapely.union_all(covered))
            if kernel.area<max(3,face.area*.30):continue
        native=samples(kernel,.65)
        if len(native)<8:continue
        r,g,b=native.T
        lum=(r+g*2+b)*.25
        valid=lum>58
        if valid.mean()<.35:continue
        neutral=(g-r<5)&(r-g<15)&(r-b<9+.13*lum)&(g-b<6+.12*lum)
        grass=((g-r>5)&(g-b>14))|((r-b>8+.23*lum)&(g-b>4+.13*lum))
        warm=(r-g>9)&(r-g<29)&(g-b>4)&(g-b<20)&(r-b<45)&(lum>105)
        paver=warm[valid].mean()>.62 and sidewalk>.35
        rich=neutral[valid].mean()
        if not paver and (rich<.70 or grass[valid].mean()>.13):continue
        if sidewalk>=max(parking,access)*.70 and (sidewalk>.25 or face.area<120):label=2 if paver else 1
        elif access+parking>.32:label=4
        else:continue
        for poly in shapely.get_parts(kernel.buffer(.20,join_style='mitre').intersection(face)):
            if poly.geom_type!='Polygon' or poly.area<4:continue
            close=poly.simplify(.10)
            rings=[np.asarray(r.coords)[:-1].round(2).tolist() for r in [close.exterior,*close.interiors]]
            records.append([label,rings])
    from aggregate_courts import survey as aggregate_courts
    records.extend(aggregate_courts(site,layers['floors']))
    lines=[[np.asarray(line.simplify(.07).coords).round(2).tolist(),width] for line,width in walks]
    from ramp_returns import survey as ramp_returns
    records.extend(ramp_returns())
    from frontage_kerbs import survey as kerbs
    import city_streets
    city=shapely.union_all([Polygon(np.reshape(s,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for s,*holes in city_streets.survey()])
    return dict(walks=lines,faces=records,kerbs=kerbs(site,city))


@lru_cache(maxsize=1)
def layers():
    data=json.loads(OUT.read_bytes())
    shapes=[LineString(points).buffer(width*.5,cap_style='flat',join_style='round') for points,width in data['walks']]
    kinds=[1]*len(shapes)
    for kind,rings in data['faces']:
        shapes.append(Polygon(rings[0],rings[1:]).buffer(0))
        kinds.append(kind)
    return shapely.STRtree(shapes),np.asarray(kinds)


def material_grid(frame,size):
    tree,labels=layers()
    ids=tree.query(box(*frame),predicate='intersects')
    width,height=size
    if not len(ids):return np.zeros((height,width),np.uint8)
    transform=Affine.translation(*frame[:2])*Affine.scale((frame[2]-frame[0])/width,(frame[3]-frame[1])/height)
    return rasterize([(tree.geometries[i],int(labels[i])) for i in sorted(ids)],out_shape=(height,width),transform=transform,dtype='uint8')


if __name__=='__main__':
    records=draw_faces()
    OUT.write_text(json.dumps(records,separators=(',',':')))
    print(len(records['walks']),'surveyed public sidewalk centre lines and',len(records['faces']),'photo-supported cadastral paving faces.')
