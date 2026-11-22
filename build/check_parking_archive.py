import base64
import json
import zlib

import numpy as np
import shapely
from shapely.geometry import LineString,Point

import campus_region as region
from bake_ground_surfaces import restore_survey_inventory
from parking_stripes import lot_mask
from road_hatch_pigment import street_ink
from surveyed_aisles import parking_kerbs


root=region.OUT.parents[1]
archive=json.loads((root/'build/survey_parking_archive.json').read_bytes())
records=archive['dividers']
lines=[LineString(np.asarray(p).reshape(-1,2)) for p,_,_ in records]
tree=shapely.STRtree(lines)
assert archive['years']==[2020,2021,2024,2025] and len(records)>1100
floor=lot_mask().buffer(.015)
assert all(floor.covers(line) and 2.05<line.length<14.4 for line in lines)
for center,orientation in [((-133.0,525.65),(-.94,.34)),((-82.95,527.48),(-.95,.31)),((225.95,726.30),(.95,.32)),((320.04,978.07),(-.16,.99))]:
    candidates=tree.query(Point(center),predicate='dwithin',distance=.20)
    assert any(abs(np.diff(np.asarray(lines[i].coords),axis=0)[0]@orientation)/lines[i].length>.975 for i in candidates),center
for center,gold in [((-73.0,181.0),0),((-70.4,180.3),0),((572.1,447.2),1),((343.9,969.7),1)]:
    candidates=tree.query(Point(center),predicate='dwithin',distance=.12)
    assert any(records[i][1]==gold and min(records[i][2][:2])>=.73 for i in candidates),center
now=np.array([e for _,_,e in records])
assert np.median(now.max(axis=1))>=.57
sports=json.loads((root/'build/survey_sports.json').read_bytes())
for x,z in [(380,675),(364.7,725),(355.8,754),(393,830)]:
    assert not any(LineString(np.reshape(p,(-1,2))).distance(Point(x,z))<1 for p in sports['fieldEdgeMarks'])
land=json.loads(region.OUT.with_name('ground-materials.json').read_bytes())['landcover']
woods=np.frombuffer(zlib.decompress(base64.b64decode(land['samples'])),'uint8').reshape(land['height'],land['width'])
shade=land['pavingTone']
duff=np.frombuffer(zlib.decompress(base64.b64decode(shade['aggregate'])),'uint8').reshape(shade['height'],shade['width'],4)[:,:,3]
def at(image,x,z):
    l,t,r,b=land['bounds']
    return image[int((z-t)/(b-t)*image.shape[0]),int((x-l)/(r-l)*image.shape[1])]
continuations=json.loads((root/'build/survey_retained_parking.json').read_bytes())
assert len(continuations)>550 and np.median([r[2][1] for r in continuations])>.70
assert at(woods,-232,914) in (0,1) and at(woods,364.7,725)==1
assert shade['woodlandEdges'] and at(woods,530,-321) in (0,1) and at(duff,530,-321)<20
from parking_archive import dated_pigment
forest_edge=np.array([[-154,141],[-151,144],[-145,147]])
canopy=region.lidar('dsm')-region.lidar('dtm')
assert (region.sample(canopy,*forest_edge.T)>9).all()
for x,z in forest_edge:
    assert at(woods,x,z)==2 and 45<at(duff,x,z)<210
loading_yard=np.array([[-135.,120.]])
assert at(woods,*loading_yard[0])==4 and at(duff,*loading_yard[0])<20
for year in (2020,2021):
    assert dated_pigment(loading_yard,year).mean()>170
assert at(woods,520,603)==2 and at(duff,520,603)>225
shaded=np.frombuffer(zlib.decompress(base64.b64decode(shade['shadedLawn'])),'uint8').reshape(duff.shape)
assert at(shaded,530,-321)>230 and at(shaded,520,603)<10 and at(shaded,322.3,1054.8)==0
print(len(records),'registered multi-year dividers, four occupied-row controls, a retained forest stand and an isolated park tree.')

original={'shrubs':[[1,2]],'observations':{'trees':[[3,4]],'lamps':[[5,6]],'sports':{'old':1}},'context':{'trees':'tree-bytes','cover':'old-ground'}}
updated={'shrubs':[],'observations':{'trees':[],'sports':{'new':2}},'context':{'trees':'other','cover':'new-ground'}}
restore_survey_inventory(updated,original)
assert updated=={'shrubs':[[1,2]],'observations':{'trees':[[3,4]],'lamps':[[5,6]],'sports':{'new':2}},'context':{'trees':'tree-bytes','cover':'new-ground'}}


for x,z in [(470,-278),(500,-290),(507,-317)]:
    assert at(woods,x,z)==1,(x,z,'mapped baseball lawn')
for x,z in [(225,1510),(325,1435),(244,1263)]:
    assert at(woods,x,z)==8,(x,z,'surveyed synthetic turf')
for x,z in [(-277,12),(258,1397)]:
    assert at(woods,x,z)==10,(x,z,'sand pitch')
assert at(woods,245.5,952.5)==5
print('Natural grass, synthetic pitches, sand and the occupied Huron Flats parking bay retain their photographed materials.')

grids=json.loads((root/'build/survey_parking_grids.json').read_bytes())
for coords,amber,(visible,parked,spacing,peers),year in grids:
    assert floor.covers(LineString(np.asarray(coords).reshape(-1,2)))
    assert 2.42<spacing<3.44 and peers>=4 and year in archive['years']
assert len(grids)>650 and sum(row[1] for row in grids)>180
residential=json.loads((root/'build/survey_residential_centers.json').read_bytes())
ways={w['id']:w for w in json.loads((root/'web/drive-network.json').read_bytes())['ways']}
names={ways[way_id]['name'] for way_id,coords,support in residential}
assert {'Wellington Drive','Glenmore Drive'}<=names
assert names.isdisjoint({'Brescia Lane','Ramsay Road','Elgin Drive'})
assert all(support>=.53 and ways[way_id]['class']=='residential' for way_id,coords,support in residential)
print(len(grids),'parking dividers supported by repeated bay spacing and',len(residential),'photographed residential centreline sections.')


aisles=json.loads((root/'build/survey_aisle_paint.json').read_bytes())
assert len(aisles)>=8
assert sum(len(group['lines']) for group in aisles)>1600
assert sum(len(group['accessible']) for group in aisles)>=16
for group in aisles:
    physical_floor=parking_kerbs(group['lot']).buffer(.015) if group['kerbside'] else floor
    for coords,colour,strength,peers,row in group['lines']:
        line=LineString(np.reshape(coords,(2,2)))
        assert physical_floor.covers(line) and line.length>1.78,(group['lot'],coords)
        assert colour in (0,1) and strength>=1.8 and peers>=0 and row>=0
for coords,colour in [((-240.45,1124.95,-229.25,1119.95),1),((-234.15,1123.15,-230.85,1121.65),0),((-231.65,1124.95,-230.25,1124.35),None)]:
    assert street_ink(LineString(np.reshape(coords,(2,2))))==colour,coords
print('Eight surveyed parking areas retain their physical bounds, accessible pads and independently measured road paint colours.')
