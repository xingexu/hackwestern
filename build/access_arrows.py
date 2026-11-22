from pathlib import Path
import json

import cv2
import numpy as np
from shapely.geometry import Polygon

from parking_archive import dated_pigment


ROOT=Path(__file__).resolve().parent


def silhouette(point,year):
    step=.08
    offsets=np.arange(-1.8,1.81,step)
    u,v=np.meshgrid(offsets,offsets)
    xy=np.stack([u,v],axis=-1)+point
    rgb=dated_pigment(xy.reshape(-1,2),year).reshape(*u.shape,3)
    light=.30*rgb[:,:,0]+.55*rgb[:,:,1]+.15*rgb[:,:,2]
    opened=cv2.morphologyEx(light,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15)))
    candidates=[]
    for level in (13,17,21,25):
        ink=np.uint8((light-opened>level)&(light>120))
        ink=cv2.morphologyEx(ink,cv2.MORPH_CLOSE,np.ones((2,2),np.uint8))
        for contour in cv2.findContours(ink,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]:
            vertices=cv2.approxPolyDP(contour,1.0,True).reshape(-1,2)
            if not 5<=len(vertices)<=18:continue
            geom=Polygon(point+(vertices-.5)*step+offsets[0]).buffer(0)
            if geom.geom_type!='Polygon' or not .16<geom.area<1.7:continue
            length=geom.minimum_rotated_rectangle
            dims=np.linalg.norm(np.diff(np.asarray(length.exterior.coords),axis=0),axis=1)
            if dims.min()<.35 or dims.max()<.95 or dims.max()>2.65:continue
            c=np.array(geom.centroid.coords[0])
            dist=np.linalg.norm(c-point)
            if dist>.6 or geom.area/length.area>.83:continue
            candidates.append((dist+.10*abs(level-17)/8-.22*geom.area,geom))
    return None if not candidates else min(candidates,key=lambda c:c[0])[1]


def survey():
    observations=json.loads((ROOT/'survey_access_arrow_centers.json').read_bytes())
    out=[]
    for row in observations:
        for point in row['centers']:
            shapes=[silhouette(np.asarray(point),year) for year in row['years']]
            seen=[p for p in shapes if p is not None]
            if len(seen)<2:continue
            score=lambda p:sum(p.intersection(q).area/p.union(q).area for q in seen)
            best=max(seen,key=score)
            if score(best)<1.55:continue
            out.append(np.asarray(best.exterior.coords)[:-1].round(2).ravel().tolist())
    return out


if __name__=='__main__':
    result=survey()
    (ROOT/'survey_access_arrows.json').write_text(json.dumps(result,separators=(',',':')))
    print(len(result),'directional arrows registered across municipal aerials.')
