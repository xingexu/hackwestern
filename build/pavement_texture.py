import base64
import json
import math
import zlib

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import Polygon

import campus_region as region
from ortho_road_paint import pigment


def lane_contrast(points,normals,half,lanes):
    usable=(np.isfinite(normals).all(axis=1))
    if not usable.any():return 0
    mid=points[usable]
    normal=normals[usable]
    offsets=-half+(np.arange(lanes)+.5)*2*half/lanes
    centers=(mid[:,None,:]+offsets[None,:,None]*normal[:,None,:]).reshape(-1,2)
    normal=np.repeat(normal,lanes,axis=0)
    flank=(pigment(centers+.79*normal)+pigment(centers-.79*normal))*.5
    body=pigment(centers)
    usable=(flank[:,1]>65)&(body[:,1]>65)&(np.abs(body[:,0]-body[:,1])<13)&(np.abs(body[:,1]-flank[:,1])<25)
    if np.count_nonzero(usable)<4:return 0
    contrast=np.median(np.sum((body-flank)[usable]*[.30,.52,.18],axis=1))
    return float(np.clip((contrast+.7)/8,.0,1.0))


def pavement_detail(bounds,network,spacing=.65):
    l,t,r,b=bounds
    width,height=math.ceil((r-l)/spacing),math.ceil((b-t)/spacing)
    sx,sz=(r-l)/width,(b-t)/height
    xs=l+(np.arange(width)+.5)*sx
    zs=t+(np.arange(height)+.5)*sz
    out=np.zeros((height,width,4),np.uint8)
    out[:,:,2:]=128
    nearest=np.full((2,height,width),100,np.float32)
    front=json.loads((region.OUT.parents[1]/'build/survey_frontages.json').read_bytes())
    civic=[dict(kind='path',level=0,bridge=False,lanes=1,width=width,points=[(x,0,z) for x,z in points]) for points,width in front['walks']]
    for way in [*network['ways'],*civic]:
        if way['level'] or way['bridge']:continue
        road=way['kind']=='road'
        points=np.asarray(way['points'])[:,[0,2]]
        delta=np.diff(points,axis=0)
        lengths=np.linalg.norm(delta,axis=1)
        normals=np.column_stack([-delta[:,1],delta[:,0]])/np.maximum(.001,lengths)[:,None]
        station=np.r_[0,np.cumsum(lengths)]
        if station[-1]<1 or points[:,0].max()<l-12 or points[:,0].min()>r+12 or points[:,1].max()<t-12 or points[:,1].min()>b+12:continue
        half=max(1.,way['width']*.5)
        lanes=max(1,min(way['lanes'],int(half*2/2.45)))
        pitch=half*2/lanes
        wear=lane_contrast((points[1:]+points[:-1])*.5,normals,half,lanes) if road else 0
        if road and wear<.01:continue
        joints=station[way.get('junctions',[])] if road else []
        for i,(a,v,length) in enumerate(zip(points,delta,lengths)):
            if length<.04:continue
            reach=half+.55
            upper=points[i+1]
            u0,u1=np.searchsorted(xs,[min(a[0],upper[0])-reach,max(a[0],upper[0])+reach])
            v0,v1=np.searchsorted(zs,[min(a[1],upper[1])-reach,max(a[1],upper[1])+reach])
            if u0>=u1 or v0>=v1:continue
            x=xs[None,u0:u1]-a[0]
            z=zs[v0:v1,None]-a[1]
            along=np.clip((x*v[0]+z*v[1])/length,0,length)
            lateral=x*normals[i,0]+z*normals[i,1]
            distance=np.hypot(x-along*v[0]/length,z-along*v[1]/length)
            closest=nearest[int(road),v0:v1,u0:u1]
            use=(distance<reach)&(distance<closest)
            if not use.any():continue
            closest[use]=distance[use]
            tile=out[v0:v1,u0:u1]
            d=along+station[i]
            if road:
                field=np.abs(np.mod(lateral+half,pitch)-pitch*.5)
                marks=np.exp(-.5*((field-.79)/.28)**2)
                fade=np.clip((half-np.abs(lateral))/.5,0,1)
                for j in joints[(joints>=station[i]-10)&(joints<=station[i+1]+10)]:
                    fade*=np.clip((np.abs(d-j)-4)/5,0,1)
                tile[:,:,0][use]=np.rint(255*wear*marks*fade)[use]
            else:
                phase=2*np.pi*(d/(1.72*8))
                tile[:,:,2][use]=np.rint(127.5+127*np.cos(phase[use]))
                tile[:,:,3][use]=np.rint(127.5+127*np.sin(phase[use]))
    observed=json.loads((region.OUT.parents[1]/'build/survey_pavement.json').read_bytes())
    repairs=[(Polygon(np.reshape(p,(-1,2))),min(255,round(contrast*7))) for p,contrast in observed['repairs']]
    if repairs:
        out[:,:,1]=rasterize(repairs,out_shape=(height,width),transform=Affine.translation(l,t)*Affine.scale(sx,sz),dtype='uint8')
    return dict(width=width,height=height,samples=base64.b64encode(zlib.compress(out.tobytes(),8)).decode())
