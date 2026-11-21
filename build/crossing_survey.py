import json
import math
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString,Point,Polygon

from campus_bounds import footprint
from ortho_road_paint import pigment
from pavement_survey import OUT,rings,source
from zebra_crossings import detect


def ramp_tint(position,axis):
    d=np.asarray(axis)
    n=np.array([-d[1],d[0]])
    p=np.asarray(position)
    width,depth=1.48,.60
    offset=np.array([[u,v] for u in np.arange(-2.5,2.51,.25) for v in np.arange(-1.8,1.81,.20)])
    cx=p+offset[:,:1]*d+offset[:,1:]*n
    def colors(u,v):
        xx,zz=np.meshgrid(u,v)
        rel=xx.ravel()[:,None]*d+zz.ravel()[:,None]*n
        return pigment((cx[:,None,:]+rel).reshape(-1,2)).reshape(len(cx),len(rel),3)
    body=colors(np.linspace(-.46,.46,5),[-.13,0,.13])
    sides=colors(np.linspace(-.5,.5,5),[-.56,.56])
    red=body[:,:,0]-body[:,:,1]
    plain=sides[:,:,0]-sides[:,:,1]
    delta=np.median(red,axis=1)-np.median(plain,axis=1)
    solid=(sides[:,:,1]>88)&(sides[:,:,0]-sides[:,:,1]<16)&(sides[:,:,1]-sides[:,:,2]<31)
    ok=(np.mean(red>12,axis=1)>.68)&(np.mean(solid,axis=1)>.69)&(np.median(body[:,:,1],axis=1)>95)&(np.std(body[:,:,1],axis=1)<18)&(delta>6)
    if not ok.any():return None
    merit=delta+.24*np.percentile(red,25,axis=1)-.85*np.linalg.norm(offset,axis=1)
    i=np.argmax(np.where(ok,merit,-100))
    return [*cx[i].round(2),*d.round(5),width,depth,'red','orthophoto']


def complete(survey):
    cv2.setNumThreads(1)
    site=footprint()
    lines=[]
    ways=source('drive-network')['ways']
    for w in ways:
        if w['kind']!='road' or w['bridge']:continue
        for line in shapely.get_parts(LineString([(x,z) for x,y,z in w['points']]).intersection(site)):
            if line.geom_type=='LineString' and line.length>2:lines.append(line)
    route=shapely.STRtree(lines)
    seeds=[]
    for line in lines:
        points=np.linspace(0,line.length,max(2,math.ceil(line.length/12)+1))
        seeds.extend(shapely.get_coordinates(shapely.line_interpolate_point(line,points)))
    used=set();seeds=[p for p in seeds if not (tuple(np.rint(p/5)) in used or used.add(tuple(np.rint(p/5))))]
    known=json.loads(OUT.with_name('survey_road_paint.json').read_bytes())['crosswalks']
    existing=[shapely.union_all([Polygon(np.reshape(r,(-1,2))) for r in group]).centroid for group in known.values() if group]
    tree=cKDTree([p.coords[0] for p in existing]);seeds=[p for p in seeds if tree.query(p)[0]>7.5]
    fresh=[]
    with ThreadPoolExecutor(4) as pool:
        for group in pool.map(detect,seeds):
            if len(group)<5:continue
            p=shapely.union_all(group).centroid
            near=route.geometries[route.nearest(p)].distance(p)
            if near>6.2 or tree.query(p.coords[0])[0]<5.6 or not site.covers(p):continue
            fresh.append((len(group),p,group))
    fresh.sort(key=lambda item:-item[0])
    measured=[]
    for _,p,group in fresh:
        if any(p.distance(c)<6 for c in measured):continue
        gap=np.median(pigment(np.asarray([q.centroid.coords[0] for q in group])),axis=0)
        if gap[0]-gap[2]>40:continue
        measured.append(p)
    groups=[]
    for p in measured:
        group=next(g for _,center,g in fresh if center is p)
        groups.append([rings(g) for g in group])
    survey['crossings']=groups
    seeds=[]
    for group in [*known.values(),*groups]:
        if len(group)<4:continue
        points=np.array([Polygon(np.reshape(r,(-1,2))).centroid.coords[0] for r in group])
        center=points.mean(axis=0)
        _,_,basis=np.linalg.svd(points-center,full_matrices=False)
        along=basis[0];side=np.array([-along[1],along[0]])
        uv=(points-center)@along
        for sign in [-1,1]:
            p=center+along*sign*(np.max(uv*sign)+1.10)
            seeds.append((p,side))
    for p in survey['pads']:
        if p[-1]!='orthophoto':seeds.append((np.array(p[:2]),np.array(p[2:4])))
    pads=[v for v in survey['pads'] if v[-1]=='orthophoto']
    fallback=[v for v in survey['pads'] if v[-1]!='orthophoto']
    for p,d in seeds:
        if any(np.linalg.norm(p-q[:2])<1.25 for q in pads):continue
        observed=ramp_tint(p,d)
        if observed and all(np.linalg.norm(np.subtract(observed[:2],q[:2]))>1.10 for q in pads):pads.append(observed)
    for q in fallback:
        if all(np.linalg.norm(np.subtract(q[:2],p[:2]))>2.6 for p in pads):pads.append(q)
    pads=[row for row in pads if site.covers(Point(row[:2]))]
    survey['ramps']=[row for row in survey['ramps'] if site.covers(Point(row[:2]))]
    survey['pads']=pads
    for p in pads:
        if not any(np.linalg.norm(np.subtract(q[:2],p[:2]))<1.1 for q in survey['ramps']):survey['ramps'].append([*p[:4],round(p[4]+.4,2)])
    tables=[]
    for row in survey['tables']:
        p=Point(row[:2])
        way=route.geometries[route.nearest(p)]
        at=way.project(p)
        axis=np.array(way.interpolate(min(way.length,at+1)).coords[0])-way.interpolate(max(0,at-1)).coords[0]
        if way.distance(p)<3 and abs(np.dot(axis,row[2:4]))<.24*np.linalg.norm(axis):
            tables.append(row[:6]+[.042])
    survey['tables']=tables
    print(len(seeds),'crossing/pad approaches;',len(groups),'new crossings;',sum(len(s) for s in groups),'new measured bars;',len(pads),'pads.',flush=True)
    return survey


if __name__=='__main__':
    OUT.write_text(json.dumps(complete(json.loads(OUT.read_bytes())),separators=(',',':')))
