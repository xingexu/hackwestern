import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import Affine
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

import campus_region as region
from streetview_pose import calibrate


def roof_reference(root):
    source=root/"buildings/lidar/roof-grid.npz"
    dem=root/"region/regional-dtm.npy"
    if not source.exists() or not dem.exists():
        return None
    with np.load(source) as data:
        surface=data["surface"]
        left,top=data["origin"]
    buildings=json.loads((root/"buildings/inventory.json").read_bytes())["buildingsList"]
    outlines=[]
    for b in buildings:
        poly=Polygon(b["footprint"],b["holes"]).buffer(-.4)
        if not poly.is_empty:outlines.append((poly,b["groundAbsolute"]+max(b["heightP90"]+6,b["heightMax"])))
    limits=rasterize(outlines,out_shape=surface.shape,transform=Affine.translation(left,top),fill=0,dtype="float32")
    return np.where((limits>0)&(surface<=limits),surface,-np.inf),left,top,np.load(dem,mmap_mode="r")


def registered_pitch(frame,labels,pose,reference):
    transition=(labels[:-1]==10)&(labels[1:]==2)
    columns=np.where(transition.any(axis=0))[0][::3]
    if len(columns)<14 or np.ptp(columns)<labels.shape[1]*.22:
        return None
    rows=np.argmax(transition[:,columns],axis=0)+1
    x=(columns+.5)/labels.shape[1]-.5
    offset=np.arctan(x/pose["fx"])
    heading=math.radians(frame["heading"])+offset
    distance=np.arange(4,310)
    surface,left,top,terrain=reference
    ix=np.floor(frame["x"]+np.outer(np.sin(heading),distance)-left).astype(int)
    iz=np.floor(frame["z"]-np.outer(np.cos(heading),distance)-top).astype(int)
    valid=(ix>=0)&(iz>=0)&(ix<surface.shape[1])&(iz<surface.shape[0])
    sample=surface[iz.clip(0,surface.shape[0]-1),ix.clip(0,surface.shape[1]-1)]
    eye=region.sample(terrain,np.array([frame["x"]]),np.array([frame["z"]]))[0]+1.7
    elevation=np.max(np.where(valid,sample-eye,-np.inf)/(np.cos(offset)[:,None]*distance),axis=1)
    usable=np.isfinite(elevation)&(elevation>-.1)
    if usable.sum()<14 or np.ptp(columns[usable])<labels.shape[1]*.22:
        return None
    observed=np.arctan((.5-(rows[usable]+.5)/labels.shape[0])/pose["fy"])
    samples=np.degrees(np.arctan(elevation[usable])-observed)
    angle=float(np.median(samples))
    residual=float(np.median(np.abs(samples-angle)))
    tolerance=3.6 if pose["source"]=="mount-prior" and usable.sum()>=24 else 1.8
    if residual>tolerance or abs(angle)>22:
        return None
    return angle,round(residual,2),int(usable.sum())


def ground_registration(street,frame):
    token=hashlib.sha256(json.dumps([frame.get(k) for k in ("lat","lon","heading","pitch","fov")],separators=(",",":")).encode()).hexdigest()[:8]
    found=[]
    for cache in (street/"ground-registrations").glob(f"{frame['id']}-*-{token}.npz"):
        with np.load(cache) as data:
            row=json.loads(str(data["f"]))
            if isinstance(row,dict) and row.get("id")==frame["id"] and row.get("score",0)>=.70 and len(data["p"])>100:
                found.append(row)
    if not found:return None
    row=max(found,key=lambda r:(r["score"],r["pixels"]))
    heading=math.radians(row["heading"])
    x,z=row["camera"]
    offset=row.get("lateral",0)
    return dict(x=x+offset*math.cos(heading),z=z+offset*math.sin(heading),heading=row["heading"],pitch=row["pitch"],registrationScore=row["score"],registeredPixels=row["pixels"])


def lane_reference(root):
    buildings=json.loads((root/"buildings/inventory.json").read_bytes())["buildingsList"]
    outlines=STRtree([Polygon(b["footprint"],b["holes"]).buffer(0) for b in buildings])
    ways=[w for w in json.loads((root.parent/"web/drive-network.json").read_bytes())["ways"] if w["kind"]=="road" and len(w["points"])>1]
    roads=STRtree([LineString([(x,z) for x,y,z in w["points"]]) for w in ways])
    return outlines,ways,roads


def lane_pose(frame,reference):
    outlines,ways,roads=reference
    camera=Point(frame["x"],frame["z"])
    outline=outlines.geometries[outlines.nearest(camera)]
    if outline.distance(camera)>3:return None
    candidates=[]
    for index in roads.query(camera.buffer(14)):
        line=roads.geometries[index]
        along=line.project(camera)
        q=line.interpolate(along)
        d=q.distance(camera)
        if d<=ways[index]["width"]/2+1.5:continue
        a=line.interpolate(max(0,along-1.5))
        b=line.interpolate(min(line.length,along+1.5))
        axis=math.degrees(math.atan2(b.x-a.x,a.y-b.y))
        difference=abs((axis-frame["heading"]+90)%180-90)
        if difference>45 or d>14 or outline.distance(q)<2.1:continue
        if len(outlines.query(q,predicate="intersects")):continue
        candidates.append((d+.09*difference,index,d,q))
    if not candidates:
        return {"poseRejected":"GPS inside surveyed footprint without a matching open lane"} if outline.contains(camera) else None
    _,index,d,q=min(candidates,key=lambda item:item[0])
    return dict(x=q.x,z=q.y,road=ways[index]["id"],laneDisplacement=round(d,2))


def main(keys):
    root=Path(__file__).resolve().parents[1]/"data"
    street=root/"streetview"
    frames={f["id"]:f for f in json.loads((street/"frames.json").read_text())}
    reference=roof_reference(root)
    lanes=lane_reference(root)
    out={}
    for key in keys:
        f=frames[key]
        with Image.open(street/f["path"]) as img:
            path=street/"semantics"/(key+".png")
            mask=np.array(Image.open(path)) if path.exists() else None
            ratio=img.width/img.height
            prior=64 if ratio>=1 else math.degrees(2*math.atan(math.tan(math.radians(32))*ratio))
            pose=calibrate(img,mask,f.get("fov") or prior)
        hfov=math.degrees(2*math.atan(.5/pose["fx"]))
        angle=-float(f["pitch"]) if f.get("pitch") is not None else -math.degrees(pose["pitch"])
        out[key]=dict(hfov=hfov,elevationAngle=angle,roll=f.get("roll") or 0,calibration=pose["source"])
        ground_fit=ground_registration(street,f)
        lane=lane_pose(f,lanes) if not ground_fit else None
        if lane:out[key].update(lane)
        horizontal={**f,**(ground_fit or lane or {})}
        if mask is not None:
            middle=mask[mask.shape[0]//9:mask.shape[0]*3//4]
            out[key]["photoBuildings"]=[round(float((part==2).mean()),3) for part in np.array_split(middle,8,axis=1)]
        if ground_fit:
            out[key].update({k:v for k,v in ground_fit.items() if k!="pitch"})
            if f.get("pitch") is None:out[key].update(elevationAngle=-ground_fit["pitch"],calibration="registered-road-surface")
        fit=registered_pitch(horizontal,mask,pose,reference) if reference and mask is not None and f.get("pitch") is None else None
        if fit:
            angle,residual,samples=fit
            out[key].update(elevationAngle=angle,calibration="surveyed-roof-silhouette",skylineResidualDegrees=residual,skylineColumns=samples)
    return out


if __name__=="__main__":
    print(json.dumps(main(sys.argv[1:])))
