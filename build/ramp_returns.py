import json

import cv2
import numpy as np
import shapely
from affine import Affine
from rasterio.features import shapes
from shapely.geometry import Point,shape

from campus_region import OUT
from ortho_road_paint import pigment


def survey():
    positions=json.loads((OUT.parents[1]/'build/survey_pavement.json').read_bytes())['ramps']
    faces=[]
    step=.16
    axis=(np.arange(85)-42)*step
    dx,dz=np.meshgrid(axis,axis)
    distance=np.hypot(dx,dz)
    for x,z,tx,tz,width in positions:
        pts=np.c_[x+dx.ravel(),z+dz.ravel()]
        red,green,blue=pigment(pts).reshape(85,85,3).transpose(2,0,1)
        lum=(red+green*2+blue)*.25
        mineral=(lum>110)&(red-green<21)&(green-red<7)&(green-blue<5+.15*lum)&(red-blue<7+.21*lum)
        planted=(green-red>5)&(green-blue>13)|(red-blue>.24*lum+5)&(green-blue>.14*lum+4)
        connected=cv2.morphologyEx(np.uint8(mineral),cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))
        center=(np.abs(dx*tx+dz*tz)<width*.57)&(np.abs(dz*tx-dx*tz)<1.0)
        connected[center&~planted]=1
        inside=(connected>0)&(distance<5.9)
        components=cv2.connectedComponents(np.uint8(inside))[1]
        ids=np.unique(components[center]);ids=ids[ids>0]
        if not len(ids):continue
        mask=np.isin(components,ids).astype('uint8')
        transform=Affine.translation(x+axis[0]-step/2,z+axis[0]-step/2)*Affine.scale(step)
        for geometry,_ in shapes(mask,mask=mask>0,transform=transform):
            surface=shape(geometry).buffer(.16,quad_segs=2).buffer(-.16,quad_segs=2).simplify(.12)
            if surface.area>1:faces.append(surface)
    union=shapely.union_all(faces)
    return [[5,[np.asarray(r.coords)[:-1].round(2).tolist() for r in [poly.exterior,*poly.interiors]]] for poly in shapely.get_parts(union) if poly.geom_type=='Polygon']
