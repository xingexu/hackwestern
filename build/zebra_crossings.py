import math

import cv2
import numpy as np
from shapely.geometry import Polygon

from ortho_road_paint import pigment


def detect(center):
    radius=19
    grid=np.arange(-radius,radius,.1)
    left=center[0]-radius
    top=center[1]-radius
    x,z=np.meshgrid(center[0]+grid,center[1]+grid)
    rgb=pigment(np.column_stack((x.ravel(),z.ravel()))).reshape(*x.shape,3).astype('uint8')
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    opening=cv2.morphologyEx(gray,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15)))
    ink=gray.astype('float32')-opening
    proposals=[]
    for threshold in [15,10,20]:
        mask=np.uint8((ink>threshold)&(gray>110))
        mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
        contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            (u,v),(a,b),angle=cv2.minAreaRect(c)
            length,width=max(a,b)*.1,min(a,b)*.1
            if not 1.15<length<4.8 or not .22<width<1.05 or width>.48*length or cv2.contourArea(c)<.46*a*b:continue
            p=np.array([left+u*.1,top+v*.1])
            if any(np.linalg.norm(p-q[0])<.38 for q in proposals):continue
            theta=math.radians(angle+(90 if b>a else 0))
            axis=np.array([math.cos(theta),math.sin(theta)])
            proposals.append((p,axis,length,width))
    if len(proposals)<4:return []
    centers=np.array([q[0] for q in proposals])
    directions=np.array([q[1] for q in proposals])
    lengths=np.array([q[2] for q in proposals])
    fits=[]
    for i,(point,axis,length,width) in enumerate(proposals):
        offset=centers-point
        same=(np.abs(directions@axis)>.96)&(np.abs(lengths-length)<.83)
        distances=np.linalg.norm(offset,axis=1)
        for j in np.flatnonzero(same&(distances>.57)&(distances<1.95)):
            cross=offset[j]/distances[j]
            if abs(cross@axis)>.72:continue
            perpendicular=np.array([-cross[1],cross[0]])
            on_band=same&(np.abs(offset@perpendicular)<.28)
            indices=np.flatnonzero(on_band)
            projections=offset[indices]@cross
            for group in np.split(indices[np.argsort(projections)],np.flatnonzero(np.diff(np.sort(projections))>2.7)+1):
                if len(group)<4:continue
                points=centers[group]
                origin=points.mean(axis=0)
                near=np.linalg.norm(origin-center)
                if near>10 or np.linalg.norm((origin-center)@perpendicular)>6:continue
                distance=np.sort((points-origin)@cross)
                gaps=np.diff(distance)
                ordinary=gaps[(gaps>.56)&(gaps<1.85)]
                if len(ordinary)<3:continue
                step=np.median(ordinary)
                residual=np.abs(gaps/step-np.rint(gaps/step))
                if np.median(residual)>.14 or np.quantile(residual,.8)>.30:continue
                fits.append((len(group)-near*.38-residual.sum(),group))
    if not fits:return []
    _,group=max(fits,key=lambda row:row[0])
    points=centers[group]
    origin=points.mean(axis=0)
    _,_,basis=np.linalg.svd(points-origin,full_matrices=False)
    travel=basis[0]
    stations=np.sort((points-origin)@travel)
    gaps=np.diff(stations)
    step=np.median(gaps[(gaps>.56)&(gaps<1.85)])
    axis=np.median(directions[group]*np.sign(directions[group]@directions[group[0]])[:,None],axis=0)
    axis/=np.linalg.norm(axis)
    side=np.array([-axis[1],axis[0]])
    length=np.median(lengths[group])
    def samples(p,across):
        steps=np.linspace(-.41,.41,19)*length
        positions=p+axis*steps[:,None]+across*side
        i,j=np.rint((positions-[left,top])*10).astype(int).T
        return gray[j.clip(0,gray.shape[0]-1),i.clip(0,gray.shape[1]-1)].astype(float)
    def strength(p):
        center=samples(p,0)
        base=(samples(p,-.45)+samples(p,.45))*.5
        return np.median(center-base)*np.mean(center>base+6)
    stripes=[]
    reference=stations[0]
    for index in range(-12,math.ceil((stations[-1]-reference)/step)+13):
        station=reference+index*step
        p=origin+travel*station
        phase=max([-.17,-.08,0,.08,.17],key=lambda d:strength(p+travel*d))
        p+=phase*travel
        if strength(p)<8:continue
        width=.1*sum(np.median(samples(p,w)-(samples(p,-.52)+samples(p,.52))*.5)>6 for w in np.arange(-.4,.41,.1))
        half=np.clip(width,.28,.70)/2
        corners=[p+a*axis*length/2+b*side*half for a,b in [(-1,-1),(-1,1),(1,1),(1,-1)]]
        stripes.append((index,Polygon(corners)))
    if len(stripes)<4:return []
    groups=np.split(np.arange(len(stripes)),np.flatnonzero(np.diff([v[0] for v in stripes])>2)+1)
    group=max(groups,key=lambda inds:sum(reference+stripes[i][0]*step>=stations[0]-.3 and reference+stripes[i][0]*step<=stations[-1]+.3 for i in inds))
    return [stripes[i][1] for i in group] if len(group)>=4 else []


def survey(region_detail):
    import shapely
    candidates=[]
    for tile in region_detail['tiles'].values():
        for kind,oid,x,_,z,*_ in tile.get('p',[]):
            if kind not in ('crossing','parallel_crossing'):continue
            stripes=detect(np.array([x,z]))
            if not stripes:continue
            shape=shapely.union_all(stripes)
            distance=shape.centroid.distance(shapely.Point(x,z))
            candidates.append((distance,str(oid),shape,stripes))
    result={}
    assigned=[]
    for _,oid,shape,stripes in sorted(candidates,key=lambda r:r[0]):
        duplicate=any(shape.intersection(other).area>.42*min(shape.area,other.area) for other in assigned)
        result[oid]=[] if duplicate else [np.array(p.exterior.coords)[:-1].round(3).ravel().tolist() for p in stripes]
        if not duplicate:assigned.append(shape)
    return result
