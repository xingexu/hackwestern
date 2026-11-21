import json
import math

import cv2
import numpy as np
import shapely
from rasterio import Affine
from rasterio.features import rasterize
from shapely.geometry import Polygon,box

import campus_region as region
from campus_bounds import footprint
from ortho_road_paint import rgb_tile
from parking_stripes import lot_mask


def silhouettes(points):
    pts=np.asarray(points,np.float32).reshape(-1,2)
    center=pts.mean(axis=0)
    axis=np.linalg.svd(pts-center,full_matrices=False)[2][0]
    basis=np.stack([axis,[-axis[1],axis[0]]])
    uv=(pts-center)@basis.T
    w,h=np.ptp(uv,axis=0)
    if min(w,h)<.01:return None
    uv=(uv-uv.min(axis=0))/[w,h]
    mask=np.zeros((36,52),np.uint8)
    cv2.fillPoly(mask,[np.rint(uv*[47,31]+2).astype('int32')],1)
    return mask


def survey():
    import city_streets
    site=footprint()
    city=shapely.union_all([Polygon(np.reshape(p,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for p,*holes in city_streets.survey()])
    lots=lot_mask()
    domain=city.union(lots).intersection(site).buffer(-.29)
    data=json.loads((region.OUT.parents[1]/'build/survey_pavement.json').read_bytes())
    previous=[Polygon(np.reshape(p,(-1,2))) for p in data['arrows']]
    templates=[]
    for p in previous:
        img=silhouettes(p.exterior.coords[:-1])
        if img is not None:templates.extend([img,np.flip(img,axis=0),np.flip(img,axis=1),np.flip(img,axis=(0,1))])
    templates=np.array(templates)
    candidates=[]
    l,t,r,b=domain.bounds
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(b/150)*150,150):
            geom=domain.intersection(box(x,z,x+150,z+150))
            if geom.is_empty:continue
            mask=rasterize([geom],out_shape=(1500,1500),transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')
            rgb=rgb_tile(x,z).astype('float32')
            lum=(rgb[:,:,0]+2*rgb[:,:,1]+rgb[:,:,2])*.25
            gold=(rgb[:,:,0]+rgb[:,:,1])*.5-rgb[:,:,2]
            tint=gold-cv2.GaussianBlur(gold,(0,0),6)
            opened=cv2.morphologyEx(lum,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(19,19)))
            gain=lum-opened+np.clip(tint,0,13)*1.1
            for threshold in (8,14,21):
                ink=np.uint8((gain>threshold)&(mask>0)&(lum>124))
                ink=cv2.morphologyEx(ink,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(3,3)))
                for c in cv2.findContours(ink,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]:
                    (u,v),(w,h),a=cv2.minAreaRect(c)
                    span,depth=max(w,h)*.1,min(w,h)*.1
                    if not 2.25<span<6.7 or not .72<depth<2.7:continue
                    if not .22<cv2.contourArea(c)/(w*h)<.79 or not 1.45<span/depth<5.8:continue
                    points=cv2.approxPolyDP(c,1.1,True).reshape(-1,2)
                    if not 6<=len(points)<=24:continue
                    img=silhouettes(points)
                    if img is None:continue
                    score=np.max(np.sum(templates&img,axis=(1,2))/np.sum(templates|img,axis=(1,2)))
                    if score<.775:continue
                    uu,vv,ww,hh=cv2.boundingRect(c)
                    l0,t0=max(0,uu-8),max(0,vv-8);rr,bb=min(rgb.shape[1],uu+ww+8),min(rgb.shape[0],vv+hh+8)
                    local=np.zeros((bb-t0,rr-l0),np.uint8)
                    cv2.drawContours(local,[c-[l0,t0]],-1,1,-1)
                    ring=cv2.dilate(local,np.ones((11,11),np.uint8))-cv2.dilate(local,np.ones((5,5),np.uint8))
                    area=lum[t0:bb,l0:rr];body=area[local>0];around=area[ring>0]
                    if len(around)<28 or np.percentile(around,13)<105 or np.ptp(np.percentile(around,[13,87]))>23:continue
                    if np.percentile(body,35)-np.median(around)<12 or np.ptp(np.percentile(body,[12,88]))>42:continue
                    if score<.80 and np.median(body)-np.median(around)<23:continue
                    hue=tint[t0:bb,l0:rr][local>0]
                    goldpaint=np.median(hue)>3.8 and np.median(gold[t0:bb,l0:rr][local>0])>16
                    shape=Polygon((points+.5)*.1+[x,z]).buffer(0)
                    if shape.geom_type!='Polygon' or not geom.covers(shape):continue
                    candidates.append((score+np.median(body-around.mean())*.0005,shape,int(goldpaint),int(lots.covers(shape))))
    registry=[]
    for _,p,c,park in sorted(candidates,key=lambda value:-value[0]):
        if any(p.distance(q)<.60 for q in previous):continue
        registry.append([np.asarray(p.exterior.coords)[:-1].round(2).ravel().tolist(),c,park])
        previous.append(p)
    return registry


if __name__=='__main__':
    arrows=survey()
    out=region.OUT.parents[1]/'build/survey_traffic_arrows.json'
    out.write_text(json.dumps(arrows,separators=(',',':')))
    print(len(arrows),'photographed supplementary road and parking arrows.')
