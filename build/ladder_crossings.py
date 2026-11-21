import json
import math
from functools import lru_cache

import cv2
import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString,Point,Polygon,box

import campus_region as region
from campus_bounds import footprint
from ortho_road_paint import pigment,rgb_tile


OUT=region.OUT.parents[1]/'build/survey_ladders.json'


@lru_cache(maxsize=1)
def registered():
    return json.loads(OUT.read_bytes())


def photo(x,z,size):
    u=x*10+np.arange(size)
    v=z*10+np.arange(size)
    image=np.empty((size,size,3),np.uint8)
    for i in np.unique(u//1500):
        for j in np.unique(v//1500):
            a=np.flatnonzero(u//1500==i)
            b=np.flatnonzero(v//1500==j)
            image[np.ix_(b,a)]=rgb_tile(int(i)*150,int(j)*150)[np.ix_(v[b]%1500,u[a]%1500)]
    return image


def openings(rgb,origin):
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    bare=cv2.morphologyEx(gray,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(21,21)))
    gain=cv2.subtract(gray,bare)
    valid=[]
    for threshold in (13,8,19,6):
        joined=cv2.morphologyEx(np.uint8(gain>threshold),cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(3,3)))
        contours,tree=cv2.findContours(joined,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
        if tree is None:continue
        for k,row in enumerate(contours):
            if tree[0,k,3]<0:continue
            (i,j),(a,b),angle=cv2.minAreaRect(row)
            length,width=max(a,b)*.1,min(a,b)*.1
            if not 1.2<length<4.9 or not .36<width<1.55 or length<width*1.4 or cv2.contourArea(row)<a*b*.69:continue
            point=origin+np.array([i,j])*.1
            if any(np.linalg.norm(point-v[0])<.32 for v in valid):continue
            theta=math.radians(angle+(90 if b>a else 0))
            valid.append((point,np.array([math.cos(theta),math.sin(theta)]),length,width))
    return valid


def measured(lines):
    center=lines.mean(axis=0)
    stations=np.linspace(-.39,.39,11)
    u=lines[1]-lines[0]
    length=np.linalg.norm(u)
    axis=u/length
    side=np.array([-axis[1],axis[0]])
    offsets=np.arange(-.70,.701,.05)
    xy=center+stations[:,None,None]*u+offsets[None,:,None]*side
    samples=pigment(xy.reshape(-1,2)).reshape(len(stations),len(offsets),3)
    light=samples@np.array([.30,.52,.18])
    strength=np.median(light,axis=0)
    background=max(np.median(strength[:3]),np.median(strength[-3:]))
    peak=np.argmax(np.where(np.abs(offsets)<.18,strength,-1))
    contrast=strength[peak]-background
    if contrast<7 or np.mean(light[:,peak]>np.maximum(light[:,1],light[:,-2])+4)<.60:return
    keep=strength>background+max(4,contrast*.44)
    a=b=peak
    while a>0 and keep[a-1]:a-=1
    while b+1<len(keep) and keep[b+1]:b+=1
    width=np.clip(.05*(b-a+1),.10,.64)
    shift=side*.5*(offsets[b]+offsets[a])
    return LineString(lines+shift).buffer(width*.5,cap_style='flat')


def fit(records):
    pts=np.asarray([r[0] for r in records])
    axes=np.asarray([r[1] for r in records])
    lengths=np.asarray([r[2] for r in records])
    patterns={}
    tree=cKDTree(pts)
    for i,(p,axis,length,width) in enumerate(records):
        for j in tree.query_ball_point(p,1.85):
            step=np.linalg.norm(pts[j]-p)
            if j<=i or step<.60:continue
            direction=(pts[j]-p)/step
            if abs(direction@axis)>.32:continue
            normal=np.array([-direction[1],direction[0]])
            delta=pts-p
            take=(np.abs(delta@normal)<.26)&(np.abs(delta@direction)<23)&(np.abs(axes@axis)>.961)&(np.abs(lengths-length)<.53)
            ind=np.flatnonzero(take)
            station=delta[ind]@direction
            ordered=ind[np.argsort(station)]
            for group in np.split(ordered,np.flatnonzero(np.diff(np.sort(station))>2.15)+1):
                if len(group)<4:continue
                ids=tuple(sorted(group))
                if ids in patterns:continue
                coord=pts[group]
                travel=np.linalg.svd(coord-coord.mean(axis=0),full_matrices=False)[2][0]
                t=(coord-coord.mean(axis=0))@travel
                order=group[np.argsort(t)]
                gaps=np.diff(np.sort(t))
                pitch=np.median(gaps)
                if not .65<pitch<1.75 or np.mean(np.abs(gaps/pitch-1)<.27)<.80:continue
                drift=np.max(np.abs((coord-coord.mean(axis=0))@[-travel[1],travel[0]]))
                if drift>.26:continue
                patterns[ids]=(order,travel,pitch)
    accepted=[]
    for order,travel,step in sorted(patterns.values(),key=lambda v:-len(v[0])):
        coord=pts[order]
        center=coord.mean(axis=0)
        if any(g.distance(Point(center))<1.4 for g,_,_ in accepted):continue
        along=(coord-center)@travel
        bar=axes[order]*np.sign(axes[order]@axes[order[0]])[:,None]
        bar=np.median(bar,axis=0)
        bar/=np.linalg.norm(bar)
        span=np.median(lengths[order])
        mid=np.r_[along[0]-step/2,(along[1:]+along[:-1])/2,along[-1]+step/2]
        marks=[]
        for t in mid:
            g=measured(center+t*travel+np.array([-.5,.5])[:,None]*(span+.08)*bar)
            if g is not None:marks.append(g)
        if len(marks)<4 or len(marks)<.70*len(mid):continue
        start,end=along[0]-step*.5,along[-1]+step*.5
        rail_offsets=[]
        for sign in [-1,1]:
            q=coord+bar*sign*(span*.5+.04)
            shift=np.arange(-.18,.181,.04)
            rgb=pigment((q[:,None,:]+shift[None,:,None]*bar).reshape(-1,2)).reshape(len(q),len(shift),3)
            bright=rgb@np.array([.30,.52,.18])
            off=(pigment(q+bar*sign*.44)+pigment(q-bar*sign*.44))*.5
            score=bright-(off@np.array([.30,.52,.18]))[:,None]
            j=np.argmax(np.median(score,axis=0))
            if np.median(score[:,j])<7 or np.mean(score[:,j]>5)<.64:continue
            rail_offsets.append(sign*(span*.5+.04)+shift[j])
        if len(rail_offsets)!=2:continue
        for direction in [-1,1]:
            station=start if direction<0 else end
            for _ in range(10):
                target=station+direction*step
                t=station+(target-station)*np.array([.3,.4,.5,.6,.7])
                centers=center+t[:,None]*travel
                edges=centers[None,:,:]+np.array(rail_offsets)[:,None,None]*bar
                probes=edges[:,:,None,:]+np.arange(-.16,.161,.04)[None,None,:,None]*bar
                bright=pigment(probes.reshape(-1,2)).reshape(2,5,-1,3)@np.array([.30,.52,.18])
                sides=(pigment((edges+.43*bar).reshape(-1,2))+pigment((edges-.43*bar).reshape(-1,2)))*.5
                evidence=np.max(np.median(bright-(sides@np.array([.30,.52,.18])).reshape(2,5,1),axis=1),axis=1)
                if evidence.min()<3 or evidence.mean()<7:break
                extra=measured(center+target*travel+np.array([-.5,.5])[:,None]*(span+.08)*bar)
                if extra is None:break
                marks.append(extra)
                station=float((np.asarray(extra.centroid.coords[0])-center)@travel)
            if direction<0:start=station
            else:end=station
        rails=[LineString(center+np.array([start,end])[:,None]*travel+offset*bar).buffer(.09,cap_style='flat') for offset in rail_offsets]
        accepted.append((shapely.union_all(marks+rails).convex_hull,marks,rails))
    return accepted


def survey():
    cv2.setNumThreads(1)
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    site=footprint();left,top,right,bottom=site.bounds
    axes=[LineString([(x,z) for x,y,z in w['points']]).buffer(max(4.5,w['width']*.66)) for w in net['ways'] if w['kind']=='road' and not w['bridge'] and not w['level']]
    from city_streets import solid_ground_floors
    road=shapely.union_all(axes).intersection(site).difference(shapely.union_all(solid_ground_floors(net)))
    groups=[]
    for x in range(math.floor(left/50)*50,math.ceil(right/50)*50,50):
        for z in range(math.floor(top/50)*50,math.ceil(bottom/50)*50,50):
            tile=box(x,z,x+50,z+50)
            if not road.intersects(tile):continue
            origin=np.array([x-9,z-9])
            rec=openings(photo(*origin,680),origin+.05)
            rec=[r for r in rec if road.covers(Point(r[0]))]
            if len(rec)<4:continue
            for belt,bars,rails in fit(rec):
                if tile.distance(belt.centroid)<5 and road.covers(belt.centroid):
                    groups.append((belt,bars,rails))
    result=[]
    for belt,bars,rails in sorted(groups,key=lambda v:-len(v[1])):
        if any(belt.intersection(o).area>.45*min(belt.area,o.area) for o,_,_ in result):continue
        result.append((belt,bars,rails))
    def rings(parts):return [np.asarray(p.exterior.coords)[:-1].round(3).ravel().tolist() for p in parts]
    return [{'bars':rings(bars),'rails':rings(rails)} for belt,bars,rails in result]


if __name__=='__main__':
    groups=survey()
    OUT.write_text(json.dumps(groups,separators=(',',':')))
    print(len(groups),'ladder crossings with paired side rails and',sum(len(g['bars']) for g in groups),'photographed bars')
