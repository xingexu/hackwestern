import json
import math

import numpy as np
import shapely
from scipy.ndimage import gaussian_filter1d,maximum_filter1d
from scipy.spatial import cKDTree
from shapely.geometry import LineString,Polygon

import campus_region as region
from campus_bounds import footprint
from ortho_road_paint import pigment

OUT=region.OUT.parents[1]/'build/survey_carriageway_ink.json'


def lines(guide,half):
    stations=np.linspace(0,guide.length,max(3,math.ceil(guide.length/.24)+1))
    center=shapely.get_coordinates(shapely.line_interpolate_point(guide,stations))
    axis=np.gradient(center,axis=0)
    axis/=np.maximum(.001,np.linalg.norm(axis,axis=1))[:,None]
    normal=np.column_stack([-axis[:,1],axis[:,0]])
    offsets=np.arange(-half,half+.01,.095)
    pts=center[:,None,:]+offsets[None,:,None]*normal[:,None,:]
    rgb=pigment(pts.reshape(-1,2)).reshape(pts.shape[:2]+(3,))
    luma=(rgb[:,:,0]+2*rgb[:,:,1]+rgb[:,:,2])*.25
    gold=(rgb[:,:,0]+rgb[:,:,1])*.5-rgb[:,:,2]
    minus=np.roll(rgb,-4,1);plus=np.roll(rgb,4,1)
    background=(minus+plus)*.5
    drift=rgb-background
    yellow=(drift[:,:,0]+drift[:,:,1])*.5-drift[:,:,2]
    lift=luma-np.maximum(np.roll(luma,4,1),np.roll(luma,-4,1))
    valid=(np.abs(plus-minus).mean(axis=2)<19)&(background[:,:,1]>83)&(background[:,:,1]<224)&(np.abs(background[:,:,0]-background[:,:,1])<15)&(background[:,:,1]-background[:,:,2]<32)&(np.ptp(rgb,axis=2)<64)
    signal=lift+np.clip(yellow,0,21)*1.60
    signal[~valid]=-19
    signal[:,:5]=-19;signal[:,-5:]=-19
    peak=gaussian_filter1d(np.clip(signal,-16,35),1.3,axis=0)
    tops=(peak==maximum_filter1d(peak,size=5,axis=1))&(peak>7)&(signal>2)
    paths=[];open_tracks=[]
    for s,row in enumerate(tops):
        ks=np.flatnonzero(row)
        filled=set()
        for idx in sorted(open_tracks,key=lambda i:-len(paths[i])):
            q,old=paths[idx][-1]
            if s-q>4:continue
            possible=[j for j,k in enumerate(ks) if j not in filled and abs(k-old)<=min(3,s-q+1)]
            if possible:
                j=min(possible,key=lambda j:abs(ks[j]-old)-.035*min(25,peak[s,ks[j]]))
                paths[idx].append((s,ks[j]));filled.add(j)
        open_tracks=[i for i in open_tracks if s-paths[i][-1][0]<4]
        for j,k in enumerate(ks):
            if j in filled:continue
            open_tracks.append(len(paths));paths.append([(s,k)])
    result=[]
    for path in paths:
        if len(path)<8:continue
        ii,kk=np.asarray(path).T
        dist=stations[ii[-1]]-stations[ii[0]]
        if dist<2.1 or len(ii)<.67*(ii[-1]-ii[0]+1):continue
        if np.quantile(np.abs(np.diff(np.interp(np.arange(ii[0],ii[-1]+1),ii,offsets[kk]))),.85)>.16:continue
        if np.median(peak[ii,kk])<8.5 or np.mean(valid[ii,kk])<.87:continue
        edges=lift[ii,kk]
        is_gold=((yellow[ii,kk]>3.3)&(gold[ii,kk]>16)).mean()>.50
        if not is_gold and (np.median(edges)<8.5 or np.mean(edges>6)<.60):continue
        flank=np.abs(np.roll(luma,2,1)[ii,kk]-np.roll(luma,-2,1)[ii,kk])
        if np.median(flank)>12 or np.quantile(rgb[ii,kk,1],.85)-np.quantile(rgb[ii,kk,1],.15)>42:continue
        lateral=gaussian_filter1d(offsets[kk],1.55,mode='nearest')
        points=center[ii]+lateral[:,None]*normal[ii]
        shape=LineString(points).simplify(.052)
        if shape.length/dist>1.07:continue
        station=np.arange(.12,shape.length-.09,.25)
        if len(station)<6:continue
        probe=shapely.get_coordinates(shapely.line_interpolate_point(shape,station))
        direction=np.gradient(probe,axis=0)
        side=np.column_stack([-direction[:,1],direction[:,0]])/np.maximum(.001,np.linalg.norm(direction,axis=1))[:,None]
        sample=pigment((probe[None,:,:]+np.array([-.68,-.36,-.24,-.14,0,.14,.24,.36,.68])[:,None,None]*side).reshape(-1,2)).reshape(9,-1,3)
        luminance=(sample[:,:,0]+2*sample[:,:,1]+sample[:,:,2])*.25
        gradient=luminance[4]-np.maximum(luminance[:4],luminance[-1:4:-1])
        far,contrast,edge,inner=np.median(gradient,axis=1)
        if far<4 or contrast<10 or edge<9 or inner<2.9 or edge<contrast*.56:continue
        if np.mean((gradient[2]>5.8)&(gradient[3]>1.1))<.56:continue
        result.append((shape,int(is_gold),float(np.median(peak[ii,kk]))))
    return result


def survey():
    import city_streets
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    site=footprint()
    native=shapely.union_all([Polygon(np.reshape(p,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for p,*holes in city_streets.survey()]).buffer(-.45)
    found=[]
    for way in net['ways']:
        if way['kind']!='road' or way['level'] or way['bridge'] or way['class'] in ('residential','living_street'):continue
        guide=LineString([(x,z) for x,y,z in way['points']])
        if guide.length<5 or not guide.intersects(site):continue
        path=guide.intersection(site.buffer(1))
        half=min(15,way['width']*.52+2.5)
        if way['class']=='service':
            if way['width']<4.4:continue
            path=path.intersection(native)
            half=max(8.4,half)
        for part in shapely.get_parts(path):
            if part.geom_type!='LineString' or part.length<4:continue
            for line,gold,score in lines(part,half):
                for section in shapely.get_parts(line.intersection(native).intersection(site)):
                    if section.geom_type=='LineString' and section.length>2:found.append((section,gold,score))
    if not found:return []
    mids=np.array([line.interpolate(.5,normalized=True).coords[0] for line,_,_ in found])
    axes=np.array([np.asarray(line.coords[-1])-line.coords[0] for line,_,_ in found])
    axes/=np.maximum(.001,np.linalg.norm(axes,axis=1))[:,None]
    points=cKDTree(mids)
    result=[]
    for i,(line,gold,strength) in enumerate(found):
        if line.length<7:
            aligned=[]
            for j in points.query_ball_point(mids[i],34):
                if j==i or found[j][1]!=gold or abs(axes[i]@axes[j])<.978:continue
                delta=mids[j]-mids[i]
                along=abs(delta@axes[i]);across=abs(delta@[-axes[i,1],axes[i,0]])
                if (4.8<along<34 and across<.78) or (gold and across<.62 and along<(line.length+found[j][0].length)*.45):aligned.append(j)
            if not aligned:continue
        result.append([np.asarray(line.coords).round(3).ravel().tolist(),gold])
    return result


if __name__=='__main__':
    rows=survey()
    OUT.write_text(json.dumps(rows,separators=(',',':')))
    print(len(rows),'native longitudinal marks,',sum(g for p,g in rows),'yellow.')


def measured_tracks():
    raw=json.loads(OUT.read_bytes())
    records=[(LineString(np.reshape(flat,(-1,2))),gold) for flat,gold in raw]
    zones=[[],[]]
    for ink in [0,1]:
        marks=[g for g,k in records if k==ink]
        tree=shapely.STRtree(marks)
        for i,line in enumerate(marks):
            zones[ink].append(line.buffer(.86,cap_style='square',quad_segs=2))
            if ink or not 2.<line.length<5.9:continue
            vector=np.array(line.coords[-1])-line.coords[0]
            direction=vector/np.linalg.norm(vector)
            center=np.asarray(line.centroid.coords[0])
            for j in tree.query(line,predicate='dwithin',distance=8.8):
                if j<=i:continue
                other=marks[j]
                if not 2.<other.length<5.9:continue
                run=np.array(other.coords[-1])-other.coords[0]
                gap=np.asarray(other.centroid.coords[0])-center
                if abs(run@direction)<.986*np.linalg.norm(run) or abs(gap@[-direction[1],direction[0]])>.43:continue
                if not 5.8<abs(gap@direction)<11.7:continue
                zones[ink].append(LineString([center,center+gap]).buffer(.88,cap_style='flat'))
    return records,[shapely.union_all(parts) for parts in zones]
