import json
import math
import sys

import numpy as np
from PIL import Image
from rasterio import Affine
from rasterio.features import rasterize
from scipy.spatial import cKDTree
from shapely import STRtree,union_all
from shapely.geometry import LineString,Polygon,box

import campus_region as region
from ground_observations import parcel,survey_tile


OUT=region.OUT.parents[1]/'build'/'survey_parking.json'


def lot_mask(extra=None,network=None):
    data=network if network is not None else json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    shapes=[]
    for area in data['areas']:
        if area['kind']=='parking':
            shell,*holes=[np.reshape(r,(-1,2)) for r in area['rings']]
            shapes.append(Polygon(shell,holes).buffer(0))
    if extra is None:
        extra=json.loads(OUT.read_bytes()).get('surveyedLots',[]) if OUT.exists() else []
    for shell,*holes in extra:
        shapes.append(Polygon(np.reshape(shell,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]))
    return union_all(shapes,grid_size=.00001).buffer(-.28).intersection(parcel())


def rows(lots):
    import cv2
    cv2.setNumThreads(1)
    cache=region.CACHE.parent/'audit'/'ortho-2025'
    left,top,right,bottom=lots.bounds
    found=[]
    for j in range(math.floor(top/150),math.ceil(bottom/150)):
        for i in range(math.floor(left/150),math.ceil(right/150)):
            x,z=150*i,150*j
            if not lots.intersects(box(x,z,x+150,z+150)):
                continue
            survey_tile(x,z)
            with Image.open(cache/f'{x}_{z}.jpg') as photo:
                rgb=np.asarray(photo.convert('RGB'),dtype=np.int16)
            red,green,blue=rgb.transpose(2,0,1)
            gray=np.rint(red*.28+green*.53+blue*.19).astype(np.uint8)
            yellow=((red+green)*.5-blue).astype(np.float32)
            pigment=yellow-cv2.GaussianBlur(yellow,(0,0),3)
            gray=np.rint(np.clip(gray+np.clip(pigment*1.9,-15,35),0,255)).astype(np.uint8)
            use=rasterize([(lots.intersection(box(x,z,x+150,z+150)),1)],out_shape=(1500,1500),
                          transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')
            background=cv2.morphologyEx(gray,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(11,11)))
            contrast=gray.astype('int16')-background
            ink=np.uint8((contrast>6)&(gray>104)&(use>0))*255
            lines=cv2.HoughLinesP(ink,1,math.pi/360,23,minLineLength=29,maxLineGap=4)
            if lines is None:
                continue
            for ax,az,bx,bz in lines[:,0,:]:
                a=np.array([ax,az],float)
                b=np.array([bx,bz],float)
                length=np.linalg.norm(b-a)
                if not 30<=length<=78:
                    continue
                axis=(b-a)/length
                normal=np.array([axis[1],-axis[0]])
                samples=np.linspace(a,b,round(length*.6))
                def light(offset):
                    u,v=np.rint(samples+offset*normal).astype(int).clip(0,1499).T
                    return gray[v,u].astype(float)
                center=np.maximum.reduce([light(d) for d in [-.75,0,.75]])
                sides=np.maximum(light(-3.6),light(3.6))
                delta=center-sides
                if (delta>5).mean()<.67 or np.median(delta)<8:
                    continue
                pos=np.r_[a/10+[x,z],b/10+[x,z]]
                if not lots.covers(LineString(pos.reshape(2,2))):
                    continue
                found.append((pos,np.median(delta),length))
    if not found:
        return []
    found.sort(key=lambda r:-r[1]*r[2])
    geom=np.array([p.reshape(2,2) for p,_,_ in found])
    centers=geom.mean(axis=1)
    axes=geom[:,1]-geom[:,0]
    axes/=np.linalg.norm(axes,axis=1)[:,None]
    tree=cKDTree(centers)
    accepted=[]
    active=np.ones(len(geom),bool)
    for i,points in enumerate(geom):
        if not active[i]:
            continue
        neighbors=np.asarray(tree.query_ball_point(centers[i],9))
        delta=centers[neighbors]-centers[i]
        axis=axes[i]
        parallel=np.abs(axes[neighbors]@axis)>.996
        offset=np.abs(delta@np.array([-axis[1],axis[0]]))
        along=np.abs(delta@axis)
        siblings=parallel&(along<1.6)&(((offset>2.35)&(offset<3.6))|((offset>4.75)&(offset<6.7)))
        order=np.rint((delta@np.array([-axis[1],axis[0]]))[siblings]/2.8)
        if not siblings.any() or found[i][1]<13 and len(np.unique(order))<2:
            continue
        accepted.append(points.ravel().round(2).tolist())
        active[neighbors[parallel&(offset<.32)&(along<3.2)]]=False
    return sorted(accepted)


def measured_rows(lots,inventory):
    import cv2
    from scipy.optimize import differential_evolution
    cache=region.CACHE.parent/'audit'/'ortho-2025'
    detected=[]
    for row,(start,end,width) in enumerate(inventory['rows']):
        a,b=np.array(start),np.array(end)
        along=(b-a)/np.linalg.norm(b-a)
        across=np.array([along[1],-along[0]])
        left,top=np.floor(np.minimum(a,b)-width-4).astype(int)
        right,bottom=np.ceil(np.maximum(a,b)+width+4).astype(int)
        pic=Image.new('RGB',((right-left)*10,(bottom-top)*10))
        for iz in range(top//150,(bottom-1)//150+1):
            for ix in range(left//150,(right-1)//150+1):
                tx,tz=ix*150,iz*150
                survey_tile(tx,tz)
                with Image.open(cache/f'{tx}_{tz}.jpg') as tile:
                    pic.paste(tile,((tx-left)*10,(tz-top)*10))
        rgb=np.asarray(pic).astype(np.float32)
        red,green,blue=rgb.transpose(2,0,1)
        yellow=(red+green)*.5-blue
        ink=red*.28+green*.53+blue*.19+np.clip((yellow-cv2.GaussianBlur(yellow,(0,0),3))*1.7,-12,27)
        layer=np.clip(ink-cv2.GaussianBlur(ink,(0,0),1.6),-6,18)
        length=np.linalg.norm(b-a)
        distances=np.linspace(-width*.46,width*.46,round(width*4))
        def centers(params):
            phase,gap,offset,drift=params
            marks=phase+np.arange(math.ceil((length+2)/gap))*gap
            marks=marks[(marks>=-1.4)&(marks<length+1.4)]
            axis=along+across*drift/length
            axis/=np.linalg.norm(axis)
            normal=np.array([axis[1],-axis[0]])
            return a+offset*across+marks[:,None]*axis,normal
        def score(params):
            marks,normal=centers(params)
            world=marks[:,None,:]+distances[None,:,None]*normal
            uv=np.ascontiguousarray(((world-[left,top])*10-.5).astype(np.float32))
            sample=cv2.remap(layer,uv,None,cv2.INTER_LINEAR)
            means=np.sort(sample.mean(axis=1))
            return -np.mean(means[len(means)//4:])
        model=differential_evolution(score,[(-1.7,1.7),(2.48,3.17),(-1.25,1.25),(-1.7,1.7)],seed=29+row,popsize=10,maxiter=35,tol=.007,polish=False)
        centers_on_row,n=centers(model.x)
        for point in centers_on_row:
            cut=LineString([point-n*width*.5,point+n*width*.5]).intersection(lots)
            for line in getattr(cut,'geoms',[cut]):
                if line.geom_type=='LineString' and line.length>=1.3:
                    detected.append(np.array([line.coords[0],line.coords[-1]]).ravel().round(2).tolist())
    return detected


def inventory_lines():
    import shapely
    from parcel_surfaces import survey
    from parking_rows import align_rows,vehicle_axes
    from ortho_road_paint import stripe_samples
    model=survey()
    edge=model.layers['rim']
    extra=[]
    for i,p in enumerate(model.faces):
        if model.face_classes[i+1]!=5 or p.area<30 or 2*p.area/p.length<2.8:continue
        near=edge.query(p.boundary,predicate='dwithin',distance=.4)
        if not len(near):continue
        frontage=sum(p.boundary.intersection(edge.geometries[j].buffer(.45)).length for j in near)
        if frontage>min(24,p.length*.18):
            extra.append([np.asarray(r.coords)[:-1].ravel().round(2).tolist() for r in [p.exterior,*p.interiors]])
    lots=lot_mask(extra)
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    axes=[LineString([(x,z) for x,_,z in w['points']]) for w in net['ways'] if w['class']=='service']
    axes.extend(edge.geometries)
    axes.extend(p.exterior for p in shapely.get_parts(lots))
    near=lots.buffer(12)
    fitted=align_rows([a for a in axes if near.intersects(a)],lots)
    fitted.extend(align_rows(vehicle_axes(lots),lots,centered=True))
    inventory=json.loads(OUT.with_name('survey_parking_rows.json').read_bytes())
    amber=measured_rows(lots,inventory)
    hatches=[]
    for hatch in inventory['hatches']:
        a,b,c,d=np.asarray(hatch['corners'])
        strips=[[a,b],[d,c]]+[[a+(b-a)*u,d+(c-d)*u] for u in np.linspace(0,1,hatch['intervals']+1)]
        for ends in strips:
            cut=LineString(ends).intersection(lots)
            for line in getattr(cut,'geoms',[cut]):
                if line.geom_type=='LineString' and line.length>.45:
                    target=amber if hatch['ink']=='amber' else hatches
                    target.append(np.array([line.coords[0],line.coords[-1]]).ravel().round(2).tolist())
    registered=[LineString(np.reshape(p,(2,2))) for p in amber+hatches]
    index=STRtree(registered)
    white=[]
    for segment in fitted+rows(lots):
        line=LineString(np.reshape(segment,(2,2)))
        near=index.query(line,predicate='dwithin',distance=.4)
        if any(registered[i].buffer(.40).intersection(line).length>line.length*.48 for i in near):
            continue
        recent=registered[len(index.geometries):]
        if any(other.distance(line)<.4 and other.buffer(.4).intersection(line).length>line.length*.48 for other in recent):continue
        contrast,tint,chroma=stripe_samples(*np.array(segment).reshape(2,2))
        if np.mean((tint>3)&(chroma>17))>.38:amber.append(segment)
        else:white.append(segment)
        registered.append(line)
        if len(recent)>=80:index=STRtree(registered)
    return dict(source='City of London Aerial2025',surveyedLots=extra,lines=sorted(white+hatches),amber=sorted(amber))


if __name__=='__main__':
    if '--check' not in sys.argv:
        OUT.write_text(json.dumps(inventory_lines(),separators=(',',':')))
    data=json.loads(OUT.read_bytes())
    lots=lot_mask().buffer(.008)
    surveyed=data['lines']+data.get('amber',[])
    assert len(surveyed)>150 and all(lots.covers(LineString(np.reshape(p,(2,2)))) for p in surveyed)
    print(f"{len(surveyed)} surveyed parking stripes in Western parking lots.")
