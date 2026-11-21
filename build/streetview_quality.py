from functools import lru_cache

import numpy as np
from PIL import Image


@lru_cache(maxsize=1)
def blade_samples():
    axis=np.linspace(0,1,39)
    side=np.linspace(-.65,1.65,56)
    points=[]
    for y in axis:
        for end in side:
            if abs(end-y)>.14:
                points.append((0,y,1,end))
    for x in axis:
        for end in side:
            if abs(end-x)>.24:
                points.append((x,0,end,1))
    x,y,u,v=np.array(points).T
    length=np.hypot(u-x,v-y)
    along=np.linspace(.025,.975,43)
    px=x[:,None]+(u-x)[:,None]*along
    py=y[:,None]+(v-y)[:,None]*along
    nx,ny=(v-y)/length,(x-u)/length
    inside=(px>=0)&(px<=1)&(py>=0)&(py<.96)
    return px,py,nx[:,None],ny[:,None],inside


def has_wiper(image):
    gray=np.asarray(image.convert('L').resize((144,108),Image.Resampling.BILINEAR),dtype=float)
    x,y,nx,ny,inside=blade_samples()
    def sample(offset):
        cols=np.rint((x+offset*nx)*143).astype(int).clip(0,143)
        rows=np.rint((y+offset*ny)*107).astype(int).clip(0,107)
        return gray[rows,cols]
    core=sample(0)
    dark=(core<76)&inside
    for distance in (.026,.046,.067):
        left=sample(distance)-core
        right=sample(-distance)-core
        contrast=np.minimum(left,right)
        band=dark&(contrast>22)&(core<.72*(contrast+core))
        blurred=inside&(core<47)&(np.maximum(left,right)>37)&(contrast>7)
        count=inside.sum(axis=1)
        qualified=(band.sum(axis=1)>np.maximum(count*.77,20))
        qualified|=(blurred.sum(axis=1)>np.maximum(count*.71,21))&((inside&(core<54)).sum(axis=1)>.90*count)
        if qualified.any():
            return True
    return False


def usable(image):
    thumb=np.asarray(image.convert('L').resize((96,72),Image.Resampling.BILINEAR))
    if (thumb<40).mean()>.68 or (thumb>245).mean()>.66:
        return False
    return not has_wiper(image)


def vertical_roll(rgb,mask,pose):
    from scipy import ndimage
    gray=rgb.mean(axis=2)
    gy,gx=ndimage.sobel(gray,axis=0),ndimage.sobel(gray,axis=1)
    strength=np.hypot(gx,gy)
    valid=(mask==2)&(strength>85)&(np.abs(gy)<np.abs(gx)*.48)
    if valid.sum()<100:
        return 0.
    h,w=gray.shape
    row,col=np.where(valid)
    u,v=(col+.5)/w,(row+.5)/h
    pitch,fy=pose[4],pose[6]
    expected=-(u-pose[7])*np.sin(pitch)*w/h/(fy*np.cos(pitch)-np.sin(pitch)*(v-pose[8]))
    offset=np.degrees(np.arctan(expected)-np.arctan(-gy[valid]/gx[valid]))
    hist,edges=np.histogram(offset,bins=np.linspace(-10,10,42),weights=np.minimum(400,strength[valid]))
    hist=ndimage.gaussian_filter1d(hist,1.6)
    index=int(hist.argmax())
    peak=(edges[index]+edges[index+1])/2
    if abs(peak)>6.5 or hist[index]<1.35*np.mean(hist):
        return 0.
    return float(np.radians(peak))
