import json
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from building_camera import main as camera_poses

ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(dir=ROOT/".agent") as folder:
    start=time.monotonic()
    result=subprocess.run(["node","web/dev/building_preview.mjs","--id","w118764099","--spec","build/specs/buildings/w118764099.json","--out",folder],cwd=ROOT,check=True,text=True,stdout=subprocess.PIPE)
    assert time.monotonic()-start<20,"Single offline building preview exceeded 20 seconds"
    poses=json.loads((Path(folder)/"w118764099-camera-poses.json").read_text())
    assert sum(p["result"]=="paired" for p in poses)==6
    assert all(p["visibleFacadeSamples"]>0 for p in poses if p["result"]=="paired")
    references=json.loads((ROOT/"data/buildings/preview-poses.json").read_bytes())
    records=json.loads((ROOT/"web/campus-buildings.json").read_bytes())
    assert {b["id"] for b in records if b["parts"]} <= set(references)
    recorded=json.loads((Path(folder)/"w118764099-obliques.json").read_bytes())
    assert recorded==references["w118764099"]
    for frame in references.values():
        assert set(frame)=={"ne","nw","se","sw"}
        for pose in frame.values():
            assert np.all(np.isfinite([pose["eye"],pose["target"]])) and np.linalg.norm(np.subtract(pose["eye"],pose["target"]))>4
    outputs=list(Path(folder).glob("*.jpg"))
    assert len(outputs)==11
    for file in outputs:
        im=Image.open(file)
        assert im.width>=400 and im.height>=250
        sample=np.array(im.convert("RGB").resize((96,72)))
        assert sample.std()>12, f"Blank render {file.name}"
        if "street-" in file.name or "aerial" in file.name:
            real=sample[:,:48].astype(float)
            model=sample[:,48:].astype(float)
            assert np.abs(real-model).mean()>6 and model.std()>12
    print(result.stdout.splitlines()[-1],len(outputs),"nonblank offline views")
    references=camera_poses(["138541401","131414491","131414011","89741257"])
    for frame,pose in references.items():
        assert pose["calibration"]=="surveyed-roof-silhouette"
        assert pose["skylineColumns"]>=20 and pose["skylineResidualDegrees"]<=1.5,frame
    road=camera_poses(["33519595","131415165"])
    assert road["33519595"]["registrationScore"]>.85 and road["33519595"]["registeredPixels"]>100
    assert "registrationScore" not in road["131415165"] and 9<road["131415165"]["laneDisplacement"]<12
    print("Four photo horizons aligned to independent airborne roof returns",[(k,p["skylineResidualDegrees"]) for k,p in references.items()])
    subprocess.run(["node","web/dev/building_preview.mjs","--id","w147379460","--shadow-reference","--out",folder],cwd=ROOT,check=True,stdout=subprocess.PIPE)
    def luminance(suffix):
        return np.asarray(Image.open(Path(folder)/f"w147379460-ne{suffix}.jpg").convert("L"),dtype=float)
    actual_shadow=luminance("")-luminance("-unshadowed")
    actual_control=luminance("-shadow-control")
    unshadowed=luminance("-unshadowed")
    receivers=[]
    for y in range(254,358,8):
        for x in range(360,520,16):
            patch=unshadowed[y:y+8,x:x+16]
            if patch.std()<1.8 and patch.mean()>135:
                receivers.append((x,y))
    assert len(receivers)>=15,"Elborn's surveyed central and southern roofs must provide exposed flat receivers"
    actual_patches=[actual_shadow[y:y+8,x:x+16].std() for x,y in receivers]
    actual_flat=[actual_control[y:y+8,x:x+16].std() for x,y in receivers]
    assert np.percentile(actual_patches,80)<1.8,f"Rendered campus roof shadow banding: {actual_patches}"
    assert np.median(actual_flat)<1.8,f"Rendered campus roof control banding: {actual_flat}"
    spec=json.loads((ROOT/"build/specs/buildings/w147379460.json").read_bytes())
    roof_spec={"form":"flat","edge":"none","features":[],"material":"roof"}
    spec.update(massing={"parts":[{"footprint":"inventory","height":11.2,"roof":roof_spec}]},roof=roof_spec,attachments=[],towers=[],entrances=[],lidarTrusted=False,lidarNote="Flat roof calibration surface at the central roof elevation.")
    path=Path(folder)/"calibration-spec.json"
    path.write_text(json.dumps(spec))
    subprocess.run(["node","web/dev/building_preview.mjs","--id","w147379460","--spec",str(path),"--shadow-reference","--out",folder],cwd=ROOT,check=True,stdout=subprocess.PIPE)
    roof=luminance("-shadow-control")
    shadows=luminance("")-luminance("-unshadowed")
    shadow_patches=[shadows[y:y+8,x:x+16].std() for x,y in [(407,287),(427,301),(417,281),(454,309),(468,290)]]
    assert np.median(shadow_patches)<1.8,f"Rendered Elborn shadow banding: {shadow_patches}"
    patches=[roof[y:y+8,x:x+16].std() for x,y in [(407,287),(427,301),(417,281),(454,309),(468,290)]]
    assert np.median(patches)<1.8,f"Flat Elborn roof has shadow banding: {patches}"
    print("Elborn oblique roof luminance deviation",round(np.median(patches),2))

    def concurrent_preview(building):
        out=Path(folder)/building
        command=["node","web/dev/building_preview.mjs","--id",building,"--out",str(out)]
        response=subprocess.run(command,cwd=ROOT,check=True,stdout=subprocess.PIPE,text=True)
        observed=json.loads((out/f"{building}-camera-poses.json").read_bytes())
        assert len(list(out.glob("*.jpg")))==5+sum(p["result"]=="paired" for p in observed)
        assert all((out/f"{building}-{pose}.jpg").is_file() for pose in ("nw","ne","sw","se","aerial"))
        if building=="w118764094":
            assert {"136654829","373912868"} <= {pose["id"] for pose in observed}
        return float(response.stdout.splitlines()[-1].split()[0])
    burst=["w558927474","w1346111803","w142216959","w147379378","c3705","w123525190","w118764108","w778714502","w142286181","w310132539","r21319537-0","w118764094"]
    with ThreadPoolExecutor(max_workers=len(burst)) as pool:
        times=list(pool.map(concurrent_preview,burst))
    assert max(times)<20,f"Concurrent offline building previews exceeded 20 seconds: {times}"
    print(len(times),"simultaneous building previews",min(times),"to",max(times),"seconds")
