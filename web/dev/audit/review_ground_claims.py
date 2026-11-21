import re

import cv2
import numpy as np

NUMBER=r'-?\d+(?:\.\d+)?'
RANGE=r'(?:\s*(?:\.\.|to|[-–—])\s*('+NUMBER+r'))?'
AXES=re.compile(r'(?<!\w)x\s*[=~:]?\s*('+NUMBER+r')'+RANGE+r'\s*[,;]?\s*z\s*[=~:]?\s*('+NUMBER+r')'+RANGE,re.I)
PAIR=re.compile(r'\(\s*('+NUMBER+r')\s*,\s*('+NUMBER+r')\s*\)')
REFERENCE=re.compile(r'tree|shrub|fence|wall|bollard|lamp|roof|manhole|poles?|drains?|stairs?|mulch|retaining|steps?|til(e|ing)|texture|blurr|pavers?|hatch|crosswalk|stop bar|arrows?|colour|color|stripe[sd]? (?:lane|centre)|kerb height|curb height|floating|stalls?|entrances? (?:is|are) missing',re.I)
FAKE_PLANT=re.compile(r'(?:(?:grass|green|lawn) (?:ring|slivers?|wedges?|spikes?|blobs?|blotches?|fingers?|puddles?|stripes?|streaks?|patches?|islands?)|(?:slivers?|spikes?|wedges?|fingers?) of (?:grass|green))',re.I)
FAKE_ROAD=re.compile(r'(?:phantom|fictitious|fabricated|spuriously|nonexistent|does not exist|do not exist|not exist|no real.world counterpart|nowhere in the|where (?:there is|the photo shows|the orthophoto shows) (?:only )?(?:grass|lawn|meadow)|over (?:about |the |an? )?(?:.*? of the cell|.*?meadow))',re.I)
ROAD=re.compile(r'asphalt|pavement|paved|parking lot|driveway|road|footpath|walkway',re.I)


def regions(row,text,west,north):
    windows=[]
    def put(x,z,u,v):
        if not (west-2<=x<=west+52 and north-2<=z<=north+52 and west-2<=u<=west+52 and north-2<=v<=north+52):return False
        x,u=sorted((x,u));z,v=sorted((z,v))
        if u-x<1:x-=1;u+=1
        if v-z<1:z-=1;v+=1
        windows.append([max(west,x),max(north,z),min(west+50,u),min(north+50,v)])
        return True
    for match in AXES.finditer(text):
        l,r,t,b=match.groups()
        if not put(float(l),float(t),float(r or l),float(b or t)):return []
    if not windows:
        points=PAIR.findall(text)
        for x,z in points:
            x,z=float(x),float(z)
            if not put(x-2,z-2,x+2,z+2):return []
    if not windows:
        if re.search('entire cell|whole cell|half (?:the|of the) cell|percent of the cell',text,re.I):return [[west,north,west+50,north+50]]
        x,z=row['x'],row['z']
        if not put(x-5,z-5,x+5,z+5):return []
    return windows


def complaint(row,before,after,photo,west,north):
    original=row['description']
    note=row.get('note2','')
    text=note or original
    nominal_hard=r'\b(?:[\w-]+ ){0,3}(?:plazas?|aprons?|walkways?|driveways?|paths?|terraces?|court(?:yard)?s?|parking strips?|parking areas?|service lanes?|roadways?|pavements?)\b'
    drawn_soft=r'(?:drawn|renders?|rendered|simulated|replaced|shown|appears?)(?: and simulated)? (?:as|by|like|only) (?:plain |mown |open |lawn |turf |a narrow )?(?:grass|lawn|turf)'
    grass=bool(FAKE_PLANT.search(text) and ROAD.search(text+' '+original) or re.search(nominal_hard,text,re.I) and re.search(drawn_soft,text,re.I))
    hard=bool(FAKE_ROAD.search(text) and ROAD.search(text) and re.search('lawn|meadow|grass|soft ground|vegetation',text,re.I))
    if grass and hard:
        if re.search(r'(?:phantom|fictitious|fabricated|nonexistent) (?:parking lot|asphalt|road|drive|paving)',text,re.I):return None
        hard=False
    if grass==hard:return None
    if grass and re.search(r'mulch|planting bed|brick|in addition|also missing|yellow|white (?:line|stripe)|arrangement|no (?:kerb|curb)|raised|soft.edge|thin grey|blurry|without|facade|roundabout|real grass island|instead of (?:a |the )?(?:road|path)',text,re.I):return None
    if REFERENCE.search(text) or re.search('set.back|setback|detached walk|(?:island|driveway) (?:width|size)|(?:missing|no|without) (?:a |the |any )?(?:path|road|sidewalk|kerb|curb)|where (?:there|the ortho).*?(?:parking|road).*?(?:instead|should)',text,re.I):return None
    if re.search('colli|physics|probes?',text,re.I):
        contacts=row['measurement']['exactContacts']
        def parity(probe):
            return probe['ground']==probe['physics'] or probe['ground']=='kerb' and probe['physics'] in ('path','road')
        if not len(contacts[0]) or any(not all(parity(p) for p in group) for group in contacts):return None
    boxes=regions(row,text,west,north)
    if not boxes:return None
    measurements=[]
    for x,z,u,v in boxes:
        a,b=max(0,int((x-west)*10)),max(0,int((z-north)*10))
        c,d=min(500,int(np.ceil((u-west)*10))),min(500,int(np.ceil((v-north)*10)))
        if min(d-b,c-a)<5:return None
        images=[im[b:d,a:c].astype('float32') for im in [before,after,photo]]
        native=images[-1]
        nr,ng,nb=native.transpose(2,0,1)
        scale=(nr+ng*2+nb)*.25
        mineral=(ng>94)&(np.abs(ng-nr)<13)&(nr-nb<9+.13*scale)&(ng-nb<6+.13*scale)
        plant=((ng>nr+5)&(ng>nb+12)|(nr-ng>4)&(ng-nb>3+.11*scale)&(nr-nb>4+.18*scale))&(ng>55)
        expected=mineral if grass else plant
        count=int(expected.sum())
        if count<22 or count<.58*expected.size:return None
        totals=[]
        for view in images[:2]:
            r,g,blue=view.transpose(2,0,1)
            turf=(g>r+7)&(g>blue+13)
            pavement=(np.abs(g-r)<12)&(np.abs(g-blue)<23)&(g>65)
            unwanted=turf if grass else pavement
            target=unwanted&expected
            components=cv2.connectedComponentsWithStats(target.astype(np.uint8))[2][1:]
            size=int(components[:,cv2.CC_STAT_AREA].max()) if len(components) else 0
            totals.append([round(float(target.sum()/100),3),round(size/100,3),round(float(unwanted.mean()),4)])
        measurements.append(dict(bounds=[x,z,u,v],nativeCoverage=round(count/expected.size,3),nativeArea=round(count/100,2),before=totals[0],after=totals[1]))
    def absent(which):
        for m in measurements:
            total,largest,fraction=m[which]
            if total>.045*m['nativeArea'] or largest>min(.30,.015*m['nativeArea']) or fraction>.037:return False
        return True
    if not absent('after'):return None
    return dict(status='already-fixed' if absent('before') else 'fixed',kind='absent-grass' if grass else 'absent-paving',windows=measurements)
