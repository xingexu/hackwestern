import json

import cv2
import numpy as np
import shapely
from shapely.geometry import Polygon

import campus_region as region
from ortho_road_paint import pigment


def paint_faces(mask,transform,min_area=.07):
    contours,parents=cv2.findContours(np.uint8(mask),cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    faces=[]
    if parents is None:return faces
    def ring(contour):
        pts=cv2.approxPolyDP(contour,.74,True).reshape(-1,2)
        return transform(pts) if len(pts)>=3 else []
    for k,shape in enumerate(contours):
        if parents[0,k,3]>=0 or cv2.contourArea(shape)*.01<min_area:continue
        shell=ring(shape)
        if len(shell)<3:continue
        holes=[]
        j=parents[0,k,2]
        while j!=-1:
            q=ring(contours[j])
            if len(q)>=3:holes.append(q)
            j=parents[0,j,0]
        piece=Polygon(shell,holes).buffer(.035,quad_segs=1,join_style='mitre').simplify(.045)
        triangles=shapely.get_parts(shapely.constrained_delaunay_triangles(piece))
        if len(triangles):faces.extend(shapely.get_coordinates(triangles).reshape(-1,4,2)[:,:3].round(3).tolist())
    return faces


def surveyed_gridiron():
    network=json.loads(region.OUT.with_name('region-detail.json').read_bytes())
    result={}
    for kind,oid,x,y,z,yaw,width,length,*_ in network['macro']:
        if kind!='canadian_football':continue
        across=np.array([np.cos(yaw),-np.sin(yaw)])
        along=np.array([np.sin(yaw),np.cos(yaw)])
        origin=np.array([x,z])
        nw=np.ceil(width*5+45);nh=np.ceil(length*5+48)
        us=(np.arange(int(nw)*2)+.5-nw)*.1
        ts=(np.arange(int(nh)*2)+.5-nh)*.1
        u,t=np.meshgrid(us,ts)
        def world(uv):return origin+uv[:,:1]*across+uv[:,1:]*along
        def uv(pts):return (pts+.5-[nw,nh])*.1
        def mapped(pts):return world(uv(pts))
        rgb=pigment(world(np.stack([u,t],axis=-1).reshape(-1,2))).reshape(*t.shape,3)
        r,g,b=rgb.transpose(2,0,1)
        purple=(r-g>14)&(b-g>2)&(g<159)
        ends=[];limits=[]
        for sign in [-1,1]:
            target=(sign*t>length*.32)&(sign*t<length*.505)&(np.abs(u)<width*.51)&purple
            shapes=cv2.findContours(target.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]
            if not shapes:break
            outline=max(shapes,key=cv2.contourArea)
            geom=Polygon(uv(cv2.approxPolyDP(cv2.convexHull(outline),1.8,True).reshape(-1,2))).buffer(.04,join_style='mitre')
            if geom.area<width*length*.07:break
            if geom.area>width*length*.20:break
            limit=sign*min(sign*v[1] for v in geom.exterior.coords)
            expand=geom.buffer(.66,quad_segs=2,join_style='mitre')
            def ring(poly):return world(np.asarray(poly.exterior.coords)[:-1]).round(3).tolist()
            ends.append(dict(fill=ring(geom),rim=ring(expand)));limits.append(limit)
        if len(ends)!=2:continue
        color=(np.minimum(r,g)>156)&(r-b<34)&(r-g<22)
        midfield=(np.abs(t)<length*.07)&(np.abs(u)<width*.15)
        seed=cv2.morphologyEx(np.uint8(midfield&purple),cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))
        candidates=cv2.findContours(seed,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]
        if not candidates:continue
        components=[shape for shape in candidates if cv2.contourArea(shape)>46]
        if not components:continue
        envelope=cv2.convexHull(np.concatenate(components))
        hull=np.zeros_like(seed);cv2.drawContours(hull,[envelope],-1,1,-1)
        near=cv2.dilate(hull,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))!=0
        art=(near&midfield)&((r>g+4)|(color&(r>=g-1)))
        art=cv2.morphologyEx(art.astype(np.uint8),cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        numbers=np.zeros_like(art)
        goal0,goal1=limits;yard=(goal1-goal0)/110
        for n in range(10,110,10):
            station=goal0+n*yard
            for sign in [-1,1]:
                window=(np.abs(t-station)<2.5)&(np.abs(sign*u-width*.29)<2.6)
                indices=np.flatnonzero((window&color).sum(axis=1)>38)
                sample=window&color
                for index in indices:sample[max(0,index-1):index+2]=False
                numbers[sample]=1
        width_samples=[]
        for sign in [-1,1]:
            band=(sign*u>width*.43)&(sign*u<width*.51)&(np.abs(t)<length*.32)&color
            coverage=band.sum(axis=0)
            width_samples.append(us[int(np.argmax(coverage))])
        sides=sorted(width_samples)
        from gridiron_overlays import markings
        ticks,soccer=markings(rgb,us,ts,limits,sides)
        result[str(oid)]=dict(ticks=ticks,soccer=soccer,ends=ends,goals=np.round(limits,3).tolist(),sides=np.round(sides,3).tolist(),crest=paint_faces(art,mapped,.13),light=paint_faces(art.astype(bool)&color,mapped,.055),numbers=paint_faces(numbers,mapped,.035))
    return result
