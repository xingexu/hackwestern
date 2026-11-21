import json
import math

import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString

import campus_region as region
from ortho_road_paint import pigment,stripe_samples
from parking_stripes import lot_mask

OUT=region.OUT.parents[1]/'build/survey_bays.json'


def car_pair(center,along,normal,gap):
    u,v=np.meshgrid(np.linspace(-1.75,1.75,9),[-.58,-.30,0,.30,.58])
    local=u.ravel()[:,None]*along+v.ravel()[:,None]*normal
    def vehicle(side):
        p=center+side*gap*.5*normal
        rgb=pigment(p+local)
        base=pigment(p+local+2.85*along)
        lum=rgb[:,1]
        dark=np.mean(lum<np.percentile(base[:,1],65)-35)
        tint=np.percentile(np.ptp(rgb,axis=1),68)
        return np.percentile(lum,88)-np.percentile(lum,12)>42 and (dark>.28 or tint>48)
    return vehicle(1) and vehicle(-1)


def bay_rows():
    data=json.loads(OUT.with_name('survey_parking.json').read_bytes())
    lines=np.asarray(data['lines']+data['amber']).reshape(-1,2,2)
    centers=lines.mean(axis=1)
    delta=lines[:,1]-lines[:,0]
    lengths=np.linalg.norm(delta,axis=1)
    axes=delta/lengths[:,None]
    index=cKDTree(centers)
    lots=lot_mask()
    islands=shapely.union_all([shapely.Polygon(p['outer']) for p in json.loads(OUT.with_name('survey_islands.json').read_bytes())]).buffer(.26)
    candidates=[]
    for i,(center,length,along) in enumerate(zip(centers,lengths,axes)):
        if not 3.3<length<7.2:continue
        normal=np.array([-along[1],along[0]])
        near=np.asarray(index.query_ball_point(center,26))
        mid=centers[near]-center
        same=(np.abs(axes[near]@along)>.986)&(np.abs(mid@along)<1.03)&(np.abs(lengths[near]-length)<1.65)
        ids=near[same]
        if len(ids)<4:continue
        progress=(centers[ids]-center)@normal
        gaps=np.arange(2.45,3.35,.025)
        error=np.abs(progress[:,None]-np.rint(progress[:,None]/gaps)*gaps)
        k=np.argmax(np.mean(np.exp(-(error/.24)**2),axis=0))
        gap=gaps[k]
        aligned=error[:,k]<.31
        ticks=np.rint(progress[aligned]/gap).astype(int)
        if aligned.mean()<.76 or len(np.unique(ticks))<4:continue
        shape=axes[ids[aligned]]
        axis=np.median(shape*np.sign(shape@along)[:,None],axis=0)
        axis/=np.linalg.norm(axis)
        side=np.array([-axis[1],axis[0]])
        occupied=set(ticks)
        pitch=np.median(lengths[ids[aligned]])
        for j in range(min(ticks)-2,max(ticks)+3):
            if j in occupied or abs(j)>5:continue
            within=min(ticks)<j<max(ticks)
            if within and (j-1 not in occupied or j+1 not in occupied) and not (j-2 in occupied and j+1 in occupied or j-1 in occupied and j+2 in occupied):continue
            p=center+side*j*gap
            existing=np.asarray(index.query_ball_point(p,2.1),int)
            if len(existing) and (np.abs(axes[existing]@axis)>.96).any():continue
            ends=np.array([p-axis*pitch*.5,p+axis*pitch*.5])
            line=LineString(ends)
            if not lots.covers(line) or islands.distance(line)<.15:continue
            optical=[]
            for drift in [-.25,-.125,0,.125,.25]:
                edge,tint,chroma=stripe_samples(*(ends+drift*side).copy())
                support=np.mean((edge>5)|((tint>4)&(chroma>17)))
                merit=np.mean(np.clip(edge+np.clip(tint,0,17),-15,30))
                optical.append((merit,support,drift,np.mean((tint>3)&(chroma>17))))
            merit,support,drift,amber=max(optical)
            cars=car_pair(p,axis,side,gap)
            if not ((merit>6.5 and support>.57) or (cars and within and support>.23 and merit>1.2)):continue
            measured=ends+side*drift
            ink=int(amber>.44 or amber>.22 and (ids[aligned]>=len(data['lines'])).mean()>.80)
            candidates.append((merit+(1 if within else 0),measured.mean(axis=0),measured,ink,'visible' if support>.57 else 'parked-cars'))
    keep=[]
    if candidates:
        sort=sorted(candidates,key=lambda v:-v[0])
        tree=cKDTree([s[1] for s in sort]);ignored=set()
        for i,(_,p,ends,ink,kind) in enumerate(sort):
            if i in ignored:continue
            keep.append([ends.round(2).ravel().tolist(),ink,kind])
            ignored.update(tree.query_ball_point(p,1.2))
    return keep


def hatch_bounds():
    data=json.loads(OUT.with_name('survey_pavement.json').read_bytes())
    rows=np.asarray(data['hatches'])
    points=rows[:,:4].reshape(-1,2,2)
    centers=points.mean(axis=1)
    steps=points[:,1]-points[:,0]
    axes=steps/np.linalg.norm(steps,axis=1)[:,None]
    index=cKDTree(centers)
    borders=[]
    seen=set()
    for i,(p,d) in enumerate(zip(centers,axes)):
        n=np.array([-d[1],d[0]])
        near=np.asarray(index.query_ball_point(p,8))
        rel=centers[near]-p
        ids=near[(np.abs(axes[near]@d)>.985)&(rows[near,4]==rows[i,4])&(np.abs(rel@d)<3.1)]
        if len(ids)<3:continue
        order=ids[np.argsort((centers[ids]-p)@n)]
        parts=np.split(order,np.flatnonzero(np.diff((centers[order]-p)@n)>2.05)+1)
        group=next(v for v in parts if i in v)
        if len(group)<3 or (int(group[0]),int(group[-1])) in seen:continue
        seen.add((int(group[0]),int(group[-1])))
        oriented=np.where((axes[group]@d)[:,None,None]>0,points[group],points[group,::-1])
        for which in [0,1]:
            tips=oriented[:,which]
            begin,end=tips[0],tips[-1]
            length=np.linalg.norm(end-begin)
            if length<2.0:continue
            axis=(end-begin)/length
            across=np.array([-axis[1],axis[0]])
            if np.max(np.abs((tips-begin)@across))>.63:continue
            best=None
            for shift in np.arange(-.4,.41,.1):
                edge=np.array([begin,end])+shift*across
                light,color,chroma=stripe_samples(*edge.copy())
                rate=np.mean((light>6)|(color>5))
                score=np.mean(np.clip(light+.7*color,-12,32))
                if rate>.62 and score>7 and (best is None or score>best[0]):best=score,edge,int(np.mean((color>3)&(chroma>17))>.44)
            if best:borders.append([best[1].round(2).ravel().tolist(),best[2]])
    return borders


if __name__=='__main__':
    rows=bay_rows();edges=hatch_bounds()
    OUT.write_text(json.dumps(dict(rows=rows,borders=edges),separators=(',',':')))
    print(len(rows),'registered stall dividers and',len(edges),'photographed hatch boundaries.')
