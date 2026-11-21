import math
import re

import cv2
import numpy as np
import shapely
from shapely.geometry import LineString,Point,Polygon,box

from review_land import ROOT,line_scores,read


def sources():
    common=read(ROOT/'build/survey_parking.json')
    rows=[(line,0) for line in common['lines']]+[(line,1) for line in common['amber']]
    rows.extend((line,ink) for line,ink,_ in read(ROOT/'build/survey_bays.json')['rows'])
    extra=read(ROOT/'build/survey_lot_markings.json')
    rows.extend(extra['dividers'])
    rows.extend(read(ROOT/'build/survey_parking_ink.json'))
    archive=ROOT/'build/survey_parking_archive.json'
    if archive.is_file():rows.extend((line,ink) for line,ink,record in read(archive)['dividers'])
    retained=ROOT/'build/survey_retained_parking.json'
    if retained.is_file():rows.extend((line,ink) for line,ink,record in read(retained))
    lines=[LineString(np.reshape(line,(-1,2))) for line,ink in rows]
    outlines=[g for p,*holes in extra['hatching'] for g in shapely.get_parts(shapely.make_valid(Polygon(p,holes))) if g.geom_type=='Polygon' and g.area>.001]
    zones=shapely.union_all([p.buffer(.60,quad_segs=4,join_style='mitre') for p in outlines])
    zones=shapely.get_parts(zones)
    return shapely.STRtree(lines),np.asarray([v[1] for v in rows]),[r['center'] for r in extra['accessible']],shapely.STRtree(zones)


def census(views,west,north,tools):
    tree,amber,panels,zones=tools
    bounds=box(west+.32,north+.32,west+49.68,north+49.68)
    center=np.array([west,north])
    rows=[]
    for i in tree.query(bounds,predicate='intersects'):
        line=tree.geometries[i]
        if not 2.5<line.length<13.85:continue
        part=line.intersection(bounds)
        if part.geom_type!='LineString' or part.length<max(2.2,.66*line.length):continue
        xy=np.asarray(part.coords)-center
        native=line_scores(views[2],xy,True)
        if native<.45:continue
        visible=[line_scores(im,xy,False,False) for im in views[:2]]
        gold=line_scores(views[2],xy,True,True)>.35 and bool(amber[i])
        golden=[line_scores(im,xy,False,True) for im in views[:2]] if gold else [0,0]
        delta=xy[-1]-xy[0]
        rows.append((xy.mean(axis=0),delta/np.linalg.norm(delta),part.length,visible,gold,golden))
    assigned=[False]*len(rows)
    groups=[]
    for i,(p,dir,length,flags,gold,golden) in enumerate(rows):
        if assigned[i]:continue
        members=[i];assigned[i]=True
        step=np.array([-dir[1],dir[0]])
        for j in members:
            q=rows[j][0]
            for k,(v,u,len2,*_) in enumerate(rows):
                if assigned[k] or abs(u@dir)<.976 or abs((v-q)@dir)>1.2 or abs(length-len2)>2.8:continue
                if 2.1<abs((v-q)@step)<4.9:assigned[k]=True;members.append(k)
        if len(members)>=3:groups.append(members)
    registered=set(i for g in groups for i in g)
    counts={}
    for name in ['all','yellow','white']:
        selected=[i for i in registered if name=='all' or bool(rows[i][4])==(name=='yellow')]
        def count(version):return sum(bool((rows[i][5] if name=='yellow' else rows[i][3])[version]>.51) for i in selected)
        counts[name]=[len(selected),count(0),count(1)]
    counts['rows']=[len(groups),*[sum(bool(np.mean([rows[i][3][v]>.51 for i in grp])>.79) for grp in groups) for v in [0,1]]]
    centers=[np.asarray(p)-center for p in panels if bounds.covers(Point(p))]
    icons=[]
    for q in centers:
        uv=np.rint(q*10-.5).astype(int);u,v=uv
        if u<6 or v<6 or u>=494 or v>=494:continue
        fraction=[]
        for im in views:
            r,g,b=im[v-5:v+6,u-5:u+6].astype(float).transpose(2,0,1)
            fraction.append(round(float(((b>r+4)&(b>g)).mean()),2))
        icons.append(fraction)
    counts['bluePanels']=[len(icons),*[sum(s[v]>.25 and s[2]>.25 for s in icons) for v in [0,1]]]
    counts['hatchedZones']=len(zones.query(bounds,predicate='intersects'))
    return counts


def judge(row,counts):
    if not counts:return
    text=(row.get('note2') or row['description']).lower()
    if not re.search(r'stall|parking (?:stripe|line|bay|paint|mark)',text):return
    if re.search(r'crop|x ?-?\d|\(\s*-?\d|kerb|curb|road width|turn|arrows?|median|islands?|hatch|gore|blobs?|rough|too dark|blue.gr[ae]y|asphalt (?:instead|rather)|colour|tex(ture|tured)|numbering|edge line|broken|sidewalk|different angle|misalign|beyond|smear|ends? abruptly|zigzag|dashed|missing.{0,40}(?:building|tree|material)|\d\s?m\b',text):return
    required=[]
    if 'yellow' in text or 'amber' in text:required.append('yellow')
    if 'white' in text:required.append('white')
    if not required:required=['all']
    if re.search('blue|accessible|disabled',text):required.append('bluePanels')
    target=re.search(r'(\d{1,3})\s*(?:painted |yellow |white |striped |marked |parking )*(?:stalls?|spaces?|bays?|lines?)',text)
    minimum=max(4,int(target[1])*.89 if target else 4)
    row_count=re.search(r'(two|three|four|[2-9])\s+(?:full |entire |main )?rows',text)
    n=int(row_count[1]) if row_count and row_count[1].isdigit() else {'two':2,'three':3,'four':4}.get(row_count[1],1) if row_count else 1
    if counts['all'][0]<minimum:return
    def ready(version):
        if counts['rows'][version]<n or counts['all'][version]<minimum:return False
        for kind in required:
            total,value=counts[kind][0],counts[kind][version]
            if kind=='bluePanels':
                if not total or value!=total:return False
            elif total<3 or value<max(3,math.ceil(total*.87)):return False
        return True
    if ready(2):
        if ready(1):return 'already-fixed','whole-cell-photographed-parking-rows'
        if counts['all'][2]>counts['all'][1]+2 or any(counts[k][2]>counts[k][1]+1 for k in required):return 'fixed','whole-cell-photographed-parking-rows'
