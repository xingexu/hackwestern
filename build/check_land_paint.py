import base64
import json

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import box

import campus_region as region
import street_finishes as finish


def load(name):
    return json.loads(region.OUT.with_name(name+'.json').read_bytes())


def triangles(encoded,left,top):
    points=np.frombuffer(base64.b64decode(encoded),dtype='<u2').reshape(-1,3,2)/128+[left,top]
    return shapely.polygons(points)


terrain=load('campus-region')
surface=load('surface-tiles')
network=load('drive-network')
road=finish.coverage(surface['carriageway'])
_,_,_,cross,clear,_,_=finish.source_layers(network,load('municipal-detail'),load('region-detail'),load('street-detail'),road)
junctions=STRtree(clear.geometry)
controls=STRtree(cross.geometry)
paints=forbidden=0
accessible_area=0
for key,(left,top,right,bottom) in finish.patches(terrain['xs'],terrain['zs']):
    frame=box(left,top,right,bottom)
    no_lane=shapely.union_all(junctions.geometries[junctions.query(frame)]).buffer(-.012)
    permitted=shapely.union_all(controls.geometries[controls.query(frame)]).buffer(.012)
    white,amber,stalls,yellow_stalls,accessible=surface['strokes'][key]
    regular=shapely.union_all(triangles(stalls,left,top))
    amber_stalls=shapely.union_all(triangles(yellow_stalls,left,top))
    blue=shapely.union_all(triangles(accessible,left,top))
    assert blue.buffer(-.012).intersection(regular.union(amber_stalls)).area<.0001,key+' accessible symbol overlaps stall lines'
    accessible_area+=blue.area
    assert regular.intersection(amber_stalls.buffer(-.012)).area<.0001,key+' contrasting parking stripes overlap'
    w=triangles(white,left,top)
    a=triangles(amber,left,top)
    white_paint=shapely.union_all(w)
    center_paint=shapely.union_all(a)
    assert white_paint.intersection(center_paint).area<.0001,key+' contrasting stripes overlap'
    assert no_lane.intersection(center_paint).area<.0001,key+' centre line crosses a junction'
    assert no_lane.difference(permitted).intersection(white_paint).area<.0001,key+' unapproved stripe inside a junction'
    forbidden+=len(junctions.query(frame))
    paints+=len(w)+len(a)
assert paints>20000 and forbidden>150 and accessible_area>6
print(f'{paints:,} packed road triangles, {forbidden:,} junction and crossing exclusions, zero conflicting white/yellow paint area.')
