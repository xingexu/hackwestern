import json
import math
from collections import defaultdict
from functools import lru_cache

import cv2
import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from scipy.spatial import cKDTree
from shapely.geometry import LineString,Point,Polygon,box

import campus_region as region
import geo
from campus_bounds import footprint
from ortho_road_paint import pigment,rgb_tile
from parking_stripes import lot_mask
from street_projection import Survey
from zebra_crossings import detect as zebra


OUT=region.OUT.parents[1]/'build/survey_pavement.json'


def rings(poly):
    return np.array(poly.exterior.coords)[:-1].round(2).ravel().tolist()


def source(name):
    return json.loads(region.OUT.with_name(name+'.json').read_bytes())


def native_lines(kind):
    from parcel_surfaces import municipal_lines
    return municipal_lines(kind,footprint())


def raster(geom,x,z):
    if geom.is_empty:return np.zeros((1500,1500),np.uint8)
    return rasterize([(geom,1)],out_shape=(1500,1500),transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')


def contours(mask):
    return cv2.findContours(np.uint8(mask),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]


def rotated(c,x,z):
    (u,v),(a,b),angle=cv2.minAreaRect(c)
    theta=math.radians(angle+(90 if b>a else 0))
    return np.array([x+.1*(u+.5),z+.1*(v+.5)]),np.array([math.cos(theta),math.sin(theta)]),.1*max(a,b),.1*min(a,b)


def scores(gray,mask,poly):
    l,t,w,h=cv2.boundingRect(poly)
    l,t=max(0,l-7),max(0,t-7)
    r,b=min(gray.shape[1],l+w+14),min(gray.shape[0],t+h+14)
    if min(r-l,b-t)<4:return None
    m=np.zeros((b-t,r-l),np.uint8)
    cv2.drawContours(m,[poly-[l,t]],-1,1,cv2.FILLED)
    band=cv2.dilate(m,np.ones((11,11),np.uint8))-cv2.dilate(m,np.ones((3,3),np.uint8))
    body=gray[t:b,l:r][m!=0]
    surround=gray[t:b,l:r][band!=0]
    if len(body)<4 or len(surround)<7:return None
    return np.median(body),np.median(surround),np.percentile(surround,80)-np.percentile(surround,20)


def thin_linework(rgb,domain,x,z):
    if not domain.any():return []
    r,g,b=rgb.astype(np.float32).transpose(2,0,1)
    lum=r*.29+g*.55+b*.16
    yellow=(r+g)*.5-b
    ink=lum+np.clip(yellow-cv2.GaussianBlur(yellow,(0,0),2.5),-8,33)*1.9
    gain=ink-cv2.morphologyEx(ink,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))
    bright=np.uint8((gain>8)&(lum>100)&(domain>0))*255
    lines=cv2.HoughLinesP(bright,1,math.pi/360,14,minLineLength=10,maxLineGap=3)
    candidates=[]
    for ax,az,bx,bz in [] if lines is None else lines[:,0]:
        a,b=np.array([ax,az]),np.array([bx,bz])
        size=np.linalg.norm(b-a)
        if not 12<size<132:continue
        d=(b-a)/size
        n=np.array([-d[1],d[0]])
        p=np.linspace(a,b,max(10,int(size*.58)))
        def at(img,offset):
            i,j=np.rint(p+offset*n).astype(int).T
            return img[j.clip(0,1499),i.clip(0,1499)]
        contrast=at(ink,0)-np.maximum(at(ink,-3),at(ink,3))
        strength=np.median(contrast)
        if strength<7 or np.mean(contrast>4)<.65 or np.quantile(contrast,.9)>88:continue
        tint=at(yellow,0)-(at(yellow,-3)+at(yellow,3))*.5
        amber=np.median(tint)>3 and np.median(at(yellow,0))>15
        candidates.append((np.array([x,z])+(a+b+1)*.05,d,size*.1,int(amber),strength))
    if not candidates:return []
    index=cKDTree([v[0] for v in candidates])
    patterns=[]
    for i,(p,d,length,gold,strength) in enumerate(candidates):
        n=np.array([-d[1],d[0]])
        family=[]
        for j in index.query_ball_point(p,7.2):
            q,axis,ln,color,_=candidates[j]
            gap=(q-p)@n
            if abs(d@axis)<.985 or color!=gold or abs((q-p)@d)>(ln+length)*.26+.25 or abs(gap)>5.5:continue
            family.append(gap)
        if len(family)<3:continue
        groups=[]
        for v in sorted(family):
            if not groups or v-groups[-1][-1]>.30:groups.append([])
            groups[-1].append(v)
        gaps=np.diff([np.median(group) for group in groups])
        close=gaps[(gaps>.38)&(gaps<1.47)]
        if len(close)<2 or np.ptp(close)>max(.30,.36*np.median(close)):continue
        patterns.append((strength,p,d,length,gold))
    selected=[]
    for strength,p,d,length,gold in sorted(patterns,key=lambda v:-v[0]):
        n=np.array([-d[1],d[0]])
        if any(abs((q-p)@n)<.23 and abs((q-p)@d)<(length+ln)*.37 and abs(d@axis)>.97 for _,q,axis,ln,_ in selected):continue
        selected.append((strength,p,d,length,gold))
    return [[*np.r_[p-d*length*.5,p+d*length*.5].round(2).tolist(),gold] for _,p,d,length,gold in selected]


def scan():
    cv2.setNumThreads(1)
    site=footprint()
    net=source('drive-network')
    road=Survey()
    streets=[LineString([(x,z) for x,y,z in w['points']]).buffer(w['width']*.5+1.6,cap_style='flat') for w in net['ways'] if w['kind']=='road' and not w['bridge']]
    road_geom=shapely.union_all(streets).intersection(site)
    lots=lot_mask()
    domain=road_geom.union(lots)
    curbs=[LineString(np.asarray(p).reshape(-1,2)) for p in source('surface-tiles')['carriageway']['curbs']]
    access=native_lines('driveway')+native_lines('parking')
    curb_index=shapely.STRtree(curbs+access)
    bare=region.lidar('dsm')-region.lidar('dtm')
    elements=json.loads((region.CACHE/'map.json').read_bytes())['elements']
    tags=[(np.array(geo.to_grid(e['lat'],e['lon'])),e.get('tags',{}),e['id']) for e in elements if e['type']=='node' and ('kerb' in e.get('tags',{}) or e.get('tags',{}).get('highway')=='crossing')]
    anchors=cKDTree([p for p,t,k in tags])
    proposed=[];tables=[];covers=[];clusters=[];hatches=[];repairs=[];arrows=[]
    l,t,r,b=site.bounds
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(b/150)*150,150):
            frame=box(x,z,x+150,z+150)
            if not site.intersects(frame):continue
            support=raster(domain.intersection(frame),x,z)
            rgb=rgb_tile(x,z)
            red,green,blue=rgb.astype(np.float32).transpose(2,0,1)
            gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
            img=gray.astype(np.float32)
            warm=red-green
            gold=(red+green)*.5-blue
            redpad=(warm>12)&(warm>cv2.GaussianBlur(warm,(0,0),8)+4)&(gold>15)&(gray>72)
            yellow=(gold>30)&(gold>cv2.GaussianBlur(gold,(0,0),11)+5)&(red>136)&(warm<26)
            for color,mask in [('red',redpad),('yellow',yellow)]:
                blob=cv2.morphologyEx(mask.astype('uint8'),cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
                for c in contours(blob):
                    p,d,length,width=rotated(c,x,z)
                    if width<.27 or length<.69 or length>10.5 or width>2.4 or length<1.35*width:continue
                    if cv2.contourArea(c)<63*length*width or not site.covers(Point(p)):continue
                    n=np.array([-d[1],d[0]])
                    def bands(positions,depth):
                        world=p+np.asarray(positions)[:,None]*length*d+depth*width*n
                        ij=np.rint((world-[x+.05,z+.05])*10).astype(int).clip(0,1499)
                        return rgb[ij[:,1],ij[:,0]].astype(float)
                    pos=np.linspace(-.38,.38,9)
                    body=np.vstack([bands(pos,v) for v in [-.23,0,.23]])
                    border=np.vstack([bands(pos,v) for v in [-.83,.83]])
                    tone=lambda values:values[:,0]-values[:,1] if color=='red' else (values[:,0]+values[:,1])*.5-values[:,2]
                    if np.median(tone(body))-np.median(tone(border))<(6 if color=='red' else 9):continue
                    if np.mean((border[:,1]>100)&(border[:,0]-border[:,1]<14)&(border[:,1]-border[:,2]<28))<.70:continue
                    if np.percentile(body[:,1],85)-np.percentile(body[:,1],15)>29:continue
                    near=anchors.query(p)[0]
                    if length>=4.15 and length>2.6*width and color=='yellow' and width>.89 and np.min(body[:,1])>142 and np.std(border[:,1])<17 and domain.covers(Point(p)):
                        base=scores(img,mask,c)
                        if base and base[0]>base[1]+8:tables.append([*p.round(2),*d.round(5),round(length+.06,2),round(width+.05,2)])
                    elif length<=3.3 and width<1.18 and (near<13 or curb_index.geometries[curb_index.nearest(Point(p))].distance(Point(p))<1.75):
                        n=np.array([-d[1],d[0]])
                        edge=pigment(np.array([p+n*.85,p-n*.85,p+n*1.3,p-n*1.3]))
                        if (edge[:,1]>95).sum()>=3 and np.median(edge[:,0]-edge[:,1])<13 and np.median(edge[:,1]-edge[:,2])<27:
                            proposed.append([*p.round(2),*d.round(5),round(length+.08,2),round(width+.09,2),color,round(float(near),1)])
            open_bright=cv2.morphologyEx(gray,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15)))
            delta=img-open_bright
            bands=cv2.morphologyEx(np.uint8((delta>12)&(gray>110)),cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
            candidates=[]
            for c in contours(bands):
                p,d,length,width=rotated(c,x,z)
                if 1.1<length<4.7 and .22<width<.92 and width<length*.46 and cv2.contourArea(c)>53*length*width:candidates.append((p,d,length))
                if 2.3<length<6.0 and .72<width<2.15 and cv2.contourArea(c)/(100*length*width)>.19 and cv2.contourArea(c)/(100*length*width)<.55:
                    poly=cv2.approxPolyDP(c,1.25,True).reshape(-1,2)
                    if not 6<=len(poly)<=18 or not road.classes(p[0:1],p[1:2])[0]==1:continue
                    n=np.array([-d[1],d[0]])
                    pts=c.reshape(-1,2)*.1+[x+.05,z+.05]-p
                    progress=pts@d;side=pts@n
                    bins=[side[(progress>=a)&(progress<=b)] for a,b in zip(np.linspace(progress.min(),progress.max(),6)[:-1],np.linspace(progress.min(),progress.max(),6)[1:])]
                    broad=[np.ptp(v) if len(v)>1 else 0 for v in bins]
                    if max(broad)<.7 or max(broad[0],broad[-1])>.75*max(broad) or min(broad[1],broad[3])>.66*max(broad):continue
                    read=scores(img,support,c)
                    if read and domain.covers(Point(p)) and read[0]-read[1]>16 and read[2]<20:arrows.append((poly*.1+[x+.05,z+.05]).round(2).ravel().tolist())
            if candidates:
                idx=cKDTree([v[0] for v in candidates])
                for i,(p,d,length) in enumerate(candidates):
                    pairs=[candidates[j][0] for j in idx.query_ball_point(p,4.8) if abs(candidates[j][1]@d)>.97 and abs((candidates[j][0]-p)@d)<.9 and abs(candidates[j][2]-length)<.67]
                    if len(pairs)>=3:clusters.append(np.mean(pairs,axis=0))
            hatches.extend(thin_linework(rgb,support,x,z))
            closed=cv2.morphologyEx(gray,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15)))
            muted=(np.abs(red-green)<13)&(gold<29)
            relief=closed-img
            for c in contours((relief>12)&(support>0)&muted):
                p,d,length,width=rotated(c,x,z)
                if not .32<=width<=.92 or not .39<=length<=1.35 or length>width*2.2:continue
                area=cv2.contourArea(c)
                if not 12<area<108 or area/((length+.1)*(width+.1)*100)<.43:continue
                read=scores(img,support,c)
                if not read or read[1]<94 or read[1]-read[0]<15 or read[2]>14:continue
                curtain=curb_index.geometries[curb_index.nearest(Point(p))].distance(Point(p))
                if length<width*1.35 and 4*math.pi*area/max(.1,cv2.arcLength(c,True)**2)>.76:kind='inlet' if area>86*length*width else 'cover'
                elif curtain<.92 and length>width*1.22:kind='inlet'
                else:continue
                if road.classes(p[:1],p[1:])[0]!=1 and not lots.covers(Point(p)):continue
                covers.append([*p.round(2),*d.round(5),round(length+.06,2),round(width+.06,2),kind,round(float(read[1]-read[0]),1)])
            broad=cv2.GaussianBlur(img,(0,0),18)-cv2.GaussianBlur(img,(0,0),2.5)
            patchmask=cv2.morphologyEx(np.uint8((broad>9)&muted&(support>0)),cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
            for c in contours(patchmask):
                p,d,length,width=rotated(c,x,z)
                if not 2.3<length<36 or not .95<width<12 or 2.9<length<6.3 and 1.25<width<2.65:continue
                A=cv2.contourArea(c)
                if A<.65*length*width*100 or A>17000:continue
                poly=cv2.approxPolyDP(c,max(1.3,length*.32),True).reshape(-1,2)
                if not 4<=len(poly)<=7 or not road.classes(p[:1],p[1:])[0]==1:continue
                if region.sample(bare,p[:1],p[1:])[0]>1.1:continue
                step=np.roll(poly,-1,axis=0)-poly
                unit=step/np.maximum(1,np.linalg.norm(step,axis=1))[:,None]
                if (np.abs(np.sum(unit*np.roll(unit,1,axis=0),axis=1))<.40).sum()<3:continue
                read=scores(img,support,c)
                if not read or not 8<read[1]-read[0]<43 or read[2]>15:continue
                repairs.append([(poly*.1+[x+.05,z+.05]).round(2).ravel().tolist(),round(float(read[1]-read[0]),1)])
    return pack(site,tags,curb_index,road,proposed,tables,covers,hatches,clusters,repairs,arrows)


def pack(site,tags,curbs,road,proposed,tables,covers,hatches,clusters,repairs,arrows):
    existing=json.loads((OUT.parent/'survey_road_paint.json').read_bytes())['crosswalks']
    crossed=[shapely.union_all([Polygon(np.reshape(r,(-1,2))) for r in group]).centroid for group in existing.values() if group]
    measured=[]
    examined=[]
    for p in clusters:
        if any(q.distance(Point(p))<7 for q in crossed) or any(np.linalg.norm(p-q)<3.3 for q in examined):continue
        examined.append(p)
        group=zebra(p)
        if len(group)<5:continue
        polygons=group
        center=shapely.union_all(polygons).centroid
        if not site.covers(center) or any(q.distance(center)<5 for q in crossed):continue
        hues=pigment(np.array([g.centroid.coords[0] for g in polygons]))
        if np.median(hues[:,0]-hues[:,2])>34:continue
        crossed.append(center);measured.append([rings(poly) for poly in polygons])
    pads=[]
    for row in sorted(proposed,key=lambda v:v[-1]):
        x,z,dx,dz,w,h,color,near=row
        p=Point(x,z)
        photo_cross=min((g.distance(p) for g in crossed),default=1000)
        if near>8 and photo_cross>13:continue
        if any(math.hypot(q[0]-x,q[1]-z)<.7 for q in pads):continue
        pads.append([*row[:-1],'orthophoto'])
    ramps=[]
    for p,t,key in tags:
        if not site.covers(Point(p)) or t.get('kerb') not in ('flush','lowered'):continue
        border=curbs.geometries[curbs.nearest(Point(p))]
        s=border.project(Point(p))
        tangent=np.array(border.interpolate(min(border.length,s+.65)).coords[0])-border.interpolate(max(0,s-.65)).coords[0]
        tangent/=max(.01,np.linalg.norm(tangent))
        native=next((q for q in pads if np.linalg.norm(p-q[:2])<=2.4),None)
        if native:p=np.asarray(native[:2]);tangent=np.asarray(native[2:4])
        elif t.get('tactile_paving')=='yes' and border.distance(Point(p))<2.5:
            pads.append([*p.round(2),*tangent.round(5),1.46,.62,'iron',str(key)])
        ramps.append([*p.round(2),*tangent.round(5),round(max(1.8,native[4]+.38) if native else 1.9,2)])
    for x,z,dx,dz,w,h,color,source in pads:
        if not any(math.hypot(x-r[0],z-r[1])<1.1 for r in ramps):ramps.append([x,z,dx,dz,round(max(1.8,w+.38),2)])
    return dict(ramps=ramps,pads=pads,tables=tables,covers=covers,hatches=hatches,crossings=measured,repairs=repairs,arrows=arrows)


if __name__=='__main__':
    from crossing_survey import complete
    panel=complete(scan())
    OUT.write_text(json.dumps(panel,separators=(',',':')))
    print({k:len(v) for k,v in panel.items()})
