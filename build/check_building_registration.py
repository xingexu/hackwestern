import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw
import building_roof_survey
from shapely import affinity
from shapely.geometry import Polygon, box

from compile_buildings import assemble, gable_windows, registered_inventory, roof_surface, survey_translation


root=Path(__file__).resolve().parents[1]
records={b["id"]:b for b in json.loads((root/"web/campus-buildings.json").read_text())}
inventory=box(0,0,12,8)
target=affinity.translate(inventory,8,-4)
ring=list(target.exterior.coords)[:-1]
walls=[]
outer=list(inventory.exterior.coords)[:-1]
for a,b in zip(outer,outer[1:]+outer[:1]):
    d=np.subtract(b,a)
    walls.append(dict(a=a,b=b,frames=[],faces="street",normal=[d[1]/np.linalg.norm(d),-d[0]/np.linalg.norm(d)]))
building=dict(id="rectangles",ground=0,heightP50=5,footprint=outer,holes=[],walls=walls,centroid=[6,4])
thin=box(10,-3,10.035,2)
baluster=box(10,1,10.034,1.036)
spec=records["c3705"]["spec"]|dict(entrances=[],towers=[],attachments=[],walls={"default":{"blank":True}},roof={"form":"flat"},evidence=[],massing={"parts":[{"footprint":ring,"height":5},{"footprint":list(thin.exterior.coords)[:-1],"height":2},{"footprint":list(baluster.exterior.coords)[:-1],"height":.90}]})
shift=survey_translation(spec,inventory)
assert np.allclose(shift,[8,-4])
aligned=registered_inventory(building,shift)
record=assemble(aligned,spec,target,[])
assert abs(record["footprintArea"]-target.area)<.001
assert set(record["parts"][0]["wallIds"][0])==set(range(4))
assert len(record["parts"][1]["rings"][0])==4
assert len(record["parts"][2]["rings"][0])==4
assert Polygon(record["parts"][1]["rings"][0]).symmetric_difference(thin).area<.00001
with TemporaryDirectory(dir=root/".agent") as folder:
    directory=Path(folder)/"data/buildings/evidence"/building["id"]
    directory.mkdir(parents=True)
    image=Image.new("RGB",(480,440),(55,69,105))
    imageBox=tuple(round((v+18)*10) for v in target.bounds)
    ImageDraw.Draw(image).rectangle(imageBox,fill=(204,96,65))
    image.save(directory/"aerial-source.jpg",quality=98)
    with patch.object(building_roof_survey,"ROOT",Path(folder)):
        sample=building_roof_survey.survey_roofs(record,building|{"surveyOutline":aligned["footprint"]})
    assert sample(18,2)[0]>190 and sample(4,6)[0]<70
    finish=record["parts"][0]["roofFinish"]["color"]
    assert int(finish[1:3],16)>int(finish[5:7],16)+35
surface=roof_surface(box(0,0,14,8),dict(form="gable",rise=3,ridge=90))
ends=[{"window":{"type":"punched","width":.8,"sill":.3,"height":3},"at":[0,3]},{"window":{"type":"punched","width":.8,"sill":.3,"height":3},"at":[0,5]}]
apertures=gable_windows(surface,ends,[7,4])
assert len(apertures)==1
holes=apertures[0]["openings"]
assert len(holes)==2 and abs(abs(holes[0]["u"]-holes[1]["u"])-2)<.01
assert all(.25<h["window"]["height"]<2.1 for h in holes)
dome=records["c31"]["parts"][0]
v=np.array(dome["surface"][0])
crown=v[v[:,1]>.95*v[:,1].max()]
assert len(crown)>3
assert np.ptp(crown[:,0])<np.ptp(v[:,0])*.92
print("Four registered wall profiles, orthophoto roof colour at the translated location, 35 mm rectangle, two laterally displaced attic windows below the rake, and dome end curvature verified")
