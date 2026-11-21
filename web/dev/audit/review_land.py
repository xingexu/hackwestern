import argparse
import json
import math
import re
import sys
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
import shapely
from PIL import Image
from scipy.spatial import cKDTree
from shapely.geometry import Polygon,box

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'build'))
import campus_region as region
from campus_bounds import footprint


def read(path):
    return json.loads(path.read_bytes())


def image(path,size=None):
    with Image.open(path) as raw:
        im=raw.convert('RGB')
        if size:im=im.resize((size,size),Image.Resampling.BOX)
        return np.asarray(im,dtype=np.int16)


def crop_bounds(row,cell):
    x,z=row['x'],row['z']
    west,north=(int(n)*50 for n in re.fullmatch(r'x(-?\d+)z(-?\d+)',cell).groups())
    if words(row['description'],r'whole cell|entire cell|(?:half|percent) of (?:the|this) cell'):
        return west,north,west+50,north+50
    values=[]
    number=r'(-?\d+(?:\.\d+)?)'
    for axis,pos in [('x',x),('z',z)]:
        groups=re.search(r'\b'+axis+r'\s*[=:~]?\s*'+number+r'\s*(?:to|and|\.\.|[-–—])\s*'+number,row['description'],re.I)
        if not groups:return x-8,z-8,x+8,z+8
        lo,hi=sorted(map(float,groups.groups()))
        if lo>pos+4 or hi<pos-4 or hi-lo<1 or hi-lo>60:return x-8,z-8,x+8,z+8
        values.append((lo-.3,hi+.3))
    return values[0][0],values[1][0],values[0][1],values[1][1]


def masks(ground):
    r,g,b=ground.transpose(2,0,1)
    plant=(g>r+8)&(g>b+15)|(r>b+18)&(g>b+17)&(r<160)
    sidewalk=(r>=168)&(g>=163)&(b>=145)&~plant
    return ~plant,sidewalk


def evidence(ground,photo,domain,h):
    r,g,b=photo.astype('float32').transpose(2,0,1)
    lum=(r+2*g+b)/4
    mean=cv2.blur(lum,(5,5))
    variation=np.sqrt(np.maximum(0,cv2.blur(lum*lum,(5,5))-mean*mean))
    pavement=(g>99)&(g-r<5)&(r-g<9)&(g-b<4+.115*lum)&(r-b<5+.15*lum)&(variation<10)
    vegetation=(g>50)&((g>r+7)&(g>b+15)|(r-g>7)&(g-b>3+.14*lum)&(r-b>5+.21*lum))&(variation<12)
    reliable=domain&(h<2.4)&(pavement|vegetation)
    return pavement,reliable,[masks(im)[0] for im in ground]


def line_scores(samples,line,photo=False,amber_only=False):
    head,tail=line
    direction=tail-head
    norm=np.linalg.norm(direction)
    if norm<.1:return 0
    across=np.array([-direction[1],direction[0]])/norm
    probes=head+np.linspace(.10,.90,31)[:,None]*direction
    def sample(offset):
        xy=np.rint((probes+across*offset)*samples.shape[0]/50-.5).astype(int).clip(0,samples.shape[0]-1)
        return samples[xy[:,1],xy[:,0]].astype(float)
    body=sample(0)
    sides=(sample(-.35)+sample(.35))*.5
    delta=body-sides
    light=delta@np.array([.32,.51,.17])
    amber=(delta[:,0]+delta[:,1])*.5-delta[:,2]
    valid=light+np.maximum(0,amber)>(6 if photo else 8)
    if amber_only:valid&=(amber>9)&((body[:,0]+body[:,1])*.5-body[:,2]>15)
    return float(valid.mean())


def words(text,pattern):
    return bool(re.search(pattern,text,re.I))


def inspected_contacts(row,before,after):
    text=row['description']
    if not before or len(before)!=len(after):return None
    if words(text,r'ortho|(?:in|from) reality|in addition|camera|also (?:shows|has)|misplaced|incorrectly (?:located|positioned)'):return None
    lead=text.split('.')[0]
    physical_lead=words(lead,r'^(?:physics|probes?|surface.class|collision|the physics|the car)')
    appearance=words(lead,r'islands?|blobs?|octagon|wedges?|slivers?|slabs? (?:sit|cross)|drawn as (?:lawn|grass|road)|misplaced|missing|ends? abruptly|phantom asphalt|flat water|no banks|shapes?|playground')
    if appearance and not physical_lead and not words(lead,r'no collision|has no collider|do(?:es)? not block|no solid|can drive through'):return None
    def surface(p):
        physics=p['physics']
        ground=p['ground']
        return ground==physics or ground=='field' and physics=='grass' or ground=='water' and p['blocked'] or ground=='gutter' and physics=='road' or ground=='bank' and physics in ('grass','path')
    if words(text,r'photos?|textur|blurry|jagged|stair.step|wavy|rendered as dark'):return None
    if words(text,r'surface.class|(?:physics|probes?).{0,100}(?:grass|water|road|pavement|path|drawn)|(?:grass|road|path).{0,80}physics'):
        predicate=surface
    elif words(text,r'invisible wall|invisible barrier|invisible collision|block.{0,60}(?:nothing|no visible)|phantom (?:obstacle|colli)|(?:open|clear).{0,45}blocked'):
        predicate=lambda p:bool(p['blocked'])==bool(p['body'])
    elif words(text,r'no collis|without collis|lack.{0,12}collis|no collider|can (?:drive|pass|clip|enter)|(?:drives?|passes?|passed|clips?) (?:straight |right )?(?:through|into)|non.collid'):
        predicate=lambda p:bool(p['blocked'] and p['body'])
    else:return None
    if not all(predicate(p) for p in after):return None
    if all(predicate(p) for p in before):return 'already-fixed','exact-drive-contact'
    return 'fixed','exact-drive-contact'


def road_observations(records,luma,west,north):
    result=[]
    for rec in records:
        left,top,right,bottom=rec['bounds']
        if right<west or bottom<north or left>west+50 or top>north+50:continue
        rings=rec['rings']
        polygons=[np.rint((np.asarray(r)-[west,north])*10-.5).astype('int32') for r in rings]
        points=np.concatenate(polygons)
        lo=points.min(axis=0);hi=points.max(axis=0)
        if min(hi)<0 or max(lo)>=500:continue
        lo=np.maximum(0,lo-8);hi=np.minimum(500,hi+9)
        if min(hi-lo)<3:continue
        mask=np.zeros(tuple((hi-lo)[::-1]),np.uint8)
        for poly in polygons:cv2.fillPoly(mask,[poly-lo],1)
        wide=cv2.dilate(mask,np.ones((9,9),np.uint8))>0
        inner=mask.astype(bool)
        outer=wide&(cv2.dilate(mask,np.ones((3,3),np.uint8))==0)
        if inner.sum()<13 or outer.sum()<13:continue
        contrast=[]
        for full in luma:
            patch=full[lo[1]:hi[1],lo[0]:hi[0]]
            contrast.append(round(float(np.median(patch[inner])-np.median(patch[outer])),1))
        bar_counts=[]
        if rec['kind']=='crossing' and len(polygons)>=4:
            for full in luma:
                gains=[]
                for polygon in polygons:
                    begin=np.maximum(0,polygon.min(axis=0)-7)
                    end=np.minimum(500,polygon.max(axis=0)+8)
                    if min(end-begin)<5:continue
                    mask=np.zeros(tuple((end-begin)[::-1]),np.uint8)
                    cv2.fillPoly(mask,[polygon-begin],1)
                    outside=cv2.dilate(mask,np.ones((9,9),np.uint8))-cv2.dilate(mask,np.ones((3,3),np.uint8))
                    if mask.sum()<16 or outside.sum()<10:continue
                    local=full[begin[1]:end[1],begin[0]:end[0]]
                    gains.append(np.median(local[mask>0])-np.median(local[outside>0]))
                bar_counts.append(int(np.count_nonzero(np.asarray(gains)>7)))
        result.append(dict(bars=len(polygons),barCounts=bar_counts,kind=rec['kind'],id=rec['id'],absent=rec['absent'],move=rec.get('move'),gain=contrast,
                           at=(np.array([west,north])+(lo+hi)*.05).round(2).tolist()))
    return result


def choose(row,data):
    text=row['description']
    delta=data['agreement'][1]-data['agreement'][0]
    fresh=row['source']!='round1-unrechecked'
    physics=words(text,r'physics|collision|passed-solid|probes?|blocks the car|car (?:passes|drives) (?:through|into)|invisible wall|no collider')
    geometry=words(text,r'\b(?:kerbs?|curbs?|steps?|ramps?|markings?|paint|stalls?|hatch(?:ed|ing)?|arrows?|bollards?|benches|terrace walls?|drains?|stripes?|retaining|planters?|stairs?)\b')
    potential=words(text,r'grass|lawn|gravel|asphalt|concrete|pav(?:ed|ing|ement|er)|sidewalk|footway|walkway|service (?:lane|yard)|plaza')
    eye=words(text,r'eye[- ]|chase[- ]|street[- ]level|horizon')
    direct=inspected_contacts(row,*data.get('exactContacts',[[],[]]))
    if direct:return direct
    if words(text,r'track|track.lane|lane lines|purple.*ribbon') and words(text,r'kink|facet|spike|taper|fann?|parallel|point|jagged|ribbon|abrupt|polyline|scratchy') and 180<row['x']<304 and 1165<row['z']<1394 and not words(text,r'collision|grandstand|missing.*(?:bleacher|scoreboard)|also.*(?:asphalt|concrete)'):
        if data['trackExcess'][0]-data['trackExcess'][1]>.8 or data['trackInk'][1]>10:
            return 'fixed','surveyed-athletics-lanes'
    if words(text,r'runway|throws? area|throws? pad|javelin|pole.vault') and words(text,r'missing|grass|absent|phantom|spurious|wrong') and 148<row['x']<296 and 1355<row['z']<1411:
        if data['centralAgreement'][1]>=.90 and data['centralAgreement'][1]-data['centralAgreement'][0]>.25:return 'fixed','photographed-practice-surface'
    if words(text,r'crosswalk|zebra|crossing') and not words(text,r'parking|hatch|also|turn arrow|stop bar|kerb.{0,15}height|median|gore|wheelchair'):
        for mark in data.get('roadMarks',[]):
            if not mark['barCounts'] or mark['bars']<6:continue
            before,after,photo=mark['barCounts']
            if after>=.85*mark['bars'] and after>=before+3 and photo>=.75*mark['bars']:
                return 'fixed','individual-photographed-crossing-bars'
    if words(text,r'crosswalk|zebra|crossing|stop bar|stop line|centre.line|center.line|turn arrow') and not words(text,r'parking|stall|textur|wrong (?:number|count)|end.*clip|chopped|also|missing.*and.*(?:arrow|line|bar)|hatch|too (?:narrow|short)|width|bike|median|gore'):
        kind='crossing' if words(text,r'crosswalk|zebra|crossing') else 'center' if words(text,r'cent(?:er|re).line') else 'approach'
        for mark in data.get('roadMarks',[]):
            if mark['kind']!=kind:continue
            old,new,photo=mark['gain']
            if mark['absent'] and old>14 and new<5 and photo<6 and words(text,r'nonexistent|stray|no (?:zebra|cross|mark)|where (?:none|there)|not (?:present|painted)|unmarked'):return 'fixed','removed-unphotographed-road-paint'
            if not mark['absent'] and photo>=8 and new>=14 and new-old>=10 and words(text,r'misaligned|shift|offset|skew|rotat|missing|orientation|wrong angle|placed'):return 'fixed','registered-road-paint'
    if words(text,r'(?:blank|void|empty grey|empty gray|featureless (?:gray|grey)|off[- ]map)|(?:grey|gray|white) (?:void|plane|slab)') and words(text,r'outside|boundary|edge|beyond|backdrop|off[- ]campus|out[- ]of[- ]campus|off[- ]map'):
        if data['blank'][0]>.12 and data['blank'][1]<.015 and not eye:return 'fixed','exterior-capture'
    if physics and not fresh and not data['contacts'][0] and not data['contacts'][1]:
        parity=words(text,r'probe|collision.parity|surface.class|physics.{0,95}(?:drawn|visible|render)|(?:drawn|visible|render).{0,95}physics|passed.solid')
        collateral=words(text,r'^(?!physics|probes?|surface.class|collision|the physics|the car).{0,100}(?:grass wedges|octagon|rounded blobs|is drawn as grass|no banks|no channel|is missing)|ortho|real(?:ity|[- ]world| road| path)|should (?:be|run)|also.{0,65}(?:missing|jagged|misalign)|look(?:s|ing) like')
        if parity and not collateral and not data['nearEdges']:return 'already-fixed','saved-contact-probes'
    parking=words(text,r'stall|parking (?:stripes?|lines?|paint|markings?|bays?)')
    if parking:
        tests,before,after=data['dividers']
        extra=words(text,r'hatch|arrow|island|crosswalk|symbol|accessible|kerb|curb|stop bar|stop line|blue |lot (?:shape|edge)|(?:incorrect|wrong) (?:angle|direction)|outline|concrete instead|building footprint')
        gold=words(text,r'yellow|amber')
        relevant=data['amberDividers'] if gold else data['dividers']
        tested,old,new=relevant
        count=re.search(r'(?<![\d.])(\d{1,2}) (?:painted |marked |parking )?(?:stalls?|spaces?|bays?)',text,re.I)
        if count and tested<int(count.group(1))*.75:extra=True
        if not extra and tested>=3 and new>=max(3,math.ceil(.77*tested)):
            if new-old>=2:return 'fixed','photographed-stall-dividers'
            if not fresh and old>=max(3,math.ceil(.85*tested)):return 'already-fixed','photographed-stall-dividers'
        return 'still-open','parking-layout'
    unrelated=words(text,r'missing.{0,40}(?:trees|stairs|wall|furniture|paint|drain)|no (?:objects|lamp|benches)|(?:no|without|misses|missing) (?:kerbs?|curbs?|fences?|lines?)|steps? (?:up|down)|(?:tan|dark|pale|light|concrete|tile|gravel|dirt|mulch) (?:instead|rather)|texture|runway|crosswalk|stadium|(?<!off-)road marking')
    subject=words(text,r'(?:phantom|fabricated|nonexistent|spurious|erroneous|isolated|detached|blobby|asphalt blob|pavement blob|paved blob|asphalt.*(?:grid|does not exist|cuts across)|grass (?:sliver|wedge|patch|berm).*(?:asphalt|drive|road)|(?:footpath|sidewalk|walkway).*(?:across (?:a |the )?lawn|where none)|(?:instead of|replaces|should be|in reality).{0,35}(?:grass|lawn|pavement|plaza))')
    if subject and not unrelated and not physics and not geometry and data['samples']>=110:
        before,after=data['agreement']
        eb,ea=data['edgeAgreement']
        if after>.93 and data['restoredArea']>3 and ((data['edgeSamples']>=25 and ea>.86 and ea-eb>.15) or (data['centralAgreement'][1]>.97 and after-before>.23)):
            return 'fixed','photographed-pavement-outline'
        if not fresh and data['edgeSamples']>=35 and min(eb,ea)>.94 and min(before,after)>.975 and min(data['centralAgreement'])>.98:return 'already-fixed','photographed-pavement-outline'
    color_claim=words(text,r'dark|blue.grey|light (?:concrete|pavement)|pale (?:concrete|pavement)|too bright|washed.out')
    if color_claim and not geometry and not physics and not words(text,r'blobs?|ragged|jagged|shape|texture|unmarked|missing|ends?|fragment|patch|stairs?|splices?|streak'):
        before,after=data['pavingColorError']
        if data['pavingSamples']>=100 and before>=22 and after<=14 and before-after>=10:
            return 'fixed','photographed-paving-tone'
    if geometry or physics or not potential:return 'still-open','additional-geometry-or-material'
    uncertain=words(text,r'\b(?:dark|wash(?:ed)?|colour|color|shade|blurry|jagged|serrated|dull|texture|offset|stair.step|triang|smear|crisp|level|rough|height|float|taper|puddles?|fragment|steps?|scattered|pieces|streak|fence|hedge|trees?|median|islands?|zigzag|join|seam|wall|shadow|gravel|mulch|brick)\b')
    if uncertain:return 'still-open','material-or-edge-detail'
    if data['samples']<100 or data['coverage']<.16 or min(data['centralSamples'],data['samples'])<12:return 'still-open','limited-ground-observation'
    before,after=data['agreement']
    cb,ca=data['centralAgreement']
    if after>=.92 and ca>=.93 and before<.88 and delta>=.12 and data['restoredArea']>=2.5:return 'fixed','ground-area-match'
    if not fresh and min(before,after)>=.973 and min(cb,ca)>=.985 and data['samples']>=185 and data['coverage']>.35:return 'already-fixed','ground-area-match'
    return 'still-open','ground-area-or-outline'


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--before',required=True)
    p.add_argument('--after',required=True)
    p.add_argument('--issues',type=Path,required=True)
    p.add_argument('--observations',type=Path)
    p.add_argument('--before-folder',type=Path)
    p.add_argument('--output',type=Path)
    args=p.parse_args()
    cv2.setNumThreads(1)
    audit=ROOT/'data/audit'
    rows=read(args.issues)
    observations=args.observations
    exact=[]
    for name in (args.before,args.after):
        file=observations/(name+'-contacts.json') if observations else None
        exact.append(read(file) if file and file.is_file() else {})
    control_file=observations/'controls.json' if observations else None
    controls=read(control_file) if control_file and control_file.is_file() else []
    for mark in controls:
        footprint_points=np.concatenate(mark['rings'])
        mark['bounds']=[*footprint_points.min(axis=0),*footprint_points.max(axis=0)]
    sports=read(ROOT/'build/survey_sports.json')
    track=Polygon(sports['track'][0],sports['track'][1:])

    cases=defaultdict(list)
    for i,issue in enumerate(rows):cases[issue['cell']].append((i,issue))
    buildings=read(ROOT/'web/campus-buildings.json')
    floors=[Polygon(part['rings'][0],part['rings'][1:]).buffer(0) for b in buildings for part in b['parts'] if part['low']<=.2]
    index=shapely.STRtree(floors)
    site=footprint()
    relief=region.lidar('dsm')-region.lidar('dtm')
    markings=read(ROOT/'build/survey_parking.json')
    extra=ROOT/'build/survey_bays.json'
    registered=read(extra)['rows'] if extra.is_file() else []
    observed_lots=ROOT/'build/survey_lot_markings.json'
    ranks=ROOT/'build/survey_parking_ink.json'
    archive=ROOT/'build/survey_parking_archive.json'
    if archive.is_file():registered.extend(read(archive)['dividers'])
    retained=ROOT/'build/survey_retained_parking.json'
    if retained.is_file():registered.extend(read(retained))
    if ranks.is_file():registered.extend([line,ink,'optical'] for line,ink in read(ranks))
    if observed_lots.exists():registered.extend([line,ink,'optical'] for line,ink in read(observed_lots)['dividers'])
    white=[*markings['lines'],*[line for line,amber,_ in registered if not amber]]
    gold=[*markings['amber'],*[line for line,amber,_ in registered if amber]]
    stripes=np.asarray(white+gold).reshape(-1,2,2)
    spatial=cKDTree(stripes.mean(axis=1))
    size=200
    def review(group):
        cell,issues=group
        west,north=(int(n)*50 for n in re.fullmatch(r'x(-?\d+)z(-?\d+)',cell).groups())
        paths=[(args.before_folder or audit/args.before)/'cells'/cell,audit/args.after/'cells'/cell]
        metrics=[read(p/'metrics.json') for p in paths]
        ground=[image(p/'views/ground.png',size) for p in paths]
        photo=image(paths[0]/'views/city-2025.png',size)
        top=[image(p/'views/top.png',size) for p in paths]
        blank=[np.all(im==216,axis=2) for im in top]
        xx,zz=np.meshgrid(west+(np.arange(size)+.5)*50/size,north+(np.arange(size)+.5)*50/size)
        local=index.geometries[index.query(box(west,north,west+50,north+50))]
        domain=shapely.contains_xy(site,xx,zz)&~shapely.contains_xy(shapely.union_all(local),xx,zz)
        heights=region.sample(relief,xx.ravel(),zz.ravel()).reshape(xx.shape)
        real,reliable,sim=evidence(ground,photo,domain,heights)
        hard_distance=cv2.distanceTransform((~(reliable&real)).astype('uint8'),cv2.DIST_L2,5)
        lawn_distance=cv2.distanceTransform((~(reliable&~real)).astype('uint8'),cv2.DIST_L2,5)
        bank=(hard_distance<6.0)&(lawn_distance<6.0)
        observed={}
        amber_observed={}
        road_marks=[]
        has_parking=any(words(r['description'],r'stall|parking (?:stripe|line|paint|mark|bay)') for _,r in issues)
        road_case=any(words(r['description'],r'crosswalk|zebra|crossing|stop bar|stop line|centre.line|center.line|turn arrow') for _,r in issues)
        if has_parking or road_case:
            detailed=[image(p/'views/ground.png') for p in paths]
            detailed_photo=image(paths[0]/'views/city-2025.png')
        if road_case and controls:
            def luma(im):return cv2.resize(.32*im[:,:,0]+.51*im[:,:,1]+.17*im[:,:,2],(500,500),interpolation=cv2.INTER_AREA)
            road_marks=road_observations(controls,[luma(im) for im in [*detailed,detailed_photo]],west,north)
        if has_parking:
            for k in spatial.query_ball_point([west+25,north+25],37):
                line=stripes[k]-[west,north]
                if np.any(line<.4) or np.any(line>49.6) or line_scores(detailed_photo,line,True)<.45:continue
                observed[k]=[line_scores(im,line)>=.57 for im in detailed]
                if k>=len(white):amber_observed[k]=[line_scores(im,line,amber_only=True)>=.47 for im in detailed]
        purple=[(im[:,:,0]>im[:,:,1]+8)&(im[:,:,2]>im[:,:,1]+7) for im in ground]
        track_inside=shapely.contains_xy(track.buffer(.35),xx,zz)
        found=[]
        for i,row in issues:
            x,z=row['x'],row['z']
            l,t,r,b=crop_bounds(row,cell)
            window=(xx>=l)&(xx<=r)&(zz>=t)&(zz<=b)
            if not window.any():window=np.ones_like(domain)
            available=reliable&window
            middle=available&((xx-x)**2+(zz-z)**2<3.1**2)
            def fractions(mask):
                if not mask.any():return [0,0]
                return [round(float((drawing[mask]==real[mask]).mean()),3) for drawing in sim]
            def relevant(f):
                return f['check'] in {'collision-parity','passed-solid','surface-class','camera-clip','off-road-paint','ground-height','launch','stuck','object-base'} and (f['x']-x)**2+(f['z']-z)**2<9**2
            hits=[sum(relevant(f) for f in m['findings']) for m in metrics]
            edges=sum((q['x']-x)**2+(q['z']-z)**2<4**2 for m in metrics for q in m.get('edgeObservations',[]))
            close=[k for k in spatial.query_ball_point([x,z],14) if k in observed]
            def lines(indices,measurements=observed):
                return [len(indices),*[sum(measurements[k][j] for k in indices) for j in range(2)]]
            data=dict(bounds=[round(n,2) for n in (l,t,r,b)],samples=int(available.sum()),coverage=round(float(available.sum()/window.sum()),3),agreement=fractions(available),
                      centralSamples=int(middle.sum()),centralAgreement=fractions(middle),restoredArea=round(float((available&(sim[0]!=real)&(sim[1]==real)).sum()*(50/size)**2),2),
                      contacts=hits,nearEdges=edges,dividers=lines(close),amberDividers=lines([k for k in close if k in amber_observed],amber_observed),blank=[round(float(im.mean()),3) for im in blank])
            pavement=available&real&sim[0]&sim[1]
            data['pavingSamples']=int(pavement.sum())
            data['pavingColorError']=[round(float(np.median(np.abs(im[pavement]-photo[pavement]).mean(axis=1))),1) if pavement.any() else 0 for im in ground]
            edge=available&bank
            data['edgeSamples']=int(edge.sum())
            data['edgeAgreement']=fractions(edge)
            data['exactContacts']=[s.get(str(i),[]) for s in exact]
            data['roadMarks']=[m for m in road_marks if math.dist(m['at'],[x,z])<10]
            data['trackExcess']=[round(float((window&mask&~track_inside).sum()/16),2) for mask in purple]
            data['trackInk']=[int((window&mask&track_inside).sum()) for mask in purple]
            state,method=choose(row,data)
            found.append(dict(id=i,**row,status=state,evidenceType=method,measurement=data))
        counts=[int(reliable.sum()),*[int((reliable&(drawing==real)).sum()) for drawing in sim]]
        recovered=int((reliable&(sim[0]!=real)&(sim[1]==real)).sum())
        lost=int((reliable&(sim[0]==real)&(sim[1]!=real)).sum())
        return found,np.array([*counts,recovered,lost])
    with ThreadPoolExecutor(5) as workers:results=list(workers.map(review,cases.items()))
    items=[item for group,counts in results for item in group]
    measured=np.sum([counts for group,counts in results],axis=0)*(50/size)**2
    area=dict(zip(['tested','matchingBefore','matchingAfter','corrected','regressed'],measured.tolist()))

    items.sort(key=lambda v:v['id'])
    summary={key:dict(Counter(r['severity'] for r in items if r['status']==key)) for key in ('fixed','already-fixed','still-open')}
    out=args.output or audit/args.after/'land-review.json'
    out.write_text(json.dumps(dict(before=args.before,after=args.after,cells=sorted(cases),counts=summary,photoAreaSquareMeters=area,issues=items),separators=(',',':')))
    print(json.dumps(summary),len(items),out,flush=True)


if __name__=='__main__':
    main()
