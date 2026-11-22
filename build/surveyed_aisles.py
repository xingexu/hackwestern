import json
from pathlib import Path

import numpy as np
from scipy.signal import find_peaks
from shapely.geometry import LineString,Point

from parking_archive import dated_pigment
from parking_stripes import lot_mask

ROOT=Path(__file__).resolve().parent
STEP=.10


def pigments(rgb,axis):
    lum=.30*rgb[:,:,0]+.55*rgb[:,:,1]+.15*rgb[:,:,2]
    gold=.50*(rgb[:,:,0]+rgb[:,:,1])-rgb[:,:,2]
    def shoulders(layer):
        return np.maximum(np.roll(layer,3,axis),np.roll(layer,-3,axis))
    gain=lum-shoulders(lum)
    hue=gold-shoulders(gold)
    return np.clip(gain+1.55*np.maximum(0,hue),-8,28),hue


def divider_peaks(signal,depths):
    success=None
    for incline in np.arange(-.18,.181,.015):
        shear=np.rint(incline*depths/STEP).astype(int)
        trace=np.stack([np.roll(row,-dx) for row,dx in zip(signal,shear)]).mean(axis=0)
        peaks=find_peaks(trace,distance=22,prominence=1.8,height=1.5)[0]
        if len(peaks)<3:continue
        gaps=np.diff(peaks)*STEP
        regular=((gaps>2.35)&(gaps<3.40))|((gaps>4.8)&(gaps<6.3))
        strengths=np.minimum(trace[peaks],18)
        quality=strengths.sum()+3.5*regular.sum()
        if success is None or quality>success[0]:success=quality,trace,peaks,incline
    return success


def image_row(year,row):
    a,b=np.asarray(row['axis'])
    axis=(b-a)/np.linalg.norm(b-a)
    normal=np.array([-axis[1],axis[0]])
    widths=np.asarray(row['widths'])
    s=np.arange(-1.8,np.linalg.norm(b-a)+1.81,STEP)
    v=np.arange(-widths[0]-2.7,widths[1]+2.71,STEP)
    pts=a+s[None,:,None]*axis+v[:,None,None]*normal
    rgb=dated_pigment(pts.reshape(-1,2),year).reshape(*pts.shape[:2],3)
    cross,hue=pigments(rgb,1)
    long,_=pigments(rgb,0)
    offset=np.zeros(len(s))
    if row['spine']:
        offsets=np.arange(-2.2,2.21,.10)
        best=None
        interior=(s>=.6)&(s<np.linalg.norm(b-a)-.6)
        base=np.arange(len(s))
        for left in offsets:
            for right in offsets:
                dx=left+(right-left)*(s-s[0])/(s[-1]-s[0])
                ids=np.rint((dx-v[0])/STEP).astype(int)
                score=np.mean(np.clip(long[ids[interior],base[interior]],-4,18))
                if best is None or score>best[0]:best=score,dx
        if best[0]>2:offset=best[1]
    marks=[]
    def coord(along,across):return a+along*axis+across*normal
    if row['spine'] and np.ptp(offset)+abs(offset[0])>0:
        j0=np.searchsorted(s,0);j1=np.searchsorted(s,np.linalg.norm(b-a))-1
        indices=np.rint((offset-v[0])/STEP).astype(int)
        stripe=rgb[indices,np.arange(len(s))]
        amber=int(np.median(stripe@np.array([.5,.5,-1.]))>13)
        marks.append((coord(s[j0],offset[j0]),coord(s[j1],offset[j1]),amber,best[0],0))
    for side,width in zip((-1,1),widths):
        if width<1:continue
        depths=side*np.arange(.35,width-.25,.15)
        indices=np.rint((depths[:,None]+offset-v[0])/STEP).astype(int)
        evidence=cross[indices,np.arange(len(s))]
        fitted=divider_peaks(evidence,depths)
        if not fitted:continue
        _,trace,peaks,tilt=fitted
        fractions=np.round(np.array([trace[j] for j in peaks]),2)
        for j,strength in zip(peaks,fractions):
            if not -1.2<=s[j]<=np.linalg.norm(b-a)+1.2:continue
            distances=abs(peaks-j)*STEP
            peers=np.count_nonzero(((distances>=2.25)&(distances<=3.45))|((distances>=4.85)&(distances<=6.35)))
            if strength<2.0 or not peers and strength<8:continue
            ix=np.clip(j+np.rint(tilt*depths/STEP).astype(int),0,len(s)-1)
            yi=np.rint((depths+offset[j]-v[0])/STEP).astype(int)
            gold=hue[yi,ix]
            present=cross[yi,ix]>3.5
            if present.mean()<.27:continue
            color=int(np.mean((gold[present]>1.5)&((rgb[yi,ix][present]@[.5,.5,-1.])>12))>.42)
            base=coord(s[j],offset[j])
            end=base+side*width*(normal+tilt*axis)
            marks.append((base,end,color,float(strength),peers))
    return marks


def accessible_pads(group,floor):
    result=[]
    for xy in group['accessible']:
        if not floor.covers(Point(xy)):continue
        offset=np.arange(-1.15,1.16,.10)
        u,v=np.meshgrid(offset,offset)
        cloud=np.stack([u,v],axis=-1).reshape(-1,2)
        rgb=dated_pigment(cloud+xy,group['year'])
        blue=(rgb[:,2]>rgb[:,0]+10)&(rgb[:,1]>rgb[:,0]+3)&(rgb[:,2]>119)
        if np.count_nonzero(blue)<15:continue
        points=cloud[blue]
        middle=(np.quantile(points,.15,axis=0)+np.quantile(points,.85,axis=0))*.5+xy
        a,b=np.asarray(group['rows'][0]['axis'])
        heading=round(float(np.degrees(np.arctan2(b[1]-a[1],b[0]-a[0]))),1)
        result.append(dict(centers=[middle.round(2).tolist()],heading=heading,width=1.30))
    return result


def parking_kerbs(way_id):
    from building_access import polygon
    from city_streets import survey
    import campus_region as region
    import shapely
    way=next(w for w in json.loads(region.OUT.with_name('drive-network.json').read_bytes())['ways'] if w['id']==way_id)
    line=LineString(np.asarray(way['points'])[:,[0,2]])
    municipal=shapely.union_all([polygon(rings) for rings in survey()])
    return municipal.buffer(-.24).intersection(line.buffer(15)).difference(line.buffer(way['width']*.48+.32))


def main():
    rows=json.loads((ROOT/'survey_aisle_axes.json').read_bytes())
    lots=lot_mask();out=[]
    for group in rows:
        marks=[]
        floor=parking_kerbs(group['lot']) if group.get('kerbside') else lots
        for k,r in enumerate(group['rows']):
            for a,b,c,strength,peers in image_row(group['year'],r):
                clipped=floor.intersection(LineString([a,b]))
                for line in getattr(clipped,'geoms',[clipped]):
                    if line.geom_type!='LineString' or line.length<1.8:continue
                    coords=np.asarray([line.coords[0],line.coords[-1]]).flatten().round(2).tolist()
                    marks.append([coords,c,round(float(strength),2),int(peers),k])
        print(group['lot'],len(marks),sum(m[1] for m in marks),flush=True)
        out.append(dict(lot=group['lot'],year=group['year'],lines=marks,accessible=accessible_pads(group,floor),kerbside=group.get('kerbside',False)))
    (ROOT/'survey_aisle_paint.json').write_text(json.dumps(out,separators=(',',':')))

if __name__=='__main__':main()
