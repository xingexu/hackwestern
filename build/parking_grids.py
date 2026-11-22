import json

import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString,Polygon

from ortho_road_paint import pigment
from parking_archive import OUT,present_day,scan_epochs
from parking_stripes import lot_mask

SOURCE=OUT.parent
OUTPUT=SOURCE/'survey_parking_grids.json'


def measured_grids(records):
    endpoints=np.asarray([row[0] for row in records]).reshape(-1,2,2)
    centers=endpoints.mean(axis=1)
    delta=endpoints[:,1]-endpoints[:,0]
    lengths=np.linalg.norm(delta,axis=1)
    axes=delta/lengths[:,None]
    index=cKDTree(centers)
    observations=[]
    for i,(center,axis) in enumerate(zip(centers,axes)):
        if not 2.7<lengths[i]<13.3:continue
        near=np.asarray(index.query_ball_point(center,23))
        along=(centers[near]-center)@axis
        near=near[(abs(axes[near]@axis)>.997)&(abs(along)<2)&(lengths[near]>2.8)]
        if len(near)<4:continue
        normal=np.array([-axis[1],axis[0]])
        offsets=(centers[near]-center)@normal
        fitted=fit_spacing(near,offsets)
        if fitted is None:continue
        spacing,peers,slots=fitted
        aligned=np.where(((axes[peers]@axis)<0)[:,None,None],endpoints[peers,::-1],endpoints[peers])
        ranges=(aligned-center)@axis
        longest=np.argsort(lengths[peers])[-max(3,len(peers)//2):]
        common=np.median(ranges[longest],axis=0)
        measured=(endpoints[i]-center)@axis
        start,end=min(common[0],measured[0]),max(common[1],measured[1])
        if start< -5.8 or end>5.8 or end-start>10.9:continue
        section=center+np.array([start,end])[:,None]*axis
        spectra,_,_=present_day(section)
        stations=np.linspace(*section,14)
        shoulders=stations[None,:,:]+normal*spacing*np.array([-.70,-.5,-.30,.30,.5,.70])[:,None,None]
        colors=pigment(shoulders.reshape(-1,2)).reshape(6,14,3)
        light=colors@np.array([.29,.55,.16])
        vehicles=((light<122)|(np.ptp(colors.astype(float),axis=2)>42)).reshape(2,3,14).mean(axis=(1,2))
        visible=spectra[0][0]
        strongest=max(spectra,key=lambda row:row[0])
        if not (visible>.29 or min(vehicles)>.23 or max(vehicles)>.44 and strongest[0]>.19):continue
        ink=int(strongest[1]>.44) if strongest[0]>.58 else records[i][1]
        observations.append([section.ravel().round(2).tolist(),ink,[round(visible,2),round(min(vehicles),2),round(spacing,2),slots]])
    return observations


def fit_spacing(neighbours,offsets):
    best=None
    for spacing in np.arange(2.43,3.43,.025):
        slots=np.rint(offsets/spacing).astype(int)
        fit=np.abs(offsets-spacing*slots)<.22
        supported=np.unique(slots[fit])
        if len(supported)<4 or np.ptp(supported)>2*len(supported) or np.count_nonzero(np.diff(supported)==1)<2:continue
        score=len(supported)-np.mean(np.abs(offsets[fit]-spacing*slots[fit]))
        if best is None or score>best[0]:best=(score,spacing,neighbours[fit],len(supported))
    return None if best is None else best[1:]


def continued_dividers(observations,lots):
    guides={}
    for row in observations:
        coords,_,proof,year=row
        ends=np.reshape(coords,(-1,2))
        delta=ends[1]-ends[0]
        length=np.linalg.norm(delta)
        axis=delta/length
        center=ends.mean(axis=0)
        angle=np.arctan2(axis[1],axis[0])%np.pi
        key=(*np.floor(center/13).astype(int),round(angle/.14),round(length/2.5))
        score=proof[3]+min(length,6)/4+proof[0]+(year-2020)*.12
        if key not in guides or score>guides[key][0]:guides[key]=(score,year,proof,center,axis,length)
    continuations=[]
    for _,year,proof,center,axis,length in guides.values():
        normal=np.array([-axis[1],axis[0]])
        spacing=proof[2]
        epochs=[year,2025] if year!=2025 else [2025,2024]
        for slot in range(-12,13):
            if slot==0:continue
            mid=center+normal*(slot*spacing)
            ends=mid+np.array([-.5,.5])[:,None]*axis*length
            if not lots.covers(LineString(ends)):continue
            best=None
            for offset in (-.22,0,.22):
                section=ends+normal*offset
                samples,occupied,flanked=present_day(section,epochs)
                source,today=samples if year!=2025 else samples[::-1]
                if source[2]<.44 or source[0]<.48 or max(source[0],today[0])<.63:continue
                pigment_seen=today[0]>.42 and today[2]>.4
                parked=source[0]>.64 and flanked>.32 and occupied>.48
                if not (pigment_seen or parked):continue
                score=source[0]+today[0]+flanked*.6+min(1,source[2])*.25
                ink=int(max(samples,key=lambda v:v[0])[1]>.45)
                if best is None or best[0]<score:best=(score,section,ink,today[0],flanked)
            if best is None:continue
            _,section,ink,visible,occupied=best
            continuations.append([section.ravel().round(2).tolist(),ink,[round(visible,2),round(occupied,2),spacing,proof[3]],year])
    return continuations


def registered_rows():
    def read(name):return json.loads((SOURCE/f'survey_{name}.json').read_bytes())
    stripes=read('parking')
    rows=stripes['lines']+stripes['amber']
    for group in [read('bays')['rows'],read('lot_markings')['dividers'],read('parking_ink'),read('parking_archive')['dividers'],read('retained_parking')]:
        rows.extend(record[0] for record in group)
    return [LineString(np.reshape(coords,(-1,2))) for coords in rows]


def survey(epochs):
    lots=lot_mask()
    rows=[]
    for year in [2025,2024,2021,2020]:
        rows.extend([*record,year] for record in measured_grids(epochs[year]))
    rows.extend(continued_dividers(rows,lots))
    islands=shapely.union_all([Polygon(row['outer']) for row in json.loads((SOURCE/'survey_islands.json').read_bytes())]).buffer(.22)
    existing=registered_rows()
    index=shapely.STRtree(existing)
    extra=[]
    for coords,ink,proof,year in sorted(rows,key=lambda r:(-r[2][-1],-r[2][0],-r[3])):
        line=LineString(np.reshape(coords,(-1,2)))
        if not lots.covers(line) or line.intersects(islands):continue
        near=list(index.geometries[index.query(line,predicate='dwithin',distance=.57)])
        near.extend(part for part in existing[len(index.geometries):] if part.distance(line)<.57)
        if near:line=line.difference(shapely.union_all([part.buffer(.44,cap_style='square') for part in near]))
        for part in shapely.get_parts(line):
            if part.geom_type!='LineString' or part.length<1.90:continue
            extra.append([np.asarray(part.coords).ravel().round(2).tolist(),ink,proof,year])
            existing.append(part)
        if len(existing)-len(index.geometries)>90:index=shapely.STRtree(existing)
    return extra


if __name__=='__main__':
    rows=survey(scan_epochs())
    OUTPUT.write_text(json.dumps(rows,separators=(',',':')))
    print(len(rows),'photographed parking grid segments;',sum(row[1] for row in rows),'yellow.')
