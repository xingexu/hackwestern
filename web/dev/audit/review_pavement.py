import argparse
import json
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import shapely
from PIL import Image
from shapely.geometry import LineString,Point,Polygon,box

from review_land import ROOT,line_scores,read,words
from review_ground_claims import complaint
from review_round_ground import pitch_edge,local_material,judge as local_verdict
from review_historic_rows import archive_reference,row_coverage,evaluate as dated_parking
from review_pitch import judged_pitch,pitch_parts,pitch_signals
from review_boundary import calibration,crossing_signals,judge as judged_boundary
from review_river import reaches,judge as judged_river,survey as river_survey
from review_lot import census,judge as judged_lot,sources as parking_sources


def forms():
    stock=read(ROOT/'build/survey_pavement.json')
    frontage=read(ROOT/'build/survey_frontages.json')
    geometries=[]
    types=[]
    def put(geometry,kind):
        geometries.append(geometry);types.append(kind)
    def rectangle(row):
        p=np.asarray(row[:2]);d=np.asarray(row[2:4]);n=np.array([-d[1],d[0]])
        w,h=np.asarray(row[4:6])*.5
        return Polygon([p+i*w*d+j*h*n for i,j in [(-1,-1),(1,-1),(1,1),(-1,1)]])
    for row in stock['pads']:put(rectangle(row),'pad')
    for row in stock['tables']:put(rectangle(row),'table')
    for line in stock['hatches']:put(LineString(np.reshape(line[:4],(-1,2))),'hatch')
    for group in stock['crossings']:
        for bar in group:put(Polygon(np.reshape(bar,(-1,2))),'crossing')
    for ring in stock['arrows']:put(Polygon(np.reshape(ring,(-1,2))),'arrow')
    for ring,ink,_ in read(ROOT/'build/survey_traffic_arrows.json'):
        put(Polygon(np.reshape(ring,(-1,2))),'arrow')
    for ring,*holes in read(ROOT/'build/survey_lot_markings.json')['hatching']:
        for zone in shapely.get_parts(shapely.make_valid(Polygon(ring,holes))):
            if zone.geom_type=='Polygon' and zone.area>.001:put(zone,'hatched-zone')
    for item in read(ROOT/'build/survey_islands.json'):put(Polygon(item['outer']),'island')
    for flat,side in frontage['kerbs']:put(LineString(np.reshape(flat,(-1,2))),'kerb')
    for kind,rings in frontage['faces']:
        put(Polygon(rings[0],rings[1:]),'court' if kind==3 else 'frontage')
    return shapely.STRtree(geometries),types


def crop_measure(poly,views,left,top,kind):
    scale=10
    l,t,r,b=poly.bounds
    l,t=max(0,int((l-left)*scale)-10),max(0,int((t-top)*scale)-10)
    r,b=min(500,int((r-left)*scale)+11),min(500,int((b-top)*scale)+11)
    if r-l<5 or b-t<5:return None
    mask=np.zeros((b-t,r-l),np.uint8)
    def ring(coords):
        return np.rint((np.asarray(coords)-[left,top])*scale-[l+.5,t+.5]).astype('int32')
    cv2.fillPoly(mask,[ring(poly.exterior.coords)],1)
    for hole in poly.interiors:cv2.fillPoly(mask,[ring(hole.coords)],0)
    outer=cv2.dilate(mask,np.ones((13,13),np.uint8))-cv2.dilate(mask,np.ones((5,5),np.uint8))
    inside=mask>0 if kind=='hatched-zone' else cv2.erode(mask,np.ones((3,3),np.uint8))>0
    if min(inside.sum(),outer.sum())<5:return None
    scores=[]
    for im in views:
        local=im[t:b,l:r].astype('float32')
        if kind=='pad':channel=local[:,:,0]-local[:,:,1]
        elif kind in ('table','hatched-zone'):channel=(local[:,:,0]+local[:,:,1])*.5-local[:,:,2]
        elif kind=='island':channel=local[:,:,1]-local[:,:,0]
        else:channel=.30*local[:,:,0]+.53*local[:,:,1]+.17*local[:,:,2]
        scores.append(round(float(np.median(channel[inside])-np.median(channel[outer>0])),1))
    return scores


def local_evidence(cell,rows,root,after,before,index,kinds,field,lots,river,sites,archive,surveyed_edges,surveyed_islands):
    left,top=(int(k)*50 for k in re.fullmatch(r'x(-?\d+)z(-?\d+)',cell).groups())
    def image(path):
        with Image.open(path) as im:return np.asarray(im.convert('RGB').resize((500,500),Image.Resampling.BOX))
    views=None
    response={}
    parking=None
    if any(words(row['description'],r'stall|parking (?:stripe|line|bay|paint|mark)') for row in rows):
        views=[image(root/name/'cells'/cell/'views'/file) for name,file in [(before,'ground.png'),(after,'ground.png'),(after,'city-2025.png')]]
        parking=census(views,left,top,lots)
    river_view=None
    if any(words(row["description"],r"\b(?:river|thames|channel)\b") for row in rows):
        views=[image(root/name/'cells'/cell/'views'/file) for name,file in [(before,'ground.png'),(after,'ground.png'),(after,'city-2025.png')]]
        river_view=reaches(views,river,left,top,sites,[root/name/'cells'/cell for name in (before,after)])
    boundary=None
    if any(words(row['description'],r'boundary|campus edge|off.campus|backdrop') for row in rows):
        if views is None:views=[image(root/name/'cells'/cell/'views'/file) for name,file in [(before,'ground.png'),(after,'ground.png'),(after,'city-2025.png')]]
        boundary=crossing_signals(views,left,top,sites,[root/name/'cells'/cell for name in (before,after)])
    pitch={}
    if any(g.intersects(box(left,top,left+50,top+50)) for _,g in field):
        frames=[image(root/name/'cells'/cell/'views'/file) for name,file in [(before,'top.png'),(after,'top.png'),(after,'city-2025.png')]]
        pitch=pitch_signals(frames,left,top,field)
    dated=row_coverage(archive,views[:2],left,top) if parking else None
    for row in rows:
        d=row['measurement'];place=Point(row['x'],row['z']);bounds=box(*d['bounds'])
        if bounds.distance(place)>2:bounds=place.buffer(6)
        nearby=index.query(bounds.buffer(.5),predicate='intersects')
        counts={}
        for i in nearby:
            poly=index.geometries[i];kind=kinds[i]
            if not poly.intersects(bounds) or poly.distance(place)>13:continue
            if kind=='kerb':
                value=round(poly.intersection(bounds).length,2)
                if value>=1:counts.setdefault(kind,[]).append(value)
                continue
            if kind=='frontage':
                area=poly.intersection(bounds).area
                if area>2:counts.setdefault(kind,[]).append(round(area,2))
                continue
            if views is None:
                views=[image(root/run/'cells'/cell/'views'/file) for run,file in [(before,'ground.png'),(after,'ground.png'),(after,'city-2025.png')]]
            if kind=='hatch':
                line=np.asarray(poly.coords)-[left,top]
                if np.any(line<.35) or np.any(line>49.65):continue
                score=[round(line_scores(v,line,i==2),2) for i,v in enumerate(views)]
            else:score=crop_measure(poly,views,left,top,kind)
            if score is not None:counts.setdefault(kind,[]).append(score)
        if views is None:
            views=[image(root/run/'cells'/cell/'views'/file) for run,file in [(before,'ground.png'),(after,'ground.png'),(after,'city-2025.png')]]
        footprint=complaint(row,*views,left,top)
        if footprint is not None:counts['groundClaim']=footprint
        local=[(a,b) for a,b in surveyed_edges if min(a[0],b[0])<left+51 and max(a[0],b[0])>left-1 and min(a[1],b[1])<top+51 and max(a[1],b[1])>top-1]
        detail={}
        pigment=pitch_edge(row,local,[views[0],views[0],views[1]],views[2],left,top)
        if pigment:detail['pitchEdge']=pigment
        surveyed=local_material(row,[views[0],views[0],views[1]],views[2],left,top,surveyed_islands)
        if surveyed:detail[surveyed[0]]=surveyed[1]
        if detail:counts['surfaceSurvey']=detail
        if pitch:counts['pitch']=pitch
        if parking:
            counts['lotCensus']=parking
            counts['datedRows']=dated
        if river_view:counts['river']=river_view
        if boundary:counts['boundary']=boundary
        response[row['id']]=counts
    return response


def classify(row,m,e):
    desc=row['description'].lower()
    method=row['evidenceType']
    if method=='surveyed-athletics-lanes' and m['trackInk'][0]==m['trackInk'][1] and abs(m['trackExcess'][0]-m['trackExcess'][1])<.1:return 'already-fixed',method
    if row['status']!='still-open':return row['status'],method
    local,method_local=local_verdict(row,e.get('surfaceSurvey',{}))
    if local=='fixed-in-land5':return 'fixed',method_local
    if local=='absent-on-lane-baseline':return 'already-fixed',method_local
    seam=judged_boundary(row,e.get('boundary'))
    if seam:return seam
    bank=judged_river(row,e.get('river'))
    if bank:return bank
    independent=dated_parking(row,e.get('datedRows'))
    if independent:return independent
    parking=judged_lot(row,e.get('lotCensus'))
    if parking:return parking
    field=judged_pitch(row,e.get('pitch'))
    if field:return field
    if e.get('groundClaim'):return e['groundClaim']['status'],'native-and-rendered-feature-footprint'
    def has(p):return words(desc,p)
    def subset(kind,p):return [s for s in e.get(kind,[]) if p(s)]
    matched={}
    pad=has(r'tactile|warning pad|(?:red|yellow) (?:paver |bumpy |raised )?(?:bands?|strips?|pads?)')
    if pad:
        signals=subset('pad',lambda s:s[1]>4 and s[2]>4)+subset('table',lambda s:s[1]>7 and s[2]>7)
        matched['pad']=bool(signals)
    cross=has(r'zebra|crosswalk|ladder crossing')
    if cross:
        strong=subset('crossing',lambda s:s[1]>7 and s[2]>7)
        old=m.get('roadMarks',[])
        matched['crossing']=len(strong)>=4 or any(v['kind']=='crossing' and v['bars']>=5 and v['barCounts'] and min(v['barCounts'][1:])>=.85*v['bars'] for v in old)
    hatch=has(r'hatch|gore')
    if hatch:
        bars=subset('hatch',lambda s:s[1]>=.59 and s[2]>=.59)
        zones=subset('hatched-zone',lambda s:s[1]>8 and s[2]>8)
        matched['hatch']=len(bars)+len(zones)>=3
    arrow=has(r'(?:turn|directional|lane|painted|white) arrows?')
    if arrow:matched['arrow']=bool(subset('arrow',lambda s:s[1]>10 and s[2]>10))
    island=has(r'(?:planted|grass|raised|kerbed|curbed|concrete|landscaped|mulch|traffic) (?:parking )?(?:islands?|medians?)')
    if island:
        matched['island']=bool(subset('island',lambda s:s[1]>5 and abs(s[2])>2))
    curb=has(r'\b(?:curbs?|kerbs?|kerbed|curbed)\b') and not island
    if curb:matched['kerb']=sum(e.get('kerb',[]))>3 or pad and matched['pad']
    stalls=has(r'\bstalls?|parking (?:bays?|stripes?|markings?)')
    if stalls:
        total,was,now=m['amberDividers'] if has('yellow|amber') else m['dividers']
        needed=re.search(r'(?<![\d.])(\d{1,2}) (?:painted |marked |parking )?(?:stalls?|spaces?|bays?)',desc)
        matched['stalls']=total>=3 and now>=max(3,.84*total,int(needed[1])*.84 if needed else 0)
    stops=has(r'stop (?:bars?|lines?)')
    if stops:matched['stop']=any(v['kind']=='approach' and min(v['gain'][1:])>10 for v in m['roadMarks'])
    shade=has(r'\b(?:color|colour|washed.out|dark blue|too dark|too light|too bright|pale concrete|light concrete)\b')
    surface=has(r'\b(?:grass|lawn|vegetation|foreground|footpaths?|sidewalks?|walkways?|aprons?|frontages?|plazas?|terraces?|courtyards?|driveways?|pavement|asphalt|concrete|gravel)\b')
    outline=has(r'edge|outline|irregular|jagged|fragments?|spliced?|blob|detached|strip of grass|island|median|kerb|curb|grass (?:sliver|wedge)|offset')
    physical=has(r'probe|physics|colli|collider|passes through|passed.solid|camera|soft.lock|\bstuck\b')
    beyond=has(r'outside|off.campus|backdrop|horizon|clip.boundary|beyond|out.of.bounds')
    structure=has(r'(?:missing|without|there (?:are|is) no|lack[s]?|no|absent|need[s]?) (?:a |any |the |real |corresponding |visible |small )?(?:trees?|shrubs?|hedges?|fences?|bollards?|lamps?|walls?|stairs?|railing|shelters?|trucks?|signs?|bridges?|bleachers?|seats?|roof|buildings?)|retaining wall|staircase|building footprint|building geometry|facade|façade')
    extra=has(r'textur|blurr|resolution|pixel|sport|stadium|court lines|vehicles?|mulch bed|pavers?|cobblestone|water|river|creek|bridge|spikes?|float|seams?|steps? (?:up|down)|lane count|cycleway|bike lane|broken.*(?:paint|dashes)|matte|checkerboard|tire|tyre')
    quantitative=m['samples']>=120 and m['coverage']>=.38 and m['centralSamples']>=12
    complete=quantitative and m['agreement'][1]>=.967 and m['centralAgreement'][1]>=.975
    old_complete=quantitative and m['agreement'][0]>=.967 and m['centralAgreement'][0]>=.975
    if outline:
        complete=complete and m['edgeSamples']>=20 and m['edgeAgreement'][1]>=.91
        old_complete=old_complete and m['edgeSamples']>=20 and m['edgeAgreement'][0]>=.91
    if shade:
        complete=complete and m['pavingSamples']>=80 and m['pavingColorError'][1]<12
        old_complete=old_complete and m['pavingSamples']>=80 and m['pavingColorError'][0]<12
    before_mark=any(any(len(s)==3 and s[1]>7 and s[2]>5 and s[1]-s[0]>6 for s in e.get(k,[])) for k in ('pad','table','arrow','crossing','island','court','hatched-zone'))
    if structure or physical or beyond or extra:return 'still-open',method
    if matched:
        if all(matched.values()) and (not surface or complete):
            improved=before_mark or bool(e.get('kerb') and curb) or (hatch and len(subset('hatch',lambda s:s[0]<.35 and s[1]>=.59 and s[2]>=.59))>=3)
            if improved:return 'fixed','native-feature-and-render'
            if (not surface or old_complete) and not curb:return 'already-fixed','native-feature-and-render'
        return 'still-open',method
    if surface and complete:
        if old_complete:return 'already-fixed','native-surface-and-outline'
        if m['restoredArea']>=2 and (m['agreement'][0]<.91 or m['edgeAgreement'][1]-m['edgeAgreement'][0]>.14):return 'fixed','native-surface-and-outline'
    return 'still-open',method


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--before',required=True);parser.add_argument('--after',required=True)
    parser.add_argument('--observations',type=str)
    args=parser.parse_args()
    root=ROOT/'data/audit'
    source=read(root/'land4-review.json')
    scores=read(root/args.after/'land-review.json')
    original={r['id']:r for r in source['issues']}
    work=[r for r in scores['issues'] if original[r['id']]['status']=='still-open']
    cells={}
    for row in work:cells.setdefault(row['cell'],[]).append(row)
    index,kinds=forms()
    field=pitch_parts()
    lots=parking_sources()
    archive=archive_reference()
    surveyed_edges=[(np.array([r[2],r[4]]),np.array([r[5],r[7]])) for t in read(ROOT/'web/region-detail.json')['tiles'].values() for r in t.get('l',[]) if r[0]=='field_edge']
    surveyed_islands=shapely.STRtree([Polygon(r['outer']) for r in read(ROOT/'build/survey_islands.json') if r['material']==1])
    river=river_survey()
    sites=calibration()
    evidence={}
    def collect(group):
        cell,rows=group
        return local_evidence(cell,rows,root,args.after,args.before,index,kinds,field,lots,river,sites,archive,surveyed_edges,surveyed_islands)
    with ThreadPoolExecutor(5) as pool:
        for result in pool.map(collect,cells.items()):evidence.update(result)
    for row in work:
        e=evidence[row['id']]
        row['status'],row['evidenceType']=classify(row,row['measurement'],e)
        row['localizedFeatures']=e
    if args.observations:
        from pathlib import Path
        verified=read(Path(args.observations))
        if verified['before']!=args.before or verified['after']!=args.after:raise ValueError('Visual certificates belong to a different pair of runs')
        by_id={r['id']:r for r in work}
        for item in verified['cases']:
            row=by_id[item['id']]
            if item['cell']!=row['cell'] or not item['observations']:raise ValueError('Missing location evidence')
            row['localizedFeatures']['inspectedLocation']=item['observations']
            row['status'],row['evidenceType']=item['status'],'registered-visual-location'
    counts={k:dict(Counter(r['severity'] for r in work if r['status']==k)) for k in ('fixed','already-fixed','still-open')}
    ledger=dict(before=args.before,after=args.after,counts=counts,previouslyClosed=602,issues=work)
    path=root/(args.after+'-review.json')
    path.write_text(json.dumps(ledger,separators=(',',':')))
    print(len(work),counts,path)


if __name__=='__main__':main()
