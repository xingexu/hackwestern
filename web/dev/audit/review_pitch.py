import re

import cv2
import numpy as np
import shapely
from shapely.geometry import LineString,Polygon,box

from review_land import ROOT,read


def pitch_parts():
    features=read(ROOT/'web/region-detail.json')
    sports=read(ROOT/'build/survey_sports.json')
    records=[]
    for kind,oid,x,y,z,yaw,width,length,*_ in features['macro']:
        grid=sports.get('gridiron',{}).get(str(oid))
        if kind!='canadian_football' or not grid:continue
        d=np.array([np.cos(yaw),-np.sin(yaw)])
        n=np.array([np.sin(yaw),np.cos(yaw)])
        center=np.array([x,z])
        def world(q):
            uv=np.asarray(q)
            return center+uv[:,:1]*d+uv[:,1:]*n
        for k in ('numbers','light'):
            mesh=shapely.union_all(shapely.polygons(grid[k]))
            records.append((k,mesh))
        lines=[LineString(world([[a-w/2,b],[a+w/2,b]])).buffer(.065,cap_style='flat') for a,b,w in grid['ticks']]
        records.append(('ticks',shapely.union_all(lines)))
        soccer=[LineString(world(q)).buffer(.072) for q in grid['soccer']]
        records.append(('soccer',shapely.union_all(soccer)))
        for zone in grid['ends']:
            area=Polygon(zone['fill'])
            records.append(('cut-corner',area.minimum_rotated_rectangle.difference(area.buffer(.6))))
    return records


def pitch_signals(views,left,top,shapes):
    frame=box(left,top,left+50,top+50)
    scores={}
    for kind,shape in shapes:
        if not shape.intersects(frame):continue
        geometry=shape.intersection(frame)
        mask=np.zeros((500,500),np.uint8)
        def ring(r):return np.rint((np.asarray(r.coords)-[left,top])*10-.5).astype('int32')
        for g in shapely.get_parts(geometry):
            if g.geom_type!='Polygon':continue
            cv2.fillPoly(mask,[ring(g.exterior)],1)
            for h in g.interiors:cv2.fillPoly(mask,[ring(h)],0)
        if mask.sum()<15:continue
        outer=cv2.dilate(mask,np.ones((11,11),np.uint8))-cv2.dilate(mask,np.ones((5,5),np.uint8))
        if not outer.any():continue
        signals=[]
        for im in views:
            rgb=im.astype('float32')
            r,g,b=rgb.transpose(2,0,1)
            band=(r+2*g+b)*.25
            if kind=='soccer':band=r-g+.6*(g-b)
            if kind=='cut-corner':
                signals.append(round(float(((r>g+7)&(b>g+4))[mask>0].mean()),3));continue
            back=cv2.GaussianBlur(band,(0,0),3.1)
            signal=band-back
            signals.append(round(float(np.mean(signal[mask>0]> (2 if kind=='soccer' else 6))),3))
        scores[kind]=[int(mask.sum()),*signals]
    return scores


def judged_pitch(row,scores):
    desc=(row.get('note2') or row['description']).lower()
    if not scores or re.search('bleachers?|lighting|stand[s ]|seats?|fans?|track|texture|brightness|collision|goalpost|pitch colour',desc):return
    needed=[]
    if re.search('yard numbers?|yard-line numbers?|number[s ]|digits',desc):needed.append('numbers')
    if re.search('hash|ticks?',desc):needed.append('ticks')
    if re.search('soccer|lacrosse',desc):needed.append('soccer')
    if re.search('square|chamfer|clipped corner',desc):needed.append('cut-corner')
    if re.search('crest|midfield logo|midfield w',desc):needed.append('light')
    if not needed:return
    if re.search('missing.{0,24}(?:arcs?|penalty area|dashes at the goal|yellow rectangle)|outside lane|breaks?|no track',desc):return
    for kind in needed:
        count,before,after,photo=scores.get(kind,[0,0,0,0])
        if count<24:return
        if kind=='cut-corner':
            if not (before>.50 and after<.20 and photo<.30):return
        elif not (photo>.28 and after>=.44 and after-before>.20):return
    return 'fixed','photographed-field-paint'
