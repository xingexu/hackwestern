import base64
import json
import math
import zlib

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely import contains_xy

import campus_region as region
from campus_bounds import footprint
from ground_observations import orthophoto, survey_tile


def woodlots(outer,core,tiles):
    land=json.loads(region.OUT.with_name('ground-materials.json').read_bytes())['landcover']
    cover=np.frombuffer(zlib.decompress(base64.b64decode(land['samples'])),np.uint8).reshape(land['height'],land['width'])
    left,top,right,bottom=land['bounds']
    heights=region.lidar('dsm')-region.lidar('dtm')
    xs=region.X0+(np.arange(heights.shape[1])+.5)*(region.X1-region.X0)/heights.shape[1]
    zs=region.Z0+(np.arange(heights.shape[0])+.5)*(region.Z1-region.Z0)/heights.shape[0]
    u=np.clip(((xs-left)*land['width']/(right-left)).astype(int),0,land['width']-1)
    v=np.clip(((zs-top)*land['height']/(bottom-top)).astype(int),0,land['height']-1)
    site=footprint()
    classes=cover[np.ix_(v,u)]
    campus=contains_xy(site,xs[None,:],zs[:,None])
    woods=(classes==2)&campus
    closed=ndimage.uniform_filter(((heights>4)&woods).astype(np.float32),5)>.66
    stems=[(p[0],p[2]) for p in outer['trees']+core['trees']]
    stems.extend(p[:2] for tile in tiles.values() for p in tile.get('trees',[]))
    stems.extend(p[:2] for p in land['observations']['trees'])
    survey=json.loads(region.OUT.with_name('canopy-survey.json').read_bytes())
    stems.extend(p[:2] for tile in survey['tiles'].values() for p in tile['stems'])
    row,col=np.where(woods&closed&(heights>4)&(heights<33))
    clear=cKDTree(stems).query(np.column_stack([xs[col],zs[row]]))[0]
    spacing=np.clip(heights[row,col]*.13+3.6,5.45,6.6)
    peaks=ndimage.gaussian_filter(heights,.65)[row,col]
    candidates=np.flatnonzero(clear>spacing)
    bins={}
    trees=[]
    for i in candidates[np.argsort(-(peaks[candidates]*.35+np.minimum(clear[candidates],9)),kind='stable')]:
        x,z=xs[col[i]],zs[row[i]]
        a,b=math.floor(x/9),math.floor(z/9)
        if any(math.hypot(x-xx,z-zz)<(s+spacing[i])*.5 for j in range(b-1,b+2) for k in range(a-1,a+2) for xx,zz,s in bins.get((k,j),())):continue
        bins.setdefault((a,b),[]).append((x,z,spacing[i]))
        h=float(heights[row[i],col[i]])
        trees.append([round(x,2),round(z,2),round(h,2),round(min(6.2,h*.29),2)])
    by_tile={}
    broadleaf=[p[:2] for p in land['observations']['trees'] if p[4] not in (1,2,3)]
    broadleaf.extend(p[:2] for tile in tiles.values() for p in tile.get('trees',[]) if p[5] not in (1,2,3))
    for i,(x,z) in enumerate([p[:2] for p in trees]+broadleaf):
        ix,iz=region.pix(x,z)
        if 0<=int(iz)<len(zs) and 0<=int(ix)<len(xs) and woods[int(iz),int(ix)]:
            by_tile.setdefault((math.floor(x/150)*150,math.floor(z/150)*150),[]).append((i,x,z))
    bare=[]
    for (tx,tz),points in by_tile.items():
        photo=np.asarray(survey_tile(tx,tz),dtype=np.int16)
        for i,x,z in points:
            u,v=int((x-tx)*4),int((z-tz)*4)
            r,g,b=photo[max(0,v-8):v+9,max(0,u-8):u+9].transpose(2,0,1)
            brown=np.mean((r>=g)&(r>b+9)&(g<145))
            evergreen=np.mean((g>=r+3)&(g>b+2)&(g<115))
            if i<len(trees):
                trees[i].append(3 if evergreen>.45 else 10 if brown>.64 else 5)
            elif brown>.64:
                bare.append([x,z])
    lawn=np.isin(classes,[0,1])&campus
    park=park_crowns(heights,lawn,xs,zs,stems+[p[:2] for p in trees])
    return dict(trees=trees,bare=bare,park=park)


def park_crowns(heights,lawn,xs,zs,stems):
    smooth=ndimage.gaussian_filter(heights,.7)
    row,col=np.where(lawn&(smooth==ndimage.maximum_filter(smooth,3))&(heights>3.5)&(heights<30))
    positions=np.column_stack([xs[col],zs[row]])
    separation=cKDTree(stems).query(positions)[0]
    by_tile={}
    for i in np.flatnonzero(separation>np.clip(heights[row,col]*.18+2.6,3.8,6)):
        h=float(heights[row[i],col[i]])
        radii=[]
        for angle in np.arange(12)*math.tau/12:
            radius=0
            for j in range(1,6):
                u=int(round(col[i]+j*math.cos(angle)))
                v=int(round(row[i]+j*math.sin(angle)))
                if not (0<=u<len(xs) and 0<=v<len(zs) and h*.42<heights[v,u]<h*1.15):break
                radius=j*(xs[1]-xs[0])
            radii.append(radius)
        if sum(r>8 for r in radii)>4 or sum(1.5<r<8 for r in radii)<5:continue
        x,z=positions[i]
        radius=float(np.clip(np.median(radii)+.5,1.5,min(h*.45,7)))
        by_tile.setdefault((math.floor(x/150)*150,math.floor(z/150)*150),[]).append([x,z,h,radius])
    found=[]
    for (tx,tz),points in sorted(by_tile.items()):
        photo=np.asarray(survey_tile(tx,tz),dtype=np.int16)
        for x,z,h,radius in sorted(points,key=lambda p:-p[2]):
            u,v=int((x-tx)*4),int((z-tz)*4)
            red,green,blue=photo[max(0,v-7):v+8,max(0,u-7):u+8].transpose(2,0,1)
            needles=np.mean((green>=red+3)&(green>blue+2)&(green<118))
            twigs=np.mean((red>=green)&(red>blue+9)&(green<147))
            if needles<.43 and (twigs<.58 or red.std()<8):continue
            if any(math.hypot(x-X,z-Z)<max(3.7,(radius+r)*.65) for X,Z,_,r,_ in found):continue
            found.append([round(float(x),2),round(float(z),2),round(h,2),round(radius,2),3 if needles>.43 else 10])
    return found


def core_crowns(records,height,ground,imagery,mapped):
    smooth=ndimage.gaussian_filter(height,.85)
    maximum=ndimage.maximum_filter(smooth,5)
    peaks=(smooth>=maximum)&(smooth>2.8)&(smooth<34)
    row,col=np.where(peaks)
    positions=np.column_stack([col+.5,row+.5])
    index=cKDTree(positions)
    spring=np.asarray(orthophoto((0,0,height.shape[1],height.shape[0]),(height.shape[1]*2,height.shape[0]*2)),dtype=np.int16)
    picks={}
    for i,(x,_,z,r,*_) in enumerate(records):
        d,k=index.query([x,z])
        if d>min(6.5,r+1.5):
            if i<mapped:picks[(x,z)]=None
            continue
        px,pz=positions[k] if i>=mapped else (x,z)
        picks[(px,pz)]=None
    result=[]
    for x,z in picks:
        ix,iz=int(x),int(z)
        h=float(np.max(height[max(0,iz-1):iz+2,max(0,ix-1):ix+2]))
        if h<2.8 or h>34:continue
        rays=[]
        for angle in np.arange(10)*math.tau/10:
            ray=1.0
            for d in np.arange(1.5,min(h*.55,9.5),.75):
                u,v=int(x+math.cos(angle)*d),int(z+math.sin(angle)*d)
                if not (0<=v<height.shape[0] and 0<=u<height.shape[1] and h*.38<height[v,u]<h*1.26):break
                ray=d
            rays.append(ray)
        radius=round(float(np.clip(np.median(rays),1.25,max(1.4,h*.46))),2)
        col,row=round(2*x),round(2*z)
        r,g,b=spring[max(0,row-4):row+5,max(0,col-4):col+5].transpose(2,0,1)
        if np.mean(np.minimum.reduce([r,g,b])>172)>.78:continue
        evergreen=np.mean((g>=r+3)&(g>b+2)&(g<115))>.48
        floor=int(ground[iz,ix])+1
        rgb=np.median(imagery[max(0,iz-2):iz+3,max(0,ix-2):ix+3].reshape(-1,3),axis=0)
        result.append([float(x),floor,float(z),radius,round(floor+h-radius*.72,2),*rgb.astype(int).tolist(),int(evergreen)])
    return result


def estate_crowns():
    import rasterio
    from rasterio.warp import reproject,Resampling,transform_bounds
    from rasterio.transform import from_bounds
    from rasterio.windows import from_bounds as window_bounds
    import geo
    estate=json.loads(region.OUT.with_name('ground-materials.json').read_bytes())['estates']
    l,t,r,b=estate['bounds']
    left,top,right,bottom=math.floor(l)-4,math.floor(t)-4,math.ceil(r)+4,math.ceil(b)+4
    limits=(geo.WEST+left/geo.METERS_PER_DEGREE_LON,geo.NORTH-bottom/geo.METERS_PER_DEGREE_LAT,
            geo.WEST+right/geo.METERS_PER_DEGREE_LON,geo.NORTH-top/geo.METERS_PER_DEGREE_LAT)
    h,w=bottom-top,right-left
    cache=region.CACHE/f'estate-canopy-{left}-{top}-{right}-{bottom}.npy'
    if cache.exists():
        height=np.load(cache)
    else:
        layers=[]
        for kind in ('dtm','dsm'):
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',GDAL_HTTP_TIMEOUT='30'),rasterio.open(region.LIDAR.format(kind)) as src:
                window=window_bounds(*transform_bounds('EPSG:4326',src.crs,*limits),src.transform)
                layer=np.empty((h,w),np.float32)
                reproject(src.read(1,window=window),layer,src_transform=src.window_transform(window),src_crs=src.crs,
                    dst_transform=from_bounds(*limits,w,h),dst_crs='EPSG:4326',resampling=Resampling.bilinear)
                layers.append(layer)
        height=layers[1]-layers[0]
        np.save(cache,height)
    rgb=np.asarray(orthophoto((left,top,right,bottom),(w*2,h*2)),dtype=np.int16)
    smooth=ndimage.gaussian_filter(height,.85)
    peaks=(smooth==ndimage.maximum_filter(smooth,5))&(smooth>3.1)&(smooth<32)
    texture=ndimage.maximum_filter(smooth,7)-ndimage.minimum_filter(smooth,7)
    row,col=np.where(peaks|((height>5)&(height<32)&(texture>2.5)))
    xs,zs=left+col+.5,top+row+.5
    site=footprint()
    keep=(zs>=t)&contains_xy(site,xs,zs)
    trees=[]
    for i in np.flatnonzero(keep)[np.argsort(-(smooth[row[keep],col[keep]]+40*peaks[row[keep],col[keep]]),kind='stable')]:
        x,z=float(xs[i]),float(zs[i])
        separation=3.7 if peaks[row[i],col[i]] else 6.0
        if any(math.hypot(x-a,z-b)<separation for a,b,*_ in trees):continue
        v,u=2*row[i]+1,2*col[i]+1
        red,green,blue=rgb[max(0,v-3):v+4,max(0,u-3):u+4].transpose(2,0,1)
        foliage=np.mean((green>=red+2)&(green>blue+2)&(green<137))
        twigs=np.mean((red>=green)&(red>blue+9)&(green<146))
        if foliage<.22 and (twigs<.48 or (red.std()<8 and twigs<.88)):continue
        if not peaks[row[i],col[i]] and max(foliage,twigs)<.78:continue
        hgt=float(height[row[i],col[i]])
        if hgt<3 or hgt>34:continue
        radius=float(np.clip(hgt*.29,1.3,6))
        trees.append([x,z,round(hgt,2),round(radius,2),1 if foliage>.38 else 10])
    return trees
