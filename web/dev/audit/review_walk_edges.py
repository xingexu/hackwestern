import argparse
import json
import re
from collections import Counter
from pathlib import Path

import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import Point,box

from review_land import ROOT,crop_bounds,image,masks,read
from sidewalk_ribbons import inventory


def examine(rows,base,current,first):
    groups={}
    for row in rows:
        if row['status']!='still-open':continue
        text=(row.get('note2') or row['description']).lower()
        if re.search(r'sidewalk|footpath|walkway|footway',text):groups.setdefault(row['cell'],[]).append((row,text))
    edge=inventory()
    for cell,items in groups.items():
        west,north=[int(v)*50 for v in re.fullmatch(r'x(-?\d+)z(-?\d+)',cell).groups()]
        bounds=box(west,north,west+50,north+50)
        polys=edge.geometries[edge.query(bounds,predicate='intersects')]
        if not len(polys):continue
        shape=shapely.union_all(polys)
        transform=Affine.translation(west,north)*Affine.scale(.1)
        inner=rasterize([shape.buffer(-.26)],out_shape=(500,500),transform=transform,dtype='uint8').astype(bool)
        xy=np.meshgrid(west+.05+np.arange(500)*.1,north+.05+np.arange(500)*.1)
        levels=[p for p in (first,base,current) if p]
        observed=[masks(image(p/'cells'/cell/'views/ground.png',500))[0] for p in levels]
        reference=image(current/'cells'/cell/'views/city-2025.png',500)
        r,g,b=reference.astype(float).transpose(2,0,1)
        pavement=(g>112)&(g-r<4)&(r-g<11)&(r-b<27)&(g-b<20)
        for row,text in items:
            x,z=row['x'],row['z']
            l,t,e,s=crop_bounds(row,cell)
            level=(xy[0]>l)&(xy[0]<e)&(xy[1]>t)&(xy[1]<s)
            focus=inner&level
            if focus.sum()<350 or shape.distance(Point(x,z))>2.1:continue
            local=focus&(np.hypot(xy[0]-x,xy[1]-z)<2.4)
            if local.sum()<40:continue
            scores=[round(float(a[focus].mean()),4) for a in observed]
            central=[round(float(a[local].mean()),4) for a in observed]
            data=dict(interiorSquareMeters=round(focus.sum()*.01,2),paved=scores,centerPaved=central,photoConcrete=round(float(pavement[focus].mean()),4))
            row['surveyedSidewalk']=data
            missing=re.search(r'missing|disappears|broken|interrupted|incomplete|cut (?:through|across)|discontinuous|gaps?|fades? (?:away|out)|drawn as grass|turns into grass',text)
            compound=re.search(r'parking|crosswalk|kerb|curb|island|bus |fence|lamp|driveway|building|roof|height|floating|texture|colour|color|blur|curved|jagged|offset|alignment|narrow|wider|too wide|detached|ends at|roadway|pavers?|striping|stalls?|tree|shadow',text)
            if missing and not compound and min(scores[-1],central[-1])>.982 and scores[-1]-scores[-2]>.10 and central[-1]-central[-2]>.10 and data['photoConcrete']>.60:
                row.update(status='fixed-in-land5' if first else 'fixed',evidenceType='paired-survey-edges-and-rendered-interior')
    return rows


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--ledger',required=True,type=Path)
    parser.add_argument('--source',type=Path)
    args=parser.parse_args()
    d=read(args.ledger)
    a=ROOT/'data/audit'
    rows=examine(d['issues'],a/(d.get('baseline') or d['before']),a/d['after'],args.source)
    d['counts']={s:dict(Counter(r['severity'] for r in rows if r['status']==s)) for s in sorted({r['status'] for r in rows})}
    args.ledger.write_text(json.dumps(d,separators=(',',':')))
    print(len(rows),d['counts'])


if __name__=='__main__':main()
