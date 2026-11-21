import math

import numpy as np
from shapely.geometry import Polygon


def curved_edges(loop):
    coords=np.array(loop,float)
    n=len(coords)
    bulges=[0.0]*n
    for j in range(n):
        p,a,b,c=coords[[(j-1)%n,j,(j+1)%n,(j+2)%n]]
        v,w,u=a-p,b-a,c-b
        lengths=np.linalg.norm([v,w,u],axis=1)
        if min(lengths)<1.2 or max(lengths)>28 or max(lengths)>3.4*min(lengths):
            continue
        a0,a1,a2=[math.atan2(s[1],s[0]) for s in [v,w,u]]
        turn0,turn1=(np.array([a1-a0,a2-a1])+math.pi)%(2*math.pi)-math.pi
        if turn0*turn1<=0 or max(abs(turn0),abs(turn1))>math.radians(41) or min(abs(turn0),abs(turn1))<math.radians(4):
            continue
        sag=float(lengths[1]*math.tan((turn0+turn1)*.125)*.5)
        if abs(sag)>.025:
            bulges[j]=round(sag,4)
    return bulges


def curved_outline(loops,curves):
    rings=[]
    for loop,bulges in zip(loops,curves):
        ring=[]
        for i,a in enumerate(loop):
            ring.append(a)
            if not bulges[i]:continue
            x,z=a
            b,c=loop[(i+1)%len(loop)]
            dx,dz=b-x,c-z
            length=math.hypot(dx,dz)
            for k in (.25,.5,.75):
                h=4*k*(1-k)*bulges[i]/length
                ring.append([x+k*dx+h*dz,z+k*dz-h*dx])
        rings.append(ring)
    return Polygon(rings[0],rings[1:])


def measured_roof(polygon,x,z,height):
    if len(height)<24 or np.percentile(height,85)-np.percentile(height,15)<.74:
        return None
    rectangle=np.array(polygon.minimum_rotated_rectangle.exterior.coords)[:4]
    if polygon.area<.62*polygon.minimum_rotated_rectangle.area:
        return None
    if len(height)>1800:
        use=np.linspace(0,len(height)-1,1800,dtype=int)
        x,z,height=x[use],z[use],height[use]
    centered=np.column_stack((x,z))-rectangle.mean(axis=0)
    errors=np.abs(height-np.median(height))
    flat_error=np.mean(errors[errors<=np.percentile(errors,85)])
    best_error=flat_error*.62
    best=None
    for i in [0,1]:
        axis=rectangle[(i+1)%4]-rectangle[i]
        axis/=np.linalg.norm(axis)
        normal=np.array([-axis[1],axis[0]])
        dz=np.ptp(rectangle@normal);dx=np.ptp(rectangle@axis)
        u=centered@axis/dx+.5;v=centered@normal/dz+.5
        cross=np.maximum(0,1-np.abs(2*v-1))
        end=np.maximum(0,1-np.abs(2*u-1))
        ridge=math.degrees(math.atan2(axis[1],axis[0]))+90
        shapes=[("gable",cross,ridge),("hip",np.minimum(cross,end*dx/dz),ridge),("shed",v,ridge),("shed",1-v,ridge+180)]
        for kind,curve,bearing in shapes:
            design=np.stack((np.ones_like(curve),curve),axis=1)
            use=np.ones(len(height),bool)
            for _ in range(3):
                eave,rise=np.linalg.lstsq(design[use],height[use],rcond=None)[0]
                residual=np.abs(height-eave-rise*curve)
                use=residual<=np.percentile(residual,85)
            error=residual[use].mean()
            if error<min(best_error,.70) and 1.1<rise<dz*.82 and 1.7<eave<85 and (kind!="shed" or rise<eave*1.2):
                best={"form":kind,"ridge":round(bearing%360,1),"rise":round(float(rise),2),"eave":round(float(eave),2)}
                best_error=error
    return best
