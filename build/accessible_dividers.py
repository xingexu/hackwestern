import math

import numpy as np
import shapely
from scipy.ndimage import binary_closing,uniform_filter1d
from scipy.spatial import cKDTree
from shapely.geometry import LineString

from ortho_road_paint import pigment


def register(panels,lines,lots):
    if len(panels)<2:return []
    centers=np.unique(np.round(np.asarray(panels),2),axis=0)
    index=cKDTree(centers)
    options=[]
    for i,center in enumerate(centers):
        for j in index.query_ball_point(center,7.0):
            if j<=i:continue
            delta=centers[j]-center
            gap=np.linalg.norm(delta)
            if not 2.8<gap<7:continue
            row=delta/gap
            axis=np.array([-row[1],row[0]])
            coords=np.arange(-6,6.05,.105)
            offsets=np.arange(-.56,.57,.08)
            for end in [-.5,.5,1.5]:
                midpoint=center+delta*end
                best=[]
                for angle in np.arange(-.14,.141,.035):
                    normal=math.cos(angle)*row-math.sin(angle)*axis
                    direction=math.cos(angle)*axis+math.sin(angle)*row
                    cloud=midpoint+offsets[:,None,None]*normal+coords[None,:,None]*direction
                    def fetch(shift):
                        return pigment((cloud+shift*normal).reshape(-1,2)).reshape(cloud.shape[:2]+(3,))
                    body,left,right=fetch(0),fetch(-.30),fetch(.30)
                    r,g,b=np.moveaxis((left+right)*.5,2,0)
                    stable=(np.abs(left-right).mean(axis=2)<20)&(g>105)&(g<234)&(r-b<46)&(r-b>0)&(r-g<18)
                    contrast=body-np.maximum(left,right)
                    luma=contrast@[.29,.54,.17]
                    drift=body-(left+right)*.5
                    yellow=drift@[.5,.5,-1.]
                    gain=np.clip(luma+np.maximum(0,yellow)*1.5,-18,30)
                    signed=np.where(stable,gain,-7)
                    for k,profile in enumerate(signed):
                        strong=uniform_filter1d(profile,9,mode='nearest')>4.0
                        kept=binary_closing(strong,structure=np.ones(5))
                        bounds=np.flatnonzero(np.diff(np.r_[False,kept,False])).reshape(-1,2)
                        for a,b in bounds:
                            if b-a<29 or coords[b-1]<-2.5 or coords[a]>2.5:continue
                            sl=slice(a,b)
                            if np.mean(profile[sl]>4)<.57 or np.median(profile[sl])<5.9 or stable[k,sl].mean()<.78:continue
                            line=LineString([cloud[k,a],cloud[k,b-1]])
                            if not lots.covers(line) or line.length<2.9:continue
                            color=int(np.mean((yellow[k,sl]>2)&((body[k,sl,0]+body[k,sl,1])*.5-body[k,sl,2]>14))>.40)
                            merit=np.clip(profile[sl],-5,20).mean()+line.length*.55
                            best.append((merit,line,color))
                if best:options.append(max(best,key=lambda p:p[0]))
    retained=[]
    index=shapely.STRtree(lines)
    for _,line,ink in sorted(options,key=lambda p:-p[0]):
        near=[*index.geometries[index.query(line,predicate='dwithin',distance=.25)],*[g for g,c in retained if g.distance(line)<.25]]
        if near:line=line.difference(shapely.union_all(near).buffer(.25,quad_segs=2))
        for part in shapely.get_parts(line):
            if part.geom_type=='LineString' and part.length>1.7:retained.append((part,ink))
    return [[np.asarray([g.coords[0],g.coords[-1]]).round(2).ravel().tolist(),c] for g,c in retained]
