import argparse
import hashlib
import json
import math
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely import STRtree,contains_xy,union_all
from shapely.geometry import Polygon,box

from grid import ROOT


def read(path):
    return json.loads(path.read_bytes())


def main():
    args=argparse.ArgumentParser()
    args.add_argument('--before',default='main1')
    args.add_argument('--after',required=True)
    args.add_argument('--reviews',nargs='+',type=Path,required=True)
    args.add_argument('--grading',type=Path)
    opt=args.parse_args()
    root=ROOT/'data/audit'
    before,after=[root/f for f in (opt.before,opt.after)]
    rows=[{**issue,'review':source.name} for source in opt.reviews for issue in read(source)['issues']]
    buildings={f['id']:f for f in read(ROOT/'web/campus-buildings.json')}
    floors=[]
    for b in buildings.values():
        for part in b['parts']:
            if part['low']>.2:continue
            rings=part['rings']
            floors.append(Polygon(rings[0],rings[1:]).buffer(0))
    floor_index=STRtree(floors)
    site=union_all([Polygon(np.reshape(s[0],(-1,2)),[np.reshape(h,(-1,2)) for h in s[1:]]) for s in read(ROOT/'web/campus-boundary.json')['polygons']])
    if opt.grading:
        for issue in read(opt.grading):
            building=buildings.get(issue['id'])
            x,z=building['center'] if building else (0,0)
            indices=re.search(r'wall\s+(\d+)',issue['description'],re.I)
            if building and indices and int(indices[1])<len(building['walls']):
                w=building['walls'][int(indices[1])]
                x,z=(np.add(w['a'],w['b'])/2+np.array(w['normal'])*2).tolist()
            rows.append({**issue,'x':x,'z':z,'cell':f'x{math.floor(x/50)}z{math.floor(z/50)}','category':issue['owner'],
                         'review':opt.grading.name,'view':str(Path('data/buildings/review')/issue['id']/'grade1'/Path(issue['image']).name)})
    size=200
    @lru_cache(maxsize=32)
    def evidence(cell):
        x,z=[int(k)*50 for k in re.fullmatch(r'x(-?\d+)z(-?\d+)',cell).groups()]
        crop=box(x,z,x+50,z+50)
        local=floor_index.query(crop)
        geometries=union_all([floors[i] for i in local])
        u,v=np.meshgrid(x+(np.arange(size)+.5)/4,z+(np.arange(size)+.5)/4)
        domain=contains_xy(site,u,v)&~contains_xy(geometries,u,v)
        sim=[]
        metrics=[]
        for run in [before,after]:
            folder=run/'cells'/cell
            metrics.append(read(folder/'metrics.json'))
            im=np.asarray(Image.open(folder/'views/ground.png').convert('RGB').resize((size,size),Image.Resampling.BOX),dtype=np.int16)
            r,g,b=im.transpose(2,0,1)
            sim.append((g-r<17)&(g-b<20)&~((r==226)&(g==226)&(b==226)))
        photo=np.asarray(Image.open(before/'cells'/cell/'views/city-2025.png').convert('RGB').resize((size,size),Image.Resampling.BOX),dtype=np.float32)
        r,g,b=photo.transpose(2,0,1)
        lum=(r+2*g+b)/4
        noise=np.sqrt(np.maximum(0,ndimage.uniform_filter(lum*lum,5)-ndimage.uniform_filter(lum,5)**2))
        hard=(g>160)&(g-b<27)&(g-r<7)&(r-g<14)&(noise<7)
        grass=(g>70)&(g<157)&((g-b>34)|(r-g>15))&(r>b+16)&(noise<8)
        return u,v,domain&(hard|grass),hard,sim,metrics
    parking=read(ROOT/'build/survey_parking.json')
    stripes=np.asarray(parking['lines']+parking.get('amber',[])).reshape(-1,2,2)
    midpoints=stripes.mean(axis=1)
    stripe_index=cKDTree(midpoints)
    @lru_cache(maxsize=18)
    def ground_views(cell):
        views=[]
        for run in (before,after):
            with Image.open(run/'cells'/cell/'views/ground.png') as im:
                views.append(np.asarray(im.convert('L'),dtype=np.int16))
        return views
    def visible_paint(cell,x,z):
        west,north=np.asarray(re.fullmatch(r'x(-?\d+)z(-?\d+)',cell).groups(),int)*50
        images=ground_views(cell)
        visible=np.zeros(2,int)
        tested=0
        for k in stripe_index.query_ball_point((x,z),19):
            a,b=stripes[k]
            along=b-a
            normal=np.array([-along[1],along[0]])/np.linalg.norm(along)
            path=a+np.linspace(.11,.89,19)[:,None]*along
            inside=(path[:,0]>west+.35)&(path[:,0]<west+49.65)&(path[:,1]>north+.35)&(path[:,1]<north+49.65)
            if inside.sum()<8:
                continue
            path=path[inside]-[west,north]
            tested+=1
            for i,im in enumerate(images):
                def sample(off):
                    u,v=np.floor((path+normal*off)*im.shape[0]/50).astype(int).T
                    return im[v,u]
                delta=sample(0)-.5*(sample(-.29)+sample(.29))
                visible[i]+=np.count_nonzero(delta>15)>.55*len(delta)
        return dict(tested=tested,before=int(visible[0]),after=int(visible[1]))
    tree_hits={}
    tree_file=after/'review-trees.json'
    if tree_file.exists():
        saved=read(tree_file)
        if saved['groundHash']==hashlib.sha256((ROOT/'web/ground-materials.json').read_bytes()).hexdigest():
            tree_hits=dict(zip(saved.get('keys',[]),saved['cases']))
    status=Counter()
    folders={p.name for p in (after/'cells').iterdir() if (p/'views/ground.png').exists()}
    for case in rows:
        cell=case['cell'];x,z=case['x'],case['z']
        if cell not in folders:
            case['evidenceStatus']='outside captured parcel'
            status[case['evidenceStatus']]+=1
            continue
        u,v,reliable,real,sim,metrics=evidence(cell)
        selected=reliable&((u-x)**2+(v-z)**2<14**2)
        case['groundSamples']=int(selected.sum())
        if selected.any():
            case['referenceAgreement']=[round(float(np.mean(layer[selected]==real[selected])),3) for layer in sim]
        checks=('collision-parity','passed-solid','camera-clip','ground-height','object-base','off-road-paint','surface-class','launch','stuck')
        nearby=[]
        for m in metrics:
            events=[f['check'] for f in m['findings'] if f['check'] in checks and (f['x']-x)**2+(f['z']-z)**2<=8**2]
            nearby.append(dict(Counter(events)))
        case['findingsWithin8m']=nearby
        if 'image' in case:
            linked=re.findall(r'[^ ,()+]+?\.(?:jpg|png)',case['image'])
            sources=[]
            for token in linked:
                parts=Path(token).parts
                path=ROOT/Path(*parts[parts.index('data'):]) if 'data' in parts else ROOT/'data/buildings/review'/case['id']/'grade1'/Path(token).name
                sources.append(path)
            case['sourceImages']=[str(p.relative_to(ROOT)) for p in sources]
            case['sourceImageExists']=bool(sources) and all(p.is_file() for p in sources)
        else:
            case['sourceImageExists']=(before/'cells'/cell/case['view']).is_file()
        case['currentViews']=[str(Path('cells')/cell/'views'/p) for p in ('top.png','ground.png','city-2025.png')]
        paint=None
        if case['category'] in ('paint','reference','surface','terrain') and re.search(r'stall|hatched|hatching|parking (?:bay|mark|stripe|line)',case['description'],re.I):
            paint=visible_paint(cell,x,z)
            case['surveyStripesVisible']=paint
        measured=tree_hits.get(cell+'|'+case['description'],[])
        if measured:
            case['nearbySurveyTrunks']=measured
        planting_gap=re.search(r'miss|absent|sparse|too few|bare|scattered|empty|few trees|no (?:young |mature |planted )?trees|instead of',case['description'],re.I)
        if case['category']=='vegetation' and planting_gap and any(p['grounded'] and p['distance']<=9 for p in measured):
            case['evidenceStatus']='new surveyed trunk visible and colliding within 9 m'
        elif paint and paint['after']>=paint['before']+2:
            case['evidenceStatus']='new photographed parking paint visible'
        elif case['category'] in ('collision','camera','height') and nearby[0] and not nearby[1]:
            case['evidenceStatus']='previous nearby probes cleared'
        elif len(case.get('referenceAgreement',[])) and selected.sum()>180 and case['referenceAgreement'][1]>case['referenceAgreement'][0]+.05:
            case['evidenceStatus']='photo surface agreement increased'
        else:
            case['evidenceStatus']='visual comparison'
        status[case['evidenceStatus']]+=1
    out=after/'ground-review.json'
    out.write_text(json.dumps({'before':opt.before,'after':opt.after,'status':dict(status),'issues':rows},separators=(',',':')))
    print(len(rows),dict(status),out)


if __name__=='__main__':
    main()
