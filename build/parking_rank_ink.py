import json
import math

import cv2
import numpy as np
import shapely
from scipy.signal import find_peaks
from scipy.spatial import cKDTree
from shapely.geometry import LineString
from shapely.prepared import prep

import campus_region as region
from ortho_road_paint import pigment
from parking_lattice import window_image
from parking_stripes import lot_mask


OUT=region.OUT.parents[1]/'build/survey_parking_ink.json'


def row_marks(anchor,axis,half,rgb,origin,pitch):
    across=np.array([-axis[1],axis[0]])
    n=np.arange(-14.8,14.81,.075)
    u=np.arange(-half,half+.06,.12)
    points=anchor+n[:,None,None]*across+u[None,:,None]*axis
    pixels=(points-origin).astype('float32')*10-.5
    light=cv2.remap(rgb,pixels[:,:,0],pixels[:,:,1],cv2.INTER_LINEAR)
    red,green,blue=light.transpose(2,0,1)
    luma=.30*red+.52*green+.18*blue
    tint=(red+green)*.5-blue
    left,right=np.roll(light,4,0),np.roll(light,-4,0)
    bg=(left+right)*.5
    base=bg@[.30,.52,.18]
    mineral=(base>100)&(base<226)&(bg[:,:,0]-bg[:,:,1]<20)&(bg[:,:,1]-bg[:,:,0]<9)&(bg[:,:,0]-bg[:,:,2]<46)
    clear=mineral&(np.abs(left-right).max(axis=2)<23)&(luma<237)
    diff=light-bg
    gray=diff@[.30,.52,.18]
    yellow=diff@[.50,.50,-1.]
    contrast=np.clip(gray+1.55*np.maximum(yellow,0),-20,30)
    ink=clear&(contrast>3.8)
    vote=np.where(clear,contrast,0)
    strength=np.mean(np.clip(vote,-7,24),axis=1)+ink.mean(axis=1)*3
    peaks=find_peaks(strength,prominence=2.0,distance=4,height=2.5)[0]
    peaks=peaks[(peaks>=5)&(peaks<len(n)-5)]
    if len(peaks)<3:return []
    result=[]
    for i in peaks:
        if abs(n[i]-round(n[i]/pitch)*pitch)>.22:continue
        d=n[peaks]-n[i]
        slots=np.rint(d/pitch)
        fit=(np.abs(d-slots*pitch)<.20)&(np.abs(slots)<=5)
        fit&=(strength[peaks]>=3.4)
        count=fit.sum()
        if count<3:continue
        visible=ink[i]
        extent=np.where(visible)[0]
        if len(extent)<max(6,len(u)*.25) or clear[i].mean()<.46:continue
        if np.ptp(u[extent])<2.35 or not (visible[:len(u)//2].any() and visible[len(u)//2:].any()):continue
        if np.median(base[i,clear[i]])<112 or np.percentile(luma[i,visible],85)>233:continue
        gold=visible&(tint[i]>12)&(yellow[i]>1.2)
        yellow_share=gold.sum()/max(1,visible.sum())
        station=anchor+n[i]*across
        end1,end2=u[extent[[0,-1]]]
        if end2-end1<2.35:continue
        segment=np.array([station+end1*axis,station+end2*axis])
        result.append((strength[i]+min(count,5)+visible.mean()*3,segment,int(yellow_share>.36)))
    return result


def seen_on_both_sides(flat,canopy):
    a,b=np.reshape(flat,(-1,2))
    axis=(b-a)/np.linalg.norm(b-a)
    side=np.array([-axis[1],axis[0]])
    points=a+np.linspace(.06,.94,31)[:,None]*(b-a)
    face=pigment(points)
    left,right=pigment(points-.28*side),pigment(points+.28*side)
    common=np.minimum(face-left,face-right)@[.29,.53,.18]
    gold=np.array([.5,.5,-1.])
    yellow=face@gold-np.maximum(left@gold,right@gold)
    visible=common+1.5*np.maximum(0,yellow)>3.4
    even=(np.abs(left-right).max(axis=1)<13).mean()
    return visible.mean()>.46 and even>.57 and region.sample(canopy,*points.T).mean()<2.4


def scan():
    cv2.setNumThreads(1)
    raw=json.loads(OUT.with_name('survey_parking.json').read_bytes())
    bay=json.loads(OUT.with_name('survey_bays.json').read_bytes())
    fine=json.loads(OUT.with_name('survey_lot_markings.json').read_bytes())
    old=[*raw['lines'],*raw['amber'],*[r for r,c,_ in bay['rows']],*[r for r,c in fine['dividers']]]
    xy=np.asarray(old).reshape(-1,2,2)
    delta=xy[:,1]-xy[:,0];length=np.linalg.norm(delta,axis=1)
    axes=delta/length[:,None];centers=xy.mean(axis=1)
    nearby=cKDTree(centers)
    lots=lot_mask();prepared=prep(lots)
    items=[]
    for i,center in enumerate(centers):
        if not 2.85<length[i]<12.5:continue
        axis=axes[i];normal=np.array([-axis[1],axis[0]])
        neighbors=np.asarray(nearby.query_ball_point(center,18),int)
        relative=centers[neighbors]-center
        family=neighbors[(np.abs(axes[neighbors]@axis)>.988)&(np.abs(relative@axis)<1.2)&(np.abs(length[neighbors]-length[i])<2.7)]
        if len(family)<2:continue
        sibling=family[family!=i]
        if not np.any((np.abs((centers[sibling]-center)@normal)>2.35)&(np.abs((centers[sibling]-center)@normal)<10)):continue
        spacing=np.arange(2.44,3.46,.025)
        stations=np.abs((centers[sibling]-center)@normal)
        err=np.abs(stations[:,None]-np.rint(stations[:,None]/spacing)*spacing)
        fit=np.minimum(1,np.exp(-(err/.16)**2)).sum(axis=0)+.16*np.exp(-((spacing-2.77)/.26)**2)
        pitch=spacing[np.argmax(fit)]
        if np.count_nonzero(err[:,np.argmax(fit)]<.23)<1:continue
        col=np.rint(center).astype(int)
        x,z=col
        photo=window_image(x,z).astype('float32')
        half=np.clip(np.median(length[family])*.50,2.40,5.50)
        for turn in [-.030,0.,.030]:
            tilt=math.cos(turn)*axis+math.sin(turn)*normal
            for score,points,gold in row_marks(center,tilt,half,photo,col-16.5,pitch):
                line=LineString(points)
                if prepared.covers(line):items.append((score,line,gold))
    assigned=[LineString(row) for row in xy]
    index=shapely.STRtree(assigned)
    result=[]
    for score,line,gold in sorted(items,key=lambda item:-item[0]):
        candidates=[*index.geometries[index.query(line,predicate='dwithin',distance=.36)],*[g for g in assigned[len(index.geometries):] if line.distance(g)<.36]]
        remaining=line
        if candidates:remaining=line.difference(shapely.union_all(candidates).buffer(.36,quad_segs=2))
        for part in shapely.get_parts(remaining):
            if part.geom_type!='LineString' or part.length<2.05:continue
            result.append([np.asarray([part.coords[0],part.coords[-1]]).round(2).ravel().tolist(),gold])
            assigned.append(part)
        if len(assigned)-len(index.geometries)>95:index=shapely.STRtree(assigned)
    from occupied_parking import exposed
    from lot_markings import on_exposed_paving
    canopy=region.lidar('dsm')-region.lidar('dtm')
    return [(points,ink) for points,ink in result if exposed(LineString(np.reshape(points,(-1,2)))) and on_exposed_paving(points) and seen_on_both_sides(points,canopy)]


if __name__=='__main__':
    rows=scan()
    OUT.write_text(json.dumps(rows,separators=(',',':')))
    print(len(rows),'registered parking lines from photographed row spacing',sum(c for _,c in rows),'amber.')
