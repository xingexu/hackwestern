import json
from functools import lru_cache

import numpy as np
import shapely
from shapely.geometry import LineString,Polygon,shape

import campus_region as region
import geo


@lru_cache(maxsize=1)
def surveyed_channels():
    pages=sorted(region.CACHE.glob('horizon-water-[0-9]*.json'))
    if not pages:raise FileNotFoundError('London topographic water polygons')
    polygons=[]
    for page in pages:
        for feature in json.loads(page.read_bytes())['features']:
            source=shape(feature['geometry'])
            projected=shapely.transform(source,lambda lon,lat:geo.to_grid(lat,lon),interleaved=False)
            polygons.extend(p for p in shapely.get_parts(shapely.make_valid(projected)) if p.geom_type=='Polygon' and p.area>25)
    return polygons


def waterlines(original,ways,extent):
    mapped=[Polygon(np.reshape(p,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]).buffer(0) for p,*holes in original]
    osm=shapely.union_all(mapped)
    municipal=[]
    for geometry in surveyed_channels():
        if geometry.area<8000 or not geometry.intersects(extent):continue
        channel=geometry.intersection(extent)
        if channel.area>150 and channel.intersection(osm).area>channel.area*.32:municipal.append(channel)
    channels=shapely.union_all(municipal)
    footprint=channels.buffer(40,quad_segs=3)
    connected=[]
    for body in mapped:
        if body.area<2000 or body.intersection(channels).area<body.area*.30:
            connected.append(body)
        else:connected.append(body.difference(footprint))
    for way in ways:
        if not way['bridge'] or way['kind']!='road':continue
        span=LineString(np.asarray(way['points'])[:,[0,2]]).buffer(way['width']*.6+2.5,cap_style='flat')
        if span.intersects(channels):connected.append(osm.intersection(span).intersection(channels.buffer(12)))
    combined=shapely.union_all([channels,*connected]).intersection(extent)
    result=[]
    for p in shapely.get_parts(combined.simplify(.15,preserve_topology=True)):
        if p.geom_type!='Polygon' or p.area<.5:continue
        rounded=shapely.set_precision(p,.01)
        for part in shapely.get_parts(rounded):
            if part.geom_type!='Polygon':continue
            result.append([np.asarray(r.coords[:-1]).round(2).reshape(-1).tolist() for r in [part.exterior,*part.interiors]])
    return result


def exposed_shore(classes,bounds):
    from scipy import ndimage
    from ortho_road_paint import pigment
    left,top,right,bottom=bounds
    rows,cols=classes.shape
    dx,dz=(right-left)/cols,(bottom-top)/rows
    water=classes==6
    if not water.any():return
    near=ndimage.binary_dilation(water,iterations=round(7/min(dx,dz)))&np.isin(classes,[0,1,2,4,10,11])
    v,u=np.nonzero(near)
    p=np.column_stack([left+(u+.5)*dx,top+(v+.5)*dz])
    around=np.stack([pigment(p+[a,b]) for a,b in [(0,0),(.25,0),(-.25,0),(0,.25),(0,-.25)]])
    r,g,b=np.median(around,axis=0).T
    light=np.mean(around,axis=2)
    band=(r+2*g+b)*.25
    mineral=(r-g>1)&(r-g<17)&(g-b>3)&(g-b<23)&(band>105)&(np.std(light,axis=0)<16)
    litter=(r-g>1)&(g-b>2)&(band>49)&(band<138)&(np.std(light,axis=0)>5)
    shore=region.sample(region.lidar('dtm'),*p.T)
    nearest=ndimage.distance_transform_edt(~water,return_distances=False,return_indices=True)
    edge=np.column_stack([left+(nearest[1,v,u]+.5)*dx,top+(nearest[0,v,u]+.5)*dz])
    rise=shore-region.sample(region.lidar('dtm'),*edge.T)
    deposit=np.zeros_like(water);floor=np.zeros_like(water)
    deposit[v,u]=mineral&(rise<.94)&(rise>-.65)
    floor[v,u]=litter&(rise<1.35)
    connected=ndimage.binary_dilation(water,iterations=3)
    for flag,code in [(floor,2),(deposit,10)]:
        clustered=ndimage.binary_closing(flag,iterations=1)&near
        surface=ndimage.binary_propagation(clustered&connected,mask=clustered)
        classes[surface]=code
