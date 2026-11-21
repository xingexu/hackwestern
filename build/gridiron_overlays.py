import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d,map_coordinates


def markings(rgb,us,ts,goals,sides):
    r,g,b=rgb.transpose(2,0,1)
    light=(r+g*2+b)*.25
    chroma=r-g+.6*(g-b)
    gold=(chroma-cv2.GaussianBlur(chroma,(0,0),3))*np.clip((r-g+12)/11,0,1)
    white=light-cv2.GaussianBlur(light,(0,0),3)
    def values(channel,u,t):
        return map_coordinates(channel,np.stack([(t-ts[0])/.1,(u-us[0])/.1]),order=1,mode='nearest')
    def peak(channel,low,high,d,vertical):
        offsets=np.arange(low,high,.035)
        uv=np.broadcast_arrays(offsets[:,None],d[None,:])
        v=values(channel,*uv) if vertical else values(channel,*uv[::-1])
        score=np.mean(np.clip(v,-4,16),axis=1)
        return offsets[np.argmax(score)],float(np.max(score))
    y0,y1=goals;mid=(y0+y1)*.5;span=sides[1]-sides[0];cx=sum(sides)*.5;yard=(y1-y0)/110
    ticks=[]
    for nominal in [sides[0]+.99,cx-span*.125,cx+span*.125,sides[1]-.99]:
        ids=np.abs(us-nominal)<1.13
        mask=(ts>y0+1)&(ts<y1-1)&(np.abs(ts-mid)>8.5)
        stripe=np.mean(np.clip(white[mask][:,ids]-6,0,32),axis=0)
        rank=gaussian_filter1d(stripe,2.4)
        u=us[ids][np.argmax(rank)]
        for n in range(1,110):
            if n%5==0:continue
            h=y0+n*yard
            t,merit=peak(white,h-.46,h+.46,np.linspace(u-.30,u+.30,11),False)
            if merit<7.0:continue
            xs=np.arange(u-.82,u+.821,.07)
            v=values(white,xs,np.full_like(xs,t))
            found=np.where(v>6.2)[0]
            if len(found)<5:continue
            parts=np.split(found,np.flatnonzero(np.diff(found)>2)+1)
            run=min(parts,key=lambda q:abs(xs[q].mean()-u))
            if len(run)>3:ticks.append([round(float((xs[run[-1]]+xs[run[0]])*.5),3),round(float(t),3),round(float(np.clip(xs[run[-1]]-xs[run[0]]+.08,.46,1.18)),2)])
    lines=[]
    def stroke(q):
        q=np.asarray(q)
        if len(q)<2:return
        seg=np.linalg.norm(np.diff(q,axis=0),axis=1)
        nodes=np.r_[0,seg.cumsum()]
        s=np.arange(.15,nodes[-1],.18)
        if len(s)<4:return
        u,t=np.interp(s,nodes,q[:,0]),np.interp(s,nodes,q[:,1])
        gain=values(gold,u,t)
        if np.mean(gain>2.45)>.44 and np.median(gain)>2.25:lines.append(q.round(3).tolist())
    outer=[]
    for i,side in enumerate(sides):
        p,v=peak(gold,side+(-2.5 if i==0 else .6),side+(-.6 if i==0 else 2.5),np.linspace(y0+2,y1-2,344),True);outer.append(p)
    for u in outer:stroke([[u,y0+.8],[u,y1-.8]])
    for sign,end in [(-1,y0),(1,y1)]:
        t,gain=peak(gold,end-1.5,end+1.5,np.linspace(cx-14,cx+14,210),False)
        stroke([[outer[0],t],[outer[1],t]])
        penalty,q=peak(gold,t-sign*16.5-1.2,t-sign*16.5+1.2,np.linspace(cx-17,cx+17,211),False)
        if q>2.1:
            goalbox=[]
            for n in [-1,1]:
                u,_=peak(gold,cx+n*20.1-.95,cx+n*20.1+.95,np.linspace(t-sign,penalty+sign,101),True)
                goalbox.append(u);stroke([[u,t],[u,penalty]])
            stroke([[goalbox[0],penalty],[goalbox[1],penalty]])
    angles=np.linspace(0,2*np.pi,181)
    best=None
    for radius in np.arange(8.75,9.46,.10):
        for x in np.arange(cx-.7,cx+.71,.16):
            for z in np.arange(mid-.7,mid+.71,.16):
                ring=np.c_[x+radius*np.cos(angles),z+radius*np.sin(angles)]
                quality=np.median(np.clip(values(gold,*ring.T),-4,20))
                if best is None or best[0]<quality:best=(quality,ring)
    if best[0]>2.5:stroke(best[1][::3])
    return ticks,lines
