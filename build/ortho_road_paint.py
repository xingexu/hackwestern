import json
import math
from collections import Counter
from functools import lru_cache

import cv2
import numpy as np
import shapely
from affine import Affine
from PIL import Image
from rasterio.features import rasterize
from scipy.spatial import cKDTree
from shapely import affinity
from shapely.geometry import LineString,Polygon,box

import campus_region as region
from campus_bounds import footprint
from city_streets import mapped_network
from ground_observations import survey_tile_path


OUT=region.OUT.parents[1]/'build/survey_road_paint.json'


@lru_cache(maxsize=10)
def rgb_tile(x,z):
    with Image.open(survey_tile_path(x,z)) as img:
        return np.asarray(img.convert('RGB'))


def pigment(points):
    px,pz=np.floor(points[:,0]/150).astype(int)*150,np.floor(points[:,1]/150).astype(int)*150
    colors=np.zeros((len(points),3),np.float32)
    for x,z in set(zip(px,pz)):
        keep=(px==x)&(pz==z)
        a,b=np.floor((points[keep]-[x,z])*10).astype(int).T
        colors[keep]=rgb_tile(x,z)[b.clip(0,1499),a.clip(0,1499)]
    return colors


def stripe_samples(a,b):
    axis=b-a
    axis/=np.linalg.norm(axis)
    n=np.array([-axis[1],axis[0]])
    p=np.linspace(a,b,max(12,round(np.linalg.norm(b-a)*6)))
    center=pigment(p)
    side=(pigment(p+n*.34)+pigment(p-n*.34))*.5
    contrast=(center-side)@np.array([.30,.52,.18])
    chroma=(center[:,0]+center[:,1])*.5-center[:,2]
    base=(side[:,0]+side[:,1])*.5-side[:,2]
    return contrast,chroma-base,chroma


def detect():
    cv2.setNumThreads(1)
    site=footprint()
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    ways=[LineString([(x,z) for x,_,z in w['points']]).buffer(w['width']*.64,cap_style='flat')
          for w in net['ways'] if w['kind']=='road' and not w['bridge'] and w['class'] not in ('service','living_street')]
    corridor=shapely.union_all(ways).intersection(site)
    surfaces,_=mapped_network(net,registered_crossings=False)
    roads=shapely.union_all([Polygon(np.reshape(shell,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for shell,*holes in surfaces]).buffer(-.68)
    domain=roads.intersection(corridor)
    l,t,r,b=domain.bounds
    candidates=[]
    for iz in range(math.floor(t/150),math.ceil(b/150)):
        for ix in range(math.floor(l/150),math.ceil(r/150)):
            x,z=ix*150,iz*150
            local=domain.intersection(box(x,z,x+150,z+150))
            if local.area<2:continue
            mask=rasterize([(local,1)],out_shape=(1500,1500),transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')
            red,green,blue=rgb_tile(x,z).astype(np.float32).transpose(2,0,1)
            lum=.29*red+.55*green+.16*blue
            chroma=(red+green)*.5-blue
            base=cv2.morphologyEx(lum,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(13,13)))
            yellow=chroma-cv2.GaussianBlur(chroma,(0,0),3.)
            score=lum-base+1.4*np.maximum(0,yellow)
            ink=((score>11)&(lum>112)&(mask!=0)).astype('uint8')*255
            ink=cv2.morphologyEx(ink,cv2.MORPH_CLOSE,np.ones((2,2),np.uint8),anchor=(0,0))
            contours,_=cv2.findContours(ink,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            for contour in contours:
                area=cv2.contourArea(contour)
                if area<9:continue
                (u,v),(w,h),yaw=cv2.minAreaRect(contour)
                width,length=min(w,h)*.1,max(w,h)*.1
                if not .85<length<38 or width>3 or length<width*1.5:continue
                rect=cv2.boxPoints(((u,v),(w,h),yaw))
                axis=(rect[1]-rect[0] if np.linalg.norm(rect[1]-rect[0])>np.linalg.norm(rect[2]-rect[1]) else rect[2]-rect[1]).astype(float)
                axis/=np.linalg.norm(axis)
                center=np.array([x+.15+u*.1,z+.15+v*.1])
                a,b=center-axis*(length*.43),center+axis*(length*.43)
                contrast,tint,chroma_=stripe_samples(a,b)
                yellow_ink=np.mean((tint>5)&(chroma_>21))>.48
                solid=area/max(w*h,1)
                kind=None
                if width<=.42 and length>1.15 and solid>.41 and np.mean(contrast+np.maximum(0,tint)>8)>.64:
                    kind='line'
                elif .24<width<.91 and 1.1<length<20 and solid>.69:
                    kind='bar'
                elif .7<width<2.9 and 2.1<length<8 and .22<solid<.66:
                    hull=cv2.convexHull(contour,returnPoints=False)
                    if len(hull)<4 or not (np.all(np.diff(hull.ravel())>0) or np.all(np.diff(hull.ravel())<0)):continue
                    defects=cv2.convexityDefects(contour,hull)
                    if defects is not None and np.sum(defects.reshape(-1,4)[:,3]>3.4*256)>=2:
                        kind='symbol'
                if not kind:continue
                ring=cv2.approxPolyDP(contour,.73,True).reshape(-1,2)
                if len(ring)<3:continue
                geom=Polygon(ring*.1+[x+.15,z+.15]).buffer(0)
                if geom.geom_type!='Polygon' or not domain.covers(geom):continue
                uu,vv,ww,hh=cv2.boundingRect(contour)
                left,top=max(0,uu-12),max(0,vv-12)
                right,bottom=min(1500,uu+ww+12),min(1500,vv+hh+12)
                stamp=np.zeros((bottom-top,right-left),np.uint8)
                cv2.drawContours(stamp,[(contour-[left,top]).astype(np.int32)],-1,1,-1)
                outside=(cv2.dilate(stamp,np.ones((15,15),np.uint8))>0)&(cv2.dilate(stamp,np.ones((5,5),np.uint8))==0)
                around=lum[top:bottom,left:right][outside]
                center_lum=lum[top:bottom,left:right][stamp>0]
                if len(around)<7 or np.percentile(around,15)<118 or np.percentile(around,85)-np.percentile(around,15)>20:continue
                if np.percentile(center_lum,35)<np.median(around)+(6 if yellow_ink else 9):continue
                candidates.append((center,axis,length,width,kind,yellow_ink,geom,contrast.mean()))
    centers=np.array([r[0] for r in candidates])
    tree=cKDTree(centers)
    result=[]
    for i,(center,axis,length,width,kind,yellow,geom,contrast) in enumerate(candidates):
        ids=tree.query_ball_point(center,11)
        siblings=[j for j in ids if j!=i and candidates[j][4]==kind and abs(axis@candidates[j][1])>.966]
        repeats=any(abs(axis@(centers[j]-center))<1 and .48<np.linalg.norm(centers[j]-center)<2.2 for j in siblings)
        if kind=='symbol':
            if not any(candidates[j][4]=='line' and candidates[j][2]>2 for j in ids):continue
        elif kind=='bar':
            if not repeats and not (length>2.4 and width<.73 and contrast>20):continue
        elif length<2.6 and not (repeats or len(siblings)>1):continue
        ring=np.asarray(geom.exterior.coords)[:-1].round(2).ravel().tolist()
        result.append([kind,2 if yellow else 1,ring])
    return result


def survey_center(guide):
    if guide.length<9:return None
    station=np.linspace(0,guide.length,max(5,math.ceil(guide.length/1.25)))
    p=np.array([guide.interpolate(d).coords[0] for d in station])
    d=np.gradient(p,axis=0)
    n=np.column_stack([-d[:,1],d[:,0]])/np.maximum(.001,np.linalg.norm(d,axis=1))[:,None]
    offsets=np.arange(-2.8,2.81,.1)
    points=p[:,None,:]+offsets[None,:,None]*n[:,None,:]
    rgb=pigment(points.reshape(-1,2)).reshape(*points.shape[:2],3)
    lum=rgb@np.array([.29,.55,.16],np.float32)
    tint=(rgb[:,:,0]+rgb[:,:,1])*.5-rgb[:,:,2]
    glow=np.clip(lum-np.maximum(np.roll(lum,-4,1),np.roll(lum,4,1)),-10,30)
    color=np.clip(tint-(np.roll(tint,-4,1)+np.roll(tint,4,1))*.5,-8,24)
    signal=np.clip(glow+color*1.6,0,36)*(tint>14)*(lum>98)
    signal[:,[0,1,2,3,-1,-2,-3,-4]]=0
    scores=signal[0]-.7*np.abs(offsets)
    back=[]
    transitions=np.minimum(36,12*np.abs(offsets[:,None]-offsets[None,:]))
    for row in signal[1:]:
        scores=scores[:,None]-transitions
        back.append(scores.argmax(axis=0))
        scores=row+scores.max(axis=0)-.7*np.abs(offsets)
    path=[scores.argmax()]
    for parents in reversed(back):path.append(parents[path[-1]])
    k=np.array(path[::-1]);rr=np.arange(len(k))
    confirmed=(signal[rr,k]>12)&(color[rr,k]>2)
    if confirmed.sum()<5 or confirmed.mean()<.27:return None
    from scipy.ndimage import gaussian_filter1d,median_filter
    index=np.arange(len(k))
    shift=np.interp(index,index[confirmed],offsets[k[confirmed]])
    shift=gaussian_filter1d(median_filter(shift,5),1.1)
    line=p+n*shift[:,None]
    marks=[np.asarray(LineString(line).simplify(.09).coords).round(2).ravel().tolist()]
    for direction in [1,-1]:
        sides=(k[:,None]+direction*np.arange(2,6)).clip(0,len(offsets)-1)
        j=sides[rr,signal[rr[:,None],sides].argmax(1)]
        dual=(signal[rr,j]>10)&(color[rr,j]>2)&confirmed
        support=np.convolve(dual.astype(float),np.ones(7)/7,mode='same')[:len(line)]>.62
        boundaries=np.flatnonzero(np.diff(np.r_[False,support,False]))
        for a,b in boundaries.reshape(-1,2):
            if b-a<6:continue
            spacing=np.median(offsets[j[a:b]]-offsets[k[a:b]])
            extra=line[a:b]+n[a:b]*spacing
            marks.append(np.asarray(LineString(extra).simplify(.09).coords).round(2).ravel().tolist())
    return marks


def match_control(key,marks):
    form=shapely.union_all(marks)
    x,z=form.centroid.coords[0]
    radius=math.ceil(max(math.hypot(a-x,b-z) for mark in marks for a,b in mark.exterior.coords))+1
    k=radius*10
    t=np.arange(-k-45,k+46)*.1
    xx,zz=np.meshgrid(x+t,z+t)
    rgb=pigment(np.stack([xx,zz],axis=-1).reshape(-1,2)).reshape(*xx.shape,3)
    lum=rgb@np.array([.29,.55,.16],dtype=np.float32)
    high=cv2.morphologyEx(lum,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(13,13)))
    signal=np.clip(lum-high,0,32)
    best=None
    for yaw in range(-30,31,5):
        stamp=np.zeros((2*k+1,2*k+1),np.uint8)
        for g in marks:
            pts=np.asarray(affinity.rotate(g,yaw,origin=(x,z)).exterior.coords)
            cv2.fillPoly(stamp,[np.rint((pts-[x,z])*10+k).astype(np.int32)],1)
        outside=cv2.dilate(stamp,np.ones((9,9),np.uint8))-stamp
        kernel=stamp.astype(np.float32)/max(stamp.sum(),1)-outside.astype(np.float32)/max(outside.sum(),1)
        raw=cv2.matchTemplate(signal,kernel.astype(np.float32),cv2.TM_CCORR)
        uu,vv=np.meshgrid(np.arange(91)-45,np.arange(91)-45)
        ranked=raw-.015*np.hypot(uu,vv)-.014*abs(yaw)
        j,i=np.unravel_index(ranked.argmax(),ranked.shape)
        if best is None or ranked[j,i]>best[0]:best=(ranked[j,i],i,j,yaw,stamp)
    score,i,j,yaw,stamp=best
    values=signal[j:j+2*k+1,i:i+2*k+1][stamp!=0]
    if score>4.0 and np.mean(values>7)>.54:
        return [round((i-45)*.1,2),round((j-45)*.1,2),yaw]
    center=lum[45:45+2*k+1,45:45+2*k+1][stamp!=0]
    if len(marks)>1 and np.mean(center>115)>.86 and score<2.9:return []
    return None


if __name__=='__main__':
    from street_finishes import source_layers,coverage
    load=lambda name:json.loads(region.OUT.with_name(name+'.json').read_bytes())
    controls={}
    centers={}
    def center(key,line):
        geometry=survey_center(line)
        if geometry:centers[key]=geometry
        return [line]
    def record(key,shapes):
        result=match_control(key,shapes)
        if result is not None:controls[key]=result
        return shapes
    source_layers(load('drive-network'),load('municipal-detail'),load('region-detail'),load('street-detail'),coverage(load('surface-tiles')['carriageway']),record,center)
    from zebra_crossings import survey
    marks=detect()
    crossings=survey(load('region-detail'))
    OUT.write_text(json.dumps(dict(controls=controls,centers=centers,marks=marks,crosswalks=crossings),separators=(',',':')))
    print(len(controls),'photo-registered control layouts',Counter((kind,ink) for kind,ink,_ in marks))
