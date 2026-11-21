import base64
import json
import math
import zlib

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely import contains_xy
from shapely.geometry import Point

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
    dormant=[]
    for entry in survey['tiles'].values():
        for x,z,h,*_ in entry['stems']:
            ix,iz=region.pix(x,z)
            if not (0<=int(iz)<len(zs) and 0<=int(ix)<len(xs) and woods[int(iz),int(ix)]):continue
            by_tile.setdefault((math.floor(x/150)*150,math.floor(z/150)*150),[])
    for tx,tz in by_tile:
        photo=np.asarray(survey_tile(tx,tz),dtype=np.int16)
        for entry in survey['tiles'].values():
            for x,z,h,*_ in entry['stems']:
                if not tx<=x<tx+150 or not tz<=z<tz+150:continue
                ix,iz=region.pix(x,z)
                if not (0<=int(iz)<len(zs) and 0<=int(ix)<len(xs) and woods[int(iz),int(ix)]):continue
                u,v=int((x-tx)*4),int((z-tz)*4)
                red,g,b=photo[max(0,v-9):v+10,max(0,u-9):u+10].transpose(2,0,1)
                brown=np.mean((red>g+2)&(red>b+11)&(g<155))
                if brown>.71 and g.std()>10:
                    dormant.append([x,z,h,round(min(8.2,max(1.8,h*.33)),2),10])
    lawn=np.isin(classes,[0,1])&campus
    park=park_crowns(heights,lawn,xs,zs,stems+[p[:2] for p in trees])
    established=stems+[p[:2] for p in trees+park]
    recruits,understory=woodland_structure(heights,classes,campus,xs,zs,established)
    return dict(trees=trees,bare=bare,park=park,recruits=recruits,understory=understory,dormantSurvey=dormant)


def woodland_structure(heights,classes,campus,xs,zs,established):
    smooth=ndimage.gaussian_filter(heights,.64)
    vegetation=campus&np.isin(classes,[0,1,2,11])
    in_woods=classes==2
    texture=ndimage.maximum_filter(smooth,5)-ndimage.minimum_filter(smooth,5)
    peaks=(smooth==ndimage.maximum_filter(smooth,3))&(heights>=3)&(heights<33)&(texture>1.45)
    row,col=np.where(vegetation&peaks)
    xy=np.column_stack((xs[col],zs[row]))
    clear=cKDTree(established).query(xy)[0]
    candidates={}
    for i in np.flatnonzero(clear>np.where(in_woods[row,col],2.9,3.5)):
        x,z=xy[i]
        candidates.setdefault((math.floor(x/150)*150,math.floor(z/150)*150),[]).append(i)
    recruits=[]
    planted={}
    for (tx,tz),ids in sorted(candidates.items()):
        photo=np.asarray(survey_tile(tx,tz),dtype=np.int16)
        for i in sorted(ids,key=lambda j:-smooth[row[j],col[j]]):
            x,z=xy[i];r,c=row[i],col[i]
            u,v=int((x-tx)*4),int((z-tz)*4)
            red,green,blue=photo[max(0,v-6):v+7,max(0,u-6):u+7].transpose(2,0,1)
            needles=np.mean((green>red+2)&(green>blue+3)&(green<144))
            bare=np.mean((red>=green)&(red>blue+8)&(green<164))
            if needles<.40 and (bare<.54 or red.std()<9):continue
            rays=[]
            for angle in np.arange(12)*math.pi/6:
                radius=0.
                for j in range(1,5):
                    a=c+round(j*math.cos(angle));b=r+round(j*math.sin(angle))
                    if not (0<=a<len(xs) and 0<=b<len(zs) and heights[b,a]>heights[r,c]*.44):break
                    radius=j*(xs[1]-xs[0])
                rays.append(radius)
            if not in_woods[r,c] and (sum(rad>=7.5 for rad in rays)>6 or sum(rad>=1.6 for rad in rays)<4):continue
            h=float(heights[r,c]);width=float(np.clip(np.quantile(rays,.45),1.12,min(6.6,h*.44)))
            key=(math.floor(x/6),math.floor(z/6));spacing=3.35 if in_woods[r,c] else 4.
            if any(math.hypot(x-a,z-b)<spacing for k in range(key[0]-1,key[0]+2) for j in range(key[1]-1,key[1]+2) for a,b in planted.get((k,j),())):continue
            form=(1 if h/width>2.9 else 2) if needles>.40 else 10 if bare>.70 else 8
            recruits.append([round(x,2),round(z,2),round(h,2),round(width,2),form])
            planted.setdefault(key,[]).append((x,z))
    canopy=ndimage.uniform_filter((heights>3.5).astype(np.float32),5)
    wooded=campus&in_woods&(canopy>.48)&(heights>2.)&(heights<34.)
    spacing=(zs[1]-zs[0],xs[1]-xs[0])
    river=ndimage.distance_transform_edt(classes!=6,sampling=spacing)
    wooded_margin=ndimage.distance_transform_edt(in_woods,sampling=spacing)
    understory=[]
    for r in range(2,len(zs)-3,3):
        for c in range(2,len(xs)-3,3):
            seed=(r*73856093^c*19349663)&65535
            j=r+seed%3-1;k=c+(seed//3)%3-1
            if not wooded[j,k] or seed%7>(4 if river[j,k]<55 else 2):continue
            h=.50+.89*((seed%59)/58)+(.35 if river[j,k]<55 else 0.)
            form=2 if river[j,k]<55 and seed%3 else 1 if seed%5 else 0
            deadfall=wooded_margin[j,k]>14 or (river[j,k]<40 and wooded_margin[j,k]>3.5)
            understory.append([round(xs[k],2),round(zs[j],2),round(h,2),form,bool(deadfall)])
    return recruits,understory


def landscape_plots(plots,shrub_plots,height,blocked,known,cleared):
    canopy=[];shrubs=[]
    indexed=cKDTree([p[:2] for p in known])
    holes=cKDTree([p[:2] for p in cleared])
    for left,top,right,bottom,form in [*plots,*[[*rect,'shrub'] for rect in shrub_plots]]:
        if top>region.Z1:continue
        frame=(math.floor(left)-3,math.floor(top)-3,math.ceil(right)+3,math.ceil(bottom)+3)
        w=frame[2]-frame[0];h=frame[3]-frame[1]
        x,z=np.meshgrid(frame[0]+np.arange(w)+.5,frame[1]+np.arange(h)+.5)
        ortho=np.asarray(orthophoto(frame,(w*2,h*2)),dtype=np.int16)
        red,green,blue=ortho.transpose(2,0,1)
        needles=((green>red+2)&(green>blue+3)&(green<146)).astype(float)
        brown=((red>=green)&(red>blue+9)&(green<156)).astype(float)
        foliage=ndimage.uniform_filter(needles,7)[1::2,1::2]
        twigs=ndimage.uniform_filter(brown,7)[1::2,1::2]
        texture=(ndimage.maximum_filter(red,7)-ndimage.minimum_filter(red,7))[1::2,1::2]
        elevation=region.sample(height,x,z)
        inside=(x>=left)&(x<=right)&(z>=top)&(z<=bottom)
        if form=='shrub':
            mask=inside&((foliage>.45)|((twigs>.63)&(texture>31)))&(texture>18)
            for j,i in np.argwhere(mask)[::3]:
                px,pz=x[j,i],z[j,i]
                if blocked(Point(px,pz)) or any(math.hypot(px-X,pz-Z)<2.15 for X,Z,*_ in shrubs):continue
                shrubs.append([float(px),float(pz),round(float(np.clip(elevation[j,i],.64,1.72)),2),1])
            continue
        relief=ndimage.maximum_filter(elevation,7)-ndimage.minimum_filter(elevation,7)
        local=ndimage.gaussian_filter(elevation,.65)
        peaks=(local==ndimage.maximum_filter(local,5))&(elevation>3.4)&(elevation<34)&(relief>1.35)&inside
        for j,i in np.argwhere(peaks):
            px,pz=x[j,i],z[j,i]
            if foliage[j,i]<.32 and (twigs[j,i]<.52 or texture[j,i]<25):continue
            if blocked(Point(px,pz)) or holes.query([px,pz])[0]<3 or indexed.query([px,pz])[0]<2.4:continue
            if any(math.hypot(px-X,pz-Z)<3 for X,Z,*_ in canopy):continue
            high=float(elevation[j,i])
            rays=[]
            for angle in np.arange(12)*math.tau/12:
                ds=np.arange(1.,min(11.,high*.62+1),.60)
                sample=region.sample(height,px+np.cos(angle)*ds,pz+np.sin(angle)*ds)
                stops=np.flatnonzero((sample<high*.39)|(sample>high*1.47))
                rays.append(ds[stops[0]] if len(stops) else ds[-1])
            wide=float(np.clip(np.median(rays),1.1,high*.51))
            habit=(1 if high/wide>2.7 else 2) if form=='c' or foliage[j,i]>.57 else 10 if form=='b' or twigs[j,i]>.72 else 5
            canopy.append([float(px),float(pz),round(high,2),round(wide,2),habit])
    return canopy,shrubs


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


def estate_surface():
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
    return height,left,top,t


def estate_crowns():
    height,left,top,t=estate_surface()
    h,w=height.shape
    right,bottom=left+w,top+h
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
