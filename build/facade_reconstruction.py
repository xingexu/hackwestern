import base64
import io
import json
import math
from collections import defaultdict

import numpy as np
from PIL import Image
from scipy import ndimage

from streetview_frames import CACHE
from streetview_materials import building_materials




def swatch(rgb):
    channels=np.clip(np.rint(np.asarray(rgb)/8)*8,24,240).astype(int)
    return int(channels[0]*65536+channels[1]*256+channels[2])


def shape(kind,u,v,w,h,color):
    return dict(kind=kind,u=round(float(u),4),v=round(float(v),4),w=round(float(w),4),h=round(float(h),4),color=swatch(color))


def same_opening(a,b):
    xa,ya,wa,ha=a[:4]
    xb,yb,wb,hb=b[:4]
    width=max(0,min(xa+wa,xb+wb)-max(xa,xb))
    height=max(0,min(ya+ha,yb+hb)-max(ya,yb))
    return width*height>.52*min(wa*ha,wb*hb)


def interpret(photo,length,height):
    rgb=np.asarray(photo)[:,:,:3].astype(float)
    valid=np.asarray(photo)[:,:,3]>155
    if valid.mean()<.25:
        return []
    ypix,xpix=valid.shape
    xmet,ymet=length/xpix,height/ypix
    light=rgb@np.array([.213,.715,.072])
    light=ndimage.gaussian_filter(light,.90)
    midwall=(light>=np.percentile(light[valid],55))&(light<=np.percentile(light[valid],87))&valid
    fabric=np.median(rgb[midwall],axis=0)
    neutral=np.array([1.02,1,.97])*np.mean(fabric)
    fabric=.76*fabric+.24*neutral
    features=[dict(shape('wall',.5,.5,1,1,fabric),coverage=round(float(valid.mean()),3))]
    padded=np.where(valid,light,np.median(light[valid]))
    radius=(max(3,round(.68/ymet)),max(3,round(.6/xmet)))
    backdrop=ndimage.percentile_filter(ndimage.zoom(padded,.5,order=1),75,size=(max(3,radius[0]),max(3,radius[1])))
    backdrop=np.asarray(Image.fromarray(backdrop.astype('float32')).resize((xpix,ypix),Image.Resampling.BILINEAR))
    apertures=[]
    for fraction in (.25,.40,.52):
        threshold=np.percentile(light[valid],fraction*100)
        mask=valid&(light<threshold)&(light<backdrop-9)
        mask=ndimage.binary_closing(mask,structure=np.ones((max(2,round(.16/ymet)),max(2,round(.13/xmet)))))
        mask=ndimage.binary_opening(mask,structure=np.ones((max(2,round(.11/ymet)),max(2,round(.09/xmet)))))
        groups,n=ndimage.label(mask)
        for j,box in enumerate(ndimage.find_objects(groups),1):
            if box is None:
                continue
            sy,sx=box
            h,w=sy.stop-sy.start,sx.stop-sx.start
            hm,wm=h*ymet,w*xmet
            if not (.48<=hm<=4.9 and .31<=wm<=6.4 and .17<=wm/hm<=6):
                continue
            local=groups[box]==j
            fill=local.mean()
            if fill<.53 or valid[box].mean()<.89:
                continue
            contrast=np.median(backdrop[box][local])-np.median(light[box][local])
            if contrast<15:
                continue
            rows,cols=np.where(local)
            left_top=np.mean(cols[rows<h*.32])
            left_bottom=np.mean(cols[rows>h*.68])
            if abs(left_top-left_bottom)>.31*w:
                continue
            bright=light[box][local]
            color=np.median(rgb[box][local][bright>=np.percentile(bright,40)],axis=0)
            apertures.append((sx.start,sy.start,w,h,fill*np.sqrt(w*h)*min(1,contrast/45),color))
    selected=[]
    for box in sorted(apertures,key=lambda b:-b[4]):
        if not any(same_opening(other,box) for other in selected):
            selected.append(box)
    for x,y,w,h,_,tone in selected:
        u=(x+w*.5)/xpix
        v=1-(y+h*.5)/ypix
        door=(ypix-y-h)*ymet<.48 and 1.65<h*ymet<3.4 and .56<w*xmet<2.4
        tint=np.array([87,108,116])*.68+tone*.32
        features.append(shape('door' if door else 'window',u,v,w/xpix,h/ypix,tint))
    valid_width=valid.sum(axis=1)
    means=(padded*valid).sum(axis=1)/np.maximum(1,valid_width)
    smooth=ndimage.median_filter(means,size=max(5,round(.85/ymet))|1)
    high=(means-smooth>15)&(valid_width>xpix*.72)
    group,n=ndimage.label(high)
    for c in ndimage.find_objects(group):
        if not c:
            continue
        sl=c[0]
        h=sl.stop-sl.start
        if .10<=h*ymet<=.62 and sl.start>1 and sl.stop<ypix-2:
            tone=np.median(rgb[sl][valid[sl]],axis=0)
            features.append(shape('band',.5,1-(sl.start+sl.stop)/2/ypix,1,h/ypix,tone))
    return features


def mesh_manifest(evidence):
    active=[]
    for tile in evidence['tiles']:
        photo=Image.open(io.BytesIO(base64.b64decode(tile['image']))).convert('RGBA')
        for p in tile['panels']:
            thumb=photo.crop(tuple(round(v*tile['size']) for v in p[8:12]))
            active.append((p,thumb))
    groups=defaultdict(list)
    for p,image in active:
        ax,az,bx,bz,low,high,nx,nz=p[:8]
        length=math.hypot(bx-ax,bz-az)
        tx,tz=(bx-ax)/length,(bz-az)/length
        key=p[13],round(nx,2),round(nz,2),round(low,2),round(high,2),round(nx*ax+nz*az,1),round(tx,2),round(tz,2)
        groups[key].append((ax*tx+az*tz,p,image))
    tiles=defaultdict(list)
    for key,row in groups.items():
        intervals=[]
        for _,p,image in sorted(row,key=lambda item:item[0]):
            if intervals and math.dist(intervals[-1][-1][0][2:4],p[:2])<.095:
                intervals[-1].append((p,image))
            else:
                intervals.append([(p,image)])
        for interval in intervals:
            p=interval[0][0]
            left=p[:2]
            right=interval[-1][0][2:4]
            length=math.dist(left,right)
            height=p[5]-p[4]
            resolution=min(19,1250/max(length,height))
            w=max(8,round(length*resolution))
            h=max(8,round(height*resolution))
            sheet=Image.new('RGBA',(w,h))
            frames=[]
            for panel,crop in interval:
                lo=round(math.dist(left,panel[:2])*w/length)
                hi=round(math.dist(left,panel[2:4])*w/length)
                if hi<=lo:
                    continue
                sheet.paste(crop.resize((hi-lo,h),Image.Resampling.BILINEAR),(lo,0))
                frames.extend([panel[12],*panel[14]])
            features=interpret(sheet,length,height)
            if not features:
                continue
            panel=[*left,*right,*p[4:8],p[13],frames[0],features,list(dict.fromkeys(frames))]
            cell=math.floor((left[0]+right[0])/384),math.floor((left[1]+right[1])/384)
            tiles[cell].append(panel)
    results=[dict(x=x*192+96,z=z*192+96,panels=p) for (x,z),p in tiles.items()]
    cov=dict(evidence['coverage'])
    cov['wallSamples']=cov.pop('walls')
    cov['walls']=sum(len(t['panels']) for t in results)
    counts=defaultdict(int)
    for tile in results:
        for panel in tile['panels']:
            for f in panel[10]:
                counts[f['kind']]+=1
    cov['architecture']=dict(counts)
    source_map={}
    materials=building_materials(evidence['tiles'],source_map)
    out=dict(coverage=cov,frames=evidence['frames'].copy(),buildings=evidence['buildings'],materials=materials,materialSources=source_map,tiles=results)
    return out
