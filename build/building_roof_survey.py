import math
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import MultiPoint, Polygon
import shapely


ROOT = Path(__file__).resolve().parents[1]
def roof_offset(image, footprint, low, scale):
    points=[]
    normals=[]
    area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(footprint,footprint[1:]+footprint[:1]))
    for a,b in zip(footprint,footprint[1:]+footprint[:1]):
        dx,dz=np.subtract(b,a);length=math.hypot(dx,dz)
        if length<2:
            continue
        for t in np.linspace(.08,.92,max(2,round(length/1.55))):
            points.append((np.array(a)+np.array([dx,dz])*t-low+18)*scale)
            normals.append(np.sign(area)*np.array([dz,-dx])/length)
    if len(points)<10:
        return np.zeros(2)
    pts=np.array(points);normal=np.array(normals)
    field=np.asarray(image.resize((max(1,image.width//3),max(1,image.height//3)),Image.Resampling.BILINEAR),dtype=np.float32)
    def score(shift):
        center=(pts+shift*scale)/3
        def rgb(d):
            p=np.rint(center+normal*(d*scale/3)).astype(int)
            return field[p[:,1].clip(0,field.shape[0]-1),p[:,0].clip(0,field.shape[1]-1)]
        a,b=rgb(-.65),rgb(.65)
        edge=np.linalg.norm(a-b,axis=1)
        inner=np.linalg.norm(a-rgb(-1.9),axis=1)
        return np.mean(np.minimum(edge,110)-.25*np.minimum(inner,85))-.4*np.linalg.norm(shift)
    shifts=[np.array([x,z],dtype=float) for x in range(-8,9,2) for z in range(-8,9,2)]
    best=max(shifts,key=score)
    choices=[best+[x,z] for x in (-1,-.5,0,.5,1) for z in (-1,-.5,0,.5,1)]
    best=max(choices,key=score)
    zero=np.zeros(2)
    return best if score(best)>score(zero)*1.15+2.3 else zero


def hex_color(rgb):
    return '#'+''.join(f'{round(float(c)):02x}' for c in np.clip(rgb,0,255))


def survey_roofs(record,building):
    source=ROOT/'data/buildings/evidence'/building['id']/'aerial-source.jpg'
    if not record['parts'] or not source.exists():
        return None
    points=np.asarray(building['footprint'])
    low=points.min(axis=0);high=points.max(axis=0)
    with Image.open(source) as raw:
        image=raw.convert('RGB')
        scale=np.array(image.size)/(high-low+36)
        offset=roof_offset(image,building.get('surveyOutline',building['footprint']),low,scale)
        rgb=np.asarray(image)
    def sample(x,z):
        ix=np.clip(np.rint((x-low[0]+18+offset[0])*scale[0]).astype(int),0,rgb.shape[1]-1)
        iz=np.clip(np.rint((z-low[1]+18+offset[1])*scale[1]).astype(int),0,rgb.shape[0]-1)
        return rgb[iz,ix]
    shapes=[Polygon(p['rings'][0],p['rings'][1:]).buffer(0) for p in record['parts']]
    for part,shape in zip(record['parts'],shapes):
        ref=part['roof'].get('material','roof')
        authored=record['spec']['materials'].get(ref,{})
        kind=authored.get('kind','membrane')
        if kind in ('glass-curtain','glass-block') or part.get('absoluteSoffit') is not None or shape.area<20:
            continue
        roof=shape.buffer(-.9)
        for higher,cover in zip(record['parts'],shapes):
            if higher['high']>part['high']+.15 and roof.intersects(cover):
                roof=roof.difference(cover.buffer(.35))
        if roof.is_empty or roof.area<12:
            continue
        l,t,r,b=roof.bounds
        z,x=np.mgrid[math.floor(t):math.ceil(b)+1,math.floor(l):math.ceil(r)+1];x=x+.5;z=z+.5
        pixels=sample(x,z).astype(float)
        red,green,blue=pixels.transpose(2,0,1)
        valid=shapely.contains_xy(roof,x,z)
        valid&=(pixels.mean(axis=2)>43)&~((green>red*1.15+5)&(green>blue*1.32+4))
        if valid.sum()<8:
            continue
        values=pixels[valid]
        median=np.median(values,axis=0)
        base=np.array([int(authored.get('color','#979487')[i:i+2],16) for i in (1,3,5)])
        strength=.48 if kind in ('membrane','gravel-ballast','concrete-smooth','standing-seam-metal') else .36
        colour=base*(1-strength)+median*strength
        if part['roof']['form']=='flat' and kind in ('membrane','gravel-ballast','concrete-smooth'):
            slope,ambient=(.80,55.) if kind=='gravel-ballast' else (.69,70.)
            calibrated=np.clip((median-ambient)/slope,median*.52,255)
            colour=base*.17+calibrated*.83
        rectangle=np.array(shape.minimum_rotated_rectangle.exterior.coords)[:4]
        edges=np.roll(rectangle,-1,axis=0)-rectangle
        axis=edges[np.argmax(np.linalg.norm(edges,axis=1))]
        finish=part['roofFinish']=dict(color=hex_color(colour),roofAxis=round(math.atan2(axis[1],axis[0])%math.pi,4),weathering=round(float(np.clip(np.std(values.mean(axis=1))/98,.10,.45)),3))
        if kind not in ('membrane','gravel-ballast','concrete-smooth') or roof.area<160:
            continue
        grey=pixels.mean(axis=2)
        found=[]
        for sign in (1,-1):
            marked=valid&(sign*(grey-np.median(grey[valid]))>max(23,np.std(grey[valid])*.9))
            marked=ndimage.binary_opening(marked,structure=np.ones((2,2)))
            components,count=ndimage.label(marked)
            for label,sl in enumerate(ndimage.find_objects(components),1):
                if sl is None:continue
                hit=components[sl]==label
                n=hit.sum()
                if n<14 or n>roof.area*.32:continue
                coords=np.stack([x[sl][hit],z[sl][hit]],axis=1)
                rect=MultiPoint(coords).minimum_rotated_rectangle
                if rect.geom_type!='Polygon' or not roof.covers(rect) or n<rect.area*.73:continue
                a,v,c=list(rect.exterior.coords)[:3]
                w=math.dist(a,v);d=math.dist(v,c)
                if min(w,d)<2 or max(w,d)/min(w,d)>7:continue
                contrast=float(np.median(grey[sl][hit])-np.median(grey[valid]))
                center=rect.centroid
                found.append((n,[round(center.x,2),round(center.y,2),round(w*.5,2),round(d*.5,2),round(math.atan2(v[1]-a[1],v[0]-a[0]),4),round(float(np.clip(contrast/140,-.32,.30)),3)]))
        if found:finish['repairs']=[row for _,row in sorted(found,key=lambda v:-v[0])[:2]]
    return lambda x,z: sample(np.asarray(x),np.asarray(z)).astype(float)


def register_rooftop_units(record, sample):
    if record['spec']['style'] in ('parking-structure', 'house') or record['spec']['roof'].get('suspension'):
        return
    parts = record['parts']
    plates = [Polygon(p['rings'][0], p['rings'][1:]).buffer(0) for p in parts]
    occupied = []
    for part in parts:
        for unit in part['roof'].get('features', []):
            center = unit.get('at', unit.get('center'))
            if center:
                size = unit.get('size', [2, 2])
                angle = math.radians(unit.get('rotation', 0))
                ux = np.array([math.cos(angle), math.sin(angle)]) * size[0] / 2
                uz = np.array([-math.sin(angle), math.cos(angle)]) * size[1] / 2
                occupied.append(Polygon([center + a*ux + b*uz for a,b in ((1,1),(-1,1),(-1,-1),(1,-1))]).buffer(.65))
    candidates = []
    step = .4
    for part, plate in zip(parts, plates):
        roof = part['roof']
        if plate.area < 180 or roof['form'] != 'flat' or part.get('absoluteSoffit') is not None:
            continue
        mat = record['spec']['materials'].get(roof.get('material', 'roof'), {})
        if mat.get('kind') not in ('membrane','gravel-ballast','concrete-smooth','precast-panel'):
            continue
        area = plate.buffer(-1.5)
        for other, cover in zip(parts, plates):
            if other['high'] > part['high'] + .15 and cover.intersects(area):
                area = area.difference(cover.buffer(.9))
        if area.is_empty or area.area < 120:
            continue
        left,top,right,bottom = area.bounds
        x,z = np.meshgrid(np.arange(left,right,step), np.arange(top,bottom,step))
        rgb = sample(x,z)
        grey = rgb.mean(axis=2)
        keep = shapely.contains_xy(area,x,z)
        local = ndimage.grey_opening(grey,size=(13,13))
        vegetation = (rgb[:,:,1] > rgb[:,:,0]*1.12+4) & (rgb[:,:,1] > rgb[:,:,2]*1.17+4)
        bright = keep & ~vegetation & (grey-local > 24)
        labels,_ = ndimage.label(ndimage.binary_opening(bright,structure=np.ones((2,2))))
        for label,sl in enumerate(ndimage.find_objects(labels),1):
            if sl is None:
                continue
            mask = labels[sl] == label
            count = mask.sum()
            if not 11 <= count <= 365:
                continue
            points = np.column_stack((x[sl][mask],z[sl][mask]))
            rect = MultiPoint(points).minimum_rotated_rectangle
            if rect.geom_type != 'Polygon' or rect.area <= 0 or not area.covers(rect):
                continue
            a,b,c = np.asarray(rect.exterior.coords)[:3]
            axis,across = b-a,c-b
            w,d = np.linalg.norm(axis)+step,np.linalg.norm(across)+step
            fill = count*step**2/(w*d)
            if min(w,d)<.85 or max(w,d)>17 or fill<.79 or max(w,d)>min(w,d)*9:
                continue
            if any(shape.intersects(rect) for shape in occupied):
                continue
            center = np.array(rect.centroid.coords[0])
            colour = np.median(rgb[sl][mask],axis=0)
            if max(colour)-min(colour)>45 or np.std(grey[sl][mask])>19:
                continue
            axis /= np.linalg.norm(axis)
            across /= np.linalg.norm(across)
            shadow_depth = 0.
            for normal,tangent,span,length in [(axis,across,w,d),(-axis,across,w,d),(across,axis,d,w),(-across,axis,d,w)]:
                if normal.sum() > -.35:
                    continue
                edge = center + normal*span/2 + np.linspace(-.36,.36,7)[:,None]*length*tangent
                near = edge + normal*.61
                far = edge + normal*2.4
                if not shapely.contains_xy(area,far[:,0],far[:,1]).all():
                    continue
                shadow = sample(near[:,0],near[:,1]).mean(axis=1)
                surround = sample(far[:,0],far[:,1]).mean(axis=1)
                if np.count_nonzero((surround-shadow>16)&(colour.mean()-shadow>25))>=5:
                    shadow_depth = max(shadow_depth,float(np.median(surround-shadow)))
            if shadow_depth == 0:
                continue
            if w < d:
                w,d = d,w
                axis = across
            height = np.clip(d*.44,.38,1.65)
            style = 'sheet metal duct' if w/d>2.65 else 'packaged air handler'
            row = dict(type='hvac',at=center.round(2).tolist(),size=[round(w,2),round(d,2),round(float(height),2)],rotation=round(math.degrees(math.atan2(axis[1],axis[0])),2),material=hex_color(colour),style=style)
            candidates.append((fill*shadow_depth*min(12,rect.area),part,rect,row))
    accepted = 0
    for _,part,rect,row in sorted(candidates,key=lambda item:-item[0]):
        if accepted >= 6:
            break
        if not any(shape.intersects(rect) for shape in occupied):
            part['roof']['features'] = [*part['roof'].get('features',[]),row]
            occupied.append(rect.buffer(.7))
            accepted += 1
