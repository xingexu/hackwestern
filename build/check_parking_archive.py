import base64
import json
import zlib

import numpy as np
import shapely
from shapely.geometry import LineString,Point

import campus_region as region
from bake_ground_surfaces import restore_survey_inventory
from parking_stripes import lot_mask


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
assert at(woods,-135,120)==2 and 45<at(duff,-135,120)<210
assert at(woods,520,603)==2 and at(duff,520,603)>225
shaded=np.frombuffer(zlib.decompress(base64.b64decode(shade['shadedLawn'])),'uint8').reshape(duff.shape)
assert at(shaded,530,-321)>230 and at(shaded,520,603)<10 and at(shaded,322.3,1054.8)==0
print(len(records),'registered multi-year dividers, four occupied-row controls, a retained forest stand and an isolated park tree.')

original={'shrubs':[[1,2]],'observations':{'trees':[[3,4]],'lamps':[[5,6]],'sports':{'old':1}},'context':{'trees':'tree-bytes','cover':'old-ground'}}
updated={'shrubs':[],'observations':{'trees':[],'sports':{'new':2}},'context':{'trees':'other','cover':'new-ground'}}
restore_survey_inventory(updated,original)
assert updated=={'shrubs':[[1,2]],'observations':{'trees':[[3,4]],'lamps':[[5,6]],'sports':{'new':2}},'context':{'trees':'tree-bytes','cover':'new-ground'}}
