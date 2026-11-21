import re

import cv2
import numpy as np
import shapely
from PIL import Image
from scipy import ndimage
from shapely.geometry import box

from review_land import read,region
import geo
from campus_bounds import footprint


def calibration():
    return footprint(),region.lidar('dtm'),float(ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4)


def clipped_sample(im,x,y):
    h,w=im.shape[:2]
    return cv2.remap(im.astype('float32'),x.astype('float32').reshape(-1,1).clip(0,w-1),y.astype('float32').reshape(-1,1).clip(0,h-1),cv2.INTER_LINEAR).reshape(-1,3)


def crossing_signals(views,west,north,sites,runs):
    site,relief,datum=sites
    reach=site.boundary.intersection(box(west+.9,north+.9,west+49.1,north+49.1))
    inside=[];outside=[]
    for segment in shapely.get_parts(reach):
        if segment.geom_type!='LineString' or segment.length<4:continue
        for t in np.arange(.6,segment.length-.5,.5):
            a=np.array(segment.interpolate(t-.35).coords[0])
            b=np.array(segment.interpolate(t+.35).coords[0])
            d=b-a;n=np.array([-d[1],d[0]])/max(.01,np.linalg.norm(d))
            center=np.array(segment.interpolate(t).coords[0])
            if shapely.contains_xy(site,*(center+.65*n)):
                n=-n
            inside.append(center-.65*n);outside.append(center+.65*n)
    if len(inside)<10:return
    a,b=np.asarray(inside),np.asarray(outside)
    def sample_top(view,p):
        h,w=view.shape[:2]
        return clipped_sample(view,(p[:,0]-west)*w/50-.5,(p[:,1]-north)*h/50-.5)
    photo_a,photo_b=(sample_top(views[2],p) for p in (a,b))
    uniform=np.max(np.abs(photo_a-photo_b),axis=1)<15
    if uniform.sum()<10:return
    a,b=a[uniform],b[uniform]
    color=[]
    for im in views[:2]:
        diff=np.abs(sample_top(im,a)-sample_top(im,b)).max(axis=1)
        color.append([round(float(np.median(diff)),2),round(float(np.quantile(diff,.9)),2),round(float(np.mean(diff>16)),3)])
    levels=[]
    for p in (a,b):
        levels.append(np.c_[p[:,0],region.sample(relief,*p.T)-datum,p[:,1]])
    perspective=[]
    for folder in runs:
        poses=read(folder/'metrics.json')['views']
        directions={}
        for pose in poses:
            if not pose['name'].startswith(('eye-','chase-')):continue
            eye=np.array(pose['eye']);fwd=np.array(pose['at'])-eye;fwd/=np.linalg.norm(fwd)
            side=np.cross(fwd,[0,1.,0]);side/=np.linalg.norm(side);up=np.cross(side,fwd)
            with Image.open(folder/'views'/(pose['name']+'.png')) as image:im=np.asarray(image.convert('RGB'))
            h,w=im.shape[:2];focus=h*.5/np.tan(np.deg2rad(pose['fov']*.5))
            pixel=[];visible=np.ones(len(a),bool)
            for p in levels:
                delta=p-eye;depth=delta@fwd
                xx=w*.5+focus*(delta@side)/np.maximum(.1,depth)
                yy=h*.5-focus*(delta@up)/np.maximum(.1,depth)
                visible&=(depth>2)&(depth<38)&(xx>3)&(xx<w-3)&(yy>h*.33)&(yy<h-3)
                pixel.append(clipped_sample(im,xx,yy))
            if visible.sum()>=4:
                diff=np.abs(pixel[0]-pixel[1]).max(axis=1)[visible]
                directions[pose['name']]=[int(len(diff)),round(float(np.median(diff)),1),round(float(np.quantile(diff,.85)),1)]
        perspective.append(directions)
    return dict(samples=len(a),top=color,eye=perspective)


def judge(row,signal):
    if not signal:return
    text=(row.get('note2') or row['description']).lower()
    if not re.search(r'boundary|off.campus|campus edge|clip edge|exterior|backdrop|terrain edge',text):return
    if not re.search(r'seam|tone|tonal|hard.+edge|straight.+edge|cut in|changes? colour',text):return
    if re.search(r'road|driveway|hedge|house|tree|building|Thames|river|channel|gravel|horizon|path|sidewalk|missing|width|curb|kerb|parking|textur|void|smear|slope|height|blurr|ripple|field|march',text,re.I):return
    wanted={f'{kind.lower()}-{name.upper()}' for kind,name in re.findall(r'(eye|chase)-([nesw])\b',text,re.I)}
    def visible(i):
        evidence=signal['eye'][i]
        if wanted and not wanted.issubset(evidence):return False
        inspected=[v for k,v in evidence.items() if not wanted or k in wanted]
        if not inspected:return False
        return signal['samples']>=15 and signal['top'][i][1]<10 and all(v[0]>=5 and v[1]<10 and v[2]<19 for v in inspected)
    if visible(1):
        if visible(0):return 'already-fixed','matched-driver-and-overhead-boundary'
        if signal['top'][0][1]-signal['top'][1][1]>8:return 'fixed','matched-driver-and-overhead-boundary'
