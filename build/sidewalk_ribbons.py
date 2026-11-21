import json
import math
from functools import lru_cache

import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import LineString,Polygon,box

import campus_region as region
from campus_bounds import footprint
from parcel_surfaces import municipal_lines


def register(path,typical,edges):
    stations=np.linspace(0,path.length,math.ceil(path.length/.8)+1)
    p=shapely.get_coordinates(shapely.line_interpolate_point(path,stations))
    tangent=np.gradient(p,axis=0)
    tangent/=np.maximum(.01,np.linalg.norm(tangent,axis=1))[:,None]
    normal=tangent[:,[1,0]]*[-1,1]
    cuts=shapely.linestrings(np.stack([p-normal*4.25,p+normal*4.25],axis=1))
    rows=[[] for _ in stations]
    i,j=edges.query(cuts,predicate='intersects')
    for at,hit in zip(i,shapely.intersection(cuts[i],edges.geometries[j])):
        for cross in shapely.get_parts(hit):
            if cross.geom_type=='Point':rows[at].append(float((np.asarray(cross.coords[0])-p[at])@normal[at]))
    spans=np.full((len(stations),2),np.nan)
    for at,row in enumerate(rows):
        offsets=sorted(set(round(v,3) for v in row))
        choices=[]
        for lo,hi in zip(offsets,offsets[1:]):
            width=hi-lo
            shift=(lo+hi)*.5
            if max(1.12,typical*.53)<width<min(4.45,typical*1.65) and abs(shift)<1.65:
                choices.append((abs(width-typical)*.6+abs(shift),lo,hi))
        if choices:spans[at]=min(choices)[1:]
    valid=np.all(np.isfinite(spans),axis=1)
    matched=valid[:-1]&valid[1:]&(np.abs(np.diff(spans,axis=0)).max(axis=1)<.90)
    records=[]
    for start,end in np.flatnonzero(np.diff(np.r_[False,matched,False])).reshape(-1,2):
        if stations[end]-stations[start]<5.8:continue
        s=slice(start,end+1)
        a=p[s]+normal[s]*spans[s,:1]
        b=p[s]+normal[s]*spans[s,1:]
        surface=Polygon(np.concatenate([a,b[::-1]])).buffer(0).simplify(.075)
        for poly in shapely.get_parts(surface):
            if poly.geom_type=='Polygon' and poly.area>6:records.append(poly)
    return records


@lru_cache(maxsize=1)
def inventory():
    site=footprint()
    edges=shapely.STRtree([p for g in municipal_lines('sidewalk',site) for p in shapely.get_parts(g) if p.geom_type=='LineString'])
    front=json.loads((region.OUT.parents[1]/'build/survey_frontages.json').read_bytes())
    lines=[(LineString(p),width) for p,width in front['walks']]
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    for way in net['ways']:
        if way['kind']!='path' or way['class'] not in ('footway','pedestrian','path','cycleway') or way.get('bridge') or way.get('level'):continue
        if way['material'] in ('gravel','dirt','unpaved','ground','earth','grass'):continue
        walk=LineString([(x,z) for x,_,z in way['points']])
        if walk.length>=6 and site.intersects(walk):lines.append((walk,way['width']))
    records=[]
    for line,w in lines:
        for part in shapely.get_parts(line.intersection(site)):
            if part.geom_type=='LineString' and part.length>6:records.extend(register(part,w,edges))
    return shapely.STRtree(records)


def masks(frame,size):
    tree=inventory()
    ids=tree.query(box(*frame).buffer(2),predicate='intersects')
    if not len(ids):return
    grid=Affine.translation(*frame[:2])*Affine.scale((frame[2]-frame[0])/size[0],(frame[3]-frame[1])/size[1])
    walks=shapely.union_all(tree.geometries[ids])
    return rasterize([(walks.buffer(1.45),2),(walks,1)],out_shape=(size[1],size[0]),transform=grid,dtype='uint8')
