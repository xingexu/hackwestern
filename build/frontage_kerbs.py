import json
import math

import numpy as np
import shapely
from shapely.geometry import LineString

from kerb_islands import observed as islands
from ortho_road_paint import pigment
from parcel_surfaces import municipal_lines


def survey(site,city):
    existing=shapely.union_all([city.boundary,*[p.boundary for p,_ in islands()]]).buffer(.72)
    records=[]
    geometry=[]
    for kind in ['parking','driveway']:
        for feature in municipal_lines(kind,site):
            for part in shapely.get_parts(feature.intersection(site).difference(existing)):
                if part.geom_type!='LineString' or part.length<3.5:continue
                stations=np.linspace(0,part.length,math.ceil(part.length/1.6)+1)
                points=shapely.get_coordinates(shapely.line_interpolate_point(part,stations))
                steps=np.diff(points,axis=0)
                lengths=np.linalg.norm(steps,axis=1)
                normals=np.column_stack([steps[:,1],-steps[:,0]])/np.maximum(.02,lengths)[:,None]
                centers=(points[1:]+points[:-1])*.5
                offset=np.array([-.42,-.78,-1.18,.42,.78,1.18])
                samples=centers[:,None,:]+normals[:,None,:]*offset[None,:,None]
                native=np.median(pigment(samples.reshape(-1,2)).reshape(-1,2,3,3),axis=2)
                r,g,b=native.transpose(2,0,1)
                lum=(r+g*2+b)*.25
                hard=(lum>89)&(r-g<13)&(g-r<5)&(r-b<.14*lum+6)
                soft=((g-r>5)&(g-b>12)|(g-b>.12*lum+5)&(r-b>.18*lum+7))&(lum>46)
                rim=(pigment(centers)*[.28,.54,.18]).sum(axis=1)
                for side,inward in [(0,-1),(1,1)]:
                    other=1-side
                    valid=hard[:,side]&soft[:,other]&(lum[:,side]>lum[:,other]+16)&(rim>lum[:,other]+13)
                    runs=np.flatnonzero(np.diff(np.r_[False,valid,False])).reshape(-1,2)
                    for a,b in runs:
                        if np.sum(lengths[a:b])<3.3:continue
                        line=LineString(points[a:b+1]).simplify(.10)
                        geometry.append(line)
                        records.append([np.array(line.coords).round(2).ravel().tolist(),inward])
    extend_parking_kerbs(site,existing,geometry,records)
    kept=[]
    tree=shapely.STRtree(geometry)
    for i,line in enumerate(geometry):
        overlaps=tree.query(line,predicate='dwithin',distance=.24)
        if any(j<i and geometry[j].buffer(.24).intersection(line).length>.62*line.length for j in overlaps):continue
        kept.append(records[i])
    return kept



def extend_parking_kerbs(site,existing,geometry,records):
    import campus_region as region
    from parcel_surfaces import cartography
    from parking_bays import registered_aprons

    network=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    layers=cartography(network,site)
    aprons=registered_aprons(network)
    if aprons.is_empty:
        return
    surveyed=layers['rim']
    filled=shapely.union_all([existing,shapely.union_all(geometry).buffer(.3)])
    envelope=aprons.boundary.buffer(.22).difference(filled)
    for idx in surveyed.query(envelope,predicate='intersects'):
        for line in shapely.get_parts(surveyed.geometries[idx].intersection(envelope)):
            if line.geom_type!='LineString' or line.length<1.9:
                continue
            stations=np.linspace(0,line.length,math.ceil(line.length/.75)+1)
            points=shapely.get_coordinates(shapely.line_interpolate_point(line,stations))
            delta=np.diff(points,axis=0)
            length=np.linalg.norm(delta,axis=1)
            normals=delta[:,[1,0]]*[1,-1]/np.maximum(.01,length)[:,None]
            centers=(points[:-1]+points[1:])*.5
            for sign in [-1,1]:
                inner=centers+normals*sign*.48
                outer=centers-normals*sign*.48
                separates=shapely.contains_xy(aprons,*inner.T)&~shapely.contains_xy(aprons,*outer.T)
                cuts=np.flatnonzero(np.diff(np.r_[False,separates,False])).reshape(-1,2)
                for start,end in cuts:
                    if sum(length[start:end])<1.9:
                        continue
                    edge=LineString(points[start:end+1]).simplify(.04)
                    geometry.append(edge)
                    records.append([np.asarray(edge.coords).round(2).ravel().tolist(),sign])
