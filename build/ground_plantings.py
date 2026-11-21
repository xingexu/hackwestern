import json

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely import intersects_xy

import campus_region as region


def observations(site,classes,bounds):
    manual=json.loads(region.OUT.parents[1].joinpath('build/survey_ground.json').read_bytes())
    outer=json.loads(region.OUT.read_bytes())
    core=json.loads(region.OUT.with_name('drive-trees.json').read_bytes())
    municipal=json.loads(region.OUT.with_name('municipal-detail.json').read_bytes())
    survey=json.loads(region.OUT.with_name('canopy-survey.json').read_bytes())
    furniture=json.loads(region.OUT.with_name('region-detail.json').read_bytes())
    anchors=[(p[0],p[2]) for p in [*outer['trees'],*core['trees']]]
    anchors+=[p[:2] for t in municipal['tiles'].values() for p in t.get('trees',[])]
    anchors+=[p[:2] for t in survey['tiles'].values() for p in t.get('stems',[])]
    existing=cKDTree(anchors)
    trees=[list(row) for row in manual['trees'] if existing.query(row[:2])[0]>1.4]
    stems=cKDTree([*anchors,*[p[:2] for p in trees]])
    lamp_refs=[p[:2] for t in municipal['tiles'].values() for p in t.get('lamps',[])]
    lamp_refs += [[p[2],p[4]] for t in furniture['tiles'].values() for p in t.get('p',[]) if p[0] in ('street_lamp','traffic_signals')]
    lamps=cKDTree(lamp_refs)
    seats=cKDTree([[p[2],p[4]] for t in furniture['tiles'].values() for p in t.get('p',[]) if p[0]=='bench'])
    canopy=np.maximum(0,region.lidar('dsm')-region.lidar('dtm'))
    smooth=ndimage.gaussian_filter(canopy,.48)
    z,x=np.where((smooth==ndimage.maximum_filter(smooth,5))&(smooth>1.25)&(smooth<29))
    w,h=region.TERRAIN_SIZE
    xs=region.X0+(x+.5)*(region.X1-region.X0)/w
    zs=region.Z0+(z+.5)*(region.Z1-region.Z0)/h
    left,top,right,bottom=bounds
    u=np.clip(((xs-left)*classes.shape[1]/(right-left)).astype(int),0,classes.shape[1]-1)
    v=np.clip(((zs-top)*classes.shape[0]/(bottom-top)).astype(int),0,classes.shape[0]-1)
    valid=intersects_xy(site,xs,zs)&np.isin(classes[v,u],[0,1,2,11])
    summer=Image.new('RGB',(w,h))
    for j in range(4):
        for i in range(4):
            with Image.open(region.CACHE/f'aerial-summer-{i}-{j}.jpg') as image:
                a,b,c,d=round(w*i/4),round(h*j/4),round(w*(i+1)/4),round(h*(j+1)/4)
                summer.paste(image.resize((c-a,d-b),Image.Resampling.BOX),(a,b))
    rgb=np.asarray(summer,dtype=np.int16)
    r,g,b=rgb.transpose(2,0,1)
    growing=ndimage.uniform_filter(((g>r+4)&(g>b+12)).astype('float32'),3)[z,x]>.52
    height=canopy[z,x]
    clear=stems.query(np.stack([xs,zs],axis=1))[0]
    grow=valid&growing&(clear>np.clip(height*.35+2.1,3.8,9))
    shrubs=[]
    for i in np.where(grow)[0]:
        px,pz,hgt=round(float(xs[i]),2),round(float(zs[i]),2),round(float(height[i]),2)
        if hgt<3.25:
            shrubs.append([px,pz,min(2.15,hgt*.77)])
        elif hgt<26:
            r=min(6.5,max(1.15,(hgt-1)*.28))
            trees.append([px,pz,hgt,round(r,2),[9,5,8,7][(int(x[i])+int(z[i]))%4]])
    habitat=ndimage.uniform_filter(((g>r+3)&(g>b+11)&(canopy>3.4)).astype('float32'),5)>.56
    row,col=np.where(habitat[::2,::2])
    row*=2
    col*=2
    px=region.X0+(col+.5)*(region.X1-region.X0)/w
    pz=region.Z0+(row+.5)*(region.Z1-region.Z0)/h
    cu=np.clip(((px-left)*classes.shape[1]/(right-left)).astype(int),0,classes.shape[1]-1)
    cv=np.clip(((pz-top)*classes.shape[0]/(bottom-top)).astype(int),0,classes.shape[0]-1)
    ht=canopy[row,col]
    spacing=np.clip(3.6+ht*.15,4.5,8.4)
    available=cKDTree([*anchors,*[p[:2] for p in trees]]).query(np.stack([px,pz],axis=1))[0]
    valid=(classes[cv,cu]==2)&(ht>3.6)&(ht<34)&(available>spacing)&intersects_xy(site,px,pz)
    bins={}
    for i in np.argsort(-np.where(valid,smooth[row,col]+np.minimum(10,available)*.40,-999),kind='stable'):
        if not valid[i]:break
        xx,zz=px[i],pz[i]
        a,b=int(np.floor(xx/9)),int(np.floor(zz/9))
        if any(np.hypot(x-xx,z-zz)<(spacing[i]+clearance)*.5 for v in range(b-1,b+2) for u in range(a-1,a+2) for x,z,clearance in bins.get((u,v),[])):continue
        bins.setdefault((a,b),[]).append((xx,zz,spacing[i]))
        hgt=round(float(ht[i]),2)
        radius=round(min(7.5,max(1.25,hgt*.30)),2)
        trees.append([round(float(xx),2),round(float(zz),2),hgt,radius,[5,9,6,8][(a+int(col[i]))%4]])
    sports=json.loads(region.OUT.parents[1].joinpath('build/survey_sports.json').read_bytes())
    return dict(sports=sports,trees=trees,shrubs=shrubs,lamps=[p for p in manual['lamps'] if lamps.query(p)[0]>1.7],seats=[p for p in manual['seats'] if seats.query(p[:2])[0]>1.35],hedges=manual['hedges'],fences=manual['fences'])
