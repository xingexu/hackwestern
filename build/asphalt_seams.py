import json
import math

import cv2
import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import LineString,box

import campus_region as region
from campus_bounds import footprint
from ortho_road_paint import rgb_tile
from street_projection import Survey

OUT=region.OUT.parents[1]/'build/survey_seams.json'


def survey():
    cv2.setNumThreads(1)
    streets=Survey()
    site=footprint()
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    major=[LineString([(x,z) for x,_,z in w['points']]).buffer(w['width']*.47,cap_style='flat') for w in net['ways'] if w['kind']=='road' and not w['bridge'] and w['class'] not in ('service','track')]
    domain=shapely.union_all(major).intersection(site)
    canopy=region.lidar('dsm')-region.lidar('dtm')
    records=[]
    l,t,r,bottom=site.bounds
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(bottom/150)*150,150):
            window=domain.intersection(box(x,z,x+150,z+150))
            if window.is_empty:continue
            mask=rasterize([window],out_shape=(1500,1500),transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')
            image=rgb_tile(x,z)
            gray=cv2.cvtColor(image,cv2.COLOR_RGB2GRAY)
            closed=cv2.morphologyEx(gray,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(11,11)))
            dark=(closed.astype(float)-gray>10)&(gray>58)&(mask>0)
            lines=cv2.HoughLinesP(np.uint8(dark),1,math.pi/360,20,minLineLength=22,maxLineGap=4)
            candidates=[]
            for ax,az,bx,bz in [] if lines is None else lines[:,0]:
                a=np.array([ax,az])
                step=np.array([bx-ax,bz-az])
                length=np.linalg.norm(step)
                if not 24<length<210:continue
                axis=step/length
                normal=np.array([-axis[1],axis[0]])
                origin=np.linspace(a,a+step,max(15,int(length*.64)))
                def rgb(offset):
                    u,v=np.rint(origin+offset*normal).astype(int).T
                    return image[v.clip(0,1499),u.clip(0,1499)].astype('float32')
                sides=np.stack([rgb(-3.2),rgb(3.2)])
                surround=sides.mean(axis=0)
                lum=surround@np.array([.28,.54,.18])
                contrast=lum-rgb(0)@np.array([.28,.54,.18])
                if not 8<np.median(contrast)<36 or np.mean((contrast>6)&(lum>84))<.77:continue
                if np.median(np.abs(sides[0]-sides[1]))>10 or np.median(np.abs(surround[:,0]-surround[:,1]))>10:continue
                if np.ptp(np.percentile(lum,[15,85]))>24:continue
                thin=lum-(rgb(-1.7)+rgb(1.7))@np.array([.14,.27,.09])
                if np.mean(thin>contrast*.65)>.4:continue
                coords=np.array([a,a+step])*.1+[x+.05,z+.05]
                probes=origin[::3]*.1+[x+.05,z+.05]
                if (streets.classes(*probes.T)!=1).any() or np.max(region.sample(canopy,*probes.T))>1.2:continue
                candidates.append((float(np.median(contrast)),LineString(coords)))
            selected=[]
            for amplitude,line in sorted(candidates,key=lambda e:-e[0]):
                if any(line.hausdorff_distance(other)<.9 or other.buffer(.32).intersection(line).length>line.length*.59 for other in selected):continue
                selected.append(line)
                records.append([np.asarray(line.coords).round(2).ravel().tolist(),round(amplitude,1)])
    return records


if __name__=='__main__':
    rows=survey()
    OUT.write_text(json.dumps(rows,separators=(',',':')))
    print(len(rows),'sealed joints and narrow asphalt repairs.')
