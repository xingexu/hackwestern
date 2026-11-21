import math

import cv2
import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString,box

from ortho_road_paint import pigment,rgb_tile


def parked_cars(lots):
    l,t,r,b=lots.bounds
    cars=[]
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(b/150)*150,150):
            if not lots.intersects(box(x,z,x+150,z+150)):continue
            rgb=rgb_tile(x,z).astype(np.float32)
            lum=(rgb[:,:,0]+2*rgb[:,:,1]+rgb[:,:,2])*.25
            local=cv2.GaussianBlur(lum,(0,0),21)
            dark=(lum<np.minimum(102,local-30))|(np.ptp(rgb,axis=2)>51)&(lum<152)
            dark=cv2.morphologyEx(dark.astype(np.uint8),cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(3,3)))
            blobs,_=cv2.findContours(dark,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            for blob in blobs:
                (a,c),(w,h),angle=cv2.minAreaRect(blob)
                if min(a,c)<12 or max(a,c)>1487:continue
                if not 10<min(w,h)<26 or not 20<max(w,h)<56 or not 1.38<max(w,h)/min(w,h)<3.5:continue
                if cv2.contourArea(blob)<w*h*.17:continue
                p=np.array([x+(a+.5)*.1,z+(c+.5)*.1])
                if not shapely.contains_xy(lots,*p):continue
                theta=math.radians(angle+(90 if h>w else 0))
                cars.append((p,np.array([math.cos(theta),math.sin(theta)]),max(w,h)*.1))
    return cars


def divider(p,axis,side):
    stations=np.arange(-2.65,2.7,.11)
    phases=np.arange(-.46,.47,.085)
    cloud=p+stations[None,:,None]*axis+phases[:,None,None]*side
    def colors(offset):
        return pigment((cloud+offset*side).reshape(-1,2)).reshape(cloud.shape[:2]+(3,))
    body=colors(0)
    left,right=colors(-.31),colors(.31)
    luma=lambda a:(a[:,:,0]+2*a[:,:,1]+a[:,:,2])*.25
    gains=body-np.maximum(left,right)
    white=luma(gains)
    tint=(gains[:,:,0]+gains[:,:,1])*.5-gains[:,:,2]
    amber=(body[:,:,0]+body[:,:,1])*.5-body[:,:,2]
    confirmed=(luma(left)>96)&(luma(right)>96)&(np.abs(luma(left)-luma(right))<28)&(np.ptp(body,axis=2)<58)
    score=np.clip(white+np.maximum(0,tint)*1.65,-18,21)
    signal=confirmed&(score>3.6)
    bilateral=signal[:,:19].sum(axis=1)+signal[:,31:].sum(axis=1)
    score=np.where(confirmed,score,-1)
    merit=np.maximum(0,score.mean(axis=1))+.10*bilateral
    k=int(np.argmax(merit))
    if merit[k]<2.25 or signal[k].sum()<9 or bilateral[k]<5:return
    chosen=confirmed[k]
    if chosen.mean()<.38 or np.median(luma(left)[k,chosen])<116 or np.median(luma(right)[k,chosen])<116:return
    side_delta=np.abs(left[k,chosen]-right[k,chosen]).mean(axis=1)
    if np.median(side_delta)>14:return
    colored=signal[k]&(amber[k]>14)&(tint[k]>2.5)
    gold=colored.sum()>=max(4,signal[k].sum()*.43)
    head=p+phases[k]*side
    return np.asarray([head-axis*2.58,head+axis*2.58]),int(gold),merit[k]


def survey(lots,existing):
    cars=parked_cars(lots)
    if not cars:return []
    centers=np.asarray([car[0] for car in cars])
    axes=np.asarray([car[1] for car in cars])
    index=cKDTree(centers)
    observed=shapely.STRtree(existing)
    candidates=[]
    for i,(center,axis,size) in enumerate(cars):
        near=index.query_ball_point(center,18)
        side=np.array([-axis[1],axis[0]])
        delta=centers[near]-center
        on_row=np.asarray(near)[(np.abs(axes[near]@axis)>.93)&(np.abs(delta@axis)<1.28)]
        if len(on_row)<4:continue
        progress=(centers[on_row]-center)@side
        spacings=np.arange(2.48,3.38,.035)
        error=np.abs(progress[:,None]-np.rint(progress[:,None]/spacings)*spacings)
        k=np.argmax(np.mean(np.exp(-(error/.32)**2),axis=0))
        fit=on_row[error[:,k]<.39];spacing=spacings[k]
        if len(fit)<4:continue
        sorted_ids=fit[np.argsort((centers[fit]-center)@side)]
        positions=centers[sorted_ids]
        stations=np.rint((positions-center)@side/spacing).astype(int)
        if len(np.unique(stations))!=len(stations):continue
        slope=np.polyfit(stations,positions,1)[0]
        side=slope/np.linalg.norm(slope)
        along=np.array([-side[1],side[0]])
        if abs(along@axis)<.95:continue
        residual=(positions-np.outer(stations,slope))
        intercept=np.median(residual,axis=0)
        if np.median(np.abs((residual-intercept)@along))>.52:continue
        for j,a,b in zip(stations,sorted_ids,sorted_ids[1:]):
            if not 2.35<np.linalg.norm(centers[b]-centers[a])<3.55:continue
            p=intercept+(j+.5)*slope
            alternatives=[]
            for angle in [-.07,0,.07]:
                u=math.cos(angle)*along+math.sin(angle)*side
                n=np.array([-u[1],u[0]])
                sample=divider(p,u,n)
                if sample is not None:alternatives.append(sample)
            if not alternatives:continue
            xy,color,score=max(alternatives,key=lambda measurement:measurement[2])
            line=LineString(xy)
            if not lots.covers(line.buffer(.13,cap_style='flat')):continue
            candidates.append((score,line,color))
    rows=[]
    for _,line,color in sorted(candidates,key=lambda v:-v[0]):
        near=observed.geometries[observed.query(line,predicate='dwithin',distance=.4)]
        neighbors=[*near,*[p for p,ink in rows if p.distance(line)<.4]]
        if neighbors:
            line=line.difference(shapely.union_all(neighbors).buffer(.38,quad_segs=2))
        for part in shapely.get_parts(line):
            if part.geom_type=='LineString' and part.length>=2.4:rows.append((part,color))
    return [[np.asarray([g.coords[0],g.coords[-1]]).round(2).ravel().tolist(),ink] for g,ink in rows if exposed(g)]


def exposed(line):
    a,b=np.asarray(line.coords)[[0,-1]]
    body=pigment(np.linspace(a,b,41))
    r,g,b=body.T
    l=(r+2*g+b)*.25
    between=(l>110)&(l<230)&(np.ptp(body,axis=1)<43)&(r>b+4)
    return between.mean()>=.80 and np.ptp(np.percentile(l,[20,80]))<34 and np.median(r-b)>9
