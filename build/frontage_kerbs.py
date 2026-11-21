import math

import numpy as np
import shapely
from shapely.geometry import LineString

from kerb_islands import observed as islands
from ortho_road_paint import pigment
from parcel_surfaces import municipal_lines


def survey(site,city):
    existing=shapely.union_all([city.boundary,*[p.boundary for p,_ in islands()]]).buffer(.72)
    records=[]
    geometry=[]
    for kind in ['parking','driveway']:
        for feature in municipal_lines(kind,site):
            for part in shapely.get_parts(feature.intersection(site).difference(existing)):
                if part.geom_type!='LineString' or part.length<3.5:continue
                stations=np.linspace(0,part.length,math.ceil(part.length/1.6)+1)
                points=shapely.get_coordinates(shapely.line_interpolate_point(part,stations))
                steps=np.diff(points,axis=0)
                lengths=np.linalg.norm(steps,axis=1)
                normals=np.column_stack([steps[:,1],-steps[:,0]])/np.maximum(.02,lengths)[:,None]
                centers=(points[1:]+points[:-1])*.5
                offset=np.array([-.42,-.78,-1.18,.42,.78,1.18])
                samples=centers[:,None,:]+normals[:,None,:]*offset[None,:,None]
                native=np.median(pigment(samples.reshape(-1,2)).reshape(-1,2,3,3),axis=2)
                r,g,b=native.transpose(2,0,1)
                lum=(r+g*2+b)*.25
                hard=(lum>89)&(r-g<13)&(g-r<5)&(r-b<.14*lum+6)
                soft=((g-r>5)&(g-b>12)|(g-b>.12*lum+5)&(r-b>.18*lum+7))&(lum>46)
                rim=(pigment(centers)*[.28,.54,.18]).sum(axis=1)
                for side,inward in [(0,-1),(1,1)]:
                    other=1-side
                    valid=hard[:,side]&soft[:,other]&(lum[:,side]>lum[:,other]+16)&(rim>lum[:,other]+13)
                    runs=np.flatnonzero(np.diff(np.r_[False,valid,False])).reshape(-1,2)
                    for a,b in runs:
                        if np.sum(lengths[a:b])<3.3:continue
                        line=LineString(points[a:b+1]).simplify(.10)
                        geometry.append(line)
                        records.append([np.array(line.coords).round(2).ravel().tolist(),inward])
    kept=[]
    tree=shapely.STRtree(geometry)
    for i,line in enumerate(geometry):
        overlaps=tree.query(line,predicate='dwithin',distance=.24)
        if any(j<i and geometry[j].buffer(.24).intersection(line).length>.62*line.length for j in overlaps):continue
        kept.append(records[i])
    return kept
