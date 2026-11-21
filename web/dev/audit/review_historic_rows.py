import math
import re

import numpy as np
import shapely
from shapely.geometry import LineString,box

from review_land import ROOT,read


def archive_reference():
    folder=ROOT/'data/audit/frozen-parking'
    if not (folder/'registered-2021.json').exists() or not (folder/'registered-2020.json').exists():return
    refs=[[LineString(np.reshape(r[0],(-1,2))) for r in read(folder/f'registered-{year}.json')] for year in [2021,2020]]
    finder=shapely.STRtree(refs[1])
    candidates=[]
    for line in refs[0]:
        pair=np.asarray(line.coords);v=pair[1]-pair[0];axis=v/line.length;n=np.array([-axis[1],axis[0]])
        for i in finder.query(line,predicate='dwithin',distance=.18):
            older=np.asarray(refs[1][i].coords)
            d=older[1]-older[0]
            if abs((d/np.linalg.norm(d))@axis)<.994:continue
            separation=(older-pair[0])@n
            if np.max(np.abs(separation))>.28:continue
            s=(older-pair[0])@axis
            a=max(0,s.min());b=min(line.length,s.max())
            if b-a>2.85:candidates.append(LineString(pair[0]+np.array([a,b])[:,None]*axis+np.median(separation)*.5*n))
    retained=[]
    tree=shapely.STRtree([])
    for line in sorted(candidates,key=lambda g:-g.length):
        if any(tree.geometries[i].buffer(.31,cap_style='flat').intersection(line).length>1.75 for i in tree.query(line,predicate='dwithin',distance=.3)):continue
        if any(l.distance(line)<.3 and l.buffer(.31,cap_style='flat').intersection(line).length>1.75 for l in retained[len(tree.geometries):]):continue
        retained.append(line)
        if len(retained)-len(tree.geometries)>85:tree=shapely.STRtree(retained)
    return shapely.STRtree(retained)


def sample_line(line,im,west,north):
    a,b=np.asarray(line.coords)-[west,north]
    axis=(b-a)/line.length;normal=np.array([-axis[1],axis[0]])
    xy=a+np.linspace(.05,.95,42)[:,None]*(b-a)
    def sample(offset):
        pixels=np.rint((xy+normal*offset)*10-.5).astype(int).clip(0,499)
        return im[pixels[:,1],pixels[:,0]].astype('float32')
    bg=(sample(-.42)+sample(.42))*.5
    traces=[]
    for shift in np.arange(-.20,.201,.05):
        center=sample(shift)
        light=(center-bg)@np.array([.29,.55,.16])
        tint=(center-bg)@np.array([.5,.5,-1.])
        traces.append((light>11)|((tint>12)&(light>2)))
    return float(np.max(np.mean(traces,axis=1)))


def row_coverage(reference,views,west,north):
    if reference is None:return
    extent=box(west+.5,north+.5,west+49.5,north+49.5)
    groups=[]
    for i in reference.query(extent,predicate='intersects'):
        line=reference.geometries[i].intersection(extent)
        if line.geom_type!='LineString' or line.length<2.65:continue
        c=np.asarray(line.coords).mean(0)
        scores=[sample_line(line,im,west,north) for im in views]
        groups.append([c.round(2).tolist(),round(line.length,2),*[round(s,3) for s in scores]])
    return groups


def evaluate(row,observed):
    if not observed:return
    text=(row.get('note2') or row['description']).lower()
    if not re.search(r'stalls?|parking (?:paint|lines?|bays?|strip)',text):return
    if re.search(r'hatch|island|kerb|curb|cars (?:are )?missing|no (?:parked )?cars|and (?:no |missing )(?:cars|light|lamp|poles)|no markings and no parked|arrows?|texture|no access road|drive aisle|broken|orientation|inconsistent angles|yellow|amber|blue|wheelchair|accessible|stall.{0,14}(?:wide|narrow)|extends? (?:over|off)|spills? onto|inte[rn]sections?',text):return
    crop=re.search(r'x\s*(-?\d+(?:\.\d+)?)\s*(?:to|\.\.|[-–])\s*(-?\d+(?:\.\d+)?).*?z\s*(-?\d+(?:\.\d+)?)\s*(?:to|\.\.|[-–])\s*(-?\d+(?:\.\d+)?)',text)
    if crop:
        l,r,n,s=map(float,crop.groups())
        observed=[v for v in observed if min(l,r)<=v[0][0]<=max(l,r) and min(n,s)<=v[0][1]<=max(n,s)]
    specified=re.search(r'(?:about |roughly |shows? )(\d{1,3}) (?:marked |painted )?(?:stalls?|bays?|spaces?)',text)
    minimum=max(9,math.ceil(.89*int(specified.group(1))) if specified else 0)
    if len(observed)<minimum:return
    def fraction(k):return sum(r[k]>.69 for r in observed)/len(observed)
    percentages=[fraction(j) for j in range(2,len(observed[0]))]
    if percentages[-1]<.89:return
    if len(percentages)==3:
        if percentages[1]>.89:return 'absent-on-lane-baseline','double-dated-divider-coverage'
        if percentages[-1]-percentages[1]>.20:return 'fixed-in-land5','double-dated-divider-coverage'
    else:
        if percentages[0]>.89:return 'already-fixed','double-dated-divider-coverage'
        if percentages[-1]-percentages[0]>.20:return 'fixed','double-dated-divider-coverage'
