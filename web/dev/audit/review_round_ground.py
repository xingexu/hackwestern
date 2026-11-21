import argparse
import json
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from shapely.geometry import Point,Polygon,box
import shapely

from review_land import ROOT,crop_bounds,image,read
from review_historic_rows import archive_reference,row_coverage,evaluate as dated_parking
from street_finishes import coverage,sample_road
from river_banks import surveyed_channels


def view(folder,name):
    file=folder/name
    if file.exists():return file
    if 'composite' in name:return folder/'composite.jpg'
    return folder/'views'/Path(name).name


def patches(row,levels,photos,road,x,z,west,north):
    text=row['description'].lower()
    if not re.search(r'blotch|mottl|camouflage|pothole|dark .{0,16}(?:stains?|patches?|blobs?)',text):return
    if not re.search(r'road|asphalt|carriageway|lanes?|driv(?:ing|e)',text):return
    if re.search(r'parking|grass|soil|mulch|track|dashes|stall|crosswalk|missing road|with no road|under (?:a |the )?tree',text):return
    region=(np.hypot(x-row['x'],z-row['z'])<13)&(road>250)
    inset=cv2.erode(region.astype('uint8'),np.ones((9,9),'uint8')).astype(bool)
    if inset.sum()<450:return
    result=[]
    for im in [*levels,photos]:
        r,g,b=im.astype('float32').transpose(2,0,1)
        lum=(r+2*g+b)*.25
        base=cv2.GaussianBlur(lum,(0,0),12)
        dark=(base-lum)>8
        local=cv2.blur(dark.astype('float32'),(5,5))>.75
        result.append(round(float(local[inset].mean()),4))
    return dict(area=round(float(inset.sum()/100),2),dark=result)


def cutoffs(row,levels,original,west,north):
    text=row['description'].lower()
    if not re.search('ground.only|empty (?:grey|gray|light|white)|terrain (?:is missing|void|ends)|missing terrain|unfilled|missing ground|cut.off|void',text):return
    if not re.search('white|grey|gray|background|blank|void|unfilled|missing|ends|cut off',text):return
    if re.search(r'\b(?:bridge|river|water|roof|decks?|plinth|pad|car park)\b',text):return
    blank=[np.max(np.abs(im.astype('int16')-213),axis=2)<2 for im in levels]
    blank=[cv2.erode(a.astype('uint8'),np.ones((5,5),'uint8')).astype(bool) for a in blank]
    flat=blank[0]
    area=flat.sum()/100
    if area<6:return
    west,north=float(west),float(north)
    x,z=row['x'],row['z']
    u=np.arange(500)*.1+west+.05;v=np.arange(500)*.1+north+.05
    at=(u[None,:]-x)**2+(v[:,None]-z)**2<14**2
    if (at&flat).sum()<50:return
    cloudy=np.min(original,axis=2)<236
    known=flat&cloudy
    if known.sum()<400:return
    return dict(area=round(float(area),2),sourceArea=round(float(known.sum()/100),2),remaining=[round(float(b[known].mean()),4) for b in blank])


def pitch_edge(row,rows,levels,photo,west,north):
    text=row['description'].lower()
    if not re.search(r'(?:white|thin|stray|painted) (?:paint(?:ed)? )?(?:lines?|stripe)',text) or not (re.search('grass|field|lawn|meadow',text) or re.search(r'absent from the orthophoto|line from the cell',text)) or not re.search('absent|no .{0,24}(?:line|paint|mark)|stray|across|does not|unmarked',text):return
    signals=[[],[],[],[]]
    straight=[]
    for a,b in rows:
        line=b-a;length=np.linalg.norm(line)
        if length<1:continue
        normal=np.array([-line[1],line[0]])/length
        v=a+np.linspace(.02,.98,max(8,round(length*3)))[:,None]*line
        keep=(v[:,0]>west+.4)&(v[:,0]<west+49.6)&(v[:,1]>north+.4)&(v[:,1]<north+49.6)
        v=v[keep]
        if not len(v):continue
        for j,im in enumerate([*levels,photo]):
            def sample(s):
                p=np.rint((v+normal*s-[west,north])*10-.5).astype(int).clip(0,499)
                return im[p[:,1],p[:,0]].astype(float).mean(1)
            face=np.maximum.reduce([sample(k) for k in [-.09,0,.09]])
            side=(sample(-.34)+sample(.34))*.5
            ink=face>side+12
            signals[j].extend(ink.tolist())
            if j==0:
                lengths=np.flatnonzero(np.diff(np.r_[False,ink,False])).reshape(-1,2)
                straight.extend((end-start)/3 for start,end in lengths)
    if len(signals[0])<18:return
    return dict(samples=len(signals[0]),longestOriginalRun=round(max(straight,default=0),2),paintShare=[round(float(np.mean(v)),3) for v in signals])


def local_material(row,levels,photos,west,north,islands):
    text=row['description'].lower()
    x,z=row['x'],row['z']
    grid=np.arange(500)*.1+.05
    xx,zz=np.meshgrid(west+grid,north+grid)
    def vegetation(im):
        r,g,b=im.astype(float).transpose(2,0,1)
        return (g>r+10)&(g>b+16)
    if re.search(r'planted median|missing (?:the |a )?median',text):
        cell=box(west,north,west+50,north+50)
        near=[islands.geometries[i] for i in islands.query(Point(x,z),predicate='dwithin',distance=2.)]
        if near:
            poly=max(near,key=lambda g:g.area)
            core=shapely.contains_xy(poly.buffer(-.39).intersection(cell),xx,zz)
            along=poly.minimum_rotated_rectangle
            sides=np.linalg.norm(np.diff(np.asarray(along.exterior.coords),axis=0),axis=1)
            if core.sum()>2300 and sides.max()>30 and sides.max()/sides.min()>4:
                return 'median',dict(area=round(core.sum().item()/100,2),green=[round(float(vegetation(im)[core].mean()),3) for im in levels])
    if re.search(r'(?:circular|elliptical|round|blurred|brown) (?:bare |brown |soil |grass )*(?:halo|patch|ring|disk|ellipse)|bare brown halo',text) and re.search(r'(?:tree|canopy|under|decal)',text):
        circle=(xx-x)**2+(zz-z)**2<3**2
        if circle.sum()>750:
            def soil(im):
                r,g,b=im.astype(float).transpose(2,0,1)
                return (r>g-5)&(r-b>13)&(g-b>13)&(g<167)
            return 'treeHalo',dict(soil=[round(float(soil(im)[circle].mean()),3) for im in levels],green=[round(float(vegetation(im)[circle].mean()),3) for im in levels])
    if re.search(r'(?:paved|asphalt|road) (?:patch|island|blob|slab)',text) and re.search(r'on grass|sits on grass|no paving|middle of the lawn',text):
        circle=(xx-x)**2+(zz-z)**2<2.7**2
        if circle.sum()>250:return 'lawnPatch',dict(green=[round(float(vegetation(im)[circle].mean()),3) for im in levels],sourceDark=round(float((photos[:,:,1][circle]<120).mean()),3))


def judge(row,e):
    z=e.get('median')
    if z and z['green'][0]<.24 and z['green'][2]>.92:
        return ('absent-on-lane-baseline' if z['green'][1]>.92 else 'fixed-in-land5'),'surveyed-planted-median'
    z=e.get('treeHalo')
    if z and min(z['soil'][:2])>.7 and z['soil'][2]<.035 and z['green'][2]>.94:return 'fixed-in-land5','isolated-canopy-ground'
    hydro=e.get('waterAtReportedPoint')
    if hydro and hydro['insideWater'] and hydro['toSurveyBank']>1.5 and hydro['waterHit'] and hydro['blocked'] and re.search(r'meadow grass|shows dry grass|shows dry ground',row['description'],re.I):return 'contradicted-by-source','municipal-water-and-actual-surface'
    matched=dated_parking(row,e.get('datedRows'))
    if matched:return matched
    z=e.get('cutoff')
    if z and z['remaining'][2]<.015 and z['sourceArea']>.66*z['area'] and not re.search(r'trees? (?:are |is )?(?:cut|missing)|road (?:is |ends)|chase|eye-',row['description'],re.I):
        return ('absent-on-lane-baseline' if z['remaining'][1]<.015 else 'fixed-in-land5'),'ground-pass-coverage'
    d=e.get('roadPatch')
    if d:
        a,b,c,source=d['dark']
        if a>.035 and c<max(.014,source+.014) and a-c>.032 and not re.search(r'edge.*also|curb|kerb|missing|stripes?|dashes|striping',row['description'],re.I):
            return ('absent-on-lane-baseline' if b<max(.014,source+.014) else 'fixed-in-land5'),'road-blotch-area'
    s=e.get('pitchEdge')
    if s:
        a,b,c,ref=s['paintShare']
        if max(c,ref)<.10 and (a>.65 or s['longestOriginalRun']>4.5 and a*s['samples']>16):
            return ('absent-on-lane-baseline' if b<.10 else 'fixed-in-land5'),'pitch-perimeter-pigment'
    lawn=e.get('lawnPatch')
    if lawn and lawn.get('contact')=='grass' and lawn['sourceDark']>.70 and lawn['green'][1]<.25 and lawn['green'][2]>.84:return 'fixed-in-land5','cleared-unmapped-paving'
    t=e.get('atReportedPoint')
    if t is not None:
        if t['kind']=='footway-blocker' and t['ground']=='path' and not t['blocked']:
            return 'absent-on-lane-baseline','exact-driver-contact'
        if t['kind']=='bridge-surface' and t['ground']=='road' and t['blocked'] and t['body']=='deck':
            return 'absent-on-lane-baseline','exact-bridge-contact'
    return 'still-open','named-view-and-orthophoto'


def main():
    cmd=argparse.ArgumentParser()
    cmd.add_argument('--issues',required=True,type=Path);cmd.add_argument('--source',required=True,type=Path)
    cmd.add_argument('--baseline',required=True,type=Path);cmd.add_argument('--after',required=True,type=Path)
    cmd.add_argument('--contacts',type=Path);cmd.add_argument('--extra-contacts',type=Path);cmd.add_argument('--output',required=True,type=Path)
    args=cmd.parse_args()
    rows=read(args.issues);groups={}
    for i,r in enumerate(rows):groups.setdefault(r['cell'],[]).append((i,r))
    samples=read(ROOT/'web/surface-tiles.json')['carriageway'];roads=coverage(samples)
    bounds=read(ROOT/'web/campus-region.json')['bounds']
    detail=read(ROOT/'web/region-detail.json')
    edges=[row for tile in detail['tiles'].values() for row in tile.get('l',[]) if row[0]=='field_edge']
    edges=[(np.array([row[2],row[4]]),np.array([row[5],row[7]])) for row in edges]
    islands=shapely.STRtree([Polygon(r['outer']) for r in read(ROOT/'build/survey_islands.json') if r['material']==1])
    points=read(args.contacts) if args.contacts else []
    if args.extra_contacts:points.extend(read(args.extra_contacts))
    municipal_water=shapely.union_all(surveyed_channels())
    reference=archive_reference()
    cv2.setNumThreads(1)
    def review(pair):
        cell,items=pair;west,north=[int(v)*50 for v in re.fullmatch('x(-?\\d+)z(-?\\d+)',cell).groups()]
        folders=[p/'cells'/cell for p in (args.source,args.baseline,args.after)]
        grounds=[image(f/'views/ground.png',500) for f in folders]
        photo=image(folders[0]/'views/city-2025.png',500)
        road=sample_road(roads,(west,north,west+50,north+50),bounds,(500,500))
        xx,zz=np.meshgrid(west+(np.arange(500)+.5)*.1,north+(np.arange(500)+.5)*.1)
        local=[(a,b) for a,b in edges if min(a[0],b[0])<west+51 and max(a[0],b[0])>west-1 and min(a[1],b[1])<north+51 and max(a[1],b[1])>north-1]
        dated=row_coverage(reference,grounds,west,north) if any(re.search(r"stalls?|parking (?:paint|lines?|bays?|strip)",r["description"],re.I) for _,r in items) else []
        results=[]
        for i,row in items:
            frames=[view(folder,row['view']) for folder in folders]
            with Image.open(frames[0]) as im:source=im.convert('RGB').resize((160,120),Image.Resampling.BOX)
            with Image.open(frames[2]) as im:last=im.convert('RGB').resize((160,120),Image.Resampling.BOX)
            evidence=dict(sourceView=str(frames[0].relative_to(folders[0])),namedViewMeanChange=round(float(np.abs(np.asarray(source,dtype=float)-np.asarray(last,dtype=float)).mean()),2))
            for key,val in [('cutoff',cutoffs(row,grounds,photo,west,north)),('roadPatch',patches(row,grounds,photo,road,xx,zz,west,north)),('pitchEdge',pitch_edge(row,local,grounds,photo,west,north))]:
                if val is not None:evidence[key]=val
            for loc in points:
                if loc['x']==row['x'] and loc['z']==row['z'] and re.search(r'meadow grass|dry grass|water|channel',row['description'],re.I):
                    at=Point(loc['x'],loc['z'])
                    evidence['waterAtReportedPoint']=dict(insideWater=bool(municipal_water.covers(at)),toSurveyBank=round(municipal_water.boundary.distance(at),2),waterHit=any(h['kind']=='water' for h in loc['hits']),blocked=loc['blocked'])
                if abs(loc['x']-row['x'])<1 and abs(loc['z']-row['z'])<1.1 and ('blocker' in row['description'].lower() or 'physics' in row['description'].lower()):
                    ground=next((hit['kind'] for hit in loc['hits'] if hit['kind'] in ('road','path','grass','water')),None)
                    evidence['atReportedPoint']=dict(kind='bridge-surface' if loc['body'] else 'footway-blocker',ground=ground,blocked=loc['blocked'],body=loc['body']['kind'] if loc['body'] else None)
            material=local_material(row,grounds,photo,west,north,islands)
            if material:evidence[material[0]]=material[1]
            if 'lawnPatch' in evidence:
                for loc in points:
                    if abs(loc['x']-row['x'])<.25 and abs(loc['z']-row['z'])<.25:evidence['lawnPatch']['contact']=loc['surface']
            if dated and re.search(r'stall|parking',row['description'],re.I):evidence['datedRows']=dated
            status,method=judge(row,evidence)
            results.append(dict(row,id=i,status=status,evidenceType=method,evidence=evidence))
        return results
    by_priority=sorted(groups.items(),key=lambda pair:not any(r['severity']=='high' for _,r in pair[1]))
    with ThreadPoolExecutor(4) as pool:items=sorted([r for group in pool.map(review,by_priority) for r in group],key=lambda r:r['id'])
    totals={s:dict(Counter(r['severity'] for r in items if r['status']==s)) for s in sorted({r['status'] for r in items})}
    args.output.write_text(json.dumps(dict(source=args.source.name,baseline=args.baseline.name,after=args.after.name,cells=len(groups),counts=totals,issues=items),separators=(',',':')))
    print(len(items),len(groups),totals)


if __name__=='__main__':main()
