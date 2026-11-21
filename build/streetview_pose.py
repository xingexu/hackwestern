import math
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def focal_width(image, horizontal_fov):
    exif = image.getexif()
    camera = exif.get_ifd(34665)
    focal35 = float(camera.get(41989) or exif.get(41989) or 0)
    aspect = image.height / image.width
    if 10 <= focal35 <= 100:
        return focal35 * math.hypot(1, aspect) / math.hypot(36, 24), 'exif-35mm'
    mm = float(camera.get(37386) or exif.get(37386) or 0)
    density = float(camera.get(41486) or exif.get(41486) or 0)
    unit = {2:25.4, 3:10, 4:1, 5:.001}.get(camera.get(41488) or exif.get(41488))
    pixels = float(camera.get(40962) or exif.get(40962) or image.width)
    if mm and density and unit and pixels:
        ratio = mm * density / (unit * pixels)
        if .27 < ratio < 2.8:
            return ratio, 'exif-sensor'
    fov = float(horizontal_fov or 0)
    measured = 30 < fov < 125
    return .5 / math.tan(math.radians(fov if measured else 72) / 2), 'reported-fov' if measured else '72deg-prior'


def road_horizon(mask):
    if mask is None or mask.ndim != 2:
        return None
    road = np.asarray(Image.fromarray((mask == 0).astype('uint8')).resize((150,112), Image.Resampling.NEAREST), dtype=bool)
    road = ndimage.binary_opening(road, structure=np.ones((3,3)))
    rows = np.arange(road.shape[0]) + .5
    columns = np.arange(road.shape[1]) + .5
    regions, count = ndimage.label(road)
    if not count:
        return None
    near = regions[59:105, 13:-13]
    sizes = np.bincount(near.ravel(), minlength=count+1)
    sizes[0] = 0
    largest = sizes.argmax()
    if sizes[largest] < 200:
        return None
    road = regions == largest
    top = np.argmax(road, axis=0)[road.any(axis=0)]
    prior = float(np.quantile(top, .08) / road.shape[0] - .024)
    if not .19 < prior < .91:
        return None
    y_values = []
    left = []
    right = []
    for i in range(int(max(0, prior+.018)*len(rows)), min(108, int((prior+.36)*len(rows)))):
        occupied = columns[road[i]]
        if len(occupied) < 4:
            continue
        y_values.append(rows[i]/len(rows))
        left.append(occupied[0]/len(columns))
        right.append(occupied[-1]/len(columns))
    y = np.array(y_values)
    left = np.array(left)
    right = np.array(right)
    def fit(x):
        visible = (x>.024) & (x<.976)
        yy, xx = y[visible], x[visible]
        if len(xx) < 10 or np.ptp(yy) < .085:
            return None
        i, j = np.triu_indices(len(xx), 3)
        slopes = (xx[j]-xx[i]) / (yy[j]-yy[i])
        slope = np.median(slopes)
        intercept = np.median(xx-slope*yy)
        good = np.abs(xx-slope*yy-intercept)<.024
        if good.mean()<.72 or good.sum()<7:
            return None
        return np.polyfit(yy[good],xx[good],1)
    l, r = fit(left), fit(right)
    if l is not None and r is not None and l[0]<-.16 and r[0]>.16:
        apex = (r[1]-l[1])/(l[0]-r[0])
        vx = l[0]*apex+l[1]
        if abs(apex-prior)<.065 and .08<vx<.92:
            return prior,float(apex)
    return prior,None


def line_horizon(image, prior):
    width=176
    height=round(width*image.height/image.width)
    photo=np.asarray(image.resize((width,height),Image.Resampling.BILINEAR).convert('L'),dtype=np.float32)
    gx=ndimage.sobel(photo,axis=1)
    gy=ndimage.sobel(photo,axis=0)
    strength=np.hypot(gx,gy)
    wy,wx=np.indices(photo.shape)
    use=(strength>max(55,np.percentile(strength,77)))&(np.abs(gx)>strength*.14)&(np.abs(gy)>strength*.24)
    use&=(wy>height*.15)&(wy<height*.94)&(wx>2)&(wx<width-2)
    if use.sum()<70:
        return None
    angle=np.mod(np.arctan2(gy[use],gx[use]),np.pi)
    nangle=72
    theta=(np.arange(nangle)+.5)*np.pi/nangle
    axis=np.stack((np.cos(theta),np.sin(theta)),axis=1)
    k=np.minimum(nangle-1,(angle*nangle/np.pi).astype(int))
    y=wy[use]+.5
    x=wx[use]+.5
    radius=math.ceil(math.hypot(width,height))+2
    rho=np.rint(x*axis[k,0]+y*axis[k,1]).astype(int)+radius
    bins=np.zeros((nangle,2*radius+1))
    np.add.at(bins,(k,rho),np.minimum(strength[use],420)/150)
    density=ndimage.gaussian_filter1d(bins,.85,axis=1)
    density=ndimage.gaussian_filter1d(density,.65,axis=0)
    peaks=(density==ndimage.maximum_filter(density,(5,9)))&(density>2.6)
    a,r = np.where(peaks)
    if len(a)<2:
        return None
    order=np.argsort(density[a,r])[-65:]
    a,r=a[order],r[order]
    nx,ny=axis[a].T
    c=r-radius
    weights=density[a,r]
    i,j=np.triu_indices(len(a),1)
    cross=nx[i]*ny[j]-ny[i]*nx[j]
    valid=(np.abs(cross)>.25)&(nx[i]*ny[i]*nx[j]*ny[j]<0)
    i,j,cross=i[valid],j[valid],cross[valid]
    if not len(i):
        return None
    px=(c[i]*ny[j]-ny[i]*c[j])/cross
    py=(nx[i]*c[j]-c[i]*nx[j])/cross
    lo,hi=(max(.19,prior-.075),min(.90,prior+.055)) if prior is not None else (.27,.875)
    valid=(px>width*.1)&(px<width*.9)&(py>height*lo)&(py<height*hi)
    px,py=px[valid],py[valid]
    if not len(px):
        return None
    distances=np.abs(px[:,None]*nx+py[:,None]*ny-c)
    support=np.exp(-(distances/1.9)**2)*weights
    left=nx*ny>0
    score=np.sqrt(support[:,left].sum(axis=1)*support[:,~left].sum(axis=1))
    score*=np.exp(-((px/width-.5)/.36)**2*.32)
    if prior is not None:
        score*=np.exp(-((py/height-prior)/.048)**2*.5)
    idx=score.argmax()
    if (distances[idx]<2.7).sum()<3 or score[idx]<7:
        return None
    return float(py[idx]/height)


def calibrate(image, road_labels=None, horizontal_fov=None):
    fx, focal_source = focal_width(image, horizontal_fov)
    fy = fx*image.width/image.height
    limits = road_horizon(np.asarray(road_labels) if road_labels is not None else None)
    prior, apex = limits or (None,None)
    lines = line_horizon(image,prior)
    if apex is not None:
        horizon = .8*apex+.2*lines if lines is not None and abs(lines-apex)<.04 else apex
        source = 'road-vanishing-point'
    elif lines is not None:
        horizon = .8*lines+.2*prior if prior is not None else lines
        source = 'image-lines-and-road' if prior is not None else 'image-lines'
    elif prior is not None:
        horizon, source = prior, 'visible-road-extent'
    else:
        horizon, source = .62, 'mount-prior'
    return dict(fx=fx, fy=fy, cx=.5, cy=.5, pitch=math.atan2(.5-horizon,fy), horizon=horizon, source=source, focalSource=focal_source)


def check():
    from PIL import ImageDraw
    height,width=600,800
    image=Image.new('RGB',(width,height),'#8da7b6')
    horizon=.67
    apex=(width*.52,height*horizon)
    left=(40,height)
    right=(835,height)
    draw=ImageDraw.Draw(image)
    polygon=[apex,right,left]
    draw.polygon(polygon,fill='#4b5255')
    for x in [55,220,560,805]:
        draw.line([apex,(x,height)],fill='#e0e0d4',width=4)
    labels=Image.new('L',(width,height),1)
    ImageDraw.Draw(labels).polygon(polygon,fill=0)
    for mask in [None,np.asarray(labels.resize((240,136),Image.Resampling.NEAREST))]:
        pose=calibrate(image,mask,76)
        assert abs(pose['horizon']-horizon)<.028,pose
        assert pose['source']!='mount-prior' and pose['pitch']<0,pose
        assert abs(pose['cy']-pose['fy']*math.tan(pose['pitch'])-pose['horizon'])<1e-10
    flat=Image.new('RGB',(640,480),'#878787')
    flat.getexif()[41989]=40
    pose=calibrate(flat,np.ones((200,250),np.uint8))
    assert pose['source']=='mount-prior' and pose['focalSource']=='exif-35mm',pose
    assert abs(pose['fx']-40*1.25/math.hypot(36,24))<1e-10
    print('Camera projection verified on converging image lines, semantic road boundaries, square pixels and EXIF focal length.')


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true')
    parser.add_argument('images',type=Path,nargs='*')
    args=parser.parse_args()
    if args.check:
        check()
    for path in args.images:
        with Image.open(path) as image:
            print(path.name,calibrate(image))
