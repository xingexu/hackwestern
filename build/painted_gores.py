import json
from functools import lru_cache

import numpy as np
import shapely
from scipy.signal import find_peaks
from shapely.geometry import LineString,Polygon

import campus_region as region
from ortho_road_paint import pigment


OUT=region.OUT.parents[1]/'build/survey_gores.json'


def pairs(raw):
    for i,(a,gold) in enumerate(raw):
        if not gold or a.length<12:continue
        for j,(b,other) in enumerate(raw):
            if j==i or b.length<12 or (other and j<i) or a.distance(b)>1.7:continue
            t=np.arange(.25,a.length,.25)
            aa=shapely.line_interpolate_point(a,t)
            ab=shapely.line_locate_point(b,aa)
            bb=shapely.line_interpolate_point(b,ab)
            d=shapely.distance(aa,bb)
            ok=(ab>.15)&(ab<b.length-.15)&(d<8.8)
            if ok.sum()<48:continue
            ad=shapely.get_coordinates(aa[ok]);bd=shapely.get_coordinates(bb[ok]);ds=d[ok]
            if np.ptp(ds)<1.1 or min(ds)>.85 or max(ds)<2.2 or max(ds)/a.length>.4:continue
            p=Polygon(np.vstack([ad,bd[::-1]])).buffer(0)
            if p.geom_type!='Polygon' or p.area<12:continue
            yield i,j,p,ad,bd



def hatch_ink(ad,bd):
    stations=np.arange(len(ad))*.25
    d=np.linalg.norm(ad-bd,axis=1)
    start=np.arange(0,stations[-1],.065)
    spacing=np.interp(start,stations,d)
    candidates=start[spacing>1.18]
    if len(candidates)<45:return []
    shifts=np.arange(-2.0,2.01,.10)
    weight=np.array([.30,.52,.18])
    def on(side,at):
        return np.stack([np.interp(at,stations,side[:,q]) for q in range(2)],axis=-1)
    offset=np.interp(candidates,stations,d)[:,None]*shifts
    l=on(ad,candidates[:,None]-offset*.5);r=on(bd,candidates[:,None]+offset*.5)
    axis=r-l
    width=np.linalg.norm(axis,axis=2)
    normal=np.stack([-axis[:,:,1],axis[:,:,0]],axis=-1)/np.maximum(.01,width[:,:,None])
    trace=l[:,:,None,:]+np.linspace(.12,.88,17)[None,None,:,None]*axis[:,:,None,:]
    cols=np.stack([pigment((trace+normal[:,:,None,:]*step).reshape(-1,2)).reshape(*trace.shape[:-1],3) for step in [-.24,0,.24]],axis=0)
    local=cols[1]-(cols[0]+cols[2])*.5
    lum=local@weight
    tint=(local[:,:,:,0]+local[:,:,:,1])*.5-local[:,:,:,2]
    strength=np.median(lum+np.clip(tint,-6,14),axis=-1)
    best=strength.argmax(axis=1);peaks=strength[np.arange(len(best)),best]
    valid,_=find_peaks(peaks,distance=13,prominence=3,height=8)
    result=[]
    for k in valid:
        h=best[k]
        if np.mean(lum[k,h]>3)<.65 or np.median(tint[k,h])<1.0 or np.median((cols[1,k,h,:,0]+cols[1,k,h,:,1])*.5-cols[1,k,h,:,2])<15:continue
        result.append((candidates[k],shifts[h],LineString([l[k,h],r[k,h]])))
    return result

def survey():
    tracks=json.loads(OUT.with_name('survey_carriageway_ink.json').read_bytes())
    raw=[(LineString(np.reshape(points,(-1,2))),color) for points,color in tracks]
    groups=[]
    for i,j,face,ad,bd in sorted(pairs(raw),key=lambda pair:-pair[2].area):
        if any(face.intersection(g[0]).area>face.area*.58 for g in groups):continue
        marks=hatch_ink(ad,bd)
        if len(marks)<4:continue
        slope=np.median([m[1] for m in marks])
        parallel=[(station,line) for station,angle,line in marks if abs(angle-slope)<.24]
        if len(parallel)<4:continue
        pitches=np.diff([station for station,line in parallel])
        if np.median(np.abs(pitches-np.median(pitches)))>.32*np.median(pitches):continue
        lo,hi=parallel[0][0],parallel[-1][0]
        sample=np.arange(len(ad))*.25
        widths=np.linalg.norm(ad-bd,axis=1)
        taper_start=np.interp(lo,sample,widths)
        taper_end=np.interp(hi,sample,widths)
        start=0 if widths[0]<taper_start and taper_start<taper_end else lo-1
        stop=sample[-1] if widths[-1]<taper_end and taper_end<taper_start else hi+1
        field=(sample>=start)&(sample<=stop)
        amber=[LineString(ad[field]),LineString(bd[field])]
        colors=[np.median(pigment(points[field]),axis=0) for points in [ad,bd]]
        chroma=[(r+g)*.5-b for r,g,b in colors]
        if min(chroma)<14 or abs(chroma[0]-chroma[1])>8:continue
        groups.append((face,amber,[line for station,line in parallel]))
    def flatten(line):return np.asarray(line.simplify(.036).coords).round(3).ravel().tolist()
    return [{'borders':[flatten(line) for line in bounds],'hatching':[flatten(line) for line in bars]} for face,bounds,bars in groups]


@lru_cache(maxsize=1)
def markings():
    groups=json.loads(OUT.read_bytes())
    channels=[[LineString(np.reshape(points,(-1,2))) for points in group['borders']+group['hatching']] for group in groups]
    floor=shapely.union_all([shapely.union_all(lines).convex_hull.buffer(.29) for lines in channels])
    return [(line,1) for lines in channels for line in lines],floor


if __name__=='__main__':
    groups=survey()
    OUT.write_text(json.dumps(groups,separators=(',',':')))
    print(len(groups),'painted channelizing islands with',sum(len(g['hatching']) for g in groups),'observed yellow cross bars')
