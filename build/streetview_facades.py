import argparse
import base64
import hashlib
import io
import inspect
import os
import concurrent.futures as futures
import requests
import json
import math
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point, Polygon
from shapely import contains_xy
from campus_bounds import footprint

import campus_region as region
import geo
from facade_reconstruction import mesh_manifest
from streetview_quality import usable, vertical_roll
from street_segmentation import labels
from streetview_frames import CACHE

WEB = region.OUT.parent
OUTPUT = WEB / 'streetview-facades.json'
ATLAS = 1024


def planar_walls():
    world=json.loads(region.OUT.read_bytes())
    architecture=json.loads((WEB/'region-detail.json').read_bytes())['architecture']
    walls=[]
    buildings={}
    portals=json.loads((WEB/'drive-network.json').read_bytes())['buildingBases']
    def wall(a,b,low,high,normal,key):
        length=math.dist(a,b)
        if length<.45 or high-low<1:
            return
        count=max(1,math.ceil(length/12))
        floors=max(1,math.ceil((high-low)/12))
        for j in range(count):
            left=[s+(t-s)*j/count for s,t in zip(a,b)]
            right=[s+(t-s)*(j+1)/count for s,t in zip(a,b)]
            for k in range(floors):
                walls.append([*left,*right,low+(high-low)*k/floors,low+(high-low)*(k+1)/floors,*normal,key])
    def outline(rings,low,high,key,adjacent=()):
        for index,ring in enumerate(rings):
            coords=np.array(ring).reshape(-1,2)
            px,pz=coords.T
            sign=(1 if (px*np.roll(pz,-1)-pz*np.roll(px,-1)).sum()>0 else -1)*(1 if index==0 else -1)
            for a,b in zip(coords,np.roll(coords,-1,axis=0)):
                length=np.linalg.norm(b-a)
                if length<.45:
                    continue
                nx,nz=(b[1]-a[1])*sign/length,(a[0]-b[0])*sign/length
                middle=(a+b)/2+np.array([nx,nz])*.09
                floor=low
                if adjacent:
                    p=Point(middle)
                    floor=max([low]+[h for h,shape in adjacent if shape.contains(p)])
                wall(a,b,floor,high,(nx,nz),key)
    for i,(ring,holes,base,height,_,name) in enumerate(world['blocks']):
        buildings[i]=name or f'Building {i+1}'
        if str(i) in portals:
            continue
        bands=architecture['tiers'].get(str(i))
        if bands:
            polygons=[(base+h,Polygon(np.array(r[0]).reshape(-1,2),[np.array(hole).reshape(-1,2) for hole in r[1:]])) for h,r in bands]
            for j,(h,rings) in enumerate(bands):
                outline(rings,base,base+h,i,polygons[:j]+polygons[j+1:])
        else:
            ridge=architecture['forms'][i][1]
            hip=architecture['hips'].get(str(i))
            eave=base+height-.5*(ridge[4] if ridge else hip[0] if hip else 0)
            outline([ring,*holes],base,eave,i)
    for i,(_,base,segments,name) in enumerate(architecture['core'],len(world['blocks'])):
        buildings[i]=name
        for ax,az,bx,bz,top,nx,nz in segments:
            wall((ax,az),(bx,bz),base,top,(nx,nz),i)
    return np.array(walls),buildings


@lru_cache(maxsize=1)
def geometry():
    walls,buildings=planar_walls()
    centers=(walls[:,:2]+walls[:,2:4])*.5
    ground=region.lidar('dtm')-(ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4)
    return walls,buildings,cKDTree(centers),ground


def camera(frame,image,mask):
    from streetview_pose import calibrate
    params=calibrate(image,mask,horizontal_fov=frame.get('fov'))
    coords=(frame['x'],frame['z'])
    _,_,_,ground=geometry()
    elevation=float(region.sample(ground,*[np.array([i]) for i in coords])[0])+1.72
    result=[*coords,elevation,math.radians(frame['heading']),params['pitch'],params['fx'],params['fy'],params['cx'],params['cy']]
    return np.asarray(result)


def project(pose,x,y,z):
    cx,cz,alt,yaw,pitch,fx,fy,px,py=pose
    dx,dz,dy=x-cx,z-cz,y-alt
    sy,cy=math.sin(yaw),math.cos(yaw)
    sp,cp=math.sin(pitch),math.cos(pitch)
    forward=dx*sy-dz*cy
    depth=forward*cp-dy*sp
    divisor=np.where(np.abs(depth)>.0001,depth,.0001)
    return px+fx*(dx*cy+dz*sy)/divisor,py+fy*(-sp*forward-cp*dy)/divisor,depth


def projected_scene(pose,near,width,height):
    ax,az,bx,bz,base,top=near[:,:6].T
    px,py,pd=project(pose,np.stack((ax,ax,bx,bx)),np.stack((base,top,top,base)),np.stack((az,az,bz,bz)))
    good=(pd.min(axis=0)>1)&(px.min(axis=0)<1)&(px.max(axis=0)>0)&(py.min(axis=0)<1)&(py.max(axis=0)>0)
    ix=np.flatnonzero(good)
    shape=Image.new('I',(width,height),-1)
    draw=ImageDraw.Draw(shape)
    for j in ix[np.argsort(pd[:,ix].mean(axis=0))[::-1]]:
        draw.polygon(list(zip(px[:,j]*width,py[:,j]*height)),fill=int(j))
    return np.asarray(shape)


def alignment(surface,mask):
    facade=mask==2
    clear=(mask==0)|(mask==1)|(mask==10)
    hit=surface>=0
    positive=(facade & hit).sum()
    return positive/(12+positive+.7*(clear & hit).sum()+.65*(facade & ~hit).sum())


def candidate(frame):
    walls,_,tree,_=geometry()
    indices=np.asarray(tree.query_ball_point([frame['x'],frame['z']],72),dtype=int)
    if not indices.size:
        return None
    near=walls[indices]
    with Image.open(CACHE/frame['path']) as original:
        image=original.convert('RGB')
        mask=labels(frame['id'],image)
        ix=np.where(mask==2)
        if len(ix[0])<mask.size*.018:
            return None
        pose=camera(frame,original,mask)
        width=144
        height=round(width*image.height/image.width)
        small=np.asarray(Image.fromarray(mask).resize((width,height),Image.Resampling.NEAREST))
        chosen=pose.copy()
        best_score=-1
        surface=None
        for delta_yaw in (0,-5,5,-10,10):
            for delta_pitch in (0,-3,3):
                trial=pose.copy()
                trial[3:5]+=np.radians((delta_yaw,delta_pitch))
                view=projected_scene(trial,near,width,height)
                fit=alignment(view,small)-.0018*abs(delta_yaw)-.003*abs(delta_pitch)
                if fit>best_score:
                    best_score,chosen,surface=fit,trial,view
        if best_score<.30:
            return None
        selected=[]
        for local in np.unique(surface[small==2]):
            if local<0:
                continue
            ax,az,bx,bz,base,top,nx,nz,_=near[local]
            dx,dz=chosen[0]-(ax+bx)*.5,chosen[1]-(az+bz)*.5
            distance=math.hypot(dx,dz)
            facing=(dx*nx+dz*nz)/max(1,distance)
            length=math.hypot(ax-bx,az-bz)
            if facing<.32 or distance<3 or distance>67 or length<1.25 or top-base<1.4:
                continue
            spans=(np.arange(12)+.5)/12
            s,t=np.meshgrid(spans,spans)
            u,v,d=project(chosen,ax+(bx-ax)*s,top-(top-base)*t,az+(bz-az)*s)
            interior=(u>.025)&(u<.975)&(v>.02)&(v<.90)&(d>1)
            cols=np.clip((u*width).astype(int),0,width-1)
            rows=np.clip((v*height).astype(int),0,height-1)
            valid=interior&(surface[rows,cols]==local)&(small[rows,cols]==2)
            coverage=float(valid.mean())
            if coverage<.38 or (valid.sum(axis=0)>2).sum()<6:
                continue
            density=image.width*chosen[5]*facing/distance
            if density<5:
                continue
            score=(coverage**1.4)*math.sqrt(facing)*min(density,35)/35*(.45+.55*best_score)
            selected.append([int(indices[local]),round(score,6)])
        if selected:
            return chosen.tolist(),selected


def coherent_views(choices,walls):
    neighbors=defaultdict(list)
    lookup=defaultdict(list)
    for index in choices:
        ax,az,bx,bz,base,top,nx,nz,building=walls[index]
        plane=(int(building),round(nx,2),round(nz,2))
        for x,z,y in [(ax,az,base),(ax,az,top),(bx,bz,base),(bx,bz,top)]:
            key=(*plane,round(x,1),round(z,1),round(y,1))
            for j in lookup[key]:
                neighbors[index].append(j)
                neighbors[j].append(index)
            lookup[key].append(index)
    result={i:max(options,key=options.get) for i,options in choices.items()}
    for sweep in range(4):
        order=sorted(choices,reverse=bool(sweep%2))
        for index in order:
            options=choices[index]
            adjacent={j for j in neighbors[index]}
            counts=defaultdict(float)
            for j in adjacent:
                counts[result[j]]+=1/max(1,len(adjacent))
            result[index]=max(options,key=lambda f:options[f]*(1+.60*counts[f]))
    return {i:(choices[i][fid],fid) for i,fid in result.items()}


def high_resolution(frame):
    low=CACHE/frame['path']
    with Image.open(low) as im:
        if max(im.size)>=1700:
            return low
    folder=CACHE/'originals'
    folder.mkdir(exist_ok=True)
    name=folder/(frame['id']+'.jpg')
    if not name.exists():
        from streetview_frames import fetch_image
        try:
            response=fetch_image(frame['url'])
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as original:
                original.verify()
            pending=name.with_suffix('.part')
            pending.write_bytes(response.content)
            pending.replace(name)
        except (OSError,requests.RequestException):
            return low
    return name


def rectified(frame,pose,entries):
    walls,_,tree,_=geometry()
    ns=np.asarray(tree.query_ball_point([frame['x'],frame['z']],72),dtype=int)
    with Image.open(high_resolution(frame)) as im:
        image=np.asarray(im.convert('RGB'))
        mask=labels(frame['id'],im)
    reduced=np.asarray(Image.fromarray(image).resize((mask.shape[1],mask.shape[0]),Image.Resampling.BILINEAR))
    roll=vertical_roll(reduced,mask,pose)
    def calibrated(pose,x,y,z):
        u,v,d=project(pose,x,y,z)
        px,py=pose[7:9]
        aspect=image.shape[1]/image.shape[0]
        co,si=math.cos(roll),math.sin(roll)
        return px+co*(u-px)-si*(v-py)/aspect,py+si*(u-px)*aspect+co*(v-py),d
    facade_levels=reduced[mask==2]
    exposure=np.clip(158/max(1,np.percentile(facade_levels,83)),.88,1.15) if len(facade_levels) else 1
    surface=projected_scene(pose,walls[ns],mask.shape[1],mask.shape[0])
    if abs(roll)>.0001:
        surface=np.asarray(Image.fromarray(surface).rotate(-math.degrees(roll),resample=Image.Resampling.NEAREST,fillcolor=-1))
    lookup={int(n):i for i,n in enumerate(ns)}
    for index in entries:
        ax,az,bx,bz,base,top,*_=walls[index]
        density=min(22,192/max(math.hypot(bx-ax,bz-az),top-base))
        w=max(16,round(math.hypot(bx-ax,bz-az)*density))
        h=max(16,round((top-base)*density))
        s,t=np.meshgrid((np.arange(w)+.5)/w,(np.arange(h)+.5)/h)
        u,v,d=calibrated(pose,ax+(bx-ax)*s,top-(top-base)*t,az+(bz-az)*s)
        r=np.clip((v*mask.shape[0]).astype(int),0,mask.shape[0]-1)
        c=np.clip((u*mask.shape[1]).astype(int),0,mask.shape[1]-1)
        visible=(d>1)&(u>.015)&(u<.985)&(v>.015)&(v<.91)&(mask[r,c]==2)&(surface[r,c]==lookup[index])
        if visible.mean()<.34:
            continue
        yi=np.clip(v*image.shape[0]-.5,0,image.shape[0]-1)
        xi=np.clip(u*image.shape[1]-.5,0,image.shape[1]-1)
        pixels=np.stack([ndimage.map_coordinates(image[:,:,k],[yi,xi],order=1,mode='nearest') for k in range(3)],axis=-1)
        good=pixels[visible]
        if np.percentile(good,90)-np.percentile(good,10)<20 or np.percentile(good,70)<37:
            continue
        rgb=np.clip(pixels.astype(float)*exposure,0,255).astype(np.uint8)
        alpha=np.minimum(ndimage.distance_transform_edt(visible),3)*85
        crop=Image.fromarray(np.dstack([rgb,alpha.astype(np.uint8)]))
        yield index,crop


def merge_views(views):
    primary_id,primary=views[0]
    canvas=np.array(primary)
    used=[primary_id]
    for fid,other in views[1:]:
        photo=np.asarray(other)
        a=canvas[:,:,3]>160
        b=photo[:,:,3]>160
        if (b&~a).mean()<.04 or (a&b).mean()<.10:
            continue
        h,w=a.shape
        proxy=(max(12,round(w/4)),max(12,round(h/4)))
        def small(p):
            return np.asarray(Image.fromarray(p).resize(proxy,Image.Resampling.BILINEAR)).astype(float)
        gray_a=small(canvas[:,:,:3]).mean(axis=2)
        gray_b=small(photo[:,:,:3]).mean(axis=2)
        ma=small(canvas[:,:,3])>210
        mb=small(photo[:,:,3])>210
        best=(.55,None,None)
        for iy in range(-3,4):
            for ix in range(-3,4):
                aa=(slice(max(0,iy),min(proxy[1],proxy[1]+iy)),slice(max(0,ix),min(proxy[0],proxy[0]+ix)))
                bb=(slice(max(0,-iy),min(proxy[1],proxy[1]-iy)),slice(max(0,-ix),min(proxy[0],proxy[0]-ix)))
                both=ma[aa]&mb[bb]
                if both.sum()<25:
                    continue
                x,y=gray_a[aa][both],gray_b[bb][both]
                x=x-x.mean()
                y=y-y.mean()
                score=float(x@y/np.sqrt(max(1,(x@x)*(y@y))))-.009*(abs(ix)+abs(iy))
                if score>best[0]:
                    best=score,ix,iy
        if best[1] is None:
            continue
        dx,dy=round(best[1]*w/proxy[0]),round(best[2]*h/proxy[1])
        shifted=np.zeros_like(photo)
        da=(slice(max(0,dy),min(h,h+dy)),slice(max(0,dx),min(w,w+dx)))
        db=(slice(max(0,-dy),min(h,h-dy)),slice(max(0,-dx),min(w,w-dx)))
        shifted[da]=photo[db]
        overlap=a&(shifted[:,:,3]>180)
        fill=(shifted[:,:,3]>128)&(canvas[:,:,3]<130)
        if fill.mean()<.035 or overlap.mean()<.08:
            continue
        correction=np.median(canvas[overlap,:3].astype(float)-shifted[overlap,:3].astype(float),axis=0)
        shifted[:,:,:3]=np.clip(shifted[:,:,:3].astype(float)+np.clip(correction,-26,26),0,255)
        canvas[fill]=shifted[fill]
        used.append(fid)
    return Image.fromarray(canvas),used


def write_atlases(winners,frames,poses,choices):
    walls,buildings,_,_=geometry()
    affected=defaultdict(list)
    preferred={}
    for index,(score,fid) in winners.items():
        ranked=[other for other,value in sorted(choices[index].items(),key=lambda item:-item[1]) if other!=fid and value>=score*.68]
        preferred[index]=[fid,*ranked[:2]]
        for other in preferred[index]:
            affected[other].append(index)
    batches=defaultdict(list)
    with futures.ThreadPoolExecutor(6) as pool:
        list(pool.map(high_resolution,[frames[fid] for fid in affected]))
    rectified_views=defaultdict(dict)
    for fid,entries in affected.items():
        for index,image in rectified(frames[fid],poses[fid],entries):
            rectified_views[index][fid]=image
    for index,available in rectified_views.items():
        ordered=[(fid,available[fid]) for fid in preferred[index] if fid in available]
        image,sources=merge_views(ordered)
        ax,az,bx,bz=walls[index,:4]
        batches[(math.floor((ax+bx)/384),math.floor((az+bz)/384))].append((index,image,sources))
    tiles=[]
    credits={}
    visible=set()
    names={}
    for (tx,tz),batch in sorted(batches.items()):
        sheet=Image.new('RGBA',(ATLAS,ATLAS))
        panels=[]
        sx=sy=row_height=0
        def flush():
            if panels:
                buffer=io.BytesIO()
                span=math.ceil(max(max(p[10],p[11]) for p in panels)*ATLAS)+1
                size=min(ATLAS,2**math.ceil(math.log2(span)))
                packed=sheet.crop((0,0,size,size))
                packed.save(buffer,'WEBP',quality=86,method=4)
                scale=ATLAS/size
                packed_panels=[p[:8]+[v*scale for v in p[8:12]]+p[12:] for p in panels]
                tiles.append(dict(x=tx*192+96,z=tz*192+96,size=size,image=base64.b64encode(buffer.getvalue()).decode(),panels=packed_panels))
        for index,image,sources in sorted(batch,key=lambda v:-v[1].height):
            w,h=image.size
            if sx+w+4>ATLAS:
                sx=0
                sy+=row_height
                row_height=0
            if sy+h+4>ATLAS:
                flush()
                sheet=Image.new('RGBA',(ATLAS,ATLAS))
                panels=[]
                sx=sy=row_height=0
            x,y=sx+2,sy+2
            sheet.paste(image,(x,y))
            panel=walls[index]
            building=int(panel[-1])
            panels.append([*[round(k,3) for k in panel[:8]],x/ATLAS,y/ATLAS,(x+w)/ATLAS,(y+h)/ATLAS,sources[0],building,sources[1:]])
            visible.add(building)
            names[building]=buildings[building]
            for fid in sources:
                f=frames[fid]
                credits[fid]=dict(url=f"https://kartaview.org/details/{f['sequence']}/{f['index']}",username=f['author'] or 'KartaView contributor',date=f['date'],x=f['x'],z=f['z'],heading=f['heading'])
            sx+=w+4
            row_height=max(row_height,h+4)
        flush()
    coverage=dict(framesExamined=len(frames),sourceFrames=len(credits),walls=sum(len(t['panels']) for t in tiles),buildings=len(visible),inventoryBuildings=len(set(walls[campus_walls(),8])))
    evidence=dict(coverage=coverage,frames=credits,buildings=names,tiles=tiles)
    (CACHE/'wall-observations.json').write_text(json.dumps(evidence,separators=(',',':')))
    save_mesh(evidence)
    print(coverage, flush=True)


def save_mesh(evidence):
    out=mesh_manifest(evidence)
    temp=OUTPUT.with_suffix('.tmp')
    temp.write_text(json.dumps(out,separators=(',',':')))
    temp.replace(OUTPUT)
    print(out['coverage'], flush=True)


def verify():
    runtime=json.loads(OUTPUT.read_bytes())
    data=json.loads((CACHE/'wall-observations.json').read_bytes())
    walls,names,_,_=geometry()
    wallset={tuple(np.round(row[:6],3)) for row in walls}
    seen=set()
    frameids=set()
    for tile in data['tiles']:
        with Image.open(io.BytesIO(base64.b64decode(tile['image']))) as im:
            assert im.size==(tile['size'],tile['size']) and im.mode=='RGBA'
            alpha=im.getchannel('A')
            for panel in tile['panels']:
                assert tuple(panel[:6]) in wallset
                ax,az,bx,bz,base,top,nx,nz,u,v,U,V,fid,bid,extras=panel
                assert (bid,*panel[:6]) not in seen and (nx*nx+nz*nz)>.97
                seen.add((bid,*panel[:6]))
                assert 0<u<U<1 and 0<v<V<1
                f=data['frames'][fid]
                dx,dz=f['x']-(ax+bx)/2,f['z']-(az+bz)/2
                assert dx*nx+dz*nz>0 and math.hypot(dx,dz)<68
                assert f['url'].startswith('https://kartaview.org/details/')
                assert alpha.crop(tuple(round(k*tile['size']) for k in (u,v,U,V))).getextrema()[1]>200
                frameids.update([fid,*extras])
                for extra in extras:
                    assert extra in data['frames'] and math.hypot(data['frames'][extra]['x']-(ax+bx)/2,data['frames'][extra]['z']-(az+bz)/2)<68
    assert len(seen)==data['coverage']['walls'] and len(frameids)==data['coverage']['sourceFrames']
    assert all(contains_xy(footprint_cached(),f['x'],f['z']) for f in runtime['frames'].values())
    assert len(frameids)>10 and len(seen)>30
    assert all('image' not in t for t in runtime['tiles'])
    assert 'data:image' not in OUTPUT.read_text()
    count=defaultdict(int)
    for tile in runtime['tiles']:
        for panel in tile['panels']:
            assert panel[9] in runtime['frames'] and contains_xy(footprint_cached(),(panel[0]+panel[2])/2,(panel[1]+panel[3])/2)
            for feature in panel[10]:
                assert 0<feature['w']<=1 and 0<feature['h']<=1 and 0<=feature['u']<=1 and 0<=feature['v']<=1
                assert isinstance(feature['color'],int) and feature['kind'] in ('wall','door','window','band','pier','sign')
                count[feature['kind']]+=1
    assert dict(count)==runtime['coverage']['architecture'] and count['window']>50
    print('Verified geolocated evidence and zero wall image payloads. Modeled architecture:',dict(count))


@lru_cache(maxsize=1)
def footprint_cached():
    return footprint()


def campus_walls():
    walls,_,_,_=geometry()
    inside=contains_xy(footprint_cached(),(walls[:,0]+walls[:,2])/2,(walls[:,1]+walls[:,3])/2)
    return np.flatnonzero(inside)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--limit',type=int)
    parser.add_argument('--from-observations',action='store_true')
    parser.add_argument('--scan-only',action='store_true')
    parser.add_argument('--cached-only',action='store_true')
    args=parser.parse_args()
    if args.check:
        return verify()
    if args.from_observations:
        return save_mesh(json.loads((CACHE/'wall-observations.json').read_bytes()))
    records=[f for f in json.loads((CACHE/'frames.json').read_bytes()) if contains_xy(footprint_cached(),f['x'],f['z'])]
    fingerprint=''.join(inspect.getsource(fun) for fun in (camera,planar_walls,geometry,project,projected_scene,alignment,candidate))
    version=hashlib.sha1(fingerprint.encode()+(Path(__file__).parent/'streetview_pose.py').read_bytes()+(WEB/'campus-region.json').read_bytes()).hexdigest()[:12]
    folder=CACHE/('matches-'+version)
    folder.mkdir(exist_ok=True)
    frames={r['id']:r for r in records[:args.limit] if not args.cached_only or (folder/(r['id']+'.json')).exists()}
    choices=defaultdict(dict)
    poses={}
    geometry()
    def scan(item):
        fid,frame=item
        p=folder/(fid+'.json')
        if p.exists():
            match=json.loads(p.read_bytes())
        else:
            match=candidate(frame)
            tmp=p.with_suffix(f'.{os.getpid()}.tmp')
            tmp.write_text(json.dumps(match,separators=(',',':')))
            tmp.replace(p)
        if match:
            stamp=CACHE/'quality-v1'/(fid+'.txt')
            if not stamp.exists():
                with Image.open(CACHE/frame['path']) as photo:
                    ok=usable(photo)
                stamp.parent.mkdir(exist_ok=True)
                stamp.write_text('clear' if ok else 'occluded')
            if stamp.read_text()!='clear':
                match=None
        return fid,match
    with futures.ThreadPoolExecutor(3) as pool:
        for i,(fid,match) in enumerate(pool.map(scan,frames.items()),1):
            if match:
                poses[fid]=match[0]
                for index,score in match[1]:
                    choices[index][fid]=score
            if i%500==0:
                print(i,'scanned',len(choices),'wall panels',flush=True)
    if not args.scan_only:
        allowed=set(campus_walls())
        choices={i:v for i,v in choices.items() if i in allowed}
        write_atlases(coherent_views(choices,geometry()[0]),frames,poses,choices)


if __name__=='__main__':
    main()
