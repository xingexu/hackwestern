import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path

import numpy as np
import shapely
from PIL import Image
from rasterio.features import shapes
from rasterio.transform import Affine
from scipy import ndimage
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import split, unary_union
from shapely.strtree import STRtree

import campus_region as region
import geo
from building_articulation import articulate, bind_grade
from building_gables import eave_outline
from building_roof_survey import register_rooftop_units, survey_roofs
from building_roof_support import seat_roof_plant, measured_plant
from building_profiles import curved_edges, curved_outline, measured_roof
from validate_specs import SCHEMA, check, Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
AUTO = ROOT / "build/specs/auto"
AUTHORED = ROOT / "build/specs/buildings"


def read(path):
    return json.loads(path.read_bytes())


def write(path, value, pretty=False):
    data = json.dumps(value, indent=2 if pretty else None, separators=None if pretty else (",", ":"), allow_nan=False)
    if path.exists() and path.read_text() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(data)
    tmp.replace(path)


def polygons(g,minimum_area=.015):
    return [p for p in shapely.get_parts(g) if p.geom_type == "Polygon" and p.area > minimum_area]


def rings(p):
    return [np.round(np.asarray(r.coords)[:-1], 3).tolist() for r in [p.exterior, *p.interiors]]


def remove_survey_spikes(polygon):
    def ring_points(ring):
        points=list(ring.coords)[:-1]
        j=0
        while len(points)>3 and j<len(points):
            a,b,c=points[j-1],points[j],points[(j+1)%len(points)]
            ux,uz=a[0]-b[0],a[1]-b[1]
            vx,vz=c[0]-b[0],c[1]-b[1]
            if ux*vx+uz*vz>0 and abs(ux*vz-uz*vx)<.0015*max(math.hypot(ux,uz),math.hypot(vx,vz)):
                points.pop(j)
                j=max(0,j-1)
            else:
                j+=1
        return points
    shell=ring_points(polygon.exterior)
    holes=[ring_points(ring) for ring in polygon.interiors]
    if len(shell)+sum(map(len,holes))==len(polygon.exterior.coords)-1+sum(len(r.coords)-1 for r in polygon.interiors):
        return polygon
    cleaned=Polygon(shell,holes)
    return cleaned if cleaned.is_valid and not cleaned.is_empty else polygon


def as_hex(rgb):
    return "#" + "".join(f"{int(c):02x}" for c in np.clip(rgb, 0, 255))


def roof_color(b,p):
    path=ROOT/"data/buildings/evidence"/b["id"]/"aerial-source.jpg"
    if not path.exists():
        return "#777773"
    x,z,X,Z=p.bounds
    image=Image.open(path).convert("RGB")
    image.thumbnail((220,220))
    h,w=image.height,image.width
    u,v=np.meshgrid(np.arange(w)+.5,np.arange(h)+.5)
    mask=shapely.contains_xy(p.buffer(-.4),x-18+u*(X-x+36)/w,z-18+v*(Z-z+36)/h)
    return as_hex(np.median(np.asarray(image)[mask],axis=0)) if mask.any() else "#777773"


def survey(b,p,cloud,regional):
    x,z,X,Z=p.bounds
    x,z=math.floor(x)-1,math.floor(z)-1
    u,v=np.meshgrid(np.arange(x,math.ceil(X)+1)+.5,np.arange(z,math.ceil(Z)+1)+.5)
    mask=shapely.contains_xy(p,u,v)
    if cloud is not None:
        surf,ox,oz=cloud
        values=surf[np.clip(np.floor(v-oz).astype(int),0,surf.shape[0]-1),np.clip(np.floor(u-ox).astype(int),0,surf.shape[1]-1)]
    else:
        values=region.sample(regional,u.ravel(),v.ravel()).reshape(u.shape)
    heights=ndimage.median_filter(values-b["groundAbsolute"],3)
    inside=ndimage.binary_erosion(mask,iterations=2)
    good=inside & (heights>2.8)
    if good.sum()<10:
        return [], max(3,b["heightP50"]), 0, None
    nearest=ndimage.distance_transform_edt(~good,return_distances=False,return_indices=True)
    roof=heights[tuple(nearest)]
    model=measured_roof(p,u[good],v[good],heights[good])
    levels=np.percentile(roof[mask],[18,50,85])
    base=max(3,float(levels[0]))
    if levels[2]-base<3.4:
        return [],max(3,float(levels[1])),float(levels[2]-base),model
    parts=[]
    bottom=base
    for threshold in np.arange(base+3.4, min(float(roof[mask].max()),90),4.25):
        high=(roof>threshold)&mask
        if high.sum()<45: break
        layer=[]
        for raw,_ in shapes(high.astype('uint8'),mask=high,transform=Affine.translation(x,z)):
            zone=shape(raw).simplify(1.35).buffer(-1.5,join_style=2).buffer(2.8,join_style=2).intersection(p).buffer(0)
            for seg in polygons(zone):
                if seg.area<max(40,p.area*.016): continue
                if seg.minimum_rotated_rectangle.area < seg.area*1.20:
                    seg=seg.minimum_rotated_rectangle.intersection(p)
                layer.extend(polygons(seg))
        if not layer: continue
        top=float(threshold+1.7)
        for seg in layer:
            parts.append(dict(footprint={"clip":rings(seg)[0]},height=round(top,2),baseOffset=round(bottom,2),floors=1))
        bottom=top
    return parts,base,float(levels[2]-levels[0]),model


def automatic(b,p,legacy,cloud,regional):
    tags=b.get("tags",{})
    name=b["name"].lower()
    old, samples, forms, style=legacy
    gothic=any(t in name for t in ["college","thames hall","lawson","stevenson","somerville","physics","gallery"]) or tags.get("start_date","9999")[:4] < "1945"
    home=tags.get("building") in ("house","detached","residential") or p.area<180
    athletic=any(t in name for t in ["arena","athletic","stadium","recreation"])
    glass=any(t in name for t in ["engineering","innovation","ivey","research"]) or style=="glass"
    industrial=any(t in name for t in ["plant","utility","garage"]) or tags.get("building") in ("industrial","shed","service")
    groups=("collegiate-gothic","ashlar-stone",3.9) if gothic else ("athletic","metal-panel",6.6) if athletic else ("industrial-utility","corrugated-metal",5.4) if industrial else ("house","brick",3) if home else ("contemporary-glass","precast-panel",4.1) if glass else ("residential-brick","brick",3.1) if "hall" in name and ("residen" in name or b["heightP50"]>25) else ("mid-century-modern","precast-panel",3.7)
    cls,kind,storey=groups
    col,glaze=("#b0a58f","#546775") if gothic else ("#a16a53","#647786") if kind=="brick" else ("#b9afa1","#69828e")
    source=None
    if old is not None:
        form=forms[style]
        source=samples["materialSources"].get(str(old))
        gains=samples["materials"].get(str(old),[0]*6)
        colors=[]
        for i,k in enumerate(("glass","wall")):
            base=np.array([(form[k]>>n)&255 for n in (16,8,0)])
            colors.append(as_hex(base*np.exp2(np.array(gains[i*3:i*3+3])*.63)))
        glaze,col=colors
    tiers,base,spread,model=survey(b,p,cloud,regional)
    roof_tone=roof_color(b,p)
    red,green,blue=[int(roof_tone[i:i+2],16) for i in (1,3,5)]
    leafy=green>max(red*.97,blue*1.15)
    small=p.area<145 and (home or industrial)
    unreliable=small and b["heightP90"]>8 and (leafy or spread>4.5 or p.area<70) and not tags.get("building:levels")
    if unreliable:
        base,tiers,spread,model=(3.1 if p.area<90 or industrial else 5.4),[],1.25,None
    h=round(max(3,base,0 if tiers or unreliable else .46*b["heightP90"]),2)
    roof_form=tags.get("roof:shape")
    if roof_form not in ("gable","hip","pyramid","shed","dome","flat","mansard","gambrel","barrel","half-hip","sawtooth"):
        roof_form=model["form"] if model else "gable" if home and spread>1.4 else "flat"
    if model and model["form"]==roof_form:
        h,tiers=model["eave"],[]
    evidence=[dict(kind="lidar",note="Roof elevations sampled within the footprint"),dict(kind="osm" if b["source"]=="openstreetmap" else "aerial",note="Survey footprint")]
    if source:
        evidence.append(dict(kind="kartaview",frame=str(source["frames"][0])) if source.get("frames") else dict(kind="photo",note=source.get("name","Western Facilities exterior")))
    floors=max(1,round(h/storey))
    parts=[dict(footprint="inventory",height=h,floors=floors), *tiers]
    flat=roof_form=="flat"
    roof=dict(form=roof_form,material="roof",edge="parapet" if flat else "gutter")
    if not flat:
        roof["rise"]=round(max(1.3,min(spread,4.5)),1)
        if model and model["form"]==roof_form:roof.update(rise=model["rise"],ridge=model["ridge"])
    facade=dict(material="wall",bays=dict(width=4.1 if gothic else 4.7 if glass else 3.5),windows=dict(type="tudor-arch" if gothic else "curtain-wall" if glass else "clerestory" if athletic else "punched",width=2.6 if glass else 1.8,height=2.25 if gothic else 1.75,sill=.85,perBay=1,recess=.19,mullions=dict(vertical=2 if gothic else 1,horizontal=1),glassColor=glaze,sillProjecting=True,lintel=gothic),base=dict(height=.62,projection=.07,material="trim"),cornice=dict(height=.24,depth=.14,material="trim"))
    if industrial:facade["windows"].update(type="slot",width=1,height=.9)
    if gothic:facade.update(piers=dict(width=.46,depth=.24,every=2,material="trim"),bands=[dict(at="sill-lines",height=.13,depth=.07,material="trim")])
    if flat:facade["parapet"]=dict(type="coped",height=.4,material="wall")
    longest=max(b["walls"],key=lambda w:w["length"]*(1.4 if w.get("frames") else 1),default=None)
    entrances=[] if longest is None else [dict(wall=longest["index"],position=.5,width=2.4 if p.area>250 else 1.1,height=2.6,type="gothic-portal" if gothic else "doors-double" if p.area>250 else "doors-single",recess=.32)]
    if "mcintosh" in name:
        wall=min(b["walls"],key=lambda w:LineString([w["a"],w["b"]]).distance(Point(277,198)))
        entrances=[dict(wall=wall["index"],position=.5,width=2.5,height=3.2,type="doors-double",doorColor="#ad3930")]
    return dict(**(dict(lidarTrusted=False,lidarNote="Small footprint with canopy-height returns inconsistent with the roof area, relief or aerial colour") if unreliable else {}),schema="western-building-spec/1",id=b["id"],name=b["name"],status="auto",confidence=.53 if source else .32,evidence=evidence,style=cls,floors=dict(count=floors,typicalHeight=storey,groundFloorHeight=storey),massing=dict(parts=parts,source="lidar"),materials=dict(wall=dict(kind=kind,color=col,variation=.28),roof=dict(kind="membrane" if flat else "slate",color=roof_tone),trim=dict(kind="limestone-smooth" if gothic else "concrete-smooth",color="#c3bbab")),walls=dict(default=facade),roof=roof,entrances=entrances)


def roof_surface(poly,roof):
    form="suspended" if roof.get("suspension") else roof.get("form","flat")
    rect=np.array(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    sides=np.roll(rect,-1,axis=0)-rect
    axis=sides[np.argmax(np.linalg.norm(sides,axis=1))]
    ridge=roof.get("ridge","long-axis")
    angle=90-ridge if isinstance(ridge,(float,int)) else math.degrees(math.atan2(axis[1],axis[0]))+(90 if ridge=="short-axis" else 0)
    if isinstance(ridge,(float,int)):angle=ridge-90
    origin=(poly.centroid.x,poly.centroid.y)
    local=affinity.rotate(poly,-angle,origin)
    l,t,r,b=local.bounds
    dx,dz=max(r-l,.01),max(b-t,.01)
    rise=roof.get("rise",min(12,dz*.5*math.tan(math.radians(min(80,roof.get("pitch",27))))))
    survey=roof.get("suspension",{}).get("profile",{})
    if survey.get("roofPoints"):
        points=sorted(survey["roofPoints"])
        minimum=min(h for _,h in points)
        cross_axis=0 if survey.get("across")=="east-west" else 1
        angle=0
        local=poly
        l,t,r,b=poly.bounds
        dx,dz=max(r-l,.01),max(b-t,.01)
    def alt(x,z):
        u,v=(x-l)/dx,(z-t)/dz
        cross=max(0,1-abs(2*v-1))
        end=max(0,min(u,1-u)*2)
        if form in ("flat","lidar"):return 0
        if form=="suspended":
            if survey.get("roofPoints"):
                return float(np.interp([x,z][cross_axis],*[list(col) for col in zip(*points)]))-minimum
            return (abs(v-.65)/.65)**1.65*4.4
        if form=="upswept":return rise*v**1.65
        if form=="shed":return v*rise
        if form=="gable":return cross*rise
        if form=="gambrel":return min(cross*2.4,.65+.35*cross)*rise
        if form=="barrel":
            crown=math.sqrt(max(0,1-(2*v-1)**2))
            if roof.get("endShape")=="rounded":
                axial=min(1,end*dx/min(dz,dx))
                crown*=math.sqrt(max(0,axial*(2-axial)))
            return crown*rise
        if form=="dome":return math.sqrt(max(0,1-(2*v-1)**2-(2*u-1)**2))*rise
        if form=="sawtooth":return (1 if v>=.99999 else (v*4)%1)*rise
        if form=="pyramid":return min(cross,end)*rise
        hip=min(cross,end*dx/dz)
        if form=="mansard":return min(1,hip*3.5)*rise
        if form=="half-hip":return min(cross,.5+end*dx/dz)*rise
        return hip*rise
    segments=[local]
    if form not in ("flat","lidar","shed"):
        vs=([.5] if form in ("gable","hip","half-hip","pyramid") else [.16,.5,.84] if form=="gambrel" else [.125,.875] if form=="mansard" else np.linspace(0,1,17)[1:-1])
        rounded_barrel=form=="barrel" and roof.get("endShape")=="rounded"
        if rounded_barrel:
            vs=(1-np.cos(np.linspace(0,np.pi,25)[1:-1]))/2
        lines=[LineString([(l-1,t+s*dz),(r+1,t+s*dz)]) for s in vs]
        if rounded_barrel:
            cap=min(.5,dz/(2*dx))
            for u in [q*cap for q in (.035,.13,.32,.57,.81,1)]:
                lines.extend(LineString([(l+v*dx,t-1),(l+v*dx,b+1)]) for v in (u,1-u))
        if form in ("dome","mansard","half-hip","hip","pyramid"):
            us=np.linspace(0,1,13)[1:-1] if form=="dome" else [.5] if form=="pyramid" else [min(.5,k*dz/dx) for k in (.15,.5)]
            lines += [LineString([(l+s*dx,t-1),(l+s*dx,b+1)]) for s in set(list(us)+[1-i for i in us])]
            if form!="dome":
                run=dx if form=="pyramid" else dz
                lines += [LineString([(x,t),(x+sign*run,b)]) for x,sign in [(l,1),(r,-1)]]
                lines += [LineString([(x,b),(x+sign*run,t)]) for x,sign in [(l,1),(r,-1)]]
        if survey.get("roofPoints"):
            lines=[LineString([(q,t-1),(q,b+1)]) if cross_axis==0 else LineString([(l-1,q),(r+1,q)]) for q,_ in points]
        for line in lines:
            segments=[sub for seg in segments for sub in (polygons(split(seg,line)) if seg.crosses(line) or line.crosses(seg) else [seg])]
    coords=[]; indices=[]; by_vertex={}
    c,s=math.cos(math.radians(angle)),math.sin(math.radians(angle))
    for seg in segments:
        for tri in shapely.get_parts(shapely.constrained_delaunay_triangles(seg)):
            for x,z in list(tri.exterior.coords)[:3]:
                h=alt(x,z)
                if form=="sawtooth" and abs((z-t)/dz*4-round((z-t)/dz*4))<.0001:h=rise if z>seg.centroid.y else 0
                pt=(round(origin[0]+(x-origin[0])*c-(z-origin[1])*s,3),round(h,3),round(origin[1]+(x-origin[0])*s+(z-origin[1])*c,3))
                if pt not in by_vertex:
                    by_vertex[pt]=len(coords);coords.append(pt)
                indices.append(by_vertex[pt])
    return [coords,indices]


def fit_canopies(spec,b,streets,street_tree):
    cuts=[]
    for entry in spec.get("entrances",[]):
        canopy=entry.get("canopy")
        if not canopy or not canopy.get("columns",2 if canopy.get("type")=="portico" else 0):
            continue
        wall=b["walls"][entry["wall"]]
        a=np.array(wall["a"])
        tangent=np.array(wall["b"])-a
        center=np.array(entry["at"]) if "at" in entry else a+tangent*entry.get("position",.5)
        tangent/=np.linalg.norm(tangent)
        normal=np.array(wall["normal"])
        depth=canopy.get("depth",1.5)
        span=(canopy.get("width",entry.get("width",2.3)+1)-.4)/2
        cols=canopy.get("columns",2)
        for d in np.arange(depth,max(.18,min(.6,depth-.1)),-.15):
            pts=[Point(center+tangent*t+normal*(d-.22)) for t in np.linspace(-span,span,cols)]
            if all(not any(streets[i].covers(pt) for i in street_tree.query(pt)) for pt in pts):
                canopy["columnDepth"]=round(float(d),3)
                break
        else:
            if depth<1.5 or span<np.linalg.norm(np.array(wall["b"])-a)*.31:
                canopy["columnDepth"]=.20
                continue
            back=depth+.65
            ends=[np.array(wall[key]) for key in ("a","b")]
            cuts.append(Polygon([ends[0]-tangent*.15+normal*2,ends[1]+tangent*.15+normal*2,ends[1]+tangent*.15-normal*back,ends[0]-tangent*.15-normal*back]))
            wall["a"],wall["b"]=[(end-normal*back).tolist() for end in ends]
            canopy["columnDepth"]=max(.3,depth-1.2)
    return unary_union(cuts)


def carve_doors(parts,entries,walls):
    recesses={}
    for i,e in enumerate(entries):
        depth=e.get("recess",.28)
        w=walls[e["wall"]]
        center=np.array(e["at"]) if "at" in e else np.array(w["a"])+(np.array(w["b"])-w["a"])*e.get("position",.5)
        candidates=[]
        fallback=[]
        for k,part in enumerate(parts):
            if part["low"]!=0:continue
            for r,loop in enumerate(part["rings"]):
                for j,id in enumerate(part["wallIds"][r]):
                    a=np.array(loop[j]);c=np.array(loop[(j+1)%len(loop)])
                    if np.linalg.norm(c-a)<.18:continue
                    line=LineString([a,c])
                    distance=line.distance(Point(center))
                    tangent=(c-a)/line.length
                    alignment=np.dot([tangent[1],-tangent[0]],w["normal"])
                    target=(distance+max(0,1-alignment)*2.5,k,r,j,a,c)
                    if id==e["wall"] or ("at" in e and alignment>=.72 and distance<=6):
                        candidates.append(target)
                    else:fallback.append(target)
        if not candidates:candidates=fallback
        if not candidates:continue
        _,k,r,j,a,c=min(candidates,key=lambda v:v[:4])
        length=np.linalg.norm(c-a)
        tangent=(c-a)/length
        width=min(e.get("width",2.3),length-.06)
        if width<=.1:continue
        u=np.clip(np.dot(center-a,tangent),width/2+.015,length-width/2-.015)
        center=a+tangent*u
        inward=np.array([-tangent[1],tangent[0]])
        bend=parts[k]["curves"][r][j]
        center-=inward*4*(u/length)*(1-u/length)*bend
        e["boundEdge"]=f"{k}:{r}:{j}"
        e["gradePoint"]=(center-.5*inward).round(3).tolist()
        if e.get("steps",0)>0:
            depth=min(e["steps"],40)*.32
            e["stairToe"]=(center-depth*inward).round(3).tolist()
        e["boundAlong"]=round(float(u),4)
        if depth<=.08:continue
        v=center-tangent*width/2
        t=center+tangent*width/2
        pocket=Polygon([v-.25*inward,t-.25*inward,t+depth*inward,v+depth*inward])
        recesses.setdefault(k,[]).append((pocket,i))
    for k,entries in recesses.items():
        part=parts[k]
        outline=part["solidRings"] or part["rings"]
        poly=Polygon(outline[0],outline[1:]).buffer(0)
        part["collisionShells"]=[rings(p) for p in polygons(poly.difference(unary_union([q for q,_ in entries])))]
        part["doorHeads"]=[[i,rings(p)] for q,i in entries for p in polygons(poly.intersection(q))]


def survey_translation(spec, inventory):
    massing=spec.get("massing",{})
    if massing.get("translation") is not None:
        return tuple(massing["translation"])
    parts=massing.get("parts",[])
    candidates=[Polygon(q["footprint"]).buffer(0) for q in parts if isinstance(q.get("footprint"),list) and q.get("baseOffset",0)<.35 and q["height"]>2]
    if not candidates or inventory.area<2:
        return 0,0
    if len(candidates)>1:
        candidates.append(unary_union(candidates))
    best=(0.,(0.,0.))
    for candidate in candidates:
        if not .85*inventory.area<candidate.area<1.16*inventory.area:
            continue
        dx,dz=candidate.centroid.x-inventory.centroid.x,candidate.centroid.y-inventory.centroid.y
        if not .38<math.hypot(dx,dz)<32:
            continue
        registered=affinity.translate(inventory,dx,dz)
        overlap=candidate.intersection(registered).area/candidate.union(registered).area
        original=candidate.intersection(inventory).area/candidate.union(inventory).area
        if overlap>.91 and overlap>original+.035 and overlap>best[0]:
            best=(overlap,(dx,dz))
    return best[1]


def registered_inventory(building,offset):
    dx,dz=offset
    def point(p):
        return [round(p[0]+dx,4),round(p[1]+dz,4)]
    return {**building,"centroid":point(building["centroid"]),"footprint":[point(p) for p in building["footprint"]],"holes":[[point(p) for p in loop] for loop in building.get("holes",[])],"walls":[{**wall,"a":point(wall["a"]),"b":point(wall["b"])} for wall in building["walls"]]}


def gable_windows(surface,requests,center):
    verts,indices=surface
    boundary={}
    for k in range(0,len(indices),3):
        ids=indices[k:k+3]
        for a,c in zip(ids,ids[1:]+ids[:1]):
            key=tuple(sorted((a,c)))
            boundary[key]=boundary.get(key,0)+1
    gables=[]
    for apex,p in enumerate(verts):
        keys=[edge for edge,n in boundary.items() if n==1 and apex in edge and min(verts[i][1] for i in edge)<p[1]-.15]
        if len(keys)!=2:
            continue
        a,c=[verts[edge[0] if edge[1]==apex else edge[1]] for edge in keys]
        length=math.hypot(c[0]-a[0],c[2]-a[2])
        if length<.65:
            continue
        tx,tz=(c[0]-a[0])/length,(c[2]-a[2])/length
        if abs((p[0]-a[0])*tz-(p[2]-a[2])*tx)>.035:
            continue
        if (p[0]-center[0])*tz-(p[2]-center[1])*tx<0:
            a,c=c,a
            tx,tz=-tx,-tz
        u=(p[0]-a[0])*tx+(p[2]-a[2])*tz
        panel=Polygon([(0,0),(length,0),(length,c[1]),(u,p[1]),(0,a[1])]).buffer(0)
        if panel.area>.30:
            gables.append(dict(a=[a[0],a[2]],b=[c[0],c[2]],edges=[f"{i}:{j}" for i,j in keys],apex=p,u=u,length=length,panel=panel,holes=[],windows=[]))
    for req in requests:
        win=req["window"]
        point=req.get("at",center)
        if not gables:
            break
        g=min(gables,key=lambda g:math.hypot(point[0]-g["apex"][0],point[1]-g["apex"][2]))
        width=win.get("width",.8);sill=win.get("sill",.28)
        u=g["u"]
        if "position" in req:
            u=g["length"]*req["position"]
        elif "at" in req and not req.get("centered"):
            u=sum((x-a)*(b-a) for x,a,b in zip(point,g["a"],g["b"]))/g["length"]
        half=width/2
        roof=g["panel"].intersection(box(u-half-.04,sill,u+half+.04,g["apex"][1]+.01))
        if roof.is_empty or not g["panel"].covers(LineString([(u-half-.04,sill),(u+half+.04,sill)])):
            continue
        heads=[g["panel"].intersection(LineString([(x,sill),(x,g["apex"][1]+.1)])).bounds[3] for x in (u-half-.04,u+half+.04)]
        height=min(win.get("height",1.2),min(heads)-sill-.13)
        if height<.20:
            continue
        cut=box(u-half,sill,u+half,sill+height)
        if any(cut.intersects(old) for old in g["holes"]):
            continue
        g["holes"].append(cut);g["windows"].append({"u":u,"window":{**win,"height":round(height,4)}})
    result=[]
    for g in gables:
        if not g["windows"]:
            continue
        panels=shapely.constrained_delaunay_triangles(g["panel"].difference(unary_union(g["holes"])))
        result.append(dict(a=g["a"],b=g["b"],edges=g["edges"],panels=[list(tri.exterior.coords)[:3] for tri in shapely.get_parts(panels)],**g["windows"][0],openings=g["windows"]))
    return result


def coffered_soffits(parts,spec):
    noted="coffer" in spec.get("notes","").lower()
    for part in parts:
        if not part["low"] or not (part.get("cofferSpacing") or noted and "cantilever" in part["name"].lower()):
            continue
        shell=Polygon(part["rings"][0],part["rings"][1:]).buffer(0)
        supports=[Polygon(q["rings"][0],q["rings"][1:]).buffer(.05) for q in parts if q["low"]<part["low"]-.1 and q["high"]>=part["low"]-.22]
        exposed=shell.difference(unary_union(supports))
        if exposed.area<2:
            continue
        rect=np.asarray(shell.minimum_rotated_rectangle.exterior.coords)[:4]
        sides=np.roll(rect,-1,axis=0)-rect
        axis=sides[np.argmax(np.linalg.norm(sides,axis=1))]
        angle=math.degrees(math.atan2(axis[1],axis[0]))
        local=affinity.rotate(exposed,-angle,(0,0))
        l,t,r,b=local.bounds
        lines=[]
        for i,spacing in enumerate(part.get("cofferSpacing",[1.9,1.55])):
            low,high=(l,r) if i==0 else (t,b)
            for offset in np.arange(math.ceil(low/spacing)*spacing,high,spacing):
                cut=LineString([(offset,t),(offset,b)] if i==0 else [(l,offset),(r,offset)])
                for segment in shapely.get_parts(cut.intersection(local)):
                    if segment.geom_type=="LineString" and segment.length>.4:
                        path=affinity.rotate(segment,angle,(0,0)).coords
                        lines.append([[round(v,3) for v in point] for point in [path[0],path[-1]]])
        if lines:
            part["soffitRibs"]=lines


def garden_canopies(record,sample):
    for part in record["parts"]:
        if not re.search(r"garden bed|planted roof bed",part["name"],re.I) or part.get("plantings"):
            continue
        footprint=Polygon(part["rings"][0],part["rings"][1:]).buffer(-.65)
        if footprint.is_empty:
            continue
        l,t,r,b=footprint.bounds
        z,x=np.mgrid[math.floor(t):math.ceil(b)+1,math.floor(l):math.ceil(r)+1]
        rgb=sample(x,z)
        red,green,blue=rgb.transpose(2,0,1)
        vegetation=(green>red*1.04+2)&(green>blue*1.14+3)&shapely.contains_xy(footprint,x,z)
        labels,count=ndimage.label(vegetation)
        trees=[]
        for i in range(1,count+1):
            mask=labels==i
            if mask.sum()<7:
                continue
            point=Point(float(x[mask].mean()),float(z[mask].mean()))
            if not footprint.contains(point):
                continue
            radius=min(2.85,math.sqrt(mask.sum()/math.pi))
            trees.append(dict(at=[round(point.x,2),round(point.y,2)],radius=round(radius,2),height=round(2.1+radius*1.35,2)))
        if trees:
            part["plantings"]=trees


def assemble(b,spec,p,portals):
    walls=[dict(a=w["a"],b=w["b"],faces=w["faces"],street=bool(w["frames"]),normal=w["normal"]) for w in b["walls"]]
    lines=[LineString([w["a"],w["b"]]) for w in walls]
    tree=STRtree(lines)
    parts=[]
    base=b["ground"]
    chunks=spec.get("massing",{}).get("parts") or [dict(footprint="inventory",height=max(3,b["heightP50"]) if spec.get("lidarTrusted",True) else spec["floors"].get("groundFloorHeight",3.5)+(spec["floors"]["count"]-1)*spec["floors"].get("typicalHeight",3.4))]
    for item in chunks:
        outline=item.get("footprint","inventory")
        geom=p if outline=="inventory" else Polygon(outline["clip"]).buffer(0).intersection(p) if isinstance(outline,dict) else Polygon(outline).buffer(0)
        if spec.get("present") is False:break
        hi=item["height"];lo=item.get("baseOffset",0)
        if hi<=lo:continue
        roof={**spec["roof"],**item.get("roof",{})}
        if not roof.get("suspension"):
            roof.pop("suspension",None)
        cuts=[(poly,y-base) for poly,y in portals if poly.intersects(geom) and y-base>lo]
        pieces=[(geom.difference(unary_union([q for q,_ in cuts])),lo)]+[(geom.intersection(q),y) for q,y in cuts if y<hi]
        for part,start in pieces:
            for shell in polygons(part,.000001 if isinstance(outline,list) else .015):
                shell=shapely.orient_polygons(shell if isinstance(outline,list) or len(shell.exterior.coords)==5 else shell.simplify(.08,preserve_topology=True))
                shell=remove_survey_spikes(shell)
                loops=rings(shell)
                selectors=[]
                for loop in loops:
                    ids=[]
                    for a,c in zip(loop,loop[1:]+loop[:1]):
                        mid=Point((a[0]+c[0])/2,(a[1]+c[1])/2)
                        dx,dz=c[0]-a[0],c[1]-a[1]
                        length=max(.001,math.hypot(dx,dz))
                        normal=np.array([dz,-dx])/length
                        tolerance=6.0 if outline!="inventory" else 1.5
                        eligible=[]
                        for k in tree.query(mid.buffer(12. if item.get("wallProfiles") else tolerance)):
                            direction=float(normal@walls[k]["normal"])
                            gap=lines[k].distance(mid)
                            authored_return = str(k) in item.get("wallProfiles",{}) and direction>.97 and gap<=12
                            if direction>.73 and (gap<=tolerance or authored_return):
                                eligible.append((gap+2.5*(1-direction),int(k)))
                        ids.append(min(eligible)[1] if eligible else -1)
                    selectors.append(ids)
                curves=[[0]*len(loop) if roof.get("suspension") else curved_edges(loop) for loop in loops]
                rounded=curved_outline(loops,curves)
                if rounded.is_valid:shell=rounded
                else:curves=[[0]*len(loop) for loop in loops]
                cap=eave_outline(shell,roof)
                parts.append(dict(rings=loops,curves=curves,solidRings=rings(shell) if any(any(v) for v in curves) else None,wallIds=selectors,low=start,high=hi,floors=item.get("floors",spec["floors"]["count"] if len(chunks)==1 else max(1,round((hi-max(0,start))/max(1,spec["floors"].get("typicalHeight",3.7))))),facade=item.get("facade",{}),material=item.get("material"),roof=roof,surface=roof_surface(cap,roof),name=item.get("name",""),center=list(shell.representative_point().coords)[0]))
                if item.get("soffit",{}).get("cofferSpacing"):
                    parts[-1]["cofferSpacing"]=item["soffit"]["cofferSpacing"]
                if item.get("plantings"):
                    parts[-1]["plantings"]=item["plantings"]
                requests=list(item.get("atticWindows",[]))
                if item.get("atticWindow") and not requests:
                    window,target=item["atticWindow"]
                    requests=[{"window":window,"at":target,"centered":True}]
                if requests:
                    openings=gable_windows(parts[-1]["surface"],requests,parts[-1]["center"])
                    if openings:
                        parts[-1]["atticAperture"]=openings[0]
                        if len(openings)>1:parts[-1]["atticApertures"]=openings[1:]
                if item.get("wallProfiles"):
                    parts[-1]["wallProfiles"]=item["wallProfiles"]

    for part in parts:
        if part["low"]<=0:continue
        outer=Polygon(part["rings"][0],part["rings"][1:]).buffer(0)
        pads=[]
        for lower in parts:
            gap=part["low"]-lower["high"]
            if gap<.04 or gap>(3 if "header" in part["name"].lower() else 1.5):continue
            seat=outer.intersection(Polygon(lower["rings"][0],lower["rings"][1:]).buffer(0))
            if seat.area<min(.5,outer.area*.16):continue
            for poly in polygons(seat):
                center=poly.representative_point()
                pads.append([round(center.x,3),round(center.y,3),lower["high"],part["low"]])
        if pads:part["seats"]=pads

    if parts and spec["walls"].get("courtyard"):
        shells=[Polygon(t["rings"][0],t["rings"][1:]).buffer(0) for t in parts]
        courts=[ring for poly in [*polygons(p),*polygons(unary_union(shells))] for ring in poly.interiors if Polygon(ring).area>6]
        by_storey={}
        for part in parts:
            section=(part["low"]+part["high"])/2
            active=tuple(i for i,panel in enumerate(parts) if panel["low"]<section<panel["high"])
            if active not in by_storey:
                plates=unary_union([shells[i] for i in active])
                by_storey[active]=[ring for poly in polygons(plates) for ring in poly.interiors if Polygon(ring).area>6]
            visible_courts=[*courts,*by_storey[active]]
            edges=[]
            loop=part["rings"][0]
            for j,(a,c) in enumerate(zip(loop,loop[1:]+loop[:1])):
                line=LineString([a,c])
                if any(all(r.distance(line.interpolate(t,normalized=True))<.45 for t in (.13,.5,.87)) for r in visible_courts):
                    edges.append(j)
            if edges:part["courtyardEdges"]=edges
    coffered_soffits(parts,spec)
    carve_doors(parts,spec.get("entrances",[]),walls)
    bind_grade(parts,spec)
    extents=[p.bounds]+[Polygon(row["rings"][0]).bounds for row in parts]
    bounds=[pick(q[i] for q in extents) for i,pick in enumerate((min,min,max,max))]
    return dict(id=b["id"],ground=base,center=b["centroid"],bounds=bounds,footprintArea=round(p.area,3),walls=walls,parts=parts,spec={k:v for k,v in spec.items() if k not in ("notes","evidence","summary","massing")},sources=[e["frame"] for e in spec["evidence"] if e.get("frame")])


def survey_forms(spec):
    notes=spec.get("notes","").lower()
    if spec["id"]=="w118764108":
        for part in spec.get("massing",{}).get("parts",[]):
            if part.get("baseOffset",0)==0:
                profiles=part.setdefault("wallProfiles",{})
                for index in ("42","44"):
                    wall=profiles.setdefault(index,{})
                    wall.setdefault("base",{}).update(batter=.56,height=1.56)
                    wall.setdefault("groundFloor",{}).setdefault("windows",{}).setdefault("shading","sloped-glass")
            if "cantilevered upper" in part.get("name","").lower():
                part.setdefault("facade",{}).setdefault("soffitBeams",dict(spacing=3.4,width=.30,height=.48,depth=3.6))
    if spec.get("roof",{}).get("suspension"):
        rig=spec["roof"]["suspension"]
        rig.setdefault("saddleSize",[1.5,1,.48])
        columns={}
        for mast in rig.get("masts",[]):
            for anchor in mast["anchors"]:
                offset=round((anchor[0]-mast["center"][0])/5)
                columns.setdefault(offset,[]).append(anchor)
        rig.setdefault("ties",[sorted(points,key=lambda a:a[1]) for points in columns.values() if len(points)>2])
    for entry in spec.get("entrances",[]):
        if "sidelight" in notes and entry["type"] in ("doors-double","gothic-portal","arched-portal","portico"):
            entry.setdefault("sidelights",True)
        if "fanlight" in notes and entry["type"]=="doors-single":
            entry.setdefault("fanlight",True)
        canopy=entry.get("canopy")
        if canopy and re.search(r"(gabl.{0,25}(hood|porch|entrance)|gable[sd]? over the entrance|gables on the porch)",notes):
            canopy.setdefault("form","gable")
            canopy.setdefault("peaks",max(2,round(canopy.get("width",5)/3.4)))
            if "glazed triangular" in notes:canopy["glazedGable"]=True
        if entry.get("type")=="arched-portal" and "mirrored vault" in notes:
            entry["vault"]=dict(material="spandrel-glass",balcony="curved balcony" in notes)
    parts=spec.get("massing",{}).get("parts",[])
    capped=any("capped crosswall" in p.get("name","").lower() for p in parts)
    for part in parts:
        roof=part.get("roof",{})
        name=part.get("name","").lower()
        if capped and roof.get("form")=="gable" and roof.get("overhang",0)>.1:
            roof.setdefault("rakeOverhang",.025)
        facade=part.get("facade",{})
        win=facade.get("windows",{})
        if "cross gable" in name and win.get("type")=="lancet":
            entry=next((e for e in spec.get("entrances",[]) if e.get("at")),None)
            if entry:
                part["atticWindow"]=[win,entry["at"]]
                part["facade"]={**facade,"blank":True}
        if "upswept" in part.get("name","").lower() and part.get("roof",{}).get("form")=="shed":
            part["roof"]["form"]="upswept"
    for facade in [spec["walls"]["default"],*spec["walls"].get("byWall",{}).values()]:
        balcony=facade.get("balconies")
        if balcony and ("solid balcony end" in notes or "side cheeks" in notes):balcony.setdefault("endPanels",True)
        if balcony and "two adjacent balconies, four ordinary window bays" in notes:balcony["bayPattern"]=[1,1,0,0,0,0]


def complete_covered_access(record,assigned,drive_lines):
    if not record["parts"] or not assigned:
        return
    shape=unary_union([Polygon(p["rings"][0],p["rings"][1:]).buffer(0) for p in record["parts"]])
    for gate,soffit in assigned:
        for piece in polygons(gate.difference(shape)):
            if piece.area<2:
                continue
            poly=shapely.orient_polygons(piece)
            loops=rings(poly)
            roof={"form":"flat","material":"roof"}
            posts=[]
            for x,z in poly.exterior.coords[:-1]:
                if drive_lines.distance(Point(x,z))>1.30 and all(math.hypot(x-a,z-b)>1.65 for a,b in posts):
                    posts.append([round(x,3),round(z,3)])
            record["parts"].append(dict(name="Covered hospital access",rings=loops,wallIds=[[-1]*len(r) for r in loops],low=soffit-record["ground"],high=soffit+.30-record["ground"],absoluteSoffit=soffit,posts=posts,floors=1,roof=roof,facade={"blank":True},surface=roof_surface(poly,roof),center=list(poly.representative_point().coords)[0]))
            l,t,r,b=record["bounds"];ll,tt,rr,bb=poly.bounds
            record["bounds"]=[min(l,ll),min(t,tt),max(r,rr),max(b,bb)]


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--id");ap.add_argument("--spec",type=Path);ap.add_argument("--out",type=Path);ap.add_argument("--refresh-auto",action="store_true")
    args=ap.parse_args()
    buildings=read(ROOT/"data/buildings/inventory.json")["buildingsList"]
    road=read(WEB/"drive-network.json")
    if args.refresh_auto or any(not (AUTO/(b["id"]+".json")).exists() for b in buildings if not args.id or b["id"]==args.id):
        blocks=read(WEB/"campus-region.json")["blocks"]
        arch=read(WEB/"region-detail.json")["architecture"]
        samples=read(WEB/"streetview-facades.json")
        city=[Polygon(np.reshape(row[0],(-1,2))).buffer(0) for row in blocks]
        tree=STRtree(city)
        forms={row["name"]:row for row in arch["atlas"]["forms"]}
        cloudpath=ROOT/"data/buildings/lidar/roof-grid.npz"
        grid=np.load(cloudpath) if cloudpath.exists() else None
        cloud=(grid["surface"],*grid["origin"]) if grid is not None else None
        regional=region.lidar("dsm")
    gates=[]
    for i,value in road["buildingBases"].items():
        for y,r in value["passages"]:
            gates.append((Polygon(np.reshape(r[0],(-1,2)),[np.reshape(h,(-1,2)) for h in r[1:]]).buffer(.52),y))
    drives=unary_union([LineString([(x,z) for x,y,z in w["points"]]) for w in road["ways"] if w.get("covered") and w["kind"]=="road" and len(w["points"])>=2])
    footprints=[Polygon(b["footprint"],b["holes"]).buffer(0) for b in buildings]
    owners=STRtree(footprints)
    canopies={}
    for geom,soffit in gates:
        owner=int(owners.nearest(geom.centroid))
        if footprints[owner].distance(geom)<14 and geom.intersects(drives):
            canopies.setdefault(buildings[owner]["id"],[]).append((geom,soffit))
    streets=[LineString([(x,z) for x,y,z in w["points"]]).buffer(w["width"]/2+.25,cap_style=2) for w in road["ways"] if w["kind"]=="road" and not w.get("covered") and w.get("class") not in ("service","driveway") and len(w["points"])>=2]
    street_tree=STRtree(streets)
    grid_path=ROOT/"data/buildings/lidar/roof-grid.npz"
    lidar=np.load(grid_path) if grid_path.exists() else None
    measured=lidar["surface"] if lidar is not None else None
    origin=lidar["origin"] if lidar is not None else None
    items=[]
    validator=Draft202012Validator(read(SCHEMA))
    for b in buildings:
        if args.id and args.id!=b["id"]:continue
        p=Polygon(b["footprint"],b["holes"]).buffer(0)
        auto=AUTO/(b["id"]+".json")
        if args.refresh_auto or not auto.exists():
            overlaps=[(p.intersection(city[i]).area,i) for i in tree.query(p)]
            area,old=max(overlaps,default=(0,None))
            if area<p.area*.18:old=None
            matched=next((i for i,r in enumerate(arch["core"]) if r[3].lower()==b["name"].lower() and b["name"]),None)
            if matched is not None:old=len(city)+matched
            style=arch["core"][matched][0] if matched is not None else list(forms)[arch["forms"][old][0]] if old is not None else None
            baseline=automatic(b,p,(old,samples,forms,style),cloud,regional)
            write(auto,baseline,True)
        source=args.spec or AUTHORED/auto.name
        baseline=read(auto)
        baseline_problems=check(baseline,b,validator)
        if baseline_problems:raise ValueError(f"{b['id']} auto: {baseline_problems}")
        spec=read(source) if source.exists() else baseline
        issues=check(spec,b,validator)
        if issues:raise ValueError(f'{b["id"]}: {issues}')
        articulate(spec)
        survey_forms(spec)
        if spec.get("roof",{}).get("suspension") and not spec.get("massing",{}).get("parts"):
            spec["massing"]={"parts":[{"footprint":"inventory","height":min((h for x,h in spec["roof"]["suspension"].get("profile",{}).get("roofPoints",[])),default=spec["floors"].get("groundFloorHeight",10)),"floors":1}]}
        if spec.get("lidarTrusted",True) and spec.get("present",True) and not spec.get("massing",{}).get("parts") and spec.get("roof",{}).get("form","lidar") in ("lidar","flat"):
            spec["massing"]=read(auto)["massing"]
        if "splay" in (spec.get("summary","")+" "+spec.get("notes","")).lower():
            for facade in [spec["walls"]["default"],*spec["walls"].get("byWall",{}).values()]:
                win=facade.get("windows")
                if win and win.get("type") not in ("curtain-wall","none","storefront"):
                    win.setdefault("splay",min(.35,win.get("recess",.24)*.65))
        for ref,mat in spec["materials"].items():
            if ref.lower() in ("mesh","screen","netting") and mat["kind"]!="glass-curtain" and not mat.get("surface"):
                mat["surface"]="perforated"
        if "roof turbine" in (spec.get("notes","")+" "+spec.get("summary","")).lower():
            units=[f for f in spec["roof"].get("features",[]) if f["type"] in ("hvac","antenna")]
            if units:min(units,key=lambda f:math.prod(f.get("size",[1,1])[:2]))["rotor"]=True
        registration=survey_translation(spec,p)
        aligned=registered_inventory(b,registration) if any(registration) else b
        footprint=affinity.translate(p,*registration) if any(registration) else p
        cuts=fit_canopies(spec,aligned,streets,street_tree)
        record=assemble(aligned,spec,footprint.difference(cuts),gates)
        if spec["style"]=="parking-structure" and "offices" in spec.get("summary","").lower():
            for part in record["parts"]:
                if part["floors"]>=4:part["officeTop"]=True
        complete_covered_access(record,canopies.get(b["id"]),drives)
        sample=survey_roofs(record,{**b,'surveyOutline':aligned['footprint']})
        if measured is not None and sample:
            measured_plant(record,measured,origin,sample)
        if sample:
            garden_canopies(record,sample)
            register_rooftop_units(record,sample)
        seat_roof_plant(record)
        record["sourceDigest"]=hashlib.sha256((source if source.exists() else auto).read_bytes()).hexdigest()
        items.append(record)
    if not items:raise ValueError("No matching inventory buildings")
    if args.id and not args.out:raise ValueError("Specify --out for a single building")
    write(args.out or WEB/"campus-buildings.json",items)
    print(f'{len(items)} buildings, {sum(len(i["parts"]) for i in items)} massing parts')


if __name__=="__main__":
    main()
