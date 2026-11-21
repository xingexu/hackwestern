import argparse
import base64
import io
import json
import math
import os
import zlib
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import inspect
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely import STRtree, intersects_xy, prepare
from shapely.geometry import LineString, Point

import campus_region as region
from campus_bounds import footprint
import geo
from street_finishes import coverage, patches
from ground_materials import estate_surfaces, game_cover
from street_segmentation import labels
from streetview_pose import calibrate

OUT=region.OUT.with_name('ground-materials.json')
CORPUS=geo.DATA/'streetview'
RES=4


def read_image(encoded):
    return Image.open(io.BytesIO(base64.b64decode(encoded)))


class Survey:
    def __init__(self):
        terrain=json.loads(region.OUT.read_bytes())
        surface=json.loads(region.OUT.with_name('surface-tiles.json').read_bytes())
        net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
        self.domain=footprint()
        prepare(self.domain)
        self.bounds=terrain['bounds']
        self.patches=dict(patches(terrain['xs'],terrain['zs']))
        self.finishes=surface['finishes']
        self.version=hashlib.sha256((surface['carriageway']['samples']+''.join(self.finishes.values())).encode()).hexdigest()[:12]
        self.road=np.asarray(coverage(surface['carriageway']))
        self.dtm=region.lidar('dtm')
        self.ways=[w for w in net['ways'] if w['kind']=='road' and not w['bridge'] and w['level']==0]
        self.lines=STRtree([LineString(np.asarray(w['points'])[:,[0,2]]) for w in self.ways])
        self.deck=STRtree([LineString(np.asarray(w['points'])[:,[0,2]]).buffer(w['width']/2+1.5) for w in net['ways'] if w['bridge']])
        self.grids={}

    @lru_cache(maxsize=16)
    def finish(self,key):
        return np.array(read_image(self.finishes[key]))

    def index(self,x,z):
        left,right,top,bottom=x.min(),x.max(),z.min(),z.max()
        return [(key,b) for key,b in self.patches.items() if b[2]>left and b[0]<right and b[3]>top and b[1]<bottom]

    def classes(self,x,z,paint=False):
        left,top,right,bottom=self.bounds
        h,w=self.road.shape
        a=np.clip(((x-left)*w/(right-left)).astype(int),0,w-1)
        b=np.clip(((z-top)*h/(bottom-top)).astype(int),0,h-1)
        road=self.road[b,a]
        out=np.where(road>=210,1,0).astype(np.uint8)
        ink=np.zeros_like(out)
        for key,(x0,z0,x1,z1) in self.index(x,z):
            fit=(x>=x0)&(x<x1)&(z>=z0)&(z<z1)
            if not paint:
                fit&=road<30
            if not fit.any():
                continue
            finish=self.finish(key)
            j=((x[fit]-x0)*finish.shape[1]/(x1-x0)).astype(int)
            i=((z[fit]-z0)*finish.shape[0]/(z1-z0)).astype(int)
            f=finish[i,j]
            out[fit]=np.where((f[:,2]>213)&(road[fit]<30),2,out[fit])
            if paint:
                ink[fit]=np.maximum(f[:,0],f[:,1])
        return (out,ink) if paint else out

    def nearest(self,x,z,heading):
        p=Point(x,z)
        candidates=[]
        for i in self.lines.query(p.buffer(15)):
            w=self.ways[i]
            line=self.lines.geometries[i]
            distance=p.distance(line)
            if distance>w['width']*.5+3:
                continue
            d=line.project(p)
            a=line.interpolate(max(0,d-3))
            b=line.interpolate(min(line.length,d+3))
            bearing=math.atan2(b.x-a.x,a.y-b.y)
            mismatch=math.acos(np.clip(abs(math.cos(heading-bearing)),0,1))
            if mismatch<math.radians(41):
                candidates.append((distance+3*mismatch,i))
        return self.ways[min(candidates)[1]] if candidates else None

    def add(self,x,z,kind,shade,weight,wear,donor):
        for key,(x0,z0,x1,z1) in self.index(x,z):
            valid=(x>=x0)&(x<x1)&(z>=z0)&(z<z1)
            if not valid.any():
                continue
            col=np.rint(x[valid]*RES).astype(int)
            row=np.rint(z[valid]*RES).astype(int)
            for bx,bz in set(zip(col//64,row//64)):
                sel=(col//64==bx)&(row//64==bz)
                block=(key,bx,bz)
                if block not in self.grids:
                    self.grids[block]=np.zeros((64,64,5),np.float32)
                data=self.grids[block]
                iy=row[sel]%64
                ix=col[sel]%64
                strength=weight[valid][sel]
                chosen=strength>data[iy,ix,1]
                data[iy[chosen],ix[chosen]]=np.stack([shade[valid][sel],strength,kind[valid][sel],wear[valid][sel],np.full(strength.size,donor)],axis=-1)[chosen]

    def export(self,frames):
        by_tile=defaultdict(list)
        for (key,bx,bz),data in self.grids.items():
            by_tile[key].append((bx,bz,data))
        tiles={}
        for key,parts in by_tile.items():
            cols,rows=zip(*[(cx,cz) for cx,cz,_ in parts])
            left,top,right,bottom=min(cols)*64-1,min(rows)*64-1,(max(cols)+1)*64+1,(max(rows)+1)*64+1
            donors=np.zeros((bottom-top,right-left),np.uint16)
            surfaces=np.zeros_like(donors,dtype=np.uint8)
            cells=[]
            for bx,bz,data in parts:
                col,row=bx*64-left,bz*64-top
                donors[row:row+64,col:col+64]=data[:,:,4]
                surfaces[row:row+64,col:col+64]=data[:,:,2]
                for j in (0,1):
                    for i in (0,1):
                        block=data[j*32:(j+1)*32,i*32:(i+1)*32]
                        states=[]
                        for kind in (1,2):
                            visible=block[:,:,2]==kind
                            differences=[]
                            for a,b in [(block[1:],block[:-1]),(block[:,1:],block[:,:-1])]:
                                match=(a[:,:,2]==kind)&(b[:,:,2]==kind)&(a[:,:,4]==b[:,:,4])
                                if match.any():
                                    differences.extend(np.abs(a[:,:,0]-b[:,:,0])[match])
                            if len(differences)<16 or visible.sum()<12:
                                states.append(0)
                                continue
                            rough=np.percentile(differences,72)
                            states.append(1 if rough<3 else 2 if rough<8 else 3)
                        observed=block[:,:,3][(block[:,:,3]>0)&(block[:,:,3]<255)]
                        wear=(1 if np.median(observed)>220 else 2) if observed.size>=3 else 0
                        inside=intersects_xy(self.domain,(bx*2+i+.5)*8,(bz*2+j+.5)*8)
                        if inside and (any(states) or wear):
                            cells.append([int(bx*2+i),int(bz*2+j),*states,wear])
            row,col=np.nonzero(donors)
            if not row.size or not cells:
                continue
            x,z,u,v=col.min(),row.min(),col.max()+1,row.max()+1
            ids,counts=np.unique(donors[row,col],return_counts=True)
            source=frames[int(ids[max(range(len(ids)),key=lambda i:frames[ids[i]-1]['contrast']*min(counts[i],1600))])-1]
            ref={k:source[k] for k in ('id','sequence','index','date','author','camera','heading','contrast')}
            provenance=np.stack([donors[z:v,x:u]%256,donors[z:v,x:u]//256,surfaces[z:v,x:u]],axis=-1).astype(np.uint8)
            source_buf=io.BytesIO()
            Image.fromarray(provenance).save(source_buf,format='PNG')
            tiles[key]={'reference':ref,'cells':cells,'proof':base64.b64encode(source_buf.getvalue()).decode(),'origin':[int(left+x),int(top+z)]}
        return tiles


def locate_camera(survey,frame):
    if frame.get('heading') is None or frame.get('projection','PLANE')!='PLANE':
        return 'unsupported-camera-pose'
    x,z=geo.to_grid(float(frame['lat']),float(frame['lon']))
    heading=math.radians(float(frame['heading']))
    way=survey.nearest(x,z,heading)
    if not way:
        return 'no-matching-road-segment'
    if survey.deck.query(Point(x,z).buffer(24),predicate='intersects').size:
        return 'elevated-deck-needs-separate-projection'
    return x,z,heading,way


def extract(survey,frame,image,mask,camera):
    x,z,heading,way=camera
    if min(image.size)<200:
        return 'source-size'
    if (mask==0).mean()<.025:
        return 'no-confident-visible-road'
    pose=calibrate(image,mask,frame.get('fov'))
    sw,sh=image.size
    factor=min(1.,864/max(sw,sh))
    w,h=round(sw*factor),round(sh*factor)
    detail_scale=w/mask.shape[1]
    mask=np.asarray(Image.fromarray(mask).resize((w,h),Image.Resampling.NEAREST))
    classes=np.where(mask==0,1,np.where(mask==1,2,0)).astype(np.uint8)
    image_h=frame.get('cameraHeight') or 1.65
    focal=pose['fx']*w
    gridx,gridz=np.meshgrid(np.arange(math.floor(x-24),math.ceil(x+24),1/RES),np.arange(math.floor(z-24),math.ceil(z+24),1/RES))
    cx,cz=gridx.ravel(),gridz.ravel()
    mapped,ink=survey.classes(cx,cz,paint=True)
    relief=region.sample(survey.dtm,cx,cz)
    eye=float(region.sample(survey.dtm,np.array([x]),np.array([z]))[0])+image_h
    elevation=eye-relief

    def camera(ids,yaw,pitch,offset):
        s,c=math.sin(yaw),math.cos(yaw)
        depth=(cx[ids]-x)*s-(cz[ids]-z)*c
        across=(cx[ids]-x)*c+(cz[ids]-z)*s-offset
        co,si=math.cos(pitch),math.sin(pitch)
        denom=np.maximum(.01,depth*co+elevation[ids]*si)
        u=w*.5+focal*across/denom
        v=h*.5+focal*(elevation[ids]*co-depth*si)/denom
        inside=(depth>4)&(depth<20)&(u>w*.13)&(u<w*.87)&(v>h*.38)&(v<h*bottom)
        i=np.clip(v.astype(int),0,h-1)
        j=np.clip(u.astype(int),0,w-1)
        return inside,i,j,depth,u,v

    sample=np.arange(cx.size).reshape(gridx.shape)[::5,::5].ravel()
    pitch=float(frame['pitch']) if frame.get('pitch') is not None else math.degrees(pose['pitch'])
    bottom=.87
    best=None
    for da in (-7,0,7):
        for dp in (-4,0,4):
            for offset in (-1.5,0,1.5):
                yaw=heading+math.radians(da)
                tilt=math.radians(pitch+dp)
                inside,i,j,*_=camera(sample,yaw,tilt,offset)
                pred=classes[i,j]
                target=mapped[sample]
                road=(target==1)&inside
                if road.sum()<28:
                    continue
                score=0
                for c,importance in [(1,.78),(2,.22)]:
                    a=(target==c)&inside
                    b=(pred==c)&inside
                    if a.sum()+b.sum()>10:
                        score+=importance*2*(a&b).sum()/(a.sum()+b.sum())
                    else:
                        score+=importance*.66
                score-=.003*abs(da)+.004*abs(dp)+.014*abs(offset)
                if best is None or score>best[0]:
                    best=(score,yaw,tilt,offset)
    if best is None or best[0]<.70:
        return 'camera-street-registration'
    ids=np.flatnonzero(mapped)
    inside,i,j,depth,u,v=camera(ids,*best[1:])
    if inside.sum()<130:
        return 'insufficient-frustum-pavement'
    photo=np.asarray(image.convert('RGB').resize((w,h),Image.Resampling.LANCZOS),dtype=np.float32)/255
    luma=photo@np.array([.2126,.7152,.0722],np.float32)
    red,green,blue=photo.transpose(2,0,1)
    neutral=(np.maximum(np.maximum(red,green),blue)-np.minimum(np.minimum(red,green),blue)<.24)&(luma>.10)&(luma<.91)
    margin=math.ceil(20*detail_scale)+2
    y0=max(0,i[inside].min()-margin)
    y1=min(h,i[inside].max()+margin+1)
    x0=max(0,j[inside].min()-margin)
    x1=min(w,j[inside].max()+margin+1)
    roi=np.s_[y0:y1,x0:x1]
    tone=np.zeros_like(luma)
    valid=np.zeros_like(classes,dtype=bool)
    paint_delta=np.zeros_like(luma)
    for c in (1,2):
        internal=(ndimage.distance_transform_edt(classes==c)>2.2*detail_scale)&neutral
        valid|=internal
        if internal.any():
            local=internal[roi]
            light=luma[roi]
            avg=ndimage.gaussian_filter(light*local,5*detail_scale)/np.maximum(.0001,ndimage.gaussian_filter(local.astype('f'),5*detail_scale))
            center=np.median(luma[internal])
            tone[roi][local]=np.clip(128+(light[local]-avg[local])*540+(avg[local]-center)*65,46,210)
            if c==1:
                paint_delta[roi][local]=light[local]-avg[local]
                valid[roi][local&(light>avg+.12)]=False
    matched=(mapped[ids]==1)&(ink[ids]>16)&(paint_delta[i,j]>.055)
    keep=inside&(valid[i,j]|matched)&(classes[i,j]==mapped[ids])
    if keep.sum()<130:
        return 'occlusion-or-nonmatching-material'
    sel=ids[keep]
    matched=matched[keep]
    i,j,depth,u,v=i[keep],j[keep],depth[keep],u[keep]/w,v[keep]/h
    edge=np.minimum.reduce([(u-.13)*14,(.87-u)*14,(bottom-v)*23,(v-.38)*23,(depth-4)/2,(20-depth)/5])
    weight=np.clip(edge,0,1)*best[0]*np.clip((24-depth)/14,.15,1)
    use=weight>.05
    wear=np.where(matched,255-weight*(90-np.clip((paint_delta[i,j]-.055)/.22,0,1)*82),255)
    shade=np.where(matched,128,tone[i,j])
    samples=np.column_stack([np.rint(cx[sel][use]*RES),np.rint(cz[sel][use]*RES),mapped[sel][use],shade[use],np.rint(weight[use]*255),np.rint(wear[use])]).astype(np.int16)
    return samples,{'id':frame['id'],'way':way['id'],'heading':round(math.degrees(best[1])%360,2),'pitch':round(math.degrees(best[2]),2),'lateral':best[3],'score':round(best[0],3),'pixels':int(use.sum()),'camera':[round(x,2),round(z,2)],'paint':int(matched[use].sum()),'author':frame.get('author'),'sequence':frame.get('sequence'),'index':frame.get('index'),'date':frame.get('date'),'orientation':pose['source'],'lens':pose['focalSource']}


def generate(manifest,cache_only=False,scan_only=False,workers=4,shard=(0,1)):
    frames=json.loads(manifest.read_bytes())
    survey=Survey()
    positions=np.array([geo.to_grid(f['lat'],f['lon']) for f in frames])
    frames=[f for f,on_campus in zip(frames,intersects_xy(survey.domain,*positions.T)) if on_campus]
    frames=[f for i,f in enumerate(frames) if i%shard[1]==shard[0]]
    used=[]
    rejected=defaultdict(list)
    seen=0
    folder=CORPUS/'ground-registrations'
    folder.mkdir(exist_ok=True,parents=True)
    version=hashlib.sha256((inspect.getsource(extract)+inspect.getsource(locate_camera)+inspect.getsource(Survey.classes)+inspect.getsource(calibrate)+survey.version).encode()).hexdigest()[:12]
    def register(frame):
        if not frame.get('path'):
            return None
        path=manifest.parent/frame['path']
        if not path.exists():
            return None
        token=hashlib.sha256(json.dumps([frame.get(k) for k in ['lat','lon','heading','pitch','fov']],separators=(',',':')).encode()).hexdigest()[:8]
        cache=folder/f"{frame['id']}-{version}-{token}.npz"
        if cache_only and not cache.exists():
            return None
        if cache.exists():
            if scan_only:
                return True
            with np.load(cache) as found:
                return found['p'],json.loads(str(found['f']))
        camera=locate_camera(survey,frame)
        if isinstance(camera,str):
            result=camera
        else:
            with Image.open(path) as image:
                result=extract(survey,frame,image,labels(frame['id'],image),camera)
        pts,origin=(np.empty((0,6),dtype=np.int16),result) if isinstance(result,str) else result
        if isinstance(origin,dict) and len(pts)<=100:
            origin='insufficient-interior-confidence'
            pts=np.empty((0,6),dtype=np.int16)
        staged=cache.with_suffix(f'.{os.getpid()}.part')
        with staged.open('wb') as out:
            np.savez_compressed(out,p=pts,f=json.dumps(origin,separators=(',',':')))
        staged.replace(cache)
        return pts,origin
    with ThreadPoolExecutor(workers) as pool:
        for frame,result in zip(frames,pool.map(register,frames)):
            if result is None:
                continue
            seen+=1
            if scan_only:
                if seen%400==0:
                    print(f'{seen} frame decisions saved.',flush=True)
                continue
            pts,origin=result
            if isinstance(origin,dict):
                pts=pts[intersects_xy(survey.domain,pts[:,0]/RES,pts[:,1]/RES)]
                if len(pts)<=100:
                    rejected['outside-campus-pavement'].append(frame['id'])
                    continue
                origin['pixels']=len(pts)
                x,z,c,l,w,wear=pts.T
                survey.add(x/RES,z/RES,c,l,w/255,wear,len(used)+1)
                origin['contrast']=round(float(l[w>125].std()),2) if np.any(w>125) else 0
                used.append(origin)
            else:
                rejected[origin].append(frame['id'])
            if seen%200==0:
                print(f'{seen} frames processed; {len(used)} accepted.',flush=True)
    if scan_only:
        print(f'{seen} available images checked.')
        return
    if not used:
        raise ValueError('No photographic ground samples passed alignment checks')
    tiles=survey.export(used)
    terrain=json.loads(region.OUT.read_bytes())
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    pack={'cellMeters':8,'landcover':game_cover(survey.domain,net),'estates':estate_surfaces(survey.domain,net),'resolution':1/RES,'source':'KartaView','license':'CC BY-SA 4.0','seen':seen,'frames':used,'rejected':rejected,'tiles':tiles}
    tmp=OUT.with_suffix(f'.{os.getpid()}.part')
    tmp.write_text(json.dumps(pack,separators=(',',':')))
    tmp.replace(OUT)


def reproject():
    pack=json.loads(OUT.read_bytes())
    survey=Survey()
    cache=defaultdict(list)
    for file in (CORPUS/'ground-registrations').glob('*.npz'):
        cache[file.name.partition('-')[0]].append(file)
    frames={f['id']:f for f in json.loads((CORPUS/'frames.json').read_bytes())}
    accepted=[]
    for frame in pack['frames']:
        samples=None
        registered=None
        for file in sorted(cache[str(frame['id'])]):
            with np.load(file) as record:
                origin=json.loads(str(record['f']))
                if not isinstance(origin,dict) or any(origin[k]!=frame[k] for k in ('camera','heading','pitch','lateral')):continue
                points=record['p']
                if samples is None or (len(points),origin['score'])>(len(samples),registered['score']):
                    samples,registered=points,origin
        if samples is None:
            metadata=frames[frame['id']]
            camera=locate_camera(survey,metadata)
            if isinstance(camera,str):
                pack['rejected'].setdefault(camera,[]).append(frame['id'])
                continue
            with Image.open(CORPUS/metadata['path']) as image:
                result=extract(survey,metadata,image,labels(frame['id'],image),camera)
            if isinstance(result,str):
                pack['rejected'].setdefault(result,[]).append(frame['id'])
                continue
            samples,registered=result
        x,z,c,shade,weight,wear=samples.T
        valid=intersects_xy(survey.domain,x/RES,z/RES)&(survey.classes(x/RES,z/RES)==c)
        if valid.sum()<=100:
            pack['rejected'].setdefault('outside-campus-pavement',[]).append(frame['id'])
            continue
        x,z,c,shade,weight,wear=samples[valid].T
        survey.add(x/RES,z/RES,c,shade,weight/255,wear,len(accepted)+1)
        accepted.append(dict(registered,pixels=len(c),paint=int((wear<255).sum()),contrast=round(float(shade[weight>125].std()),2) if np.any(weight>125) else 0))
    pack['frames']=accepted
    pack['tiles']=survey.export(accepted)
    tmp=OUT.with_suffix('.pending')
    tmp.write_text(json.dumps(pack,separators=(',',':')))
    tmp.replace(OUT)


def check():
    survey=Survey()
    data=json.loads(OUT.read_bytes())
    total=[0,0]
    for key,t in data['tiles'].items():
        assert set(t)=={'reference','cells','proof','origin'}
        assert all(intersects_xy(survey.domain,(c[0]+.5)*8,(c[1]+.5)*8) for c in t['cells'])
        assert all(len(c)==5 and 0<=c[2]<=3 and 0<=c[3]<=3 and 0<=c[4]<=2 for c in t['cells'])
        proof=np.array(read_image(t['proof']))
        owners=proof[:,:,0].astype(np.uint16)+256*proof[:,:,1].astype(np.uint16)
        assert np.array_equal(owners>0,proof[:,:,2]>0)
        row,col=np.nonzero(owners)
        sx=(t['origin'][0]+col)/RES
        sz=(t['origin'][1]+row)/RES
        assert intersects_xy(survey.domain,sx,sz).all()
        owner=survey.classes(sx,sz)
        source=owners[row,col].astype(int)-1
        origins=np.asarray([f['camera'] for f in data['frames']])[source]
        yaw=np.radians([f['heading'] for f in data['frames']])[source]
        depth=(sx-origins[:,0])*np.sin(yaw)-(sz-origins[:,1])*np.cos(yaw)
        assert np.all((depth>3.98)&(depth<20.02)), 'A photographic ground texel is outside its source camera frustum'
        near={data['frames'][i]['id'] for i in np.unique(source)}
        assert t['reference']['id'] in near
        for c in [1,2]:
            active=proof[row,col,2]==c
            assert np.all(owner[active]==c),(key,c)
            total[c-1]+=active.sum()
    accepted={f['id'] for f in data['frames']}
    terrain=data['landcover']
    classes=np.frombuffer(zlib.decompress(base64.b64decode(terrain['samples'])),dtype=np.uint8)
    contours=np.frombuffer(zlib.decompress(base64.b64decode(terrain['transitions'])),np.uint8).reshape(-1,4)
    assert len(contours)==classes.size and np.isin(contours[:,:2],np.unique(classes)).all()
    assert np.count_nonzero((contours[:,3]>0)&(contours[:,3]<255))>1500
    assert classes.size==terrain['width']*terrain['height'] and set(np.unique(classes))<=set(range(12))|{255}
    assert all(v in classes for v in (1,2,3,5,6,8,11,255))
    assert len(terrain["shrubs"])>100 and all(.42<h<2.41 for _,_,h in terrain["shrubs"])
    assert all(survey.domain.distance(Point(*f['camera']))<.008 for f in data['frames'])
    assert data['cellMeters']==8
    assert total[0]>90000 and total[1]>700 and len(data['tiles'])>3 and len(accepted)==len(data['frames'])
    assert all(f['score']>=.70 and f['pixels']>100 and f['way'] for f in data['frames'])
    if 'rejected' in data:
        rejected=[i for ids in data['rejected'].values() for i in ids] if isinstance(data['rejected'],dict) else data['rejected']
        assert len(accepted|set(rejected))==data['seen'] and accepted.isdisjoint(rejected)
    assert all(t['reference']['id'] in accepted for t in data['tiles'].values())
    print(f"{data['seen']} KartaView images evaluated, {len(data['frames'])} registered, {len(data['tiles'])} tiles, {total[0]/RES**2:.1f} m² asphalt and {total[1]/RES**2:.1f} m² sidewalk.")


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--manifest',type=Path,default=CORPUS/'frames.json')
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--cached-only',action='store_true')
    parser.add_argument('--reproject',action='store_true')
    parser.add_argument('--scan-only',action='store_true')
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--shard',default='0/1')
    args=parser.parse_args()
    if args.reproject:
        reproject()
    elif not args.check:
        shard=tuple(map(int,args.shard.split('/')))
        if shard!=(0,1) and not args.scan_only:
            parser.error('A scan shard cannot publish a partial atlas')
        generate(args.manifest,args.cached_only,args.scan_only,args.workers,shard)
    if not args.scan_only:
        check()
