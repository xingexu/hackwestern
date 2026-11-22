import json
from functools import lru_cache

import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString,Polygon

import campus_region as region
from ortho_road_paint import pigment
from parking_stripes import lot_mask


def measured_edge(a,b):
    a,b=np.asarray(a),np.asarray(b)
    delta=b-a
    length=np.linalg.norm(delta)
    if length<.25:return False
    n=np.array([-delta[1],delta[0]])/length
    points=a+np.linspace(.04,.96,max(12,int(length*6)))[:,None]*delta
    colors=pigment(points)
    sides=(pigment(points-.32*n)+pigment(points+.32*n))*.5
    gain=(colors-sides)@np.array([.35,.53,.12])
    amber=(colors-sides)@np.array([.48,.46,-.94])
    return np.mean((gain>5)|(amber>4))>.46


@lru_cache(maxsize=1)
def bay_floors():
    source=region.OUT.parents[1]/'build'
    def read(name):return json.loads((source/f'survey_{name}.json').read_bytes())
    raw=read('parking')
    measured=[*raw['lines'],*raw['amber']]
    for group in [read('bays')['rows'],read('lot_markings')['dividers'],read('parking_ink'),
                  read('parking_archive')['dividers'],read('retained_parking'),read('parking_grids')]:
        measured.extend(record[0] for record in group)
    for aisle in read('aisle_paint'):
        if not aisle['kerbside']:
            measured.extend(coords for coords,ink,contrast,neighbours,row in aisle['lines'] if neighbours)
    rows=np.asarray(measured).reshape(-1,2,2)
    centers=rows.mean(axis=1)
    delta=rows[:,1]-rows[:,0]
    lengths=np.linalg.norm(delta,axis=1)
    unit=delta/np.maximum(.1,lengths)[:,None]
    index=cKDTree(centers)
    panels=[]
    for i,(center,axis,length) in enumerate(zip(centers,unit,lengths)):
        if not 2.4<length<13:continue
        normal=np.array([-axis[1],axis[0]])
        for j in index.query_ball_point(center,6.4):
            if j<=i or not 2.4<lengths[j]<13 or abs(unit[j]@axis)<.994:continue
            delta=centers[j]-center
            lateral=delta@normal
            if not 2.20<abs(lateral)<3.9:continue
            aligned=rows[j] if unit[j]@axis>0 else rows[j,::-1]
            if 3.2<length<7.7 and .78<length/lengths[j]<1.27 and abs(delta@axis)<=.85:
                corners=[*rows[i],*aligned[::-1]]
            else:
                offsets=(aligned-center)@axis
                first,last=max(-length*.5,offsets[0]),min(length*.5,offsets[1])
                if last-first<2.45:continue
                a,b=center+first*axis,center+last*axis
                fraction=(np.array([first,last])-offsets[0])/(offsets[1]-offsets[0])
                near,far=aligned[0]+fraction[:,None]*(aligned[1]-aligned[0])
                corners=[a,b,far,near]
            panel=Polygon(corners)
            if panel.is_valid:panels.append(panel.buffer(.22,join_style='mitre'))
    return shapely.union_all(panels).intersection(lot_mask())


def painted_frontages(network):
    from campus_bounds import footprint
    from parcel_surfaces import cartography
    from planting_verges import material_fractions

    layers=cartography(network,footprint())
    lots=lot_mask(network=network).buffer(.28)
    record=json.loads((region.OUT.parents[1]/'build/parking_paint_observations.json').read_bytes())
    paint=shapely.union_all([LineString(row) for row in record['lines']])
    faces=layers['faces']
    rims=layers['rim']
    additions=[]
    for i in faces.query(paint,predicate='intersects'):
        face=faces.geometries[i]
        outer=face.difference(lots)
        if not 2<outer.area<550 or outer.intersection(paint).length<.85:
            continue
        if outer.intersection(lots.buffer(6.5)).area<.90*outer.area:
            continue
        boundary=face.boundary
        if boundary.intersection(lots.buffer(.4)).length<2.5:
            continue
        surveyed=rims.query(boundary,predicate='dwithin',distance=.35)
        if not len(surveyed):
            continue
        kerb=shapely.union_all(rims.geometries[surveyed]).buffer(.35)
        if boundary.intersection(kerb).length<max(3,.15*boundary.length):
            continue
        fractions=material_fractions(outer)
        if fractions is None:
            continue
        planted,paving=fractions
        if np.count_nonzero((paving>.45)&(planted<.32))<2:
            continue
        additions.append(face)
    return shapely.union_all(additions)


def registered_aprons(network):
    from building_access import polygon
    return shapely.union_all([polygon(area['rings']) for area in network['areas']
                              if str(area['id']).startswith('city-painted-parking-')])
