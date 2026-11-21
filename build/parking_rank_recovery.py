import json
from functools import lru_cache

import cv2
import numpy as np
import shapely
from scipy.ndimage import binary_closing
from scipy.signal import find_peaks
from shapely.geometry import LineString

from ortho_road_paint import rgb_tile
from parking_archive import OUT,archive


@lru_cache(maxsize=30)
def spectrum(year,x,z):
    photo=rgb_tile(x,z) if year==2025 else archive(year,x,z)
    r,g,b=photo.astype(np.float32).transpose(2,0,1)
    gold=(r+g)*.5-b
    gray=.29*r+.55*g+.16*b
    dye=gray+1.8*(gold-cv2.GaussianBlur(gold,(0,0),3))
    return np.stack((dye,gray,gold),axis=2)


def color_samples(year,points):
    shape=points.shape[:-1]
    cloud=points.reshape(-1,2)
    pixels=np.floor(cloud/150).astype(int)
    xmin,zmin=pixels.min(axis=0);xmax,zmax=pixels.max(axis=0)
    values=np.empty((len(cloud),3),'float32')
    for tx in range(xmin,xmax+1):
        for tz in range(zmin,zmax+1):
            use=(pixels[:,0]==tx)&(pixels[:,1]==tz)
            if not use.any():continue
            local=np.rint((cloud[use]-[150*tx,150*tz])*10-.5).astype(int).clip(0,1499)
            values[use]=spectrum(year,tx*150,tz*150)[local[:,1],local[:,0]]
    return values.reshape(shape+(3,))


def scan_rank(center,axis):
    side=np.array([-axis[1],axis[0]])
    along=np.arange(-8.4,8.41,.12)
    across=np.arange(-10.,10.01,.075)
    world=center+along[None,:,None]*axis+across[:,None,None]*side
    captures=[]
    for year in [2021,2020,2025]:
        value,lum,color=color_samples(year,world).transpose(2,0,1)
        lower=np.roll(value,4,0);upper=np.roll(value,-4,0)
        clear=(lum>107)&(np.abs(np.roll(lum,4,0)-np.roll(lum,-4,0))<28)
        bright=np.clip(value-np.maximum(lower,upper),-20,32)
        bright=np.where(clear,bright,-4)
        glare=(color-(np.roll(color,4,0)+np.roll(color,-4,0))*.5>1.6)&(color>13)
        captures.append((bright,glare,lum))
    gain=[]
    for bright,_,_ in captures:
        best=cv2.dilate(cv2.blur(bright,(7,1)),np.ones((3,1),'uint8'))
        gain.append(best)
    persistent=np.minimum(cv2.dilate(gain[0],np.ones((3,1),'uint8')),cv2.dilate(gain[1],np.ones((5,1),'uint8')))
    stable=np.where((gain[0]>3)|(gain[1]>4),persistent,0)
    profile=np.maximum(cv2.blur(stable,(37,1)).max(axis=1),0)
    peaks=find_peaks(profile,prominence=2.7,distance=20,height=4.5)[0]
    peaks=peaks[(peaks>9)&(peaks<len(across)-9)]
    events=[]
    for j in peaks:
        dz=np.abs(across[peaks]-across[j])
        match=np.any(((dz>2.36)&(dz<3.40))|((dz>4.9)&(dz<6.75)))
        if not match:continue
        bonded=(cv2.blur(stable,(5,1))[j]>2.8)&((gain[0][j]>4)|(gain[1][j]>5))
        strip=binary_closing(bonded,structure=np.ones(6,bool))
        ends=np.flatnonzero(np.diff(np.r_[False,strip,False])).reshape(-1,2)
        for a,b in ends:
            if not 3.25<along[b-1]-along[a]<13.1:continue
            if np.abs(np.mean(along[a:b]))>3.6:continue
            support=float((persistent[j,a:b]>3.8).mean())
            if support<.65:continue
            direct=max(float((gain[2][j,a:b]>3).mean()),0.)
            local=world[j,a:b]
            cars=color_samples(2025,(local[None,:,:]+np.array([-1.35,-.9,.9,1.35])[:,None,None]*side))[:,:,1]
            occupied=float(np.min((cars<116).reshape(2,-1).mean(axis=1)))
            if direct<.22 and occupied<.20:continue
            weight=np.array([.35,.35,.30])
            chroma=[]
            for (signal,tint,_),band in zip(captures,gain):
                m=signal[j-2:j+3,a:b]>3.6
                chroma.append((tint[j-2:j+3,a:b]&m).sum()/max(1,m.sum()))
            hue=int(np.dot(chroma,weight)>.40)
            first,last=world[j,[a,b-1]]
            events.append((profile[j]+stable[j,a:b].mean()*.5,(first,last),hue,[round(direct,2),round(support,2),round(occupied,2)]))
    return events


def surveyed_ranks():
    records=json.loads(OUT.read_bytes())['dividers']
    common=json.loads(OUT.with_name('survey_parking.json').read_bytes())
    stock=[p for p,k,c in records]+common['lines']+common['amber']
    stock+=[p for p,c in json.loads(OUT.with_name('survey_parking_ink.json').read_bytes())]
    stock+=[p for p,c,t in json.loads(OUT.with_name('survey_bays.json').read_bytes())['rows']]
    stock+=[p for p,c in json.loads(OUT.with_name('survey_lot_markings.json').read_bytes())['dividers']]
    seeds={}
    for p,k,c in records:
        a,b=np.array(p).reshape(2,2);d=b-a;length=np.linalg.norm(d)
        if length<2.9:continue
        theta=np.arctan2(d[1],d[0])%np.pi
        mid=(a+b)*.5;key=(*np.floor(mid/7).astype(int),round(theta/.14))
        if key not in seeds or seeds[key][0]<length:seeds[key]=(length,mid,d/length)
    accepted=[LineString(np.reshape(p,(-1,2))) for p in stock]
    tree=shapely.STRtree(accepted)
    from parking_stripes import lot_mask
    lots=lot_mask()
    islands=shapely.union_all([shapely.Polygon(p['outer']) for p in json.loads(OUT.with_name('survey_islands.json').read_bytes())]).buffer(.16)
    offers=[]
    for length,center,axis in seeds.values():
        offers.extend(scan_rank(center,axis))
    result=[]
    for score,ends,gold,cert in sorted(offers,key=lambda v:-v[0]):
        line=LineString(ends)
        if not lots.covers(line) or line.intersects(islands):continue
        holders=list(tree.geometries[tree.query(line,predicate='dwithin',distance=.45)])
        holders.extend(q for q in accepted[len(tree.geometries):] if q.distance(line)<.45)
        if holders:line=line.difference(shapely.union_all([l.buffer(.42,cap_style='flat') for l in holders]))
        for part in shapely.get_parts(line):
            if part.geom_type!='LineString' or part.length<1.35:continue
            result.append([np.asarray([part.coords[0],part.coords[-1]]).ravel().round(2).tolist(),gold,cert])
            accepted.append(part)
        if len(accepted)-len(tree.geometries)>110:tree=shapely.STRtree(accepted)
    return result


if __name__=='__main__':
    output=surveyed_ranks()
    OUT.with_name('survey_retained_parking.json').write_text(json.dumps(output,separators=(',',':')))
    print(len(output),'continuations of doubly photographed stall dividers.')
