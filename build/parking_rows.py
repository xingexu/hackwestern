import math

import cv2
import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.spatial import cKDTree
from shapely.geometry import LineString

from ortho_road_paint import pigment


def align_rows(axes,lots,centered=False):
    candidates=[]
    for guide in axes:
        g=guide.simplify(.75)
        for start,end in zip(g.coords,list(g.coords)[1:]):
            a,b=np.array(start),np.array(end)
            delta=b-a
            length=np.linalg.norm(delta)
            if length<13:continue
            along=delta/length
            normal=np.array([-along[1],along[0]])
            u=np.arange(0,length,.1)
            cross=np.arange(-13,13,.1)
            points=a+u[None,:,None]*along+cross[:,None,None]*normal
            rgb=pigment(points.reshape(-1,2)).reshape(*points.shape[:2],3)
            r,gc,bl=rgb.transpose(2,0,1)
            lum=.29*r+.55*gc+.16*bl
            tint=(r+gc)*.5-bl
            paint=lum+1.9*np.clip(tint-cv2.GaussianBlur(tint,(0,0),3.),-10,30)
            edge=np.clip(paint-np.maximum(np.roll(paint,-4,1),np.roll(paint,4,1)),-18,38)
            strength=uniform_filter1d(edge,39,axis=0)
            for side in ([1] if centered else [-1,1]):
                best=None
                offsets=np.arange(-.7,.71,.2) if centered else np.arange(2.3,10.1,.3)
                for v in offsets:
                    j=round((13+v*side)*10)
                    for gap in np.arange(2.48,3.17,.045):
                        columns=np.arange(0,length-gap,gap)
                        if len(columns)<4:continue
                        phases=np.arange(0,gap,.12)
                        k=np.rint((columns[:,None]+phases[None,:])*10).astype(int)
                        profile=strength[j,np.minimum(k,len(u)-1)]
                        coverage=(profile>3.4).mean(axis=0)
                        score=np.mean(np.minimum(15,profile),axis=0)*coverage
                        c=np.argmax(score)
                        if coverage[c]<.45 or score[c]<3.0 or best is not None and score[c]<=best[0]:continue
                        best=score[c],v,columns+phases[c],profile[:,c]
                if best is None:continue
                score,v,columns,profile=best
                strong=np.flatnonzero(profile>3.4)
                for k in range(strong[0],strong[-1]+1):
                    if np.min(np.abs(strong-k))>1:continue
                    mid=a+along*columns[k]+normal*v*side
                    ends=np.array([mid-2.45*normal,mid+2.45*normal])
                    line=LineString(ends)
                    if lots.covers(line):candidates.append((score+max(profile[k],0)*.12,ends,mid,along))
    if not candidates:return []
    candidates.sort(key=lambda item:-item[0])
    tree=cKDTree([r[2] for r in candidates])
    rejected=set()
    result=[]
    for i,(_,ends,mid,along) in enumerate(candidates):
        if i in rejected:continue
        result.append(ends.ravel().round(2).tolist())
        for j in tree.query_ball_point(mid,3):
            delta=candidates[j][2]-mid
            if abs(candidates[j][3]@along)>.97 and abs(delta@along)<.6:rejected.add(j)
    return result


def vehicle_axes(lots):
    import shapely
    from ortho_road_paint import rgb_tile
    l,t,r,b=lots.bounds
    centers=[]
    axes=[]
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(b/150)*150,150):
            if not lots.intersects(shapely.box(x,z,x+150,z+150)):continue
            rgb=rgb_tile(x,z)
            gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
            surround=cv2.morphologyEx(gray,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(33,33)))
            shade=(gray<112)&(gray.astype(float)<surround.astype(float)-30)
            shade=cv2.morphologyEx(shade.astype('uint8'),cv2.MORPH_CLOSE,np.ones((4,4),np.uint8))
            contours,_=cv2.findContours(shade,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            for c in contours:
                area=cv2.contourArea(c)
                if not 260<area<1450:continue
                (u,v),(w,h),yaw=cv2.minAreaRect(c)
                if not 25<max(w,h)<64 or not 11<min(w,h)<28 or max(w,h)<1.55*min(w,h) or area<.48*w*h:continue
                mid=np.array([x+u*.1,z+v*.1])
                if not shapely.contains_xy(lots,*mid):continue
                theta=math.radians(yaw+(90 if h>w else 0))
                centers.append(mid)
                axes.append([math.cos(theta),math.sin(theta)])
    if not centers:return []
    centers=np.array(centers)
    axes=np.array(axes)
    tree=cKDTree(centers)
    strips=[]
    for i,mid in enumerate(centers):
        crowd=np.asarray(tree.query_ball_point(mid,43))
        orientations=axes[crowd]
        nearby=crowd[np.abs(orientations@axes[i])>.945]
        axis=np.median(axes[nearby]*np.sign(axes[nearby]@axes[i])[:,None],axis=0)
        axis/=np.linalg.norm(axis)
        side=np.array([-axis[1],axis[0]])
        dif=centers[nearby]-mid
        near=nearby[np.abs(dif@axis)<1.15]
        if len(near)<4:continue
        p=centers[near]
        along=(p-mid)@side
        order=np.argsort(along)
        for cluster in np.split(order,np.flatnonzero(np.diff(along[order])>10.2)+1):
            if len(cluster)<4 or i not in near[cluster]:continue
            group=p[cluster]
            avg=group.mean(0)
            _,_,vectors=np.linalg.svd(group-avg,full_matrices=False)
            direction=vectors[0]
            normal=vectors[1]
            if abs(axis@normal)<.97:continue
            stations=(group-avg)@direction
            spacing=np.arange(2.48,3.21,.02)
            freq=np.exp(2j*np.pi*stations[:,None]/spacing[None,:]).mean(axis=0)
            index=np.argmax(np.abs(freq))
            if abs(freq[index])<.81:continue
            gap=spacing[index]
            first=np.angle(freq[index])*gap/(2*np.pi)+gap/2
            ticks=first+np.arange(math.floor((stations.min()-first)/gap),math.ceil((stations.max()-first)/gap)+1)*gap
            if len(ticks)<4:continue
            start=avg+direction*ticks.min()
            end=avg+direction*ticks.max()
            strips.append((len(cluster)*abs(freq[index]),start,end))
    strips.sort(key=lambda row:-row[0])
    accepted=[]
    for _,start,end in strips:
        path=LineString([start,end])
        if any(line.buffer(1.05).intersection(path).length>.65*path.length for line in accepted):continue
        accepted.append(path)
    return accepted
