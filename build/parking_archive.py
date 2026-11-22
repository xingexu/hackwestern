import io
import json
import math
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile

import cv2
import numpy as np
import requests
import shapely
from PIL import Image
from scipy.spatial import cKDTree
from shapely.geometry import LineString,box

import campus_region as region
from building_inventory import local_to_mercator
from ortho_road_paint import pigment
from parking_stripes import lot_mask

OUT=region.OUT.parents[1]/'build/survey_parking_archive.json'


@lru_cache(maxsize=12)
def archive(year,x,z):
    path=region.CACHE.parent/'audit'/f'ortho-{year}'/f'{x}_{z}.jpg'
    if not path.exists():
        west,north=local_to_mercator(x,z)
        east,south=local_to_mercator(x+150,z+150)
        params=dict(bbox=f'{west},{south},{east},{north}',bboxSR=3857,imageSR=3857,size='1500,1500',adjustAspectRatio='false',format='jpg',f='image')
        data=requests.get(region.CITY+f'Aerial{year}/MapServer/export',params=params,timeout=75)
        data.raise_for_status()
        with Image.open(io.BytesIO(data.content)) as im:
            if im.size!=(1500,1500):raise ValueError('Incomplete municipal aerial tile')
        path.parent.mkdir(parents=True,exist_ok=True)
        with NamedTemporaryFile(dir=path.parent,suffix='.pending',delete=False) as stream:
            stream.write(data.content)
            pending=Path(stream.name)
        pending.replace(path)
    with Image.open(path) as im:return np.asarray(im.convert('RGB'))


def lot_tiles(lots):
    x,z,r,b=lots.bounds
    return [(i,j) for i in range(math.floor(x/150)*150,math.ceil(r/150)*150,150) for j in range(math.floor(z/150)*150,math.ceil(b/150)*150,150) if lots.intersects(box(i,j,i+150,j+150))]


def fetch(lots):
    with ThreadPoolExecutor(5) as pool:
        for _ in pool.map(lambda t:archive(*t).shape,[(year,x,z) for x,z in lot_tiles(lots) for year in (2020,2021,2024)]):pass


def registration(historic,current,mask):
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(23,23))
    search=cv2.dilate(mask,kernel,iterations=3)
    def frame(rgb):
        gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY).astype('float32')
        return gray-cv2.GaussianBlur(gray,(0,0),7)
    old,new=frame(historic),frame(current)
    corners=cv2.goodFeaturesToTrack(old,1000,.003,12,mask=search,blockSize=7)
    matches=[]
    if corners is None:return
    for u,v in np.rint(corners[:,0]).astype(int):
        if min(u,v)<28 or max(u,v)>1471:continue
        patch=old[v-12:v+13,u-12:u+13]
        area=new[v-23:v+24,u-23:u+24]
        surface=cv2.matchTemplate(area,patch,cv2.TM_CCOEFF_NORMED)
        _,value,_,(a,b)=cv2.minMaxLoc(surface)
        if value>.72:matches.append([a-11,b-11])
    if len(matches)<8:return
    offsets=np.asarray(matches)
    index=cKDTree(offsets)
    size=index.query_ball_point(offsets,1.9,return_length=True)
    best=offsets[size.argmax()]
    consistent=offsets[index.query_ball_point(best,1.9)]
    if len(consistent)<max(7,len(matches)*.24):return
    return np.median(consistent,axis=0)


def aligned_photo(year,x,z,current,mask):
    historic=archive(year,x,z)
    shift=registration(historic,current,mask)
    if shift is None:return
    transform=np.float32([[1,0,shift[0]],[0,1,shift[1]]])
    return cv2.warpAffine(historic,transform,(1500,1500),borderMode=cv2.BORDER_REPLICATE)


def frame_records(year,x,z,lots):
    from affine import Affine
    from rasterio.features import rasterize
    from ortho_road_paint import rgb_tile
    area=lots.intersection(box(x,z,x+150,z+150))
    if area.area<14:return []
    mask=rasterize([(area.buffer(3),255)],out_shape=(1500,1500),transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')
    current=rgb_tile(x,z)
    aligned=current
    if year!=2025:
        aligned=aligned_photo(year,x,z,current,mask)
        if aligned is None:return []
    rgb=aligned.astype(np.float32);r,g,b=rgb.transpose(2,0,1)
    gold=(r+g)*.5-b
    grey=.29*r+.55*g+.16*b
    raw=grey+1.65*(gold-cv2.GaussianBlur(gold,(0,0),3))
    background=cv2.GaussianBlur(raw,(0,0),4.2)
    detail=np.uint8(np.clip(125+3.8*(raw-background),0,255))
    detail[mask==0]=125
    detector=cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD,.85,.65,1.6)
    strokes=detector.detect(detail)[0]
    if strokes is None:return []
    result=[]
    def sample(image,points):return cv2.remap(image,points[:,:,0].astype('float32'),points[:,:,1].astype('float32'),cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
    for segment in strokes[:,0]:
        p,q=segment.reshape(2,2)
        length=np.linalg.norm(q-p)
        if not 24<length<142:continue
        axis=(q-p)/length;normal=np.array([-axis[1],axis[0]])
        points=np.linspace(p,q,round(length*.55))
        shifts=np.arange(-3.0,3.1,.5)
        cloud=points+shifts[:,None,None]*normal
        body=sample(rgb,cloud)
        lo=sample(rgb,cloud-3.45*normal);hi=sample(rgb,cloud+3.45*normal)
        diff=np.minimum(body-lo,body-hi)
        white=diff@[.29,.55,.16]
        col=np.array([.5,.5,-1.])
        dye=body@col-np.maximum(lo@col,hi@col)
        bright=white+np.maximum(0,dye)*1.55
        clear=(np.abs(lo-hi).max(axis=2)<23)&(lo[:,:,1]>105)&(hi[:,:,1]>105)&(body[:,:,0]-body[:,:,1]<26)
        signal=(bright>3.6)&clear
        score=np.where(clear,np.clip(bright,-12,29),-2).mean(axis=1)
        k=int(score.argmax())
        if score[k]<4 or signal[k].mean()<.55 or clear[k].mean()<.68:continue
        end=(np.array([p,q])+shifts[k]*normal+.5)*.1+[x,z]
        line=LineString(end)
        if not lots.covers(line):continue
        amber=np.mean((dye[k]>1.5)&((body[k]@col)>13)&signal[k])>signal[k].mean()*.45
        result.append([end.round(2).ravel().tolist(),int(amber),round(float(score[k]),2)])
    return result


def reduce_records(records):
    if not records:return []
    xy=np.array([r[0] for r in records]).reshape(-1,2,2)
    mid=xy.mean(axis=1);delta=xy[:,1]-xy[:,0];length=np.linalg.norm(delta,axis=1)
    axis=delta/length[:,None]
    idx=cKDTree(mid)
    found=[]
    for i in range(len(mid)):
        near=np.asarray(idx.query_ball_point(mid[i],16))
        relative=mid[near]-mid[i]
        normal=np.array([-axis[i,1],axis[i,0]])
        across=relative@normal
        broad=(np.abs(axis[near]@axis[i])>.991)&(np.abs(relative@axis[i])<2.8)
        siblings=across[broad]
        spacings=np.arange(2.45,3.33,.04)
        gap=np.abs(siblings[:,None]-np.round(siblings[:,None]/spacings)*spacings)
        fit=(gap<.23)&(np.abs(siblings[:,None])>2.18)
        if max(len(np.unique(np.round(siblings[j]/s))) for j,s in zip(fit.T,spacings))<2:continue
        found.append(records[i])
    return found


def scan_epochs():
    cv2.setNumThreads(1)
    lots=lot_mask()
    epochs={}
    for year in (2020,2021,2024,2025):
        output=region.CACHE.parent/'audit/frozen-parking'/f'registered-{year}.json'
        with ThreadPoolExecutor(3) as pool:
            parts=pool.map(lambda tile:frame_records(year,*tile,lots),lot_tiles(lots))
            epochs[year]=reduce_records([r for part in parts for r in part])
        if not output.exists():
            output.parent.mkdir(parents=True,exist_ok=True)
            with NamedTemporaryFile(dir=output.parent,suffix='.pending',delete=False) as stream:
                stream.write(json.dumps(epochs[year],separators=(',',':')).encode())
                pending=Path(stream.name)
            try:
                output.hardlink_to(pending)
            except FileExistsError:
                pass
            finally:
                pending.unlink()
    return epochs


def dated_pigment(points,year):
    if year==2025:return pigment(points)
    indices=np.floor(points/150).astype(int)*150
    rgb=np.zeros((len(points),3),'float32')
    for x,z in set(map(tuple,indices)):
        keep=(indices==[x,z]).all(axis=1)
        uv=np.floor((points[keep]-[x,z])*10).astype(int).clip(0,1499)
        rgb[keep]=archive(year,x,z)[uv[:,1],uv[:,0]]
    return rgb


def present_day(points,years=(2025,2024)):
    a,b=points
    axis=(b-a)/np.linalg.norm(b-a)
    side=np.array([-axis[1],axis[0]])
    dots=np.linspace(a,b,max(25,round(np.linalg.norm(b-a)*7)))
    cloud=dots+np.arange(-7,8)[:,None,None]*.095*side
    evidence=[]
    for year in years:
        image=dated_pigment(cloud.reshape(-1,2),year).reshape(15,-1,3)
        center=image[4:11]
        left=image[:7];right=image[8:15]
        lum=np.array([.29,.55,.16]);gold=np.array([.5,.5,-1.])
        difference=center@lum-np.maximum(left@lum,right@lum)
        yellow=center@gold-np.maximum(left@gold,right@gold)
        clean=(np.abs(left-right).max(axis=2)<24)&(left[:,:,1]>102)&(right[:,:,1]>102)
        sign=clean&(difference+1.55*np.maximum(0,yellow)>3.8)
        fractions=sign.mean(axis=1)
        j=np.argmax(fractions)
        favor=np.count_nonzero(sign[j]&(center[j]@gold>14)&(yellow[j]>1.5))
        evidence.append([float(fractions[j]),favor/max(1,sign[j].sum()),float(clean[j].mean())])
    shoulder=dots+np.array([-1.3,-.94,.94,1.3])[:,None,None]*side
    wings=pigment(shoulder.reshape(-1,2)).reshape(4,-1,3)
    low=wings@np.array([.29,.55,.16])
    cars=(low<111)|(np.ptp(wings,axis=2)>40)
    dark=cars.reshape(2,-1).mean(axis=1)
    return evidence,float(dark.max()),float(dark.min())


def registered_dividers(epochs):
    previous=json.loads(OUT.with_name('survey_parking.json').read_bytes())
    earlier=[*previous['lines'],*previous['amber'],*[p for p,k,source in json.loads(OUT.with_name('survey_bays.json').read_bytes())['rows']],*[p for p,k in json.loads(OUT.with_name('survey_lot_markings.json').read_bytes())['dividers']],*[p for p,k in json.loads(OUT.with_name('survey_parking_ink.json').read_bytes())]]
    stock=[LineString(np.reshape(p,(-1,2))) for p in earlier]
    paint=shapely.STRtree(stock)
    islands=shapely.union_all([shapely.Polygon(p['outer']) for p in json.loads(OUT.with_name('survey_islands.json').read_bytes())]).buffer(.15)
    offers=[]
    for modern,reference in [(2020,2021),(2025,2024)]:
        a,b=epochs[modern],epochs[reference]
        secondary=[LineString(np.reshape(record[0],(-1,2))) for record in b]
        idx=shapely.STRtree(secondary)
        for flat,amber,contrast in a:
            end=np.reshape(flat,(-1,2));axis=end[1]-end[0];axis/=np.linalg.norm(axis)
            normal=np.array([-axis[1],axis[0]])
            line=LineString(end)
            for i in idx.query(line,predicate='dwithin',distance=.20):
                ends=np.asarray(secondary[i].coords);other=ends[1]-ends[0];other/=np.linalg.norm(other)
                if abs(axis@other)<.995:continue
                d=(ends-end[0])@normal
                if np.abs(d).max()>.33:continue
                t=(ends-end[0])@axis
                lo=max(0.,t.min());hi=min(line.length,t.max())
                if hi-lo<2.4:continue
                ends=end[0]+np.array([lo,hi])[:,None]*axis+np.median(d)*.5*normal
                signals,occupied,flanked=present_day(ends)
                visible=max(s[0] for s in signals)
                paired=flanked>.32 and hi-lo>3.1 and min(contrast,b[i][2])>6.1
                if not paired and visible<.27 and (occupied<.27 or visible<.13 or max(s[2] for s in signals)<.31):continue
                certificate=[round(signals[0][0],2),round(signals[1][0],2),round(occupied,2)]
                gold=int(max(signals,key=lambda s:s[0])[1]>.48) if visible>.46 else int(amber+b[i][1]>0)
                offers.append((visible+min(contrast,b[i][2])/55+(hi-lo)*.055,LineString(ends),gold,certificate))
    for year in (2024,2025):
        for flat,gold,contrast in epochs[year]:
            ends=np.reshape(flat,(-1,2))
            line=LineString(ends)
            if not 2.9<line.length<7.8 or contrast<6:continue
            signals,occupied,_=present_day(ends)
            source,other=signals if year==2025 else signals[::-1]
            if source[0]<.65 or other[0]<.35 or other[2]<.45:continue
            ink=int(max(signals,key=lambda s:s[0])[1]>.46)
            certificate=[round(signals[0][0],2),round(signals[1][0],2),round(occupied,2)]
            offers.append((min(s[0] for s in signals)+contrast/80+line.length*.035,line,ink,certificate))
    single_pass=[(record,year) for year in (2020,2021) for record in epochs[year]]
    for (flat,gold,contrast),year in single_pass:
        end=np.reshape(flat,(-1,2))
        line=LineString(end)
        if line.length<3.05 or contrast<5.8:continue
        prior=2021 if year==2020 else 2020
        confidence,occupied,flanked=present_day(end,(2025,2024,prior))
        today,last,other=confidence
        valid=other[0]>.46 and (max(today[0],last[0])>.30 or occupied>.32 and max(today[0],last[0])>.18)
        if not valid and not (other[0]>.54 and flanked>.35 and contrast>7.5) and (today[0]<.47 or last[0]<.49):continue
        strongest=max([today,last],key=lambda r:r[0])
        ink=int(strongest[1]>.43) if strongest[0]>.38 else gold
        certificate=[round(today[0],2),round(last[0],2),round(occupied,2)]
        offers.append((min(today[0],last[0])+.2+min(contrast,25)/60+line.length*.025,line,ink,certificate))
    kept=[]
    for score,line,gold,certificate in sorted(offers,key=lambda item:-item[0]):
        covered=list(paint.geometries[paint.query(line,predicate='dwithin',distance=.46)])
        covered.extend([old for old in stock[len(paint.geometries):] if old.distance(line)<.46])
        surveyed=line.difference(islands)
        candidates=[]
        axis=np.asarray(line.coords[-1])-line.coords[0]
        axis/=line.length
        points=np.asarray(line.coords)
        for divider in covered:
            ends=np.asarray(divider.coords)
            direction=ends[-1]-ends[0]
            if abs(direction@axis)<.987*divider.length:continue
            offset=(ends-points[0])@np.array([-axis[1],axis[0]])
            if max(abs(offset))>.095:continue
            candidates.append(divider)
        confirmed=bool(candidates) and certificate[0]>.42 and certificate[1]>.42
        if covered:
            caps=[g.buffer(.36,cap_style='flat') if confirmed and g in candidates else g.buffer(.46,quad_segs=2) for g in covered]
            line=line.difference(shapely.union_all(caps))
        line=line.difference(islands)
        accepted=[]
        for part in shapely.get_parts(line):
            if part.geom_type!='LineString':continue
            if part.length>=2.1:
                accepted.append(part)
            elif confirmed and part.length>=.6:
                trace,_,_=present_day(np.asarray([part.coords[0],part.coords[-1]]))
                if max(r[0] for r in trace)<.72 or min(r[0] for r in trace)<.46:continue
                full=next((span for span in shapely.get_parts(surveyed) if span.geom_type=='LineString' and span.length>=2.1 and span.distance(part.centroid)<.03),None)
                if full is not None:
                    accepted=[full]
                    break
        for part in accepted:
            kept.append([np.asarray([part.coords[0],part.coords[-1]]).round(2).ravel().tolist(),gold,certificate])
            stock.append(part)
        if len(stock)-len(paint.geometries)>80:paint=shapely.STRtree(stock)
    return kept


def main():
    fetch(lot_mask())
    lines=registered_dividers(scan_epochs())
    OUT.write_text(json.dumps(dict(years=[2020,2021,2024,2025],dividers=lines),separators=(',',':')))
    print(len(lines),'new multi-year registered dividers;',sum(row[1] for row in lines),'amber.')


if __name__=='__main__':main()
