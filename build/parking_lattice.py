import math

import cv2
import numpy as np
import shapely
from scipy.signal import find_peaks
from scipy.spatial import cKDTree
from shapely.geometry import LineString,box

from ortho_road_paint import rgb_tile


def window_image(x,z):
    u=np.arange(x*10-165,x*10+166)
    v=np.arange(z*10-165,z*10+166)
    rgb=np.zeros((len(v),len(u),3),np.uint8)
    for a in np.unique(u//1500):
        xx=np.flatnonzero(u//1500==a)
        for b in np.unique(v//1500):
            yy=np.flatnonzero(v//1500==b)
            rgb[np.ix_(yy,xx)]=rgb_tile(a*150,b*150)[np.ix_(v[yy]%1500,u[xx]%1500)]
    return rgb


def stain(im):
    r,g,b=im.astype(np.float32).transpose(2,0,1)
    gold=(r+g)*.5-b
    gray=(r+g*2+b)*.25
    return gray+2.3*(gold-cv2.GaussianBlur(gold,(0,0),2.5)),gray,gold


def lattice(lots,registered):
    l,t,r,b=lots.bounds
    positions=np.array([np.asarray(g.coords).mean(axis=0) for g in registered])
    lines=cKDTree(positions)
    candidates=[]
    for x in range(math.floor(l/20)*20,math.ceil(r/20)*20+1,20):
        for z in range(math.floor(t/20)*20,math.ceil(b/20)*20+1,20):
            window=box(x-10,z-10,x+10,z+10)
            if lots.intersection(window).area<18:continue
            photo=window_image(x,z)
            ink,lum,gold=stain(photo)
            lsd=cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD).detect(np.uint8(np.clip((ink-125)*2.7+118,0,255)))[0]
            votes=np.zeros(90,float)
            if lsd is not None:
                d=lsd[:,0,2:]-lsd[:,0,:2]
                lengths=np.linalg.norm(d,axis=1)
                for angle,length in zip(np.arctan2(d[:,1],d[:,0]),lengths):
                    if 19<length<125:votes[round(math.degrees(angle)/2)%90]+=min(length,65)
            for index in lines.query_ball_point([x,z],23):
                a,bp=registered[index].coords[0],registered[index].coords[-1]
                angle=math.atan2(bp[1]-a[1],bp[0]-a[0])
                votes[round(math.degrees(angle)/2)%90]+=65
            votes=.5*votes+.20*(np.roll(votes,1)+np.roll(votes,-1))+.05*(np.roll(votes,2)+np.roll(votes,-2))
            for turn in range(5):
                k=np.argmax(votes);score=votes[k]
                if score<70:break
                neighbors=(np.arange(k-2,k+3)%90)
                theta=np.sum(votes[neighbors]*np.arange(k-2,k+3))/votes[neighbors].sum()*np.pi/90
                votes[np.arange(k-5,k+6)%90]=0
                axis=np.array([math.cos(theta),math.sin(theta)])
                normal=np.array([-axis[1],axis[0]])
                stations=np.arange(-138,139)
                u,v=np.meshgrid(stations,stations)
                mx=(165+axis[0]*u+normal[0]*v).astype('float32')
                my=(165+axis[1]*u+normal[1]*v).astype('float32')
                def remap(layer):return cv2.remap(layer,mx,my,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
                intens=remap(ink);gray=remap(lum)
                signal=intens-np.maximum(np.roll(intens,3,0),np.roll(intens,-3,0))
                valid=(np.abs(np.roll(intens,3,0)-np.roll(intens,-3,0))<20)&(gray>100)
                signed=np.clip(signal,-16,30)*valid
                gain=cv2.blur(signed,(31,1))
                color=remap(gold)
                tint=color-(np.roll(color,3,0)+np.roll(color,-3,0))*.5
                for j in range(46,len(stations)-46,21):
                    profile=np.median(gain[:,j-3:j+4],axis=1)
                    peaks=find_peaks(profile,distance=5,prominence=1.9,height=1.8)[0]
                    peaks=peaks[(peaks>12)&(peaks<len(stations)-12)]
                    for i in peaks:
                        offsets=peaks-i
                        gaps=np.arange(24.5,33,.5)
                        ticks=np.rint(offsets[:,None]/gaps)
                        ok=(np.abs(offsets[:,None]-ticks*gaps)<2.65)&(np.abs(ticks)<5)
                        counts=ok.sum(axis=0)
                        if counts.max()<4 or (profile[i]<3.8 and counts.max()<5):continue
                        strong=np.max(gain[i-1:i+2],axis=0)>2.1
                        strong=cv2.morphologyEx(np.uint8(strong[None,:]),cv2.MORPH_CLOSE,np.ones((1,6),np.uint8))[0]>0
                        bounds=np.flatnonzero(np.diff(np.r_[False,strong,False])).reshape(-1,2)
                        found=next(((a,b) for a,b in bounds if a<=j<b),None)
                        if not found:continue
                        a,b=found
                        a=max(a+6,j-64);b=min(b-6,j+65)
                        if b-a<26 or b-a>137:continue
                        center=np.array([x,z])+axis*((stations[a]+stations[b-1])*.05)+normal*stations[i]*.1
                        if np.max(np.abs(center-[x,z]))>10.2:continue
                        true=signed[i,a:b]
                        if np.mean(true>2.2)<.48 or np.median(true)<2.2 or np.median(gray[i,a:b])<117:continue
                        bright=profile[i]
                        amber=np.mean((tint[i,a:b]>1.8)&(color[i,a:b]>14))>.40
                        start=np.array([x,z])+axis*stations[a]*.1+normal*stations[i]*.1
                        end=np.array([x,z])+axis*stations[b-1]*.1+normal*stations[i]*.1
                        segment=LineString([start,end])
                        if lots.covers(segment):candidates.append((min(bright,20)+min(7,counts.max())+segment.length*.25,segment,int(amber)))
    result=[]
    all_lines=list(registered)
    tree=shapely.STRtree(all_lines)
    for _,line,color in sorted(candidates,key=lambda v:-v[0]):
        near=[*tree.geometries[tree.query(line,predicate='dwithin',distance=.29)],*[q for q in all_lines[len(tree.geometries):] if q.distance(line)<.29]]
        if near:
            cut=line.difference(shapely.union_all(near).buffer(.29,quad_segs=2))
        else:cut=line
        for piece in shapely.get_parts(cut):
            if piece.geom_type!='LineString' or piece.length<1.7:continue
            result.append([np.array([piece.coords[0],piece.coords[-1]]).round(2).ravel().tolist(),color])
            all_lines.append(piece)
        if len(all_lines)-len(tree.geometries)>90:tree=shapely.STRtree(all_lines)
    return result
