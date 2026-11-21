import base64
import json
import zlib

import numpy as np
import shapely
from shapely.geometry import LineString,Point,Polygon

import campus_region as region
from campus_bounds import footprint
from ortho_road_paint import pigment
from street_projection import Survey


def read(name):
    return json.loads(name.read_bytes())


survey=Survey()
domain=footprint()
records=read(region.OUT.parents[1]/'build/survey_pavement.json')
packed=read(region.OUT.with_name('surface-tiles.json'))['pavementSurvey']
for key in ('pads','tables','covers','ramps'):assert records[key]==packed[key],key
assert len(packed['ramps'])>=100 and len(packed['pads'])>=80
for x,z,dx,dz,w,h,tint,source in packed['pads']:
    assert domain.covers(Point(x,z)) and abs(dx*dx+dz*dz-1)<.01 and .25<=h<1.4
    assert min(np.hypot(x-a,z-b) for a,b,*_ in packed['ramps'])<1.11
native=[p for p in packed['pads'] if p[-1]=='orthophoto' and p[-2]=='red']
center=np.array([p[:2] for p in native])
normal=np.array([[-p[3],p[2]] for p in native])
middle=pigment(center)
surround=(pigment(center+.85*normal)+pigment(center-.85*normal))*.5
lift=middle-surround
assert np.median(lift[:,0]-lift[:,1])>5 and len(native)>40
for x,z in [(430.6,-363.7),(364.4,-429.4)]:
    record=min(packed['tables'],key=lambda p:np.hypot(x-p[0],z-p[1]))
    assert np.hypot(x-record[0],z-record[1])<.35 and record[4]>6 and .02<record[6]<.08
assert all(np.hypot(x-202,z-1715)>4 for x,z,*_ in packed['tables'])
assert len(packed['covers'])>=90 and {p[6] for p in packed['covers']}=={'cover','inlet'}
groups=[[Polygon(np.reshape(r,(-1,2))) for r in group] for group in records['crossings']]
crossing=min(groups,key=lambda g:shapely.union_all(g).centroid.distance(Point(-255,30)))
assert len(crossing)>=10 and max(p.distance(Point(-255,30)) for p in crossing)<10
mid=np.array([p.centroid.coords[0] for p in crossing]);assert (survey.classes(*mid.T)==1).all()
from parking_bays import bay_floors
from parking_stripes import lot_mask
parking=read(region.OUT.parents[1]/'build/survey_bays.json')
assert bay_floors().area>18000 and len(parking['rows'])>150 and len(parking['borders'])>6
bay_interiors=bay_floors().buffer(-.80)
for a,b in [((96.97,462.76),(92.91,465.55)),((-344.20,554.35),(-348.95,556.18))]:
    divider=LineString([a,b])
    assert divider.intersection(bay_interiors).length>divider.length*.75,(a,b)
area=lot_mask().buffer(.009)
assert all(area.covers(LineString(np.reshape(line,(2,2)))) for line,_,_ in parking['rows'])
markings=read(region.OUT.parents[1]/'build/survey_lot_markings.json')
hatching=[Polygon(outer,holes) for outer,*holes in markings['hatching']]
near=shapely.union_all([p for p in hatching if p.distance(Point(18,184))<8])
assert near.area>1.0 and len(shapely.get_parts(near))>=1
from carriageway_ink import measured_tracks
native_lanes,_=measured_tracks()
assert len(native_lanes)>120 and sum(ink for _,ink in native_lanes)>18
assert sum(g.length for g,ink in native_lanes if not ink and g.distance(Point(250,1653))<12)>6
for ink,point in [(0,(-180.76,463.69)),(0,(-210.44,478.71)),(1,(-68.72,610.44))]:
    assert min(line.distance(Point(point)) for line,color in native_lanes if color==ink)<.16
assert len(markings['dividers'])>=200 and len(markings['accessible'])>=40
ranks=read(region.OUT.parents[1]/'build/survey_parking_ink.json')
assert len(ranks)>120 and sum(ink for _,ink in ranks)>80
assert all(area.covers(LineString(np.reshape(row,(2,2)))) for row,_ in ranks)
panels=np.asarray([p['center'] for p in markings['accessible']])
assert np.min(np.linalg.norm(panels-[63.4,1184.3],axis=1))<.55
divider_lines=[LineString(np.reshape(flat,(-1,2))) for flat,_ in markings['dividers']]
assert all(min(p.distance(Point(63,z)) for p in divider_lines)<.28 for z in [1181.99,1186.60,1190.81])
blue=pigment(panels);assert np.median(blue[:,2]-blue[:,0])>5
extra_arrows=read(region.OUT.parents[1]/'build/survey_traffic_arrows.json')
assert any(park and gold and Polygon(np.reshape(r,(-1,2))).distance(Point(142,-327))<.6 for r,gold,park in extra_arrows)
assert any(not park and Polygon(np.reshape(r,(-1,2))).distance(Point(24,-306))<.75 for r,gold,park in extra_arrows)
assert len(records['hatches'])>150 and len(records['arrows'])>=10
islands=[(Polygon(p['ring']),p) for p in packed['islands']]
for xy in [(-35,225),(280,977)]:
    shape,data=next((p,item) for p,item in islands if p.covers(Point(xy)))
    mesh=shapely.polygons(np.asarray(data['triangles']).reshape(-1,3,2))
    assert abs(shapely.area(mesh).sum()-shape.buffer(-.15,quad_segs=3).area)<.12 and data['kind']==1
assert len(islands)>=40 and len(packed['kerbs'])>=40 and len(packed['seams'])>=60
seams=np.asarray([line for line,_ in packed['seams']]).reshape(-1,2,2)
mid=seams.mean(axis=1);d=seams[:,1]-seams[:,0];n=np.c_[-d[:,1],d[:,0]]/np.linalg.norm(d,axis=1)[:,None]
base=(pigment(mid+n*.35)+pigment(mid-n*.35))*.5
assert np.median((base-pigment(mid)).mean(axis=1))>5
land=read(region.OUT.with_name('ground-materials.json'))['landcover']
stadium=next(iter(land['observations']['sports']['gridiron'].values()))
endfills=[Polygon(zone['fill']) for zone in stadium['ends']]
assert all(850<p.area<1250 and p.area<p.minimum_rotated_rectangle.area*.99 for p in endfills)
assert len(stadium['ticks'])>170 and len(stadium['soccer'])>=6
assert len(stadium['numbers'])>200 and len(stadium['light'])>30
crest=shapely.union_all(shapely.polygons(stadium['crest']))
assert 65<crest.area<205 and crest.distance(Point(244,1262))<1
wet_network=read(region.OUT.with_name('drive-network.json'))
wet=shapely.union_all([Polygon(np.reshape(p,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for p,*holes in wet_network['water']])
banks=[(364.7,1114.4),(621.7,578.8),(661.6,-6.9),(368.1,1047.4),(744.2,403.2)]
watermask=np.frombuffer(zlib.decompress(base64.b64decode(land['samples'])),'uint8').reshape(land['height'],land['width'])
left,top,right,bottom=land['bounds']
for x,z in banks:
    assert wet.covers(Point(x,z)) and watermask[int((z-top)/(bottom-top)*land['height']),int((x-left)/(right-left)*land['width'])]==6
tone=land['pavingTone']
channels=np.frombuffer(zlib.decompress(base64.b64decode(tone['aggregate'])),'uint8').reshape(tone['height'],tone['width'],4)
assert np.count_nonzero(channels[:,:,1]>160)>20000 and np.count_nonzero(channels[:,:,2]>200)>10000
assert np.array_equal(channels[:,:,0].ravel(),np.frombuffer(zlib.decompress(base64.b64decode(tone['samples'])),'uint8'))
belt=land['context']
cols,rows=belt['size']
west,north,east,south=belt['bounds']
coverage=np.frombuffer(zlib.decompress(base64.b64decode(belt['coverage'])),'uint8').reshape(rows,cols,4)
for x,z,channel in [(70.23,-443.29,0),(59.24,-428.29,2),(425.17,-535.28,0)]:
    assert not domain.covers(Point(x,z))
    assert coverage[int((z-north)/(south-north)*rows),int((x-west)/(east-west)*cols),channel]>210
condition=land['pavementDetail']
detail=np.frombuffer(zlib.decompress(base64.b64decode(condition['samples'])),'uint8').reshape(condition['height'],condition['width'],4)
assert np.count_nonzero(detail[:,:,0]>65)>9000 and np.count_nonzero(detail[:,:,1])>25
assert np.count_nonzero(np.abs(detail[:,:,2].astype(int)-128)>90)>80000
assert survey.classes(np.array([629.]),np.array([336.]))[0]==2
print(f"{len(packed['ramps'])} kerb openings, {len(native)} red optical registrations, {len(islands)} surveyed raised islands, {len(packed['kerbs'])} private kerbs and {len(seams)} photographed repairs.")

from sidewalk_ribbons import inventory as registered_walks

walks=registered_walks()
assert len(walks.geometries)>250
controls=np.array([[4.46,620.20],[4.92,625.72],[467.04,150.38],[425.92,256.28]])
assert all(any(walks.geometries[k].contains(Point(p)) for k in walks.query(Point(p))) for p in controls)
assert list(survey.classes(*controls.T))==[2,2,2,2]
assert land['observations']['sports']==read(region.OUT.parents[1]/'build/survey_sports.json')
print('Paired kerb-edge footways',len(walks.geometries),'continuous pavement at four independently registered surveyed breaks.')
