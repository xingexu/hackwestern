import json
import math

import cv2
import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from scipy.spatial import cKDTree
from shapely.geometry import LineString,Point,Polygon,box

import campus_region as region
from ortho_road_paint import pigment,rgb_tile
from parking_stripes import lot_mask

OUT=region.OUT.parents[1]/'build/survey_lot_markings.json'


def scan():
    cv2.setNumThreads(1)
    bays=lot_mask()
    l,t,r,bottom=bays.bounds
    candidates=[]
    panels=[]
    for x in range(math.floor(l/150)*150,math.ceil(r/150)*150,150):
        for z in range(math.floor(t/150)*150,math.ceil(bottom/150)*150,150):
            inside=bays.intersection(box(x,z,x+150,z+150))
            if inside.is_empty:continue
            mask=rasterize([inside],out_shape=(1500,1500),transform=Affine.translation(x,z)*Affine.scale(.1),dtype='uint8')
            rgb=rgb_tile(x,z)
            red,green,blue=rgb.astype('float32').transpose(2,0,1)
            gray=(red+2*green+blue)*.25
            amber=(red+green)*.5-blue
            pigment=gray+2.2*(amber-cv2.GaussianBlur(amber,(0,0),2.4))
            bright=pigment-cv2.morphologyEx(pigment,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))
            ink=np.uint8((bright>3.2)&(gray>100)&(mask>0))
            pieces=cv2.HoughLinesP(ink,1,np.pi/360,26,minLineLength=29,maxLineGap=3)
            for ax,az,bx,bz in [] if pieces is None else pieces[:,0]:
                a,b=np.array([ax,az]),np.array([bx,bz])
                length=np.linalg.norm(b-a)
                if not 29<length<134:continue
                axis=(b-a)/length;norm=np.array([-axis[1],axis[0]])
                p=np.linspace(a,b,max(14,int(length*.67)))
                def sample(image,d):
                    u,v=np.rint(p+norm*d).astype(int).T
                    return image[v.clip(0,1499),u.clip(0,1499)]
                options=[]
                for shift in [-1.,0.,1.]:
                    body=sample(pigment,shift)
                    one=sample(pigment,shift-3.3);two=sample(pigment,shift+3.3)
                    gain=body-np.maximum(one,two)
                    yellow=sample(amber,shift)-(sample(amber,shift-3.3)+sample(amber,shift+3.3))*.5
                    control=(np.abs(one-two)<17)&(sample(gray,shift-3.3)>90)&(sample(gray,shift+3.3)>90)
                    quality=control.mean()
                    if quality<.65:continue
                    clean=gain[control]
                    rate=np.mean(clean>2.3)
                    score=np.median(clean)
                    if rate>.58 and score>2.8 and np.percentile(clean,90)<78:
                        options.append((score+.7*rate,shift,int(np.mean((yellow[control]>2.0)&(sample(amber,shift)[control]>14))>.44)))
                if not options:continue
                score,shift,color=max(options)
                ends=(np.array([a,b])+shift*norm+.5)*.1+[x,z]
                if not bays.covers(LineString(ends)):continue
                candidates.append([ends,score,color])
            blue_mask=np.uint8((blue-red>3)&(green-red>1)&(blue>139)&(gray>122)&(mask>0))
            blue_mask=cv2.morphologyEx(blue_mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
            cs,_=cv2.findContours(blue_mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            for c in cs:
                (u,v),(w,h),theta=cv2.minAreaRect(c)
                if not 7.0<min(w,h)<20 or max(w,h)>21 or max(w,h)/min(w,h)>1.52:continue
                area=cv2.contourArea(c)
                if not .50<area/(w*h)<1.02:continue
                p=np.array([(u+.5)*.1+x,(v+.5)*.1+z])
                yy,xx=np.mgrid[round(v)-14:round(v)+15,round(u)-14:round(u)+15]
                valid=(xx>=0)&(yy>=0)&(xx<1500)&(yy<1500)
                xx=xx[valid];yy=yy[valid]
                body=(xx-u)**2+(yy-v)**2<(.45*min(w,h))**2
                outside=((xx-u)**2+(yy-v)**2>13**2)
                local=rgb[yy,xx].astype(float)
                if (np.percentile(local[body,0],85)-np.percentile(local[body,0],12)<8 or
                    np.median(local[outside,0]-local[outside,2])<2 or np.std(local[outside,1])>21):continue
                panels.append([p,round((w+h)*.05,2),theta])
    return bays,candidates,panels


def wheelchair_heading(center,width,heading):
    arc=np.linspace(.62*math.pi,1.91*math.pi,13)
    symbols=[*zip(-.09+.26*np.cos(arc),-.13+.26*np.sin(arc)),(-.17,.40),(-.12,.23),(-.11,.13),(.02,.13),(.06,-.01),(.23,-.17)]
    solid=[(-.46,.41),(.45,.40),(.33,.22),(.46,-.15),(-.46,-.34),(.22,-.48),(-.15,-.48),(.05,.39)]
    probes=np.array([*symbols,*solid])*width/1.26
    options=[]
    for quarter in [0,90,180,270]:
        for shift in [-6,0,6]:
            angle=math.radians(heading+quarter+shift)
            d=np.array([math.cos(angle),math.sin(angle)]);n=np.array([-d[1],d[0]])
            positions=center+probes[:,:1]*d+probes[:,1:]*n
            rgb=pigment(positions)
            light=rgb[:,0]*.62+rgb[:,1]*.26+rgb[:,2]*.12
            score=np.mean(light[:len(symbols)])-np.mean(light[len(symbols):])
            options.append((score,heading+quarter+shift))
    return round(max(options)[1]%360,2)


def on_exposed_paving(flat):
    a,b=np.reshape(flat,(2,2))
    d=b-a
    length=np.linalg.norm(d)
    n=np.array([-d[1],d[0]])/length
    points=np.linspace(a,b,max(16,round(length*8)))
    face=pigment(points)
    sides=np.stack([pigment(points+n*.34),pigment(points-n*.34)])
    r,g,blue=sides.transpose(2,0,1)
    surface=(g>109)&(g<234)&(r-g<17)&(g-r<7)&(g-blue<32)&(r-blue<43)
    clear=surface.all(axis=0)&(np.max(np.abs(sides[0]-sides[1]),axis=1)<25)
    light=(face-sides.mean(axis=0))@[.29,.54,.17]
    if clear.mean()<.54 or np.mean((light>2)&clear)<.40:return False
    median=np.median(sides,axis=(0,1))
    return np.median(np.abs(sides-median))<14


def register(bays,candidates,panels):
    points=np.array([p[0] for p in candidates])
    mid=points.mean(axis=1)
    delta=points[:,1]-points[:,0]
    length=np.linalg.norm(delta,axis=1)
    axes=delta/length[:,None]
    tree=cKDTree(mid)
    groups=[]
    for i,(_,score,color) in enumerate(candidates):
        near=np.asarray(tree.query_ball_point(mid[i],13),int)
        axis=axes[i];n=np.array([-axis[1],axis[0]])
        rel=mid[near]-mid[i]
        advance=rel@n
        possible=(np.abs(axes[near]@axis)>.994)&(np.abs(rel@axis)<np.maximum(1.3,np.minimum(length[i],length[near])*.32))
        others=advance[possible&(np.abs(advance)>2.25)]
        if len(others)<2:continue
        gaps=np.arange(2.45,3.28,.05)
        order=np.rint(others[:,None]/gaps)
        ok=np.abs(others[:,None]-order*gaps)<.29
        quality=np.array([len(set(k[v])) for k,v in zip(order.T,ok.T)])
        best=quality.max()
        if best<2 or best<3 and score<6.6 or score<4.4 and best<4:continue
        groups.append((score+min(best,5)*1.5+length[i]*.5,i,color))
    existing=json.load(open(OUT.with_name('survey_parking.json')))
    existing_bays=json.load(open(OUT.with_name('survey_bays.json')))
    segments=[LineString(np.reshape(q,(-1,2))) for q in [*existing['lines'],*existing['amber'],*[v[0] for v in existing_bays['rows']]]]
    index=shapely.STRtree(segments)
    accepted=[]
    for _,i,color in sorted(groups,reverse=True):
        p=points[i];line=LineString(p)
        near=list(index.geometries[index.query(line,predicate='dwithin',distance=.24)])+segments[len(index.geometries):]
        overlaps=[s for s in near if s.distance(line)<.24]
        if overlaps:
            remaining=line.difference(shapely.union_all(overlaps).buffer(.24,quad_segs=2))
        else:remaining=line
        for piece in shapely.get_parts(remaining):
            if piece.geom_type!='LineString' or piece.length<2.1:continue
            coords=np.array([piece.coords[0],piece.coords[-1]]).round(2).ravel().tolist()
            accepted.append([coords,int(color)])
            segments.append(piece)
        if len(segments)-len(index.geometries)>100:index=shapely.STRtree(segments)
    registry=[]
    if panels:
        tree=cKDTree([p for p,_,_ in panels])
        for i,(p,width,angle) in enumerate(panels):
            siblings=[]
            for j in tree.query_ball_point(p,15):
                if j==i or abs(panels[j][1]-width)>.58:continue
                dx=panels[j][0]-p;distance=np.linalg.norm(dx)
                if 2.45<distance<6.9:siblings.append((distance,dx/distance))
            if not siblings:continue
            dist,side=min(siblings,key=lambda a:a[0])
            if any(np.linalg.norm(p-q['center'])<1 for q in registry):continue
            registry.append(dict(center=p.round(2).tolist(),width=width,heading=wheelchair_heading(p,width,math.degrees(math.atan2(side[1],side[0])))))
    from parking_lattice import lattice
    accepted.extend(lattice(bays,segments))
    dividers=[row for row in accepted if on_exposed_paving(row[0])]
    from occupied_parking import survey as occupied_bays
    from hatched_bays import survey as hatched_bays
    baseline=[*existing['lines'],*existing['amber'],*[v[0] for v in existing_bays['rows']],*[v[0] for v in dividers]]
    occupied=occupied_bays(bays,[LineString(np.reshape(flat,(-1,2))) for flat in baseline])
    from accessible_dividers import register as panel_borders
    surveyed=json.loads(OUT.with_name('survey_parking_rows.json').read_bytes())['accessible']
    centers=[p['center'] for p in registry]+[c for row in surveyed for c in row['centers']]
    known=[*baseline,*[p for p,_ in occupied]]
    dividers.extend(occupied)
    dividers.extend(panel_borders(centers,[LineString(np.reshape(flat,(-1,2))) for flat in known],bays))
    return dict(dividers=dividers,accessible=registry,hatching=hatched_bays())


if __name__=='__main__':
    data=register(*scan())
    OUT.write_text(json.dumps(data,separators=(',',':')))
    print(len(data['dividers']),'additional optical divider segments and',len(data['accessible']),'registered blue accessible-space panels.')
