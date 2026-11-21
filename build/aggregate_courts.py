import math

import cv2
import numpy as np
import shapely
from shapely.geometry import Polygon,box

import campus_region as region
from ortho_road_paint import pigment
from parcel_surfaces import block_rgb


def rectangular_pad(contour,light):
    (x,z),(width,depth),degrees=cv2.minAreaRect(contour)
    if width<6 or depth<6:return
    center=np.array([x,z])
    v=np.linspace(-.42,.42,13)
    def fit(params):
        x,z,w,h,yaw=params
        if min(w,h)<8:return -100,None
        axis=np.array([math.cos(yaw),math.sin(yaw)])
        normal=np.array([-axis[1],axis[0]])
        p=np.array([x,z])
        sides=[(p+sign*w*.5*axis,axis*sign,h*normal) for sign in [-1,1]]
        sides.extend((p+sign*h*.5*normal,normal*sign,w*axis) for sign in [-1,1])
        ring=np.array([pt+along*d for pt,out,along in sides for d in v]).reshape(4,len(v),2)
        n=np.array([out for _,out,_ in sides])[:,None]
        def read(offset):
            pos=np.rint(ring+offset*n).astype(int)
            return light[pos[:,:,1].clip(0,light.shape[0]-1),pos[:,:,0].clip(0,light.shape[1]-1)]
        edge=(read(-2)+read(-4)-read(2)-read(4))*.5
        gains=np.median(edge,axis=1)
        merit=np.mean(np.clip(gains,-20,50))*.57+np.min(gains)*.28+np.mean(edge>8)*9
        corners=np.array([p+i*axis*w*.5+j*normal*h*.5 for i,j in [(-1,-1),(1,-1),(1,1),(-1,1)]])
        return merit,(gains,np.mean(edge>7,axis=1),corners)
    params=np.array([*center,width,depth,math.radians(degrees)])
    value,details=fit(params)
    for step in [6,3,1.5,.7]:
        for index,delta in enumerate([step,step,step*2,step*2,step*.019]):
            options=[]
            for offset in [-2,-1,0,1,2]:
                q=params.copy();q[index]+=offset*delta
                estimate,record=fit(q)
                options.append((estimate,q,record))
            value,params,details=max(options,key=lambda e:e[0])
    gains,coverage,corner=details
    if np.min(gains)>9 and np.min(coverage)>.48 and value>22:return corner


def survey(site,floors):
    canopy=region.lidar('dsm')-region.lidar('dtm')
    areas=[]
    l,t,r,south=site.bounds
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(south/150)*150,150):
            if not site.intersects(box(x,z,x+150,z+150)):continue
            halo=84
            image=block_rgb(x,z,halo)
            red,green,blue=image.astype('float32').transpose(2,0,1)
            lum=(red+green*2+blue)*.25
            smoothed=cv2.GaussianBlur(lum,(0,0),2)
            var=cv2.blur((lum-smoothed)**2,(9,9))
            warm=(red-green>3)&(red-green<26)&(green-blue>11)&(green-blue<37)&(lum>132)&(var<35)
            mask=cv2.morphologyEx(np.uint8(warm),cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
            mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
            cs,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            eligible=(red-green>1)&(red-green<29)&(green-blue>9)&(green-blue<41)&(lum>118)&(var<85)
            for contour in cs:
                area=cv2.contourArea(contour)/16
                if not 19<area<1050:continue
                (_, _),(a,b),_=cv2.minAreaRect(contour)
                if min(a,b)<12 or area*16<.54*a*b:continue
                cx,cz,w,h=cv2.boundingRect(contour)
                left,top=max(0,cx-13),max(0,cz-13)
                right,bottom=min(image.shape[1],cx+w+13),min(image.shape[0],cz+h+13)
                seed=np.zeros((bottom-top,right-left),np.uint8)
                cv2.fillPoly(seed,[contour-np.array([[[left,top]]],np.int32)],1)
                domain=eligible[top:bottom,left:right]
                for _ in range(12):
                    grown=cv2.dilate(seed,None)&domain
                    seed|=grown
                ring=max(cv2.findContours(seed,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0],key=cv2.contourArea)
                contour=ring+np.array([[[left,top]]],np.int32)
                approx=cv2.approxPolyDP(contour,3.0,True).reshape(-1,2)
                if not 4<=len(approx)<=38:continue
                shape=Polygon((approx+.5-halo)*.25+[x,z]).buffer(0)
                if shape.geom_type!='Polygon':continue
                center=shape.centroid
                if not (x<=center.x<x+150 and z<=center.y<z+150 and site.covers(center)):continue
                if any(f.intersection(shape).area>shape.area*.05 for f in floors.geometries[floors.query(shape)]):continue
                seed=np.asarray(shape.exterior.coords)[:-1]
                tangents=np.roll(seed,-1,axis=0)-seed
                lengths=np.linalg.norm(tangents,axis=1)
                orientation=np.arctan2(tangents[:,1],tangents[:,0])
                rectangular=abs(np.sum(lengths*np.exp(4j*orientation)))/np.sum(lengths)
                if rectangular<.45 or shape.area/shape.minimum_rotated_rectangle.area<.78:
                    fit=rectangular_pad(np.array(np.rint((seed-[x,z])/.25+halo-.5),dtype=np.float32).reshape(-1,1,2),lum)
                    if fit is None:continue
                    seed=(fit+.5-halo)*.25+[x,z]
                    shape=Polygon(seed)
                    if any(f.intersection(shape).area>shape.area*.05 for f in floors.geometries[floors.query(shape)]):continue
                inside=shape.buffer(-.6)
                if inside.is_empty:continue
                station=np.arange(.2,shape.length,.45)
                boundary=shapely.get_coordinates(shapely.line_interpolate_point(shape.exterior,station))
                along=shapely.get_coordinates(shapely.line_interpolate_point(shape.exterior,(station+.22)%shape.length))-boundary
                normal=np.column_stack([-along[:,1],along[:,0]])/np.maximum(.001,np.linalg.norm(along,axis=1))[:,None]
                if not shape.exterior.is_ccw:normal*=-1
                front=pigment(boundary+normal*.58)
                back=pigment(boundary-normal*.82)
                light=(front-back)@np.array([.28,.54,.18])
                if np.mean(light>9)<.55 or np.median(light)<13:continue
                sample=boundary+normal*.9
                if np.mean(region.sample(canopy,*sample.T)<1.15)<.80:continue
                areas.append([3,[seed.round(2).tolist()]])
    return areas
