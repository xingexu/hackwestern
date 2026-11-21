import math

import cv2
import numpy as np
import shapely
from rasterio import Affine
from rasterio.features import rasterize
from scipy.spatial import cKDTree
from shapely.geometry import LineString,box

from ortho_road_paint import rgb_tile
from parking_stripes import lot_mask


def painted_zones(rgb,allowed,threshold):
    r,g,b=rgb.astype(np.float32).transpose(2,0,1)
    lum=(r+g*2+b)*.25
    gold=(r+g)*.5-b
    tint=gold-cv2.GaussianBlur(gold,(0,0),3)
    medium=cv2.morphologyEx(lum,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))
    neutral=(r-g<18)&(g>105)&(b>79)
    gain=lum-medium+np.clip(tint,-8,20)*1.5
    ink=(gain>threshold)&neutral&(allowed!=0)
    closed=cv2.morphologyEx(np.uint8(ink),cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    spans,tree=cv2.findContours(closed,cv2.RETR_TREE,cv2.CHAIN_APPROX_SIMPLE)
    if tree is None:return []
    holes=[]
    neighbors=[]
    for k,h in enumerate(spans):
        if tree[0,k,3]<0:continue
        (cx,cz),(w,d),angle=cv2.minAreaRect(h)
        area=cv2.contourArea(h)
        if 2.2<min(w,d)<19 and 5<max(w,d)<65 and 8<area<520:neighbors.append((h,np.array([cx,cz]),min(w,d),max(w,d)))
        if not (4.2<min(w,d)<16 and 9<max(w,d)<60 and .48*w*d<area<425):continue
        theta=math.radians(angle+(90 if d>w else 0))
        holes.append((h,np.array([cx,cz]),np.array([math.cos(theta),math.sin(theta)]),max(w,d),min(w,d)))
    if not holes:return []
    points=np.asarray([h[1] for h in holes])
    tree=cKDTree(points)
    clusters=[]
    for i,(h,p,axis,length,width) in enumerate(holes):
        n=np.array([-axis[1],axis[0]])
        near=[j for j in tree.query_ball_point(p,51) if abs(axis@holes[j][2])>.93 and abs((points[j]-p)@axis)<.60*(length+holes[j][3]) and .53<holes[j][4]/width<1.75]
        if len(near)<3:continue
        order=sorted(near,key=lambda j:points[j]@n)
        pos=order.index(i)
        along=points[order]@n
        target=width+1
        gaps=np.diff(along)
        lo=pos
        while lo and .60*target<gaps[lo-1]<1.55*target:lo-=1
        hi=pos
        while hi<len(order)-1 and .60*target<gaps[hi]<1.55*target:hi+=1
        if hi-lo<2:continue
        group=set(order[lo:hi+1])
        for found in clusters[:]:
            if len(group&found)>=2:group.update(found);clusters.remove(found)
        clusters.append(group)
    result=[]
    for group in clusters:
        cells=[holes[j][0] for j in group]
        sample=np.asarray([holes[j][1] for j in group])
        origin=sample.mean(axis=0)
        row=np.linalg.svd(sample-origin,full_matrices=False)[2][0]
        along=(sample-origin)@row
        order=np.argsort(along)
        pitch=np.median(np.diff(along[order]))
        if not 4.5<pitch<25:continue
        side=np.array([-row[1],row[0]])
        breadth=np.median([holes[j][3] for j in group])
        for sign,base in [(-1,sample[order[0]]),(1,sample[order[-1]])]:
            for step in range(8):
                candidates=[]
                for h,pt,w,hgt in neighbors:
                    advance=(pt-base)@row*sign
                    cross=abs((pt-base)@side)
                    if .43*pitch<advance<1.65*pitch and cross<max(4.2,breadth*.25) and w<1.5*pitch:
                        candidates.append((abs(advance-pitch)+cross*.8,h,pt))
                if not candidates:break
                _,cell,base=min(candidates,key=lambda option:option[0])
                cells.append(cell)
        points=np.concatenate(cells)
        u,v,w,d=cv2.boundingRect(points)
        u=max(0,u-4);v=max(0,v-4);w=min(w+8,rgb.shape[1]-u);d=min(d+8,rgb.shape[0]-v)
        origin=np.asarray([[[u,v]]],np.int32)
        faces=np.zeros((d,w),np.uint8)
        cv2.fillPoly(faces,[c-origin for c in cells],1)
        kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5))
        support=cv2.dilate(faces,kernel)>0
        raw=support&ink[v:v+d,u:u+w]
        if raw.sum()<25:continue
        hues=gold[v:v+d,u:u+w];drift=tint[v:v+d,u:u+w]
        if np.median(hues[raw])<13 or np.median(drift[raw])<.85:continue
        strokes=[]
        for cell in cells:
            pts=cv2.approxPolyDP(cell,1.1,True).reshape(-1,2).astype(float)
            if len(pts)<3:continue
            if cv2.contourArea(pts.astype('float32'),oriented=True)<0:pts=pts[::-1]
            for a,end in zip(pts,np.roll(pts,-1,axis=0)):
                vector=end-a;length=np.linalg.norm(vector)
                if length<2.5:continue
                direction=vector/length
                normal=np.array([direction[1],-direction[0]])
                body=a+np.linspace(.12,.88,max(4,round(length*.7)))[:,None]*vector
                offsets=np.arange(-1.0,4.26,.25)
                probes=body[None,:,:]+offsets[:,None,None]*normal
                coords=np.rint(probes).astype(int)
                values=gain[coords[:,:,1].clip(0,rgb.shape[0]-1),coords[:,:,0].clip(0,rgb.shape[1]-1)]
                merit=np.median(np.clip(values,-8,40),axis=1)
                peak=int(np.argmax(merit))
                if merit[peak]<10 or np.mean(values[peak]>8)<.68:continue
                sides=probes[peak][None,:,:]+np.array([-3,3])[:,None,None]*normal
                xx,yy=np.rint(sides).astype(int).transpose(2,0,1)
                flank=rgb[yy.clip(0,rgb.shape[0]-1),xx.clip(0,rgb.shape[1]-1)].astype(float)
                red,green,blue=flank.transpose(2,0,1)
                exposed=(green>111)&(green<231)&(red>blue+4)&(red-green<19)&(np.ptp(flank,axis=2)<46)
                if np.mean(exposed.all(axis=0))<.68 or np.median(np.abs(flank[0]-flank[1]))>13:continue
                shift=normal*offsets[peak]+.5
                strokes.append(LineString([a+shift-direction*.42,end+shift+direction*.42]).buffer(.61,quad_segs=2))
        if strokes:
            result.extend(shapely.get_parts(shapely.union_all(strokes).simplify(.23)))
    return result


def survey():
    lots=lot_mask()
    l,t,r,b=lots.bounds
    masks=[]
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(b/150)*150,150):
            site=lots.intersection(box(x,z,x+150,z+150))
            if site.is_empty:continue
            native=rgb_tile(x,z)
            allowed=rasterize([site],out_shape=native.shape[:2],transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')
            passes=[p for threshold in [7,12,17] for p in painted_zones(native,allowed,threshold)]
            combined=shapely.union_all(passes).simplify(.28)
            for p in shapely.get_parts(combined):
                if p.geom_type!='Polygon':continue
                rings=[(np.asarray(r.coords)[:-1]*.1+[x,z]).round(2).tolist() for r in [p.exterior,*p.interiors]]
                masks.append(rings)
    return masks
