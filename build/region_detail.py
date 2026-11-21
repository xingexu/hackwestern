import base64
import bisect
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from scipy.ndimage import gaussian_filter, median_filter
from scipy.spatial import cKDTree
from shapely import contains_xy, union_all
from shapely.ops import nearest_points
from shapely.affinity import scale
from shapely.geometry import LineString, Point, Polygon, box
from shapely.strtree import STRtree
import numpy as np

import architecture
import geo
from campus_region import sample

WEB = Path(__file__).resolve().parents[1] / "web"
OUT = WEB / "region-detail.json"
TILE = 96
PROFILES = {
    "Alumni Hall": "AH",
    "Cronyn Observatory": "CO",
    "Biotron Experimental Climate Change Research Centre": "BIO",
    "FIMS & Nursing Building": "FNB",
    "Health Sciences Building": "HSB",
    "Power Plant": "PP",
    "Support Services Building": "SSB",
    "Thompson Engineering Building": "TEB",
    "University Community Center": "UCC",
    "Westminister Hall": "WH",
    "Western Centre for Public Health and Family Medicine": "PHFM",
    "Western Interdisciplinary Research Building": "WIRB",
    "Western Student Services Building": "WSSB",
    "Bayfield Hall (Residence)": "BAHR",
    "Perth Hall": "PHR",
    "Essex Hall": "EHR",
    "The Stiller Centre": "SC",
    "Advanced Facility for Avian Research": "AFAR",
    "Convergence Centre": "CC",
    "Spencer Engineering Building": "SEB",
    "Ontario Hall": "OHR",
    "North Campus Building": "NCB",
    "Saugeen Maitland Hall (Residence)": "SMHR",
    "Thompson Arena": "TRAC",
    "Western Student Recreation Centre": "WSRC",
}
PHOTOS = "https://www.uwo.ca/fm/img/what_we_do/bldg/"
ROAD_WIDTH = {"primary": 14, "secondary": 11, "secondary_link": 7, "tertiary": 8, "unclassified": 6, "residential": 7, "service": 4.8}


def rectangle(poly):
    corners = list(poly.minimum_rotated_rectangle.exterior.coords)
    vectors = [(b[0]-a[0], b[1]-a[1]) for a,b in zip(corners,corners[1:])]
    dx,dz = max(vectors,key=lambda v:math.hypot(*v))
    center = poly.minimum_rotated_rectangle.centroid
    return center.x, center.y, math.atan2(dx,dz), min(math.hypot(*v) for v in vectors), math.hypot(dx,dz)


def classify(t):
    for field, types in (
        ("highway", ("crossing","traffic_signals","stop","bus_stop","street_lamp")),
        ("amenity", ("bench","bicycle_parking","post_box","shelter","parking_entrance")),
        ("emergency", ("fire_hydrant","phone")),
        ("barrier", ("gate","lift_gate","cycle_barrier","block","bollard","swing_gate","kerb")),
        ("man_made", ("flagpole",)), ("leisure", ("picnic_table",)),
    ):
        if t.get(field) in types:
            return t[field]
    if t.get("entrance") not in (None,"no"):
        return "entrance"
    if t.get("public_transport") == "platform":
        return "bus_stop"


def compile_detail():
    region = json.loads((WEB/"campus-region.json").read_bytes())
    core = json.loads((WEB/"street-detail.json").read_bytes())
    core_ids = {f['id'] for f in core['features']}
    elements = json.loads((geo.DATA/"region"/"map.json").read_bytes())['elements']
    nodes = {e['id']:geo.to_grid(e['lat'], e['lon']) for e in elements if e['type']=='node'}
    ways = [(e['id'],e.get('tags',{}),[nodes[n] for n in e['nodes'] if n in nodes]) for e in elements if e['type']=='way']
    bounds = box(*region['bounds'])
    xs,zs=region['xs'],region['zs']
    elevation=np.frombuffer(base64.b64decode(region['elevation']),dtype='<i2').reshape(len(zs),len(xs))
    core_ground=json.loads((WEB/'campus-ground.json').read_bytes())
    import zlib
    ground=np.frombuffer(zlib.decompress(base64.b64decode(core_ground['heightMillimeters'])),dtype='<u2').reshape(core_ground['depth'],core_ground['width'])
    def floor_y(x,z):
        if 0<=x<ground.shape[1] and 0<=z<ground.shape[0]:
            return float(ground[int(z),int(x)])/1000
        i = max(0,min(len(xs)-2,bisect.bisect_right(xs,x)-1))
        j = max(0,min(len(zs)-2,bisect.bisect_right(zs,z)-1))
        a,b=(x-xs[i])/(xs[i+1]-xs[i]),(z-zs[j])/(zs[j+1]-zs[j])
        y=elevation[j,i]*(1-a-b)+elevation[j,i+1]*a+elevation[j+1,i]*b if a+b<=1 else elevation[j+1,i+1]*(a+b-1)+elevation[j+1,i]*(1-a)+elevation[j,i+1]*(1-b)
        return float(y)*.1
    road_samples=[]
    road_segments=[]
    buildings=[]
    building_tags=[]
    for _,t,line in ways:
        if t.get('building') and len(line)>=4:
            polygon=Polygon(line).buffer(0)
            if not polygon.is_empty:
                buildings.append(polygon)
                building_tags.append(t)
        highway=t.get('highway')
        if highway not in ROAD_WIDTH or t.get('area')=='yes':
            continue
        for a,b in zip(line,line[1:]):
            length=math.dist(a,b)
            if length<.05:continue
            dx,dz=(b[0]-a[0])/length,(b[1]-a[1])/length
            for i in range(math.ceil(length/3)+1):
                u=min(length,i*3)
                road_samples.append((a[0]+dx*u,a[1]+dz*u))
                road_segments.append((math.atan2(dx,dz), ROAD_WIDTH[highway]))
    road_data=json.loads((WEB/'drive-network.json').read_bytes())
    road_areas=[]
    for way in road_data['ways']:
        if way['kind']=='road':
            road_areas.append(LineString([(p[0],p[2]) for p in way['points']]).buffer(way['width']/2,quad_segs=5))
    pavement=STRtree(road_areas)
    clearances={'bus_stop':.55,'stop':.55,'street_lamp':.55,'traffic_signals':.55,'flagpole':.55,
                'post_box':.7,'phone':.72,'fire_hydrant':.76,'parking_entrance':.65,
                'picnic_table':1.35,'bench':1.15,'bicycle_parking':2.85,'shelter':2.1}
    road_tree=cKDTree(road_samples)
    building_tree=STRtree(buildings)
    tiles=defaultdict(dict)
    counts=Counter()
    macro=[]
    landmark_ids=[]
    atlas=architecture.atlas()
    names=[f["name"] for f in atlas["forms"]]
    forms=[]
    hips={}
    tiers={}
    def tile(x,z):
        return tiles[f'{math.floor(x/TILE)}:{math.floor(z/TILE)}']
    def add(x,z,k,record):
        tile(x,z).setdefault(k,[]).append(record)
    def rounded(values):
        return [round(float(v),3) for v in values]
    def prop(kind,oid,x,z,t,forced_yaw=None):
        if not bounds.covers(Point(x,z)):return
        dist,idx=road_tree.query((x,z))
        yaw,width=road_segments[idx]
        px,pz=road_samples[idx]
        side=1 if (x-px)*math.cos(yaw)-(z-pz)*math.sin(yaw)>=0 else -1
        if kind in ('stop','traffic_signals') and dist<width*.45:
            x,z=px+side*math.cos(yaw)*(width*.52+.32),pz-side*math.sin(yaw)*(width*.52+.32)
        if kind in clearances:
            point=Point(x,z)
            reach=clearances[kind]
            nearby=pavement.query(point.buffer(reach+15))
            if len(nearby):
                envelope=union_all([road_areas[j] for j in nearby]).buffer(reach,quad_segs=5)
                if envelope.contains(point):
                    edge=nearest_points(point,envelope.boundary)[1]
                    x,z=edge.coords[0]
        if forced_yaw is not None:yaw=forced_yaw
        if kind=='entrance':
            boundary=buildings[building_tree.nearest(Point(x,z))].boundary
            lines=getattr(boundary,'geoms',[boundary])
            edges=[(a,b) for line in lines for a,b in zip(line.coords,list(line.coords)[1:]) if math.dist(a,b)>.25]
            if edges:
                a,b=min(edges,key=lambda edge:LineString(edge).distance(Point(x,z)))
                yaw=math.atan2(-(b[1]-a[1]),b[0]-a[0])
        if kind=='crossing':
            if dist>width*.7:return
            marking=t.get('crossing:markings')
            kind='kerb_crossing' if marking=='no' or t.get('crossing')=='unmarked' else 'parallel_crossing' if marking=='lines' else 'crossing'
        try: count=min(12,max(1,int(t.get('capacity',6))//2))
        except ValueError:count=3
        add(x,z,'p',[kind,oid,*rounded((x,floor_y(x,z),z,yaw,width,side)),count])
        counts[kind]+=1
    for e in elements:
        if e['type']=='node' and e['id'] not in core_ids:
            t=e.get('tags',{})
            kind=classify(t)
            if kind:prop(kind,e['id'],*nodes[e['id']],t)
    for oid,t,line in ways:
        if len(line)<2 or oid in core_ids:continue
        high,amenity,leisure=t.get('highway'),t.get('amenity'),t.get('leisure')
        poly=Polygon(line).buffer(0) if len(line)>=4 and line[0]==line[-1] else None
        if poly is not None and poly.geom_type=='Polygon' and poly.area>.1:
            x,z,yaw,w,l=rectangle(poly)
            kind=None
            if leisure=='pitch':kind=t.get('sport','field').split(';')[0]
            if t.get('building')=='grandstand':kind='grandstand'
            if leisure=='swimming_pool':kind='pool'
            if leisure in ('fitness_station','playground'):kind=leisure
            if leisure=='track' and t.get('sport')=='athletics' and oid!=427497760:kind='runway'
            if t.get('surface')=='sand' and kind=='athletics':kind='sandpit'
            if high=='platform':kind='platform'
            if amenity=='parking_space':kind='parking_space'
            if kind and bounds.covers(Point(x,z)):
                record=[kind,oid,*rounded((x,floor_y(x,z),z,yaw,w,l))]
                if kind in ('playground','fitness_station'):
                    point=poly.representative_point()
                    record[2:5]=rounded((point.x,floor_y(point.x,point.y),point.y))
                if kind=='baseball':
                    ring=line[:-1]
                    edges=sorted(range(len(ring)),key=lambda j:math.dist(ring[j],ring[(j+1)%len(ring)]),reverse=True)
                    first,second=edges[:2]
                    ends1=(ring[first],ring[(first+1)%len(ring)])
                    ends2=(ring[second],ring[(second+1)%len(ring)])
                    a,b=min(((a,b) for a in ends1 for b in ends2),key=lambda ab:math.dist(*ab))
                    hx,hz=(a[0]+b[0])/2,(a[1]+b[1])/2
                    heading=math.atan2(poly.centroid.x-hx,poly.centroid.y-hz)
                    record[2:6]=rounded((hx,floor_y(hx,hz),hz,heading))
                if kind in ('canadian_football','grandstand'):
                    macro.append(record)
                else:add(x,z,'a',record)
                counts[kind]+=1
            if amenity in ('shelter','bicycle_parking'):prop(amenity,oid,x,z,t,yaw)
        kind='steps' if high=='steps' else 'fence' if t.get('barrier')=='fence' else 'track' if oid==427497760 else 'platform_edge' if high=='platform' and poly is None else 'field_edge' if leisure=='pitch' and not t.get('sport') else None
        if not kind:continue
        for a,b in zip(line,line[1:]):
            diff=np.subtract(b,a)
            length=np.linalg.norm(diff)
            if length<.1:continue
            n=math.ceil(length/(4 if kind=='steps' else 10))
            for i in range(n):
                ax,az=np.add(a,diff*i/n); bx,bz=np.add(a,diff*(i+1)/n)
                x,z=(ax+bx)/2,(az+bz)/2
                if not bounds.covers(Point(x,z)):continue
                feature=[kind,oid,*rounded((ax,floor_y(ax,az),az,bx,floor_y(bx,bz),bz))]
                if kind=='track':macro.append(feature)
                else:add(x,z,'l',feature)
                counts[kind]+=1
    surface=median_filter(np.load(geo.DATA/'region'/'regional-dsm.npy'),size=3)
    datum=float(gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4)
    surface-=datum
    for i,(ring,holes,y,h,rgb,name) in enumerate(region['blocks']):
        polygon=Polygon(list(zip(ring[::2],ring[1::2])),[list(zip(hole[::2],hole[1::2])) for hole in holes]).buffer(0)
        if polygon.is_empty:continue
        x,z=polygon.representative_point().coords[0]
        profile=PROFILES.get(name,'')
        if profile:
            landmark_ids.append([profile,i])
        candidates=building_tree.query(polygon,predicate='intersects')
        tags={}
        if len(candidates):
            best=max(candidates,key=lambda j:polygon.intersection(buildings[j]).area)
            if polygon.intersection(buildings[best]).area>.4*polygon.area:tags=building_tags[best]
        gable=[]
        kind=tags.get('building','')
        shape=tags.get('roof:shape')
        if (shape in ('gabled','hipped','half-hipped') or (shape is None and (kind in ('house','detached','semidetached_house','bungalow','garage') or (kind in ('','yes','residential') and 32<polygon.area<230 and h<9)))) and polygon.geom_type=='Polygon' and not holes:
            cx,cz,yaw,w,l=rectangle(polygon)
            if 3<w<23 and l<42 and polygon.area/(w*l)>.79:
                rect=polygon.minimum_rotated_rectangle
                for inset in (.92,.82,.72,.62):
                    if polygon.covers(scale(rect,inset,inset,origin='center')):
                        gable=rounded((cx,cz,yaw,w*inset,l*inset))
                        break
        if polygon.area>220 and not gable:
            x0,z0,x1,z1=polygon.bounds
            step=2
            gx,gz=np.meshgrid(np.arange(math.ceil(x0/step)*step,x1,step),np.arange(math.ceil(z0/step)*step,z1,step))
            if gx.size:
                inside=contains_xy(polygon.buffer(-1.6),gx,gz)
                heights=sample(surface,gx.ravel(),gz.ravel()).reshape(gx.shape)-y-h
                raised_roof=np.where(inside & (heights>1.25) & (heights<30), np.round(heights),0).astype(int)
                for r, row in enumerate(raised_roof):
                    start=0
                    for stop in np.flatnonzero(np.r_[row[:-1]!=row[1:],True])+1:
                        rise=row[start]
                        if rise>0:
                            rx=(gx[r,start]+gx[r,stop-1])/2; rz=gz[r,start]
                            entry=[*rounded((rx,y+h,rz,step*(stop-start),rise)),rgb]
                            if profile in ('TRAC','SMHR','NCB','AH','OHR','SEB'): macro.append(['lidar',i,*entry])
                            else:add(rx,rz,'r',[*entry,i])
                            counts['surveyed_roof_runs']+=1
                        start=stop
        style=architecture.choose_style(name,tags,profile,polygon,h,i)
        ridge=[]
        if gable:
            cx,cz,yaw,span,length=rectangle(polygon)
            u=np.linspace(-span*.37,span*.37,9)
            along=np.linspace(-length*.26,length*.26,5)
            gu,gt=np.meshgrid(u,along)
            east=cx+gu*np.cos(yaw)+gt*np.sin(yaw)
            south=cz-gu*np.sin(yaw)+gt*np.cos(yaw)
            sampled=sample(surface,east.ravel(),south.ravel()).reshape(gu.shape)
            measured=float(np.median(sampled[:,3:6])-np.median(sampled[:,[0,-1]]))
            rise=min(span*.42,max(span*.13,measured*1.38))
            ridge=rounded([cx,cz,yaw,span,rise])
        tagged_flat=tags.get('roof:shape')=='flat'
        residential=style in ('sidingHome','brickHome')
        if not ridge and not tagged_flat and residential and polygon.area<620 and len(ring)<130:
            cx,cz,yaw,span,length=rectangle(polygon)
            xg,zg=np.meshgrid(np.arange(polygon.bounds[0]+1,polygon.bounds[2],2),np.arange(polygon.bounds[1]+1,polygon.bounds[3],2))
            visible=contains_xy(polygon.buffer(-.75),xg,zg)
            surveyed=sample(surface,xg[visible],zg[visible]) if visible.any() else []
            rise=float(np.percentile(surveyed,88)-np.percentile(surveyed,22)) if len(surveyed)>4 else span*.23
            if len(surveyed)>4 and rise>.65 or tags.get('roof:shape') in ('hipped','gabled','pyramidal'):
                hip=architecture.hip_roof(polygon,rise)
                if hip:hips[i]=hip
        if polygon.area>520 and not ridge and not residential:
            bands=architecture.surveyed_tiers(polygon,surface,y,h)
            if bands:tiers[i]=bands
        forms.append([names.index(style),ridge])
        approach=rounded(road_samples[road_tree.query((x,z))[1]]) if residential else []
        add(x,z,'b',[i,profile,gable,approach])
        counts['facades']+=1
        if gable:counts['pitched_roofs']+=1
    data=dict(tileSize=TILE,tiles=tiles,macro=macro,landmarks=landmark_ids,counts=counts,sources=dict(osm='https://www.openstreetmap.org/copyright',photos={code:PHOTOS+code+'.jpg' for code in sorted(set(PROFILES.values())|{'WAS'})}))
    data['architecture']=dict(atlas=atlas,roof=architecture.roof_atlas(region),forms=forms,hips=hips,tiers=tiers,core=architecture.core_frontages(WEB,ground),
        imagery='https://maps.london.ca/server/rest/services/Aerial2025/MapServer',streetFrames=architecture.SOURCES,landmarkPhotos=architecture.WESTERN_REFERENCES,
        streetAttribution='© Grab and KartaView contributors. Rectified facade samples, CC BY-SA 4.0.',
        license='https://creativecommons.org/licenses/by-sa/4.0/')
    OUT.write_text(json.dumps(data,separators=(',',':')))
    return data


def check(data):
    counts=data['counts']
    art=data['architecture']
    assert len(art['forms'])==counts['facades'] and len(art['core'])>30
    landmarks={entry[3]:entry[0] for entry in art['core']}
    assert landmarks['University College']=='universityBay' and landmarks['Middlesex College']=='middlesexBay'
    assert 'conronTracery' in {f['name'] for f in art['atlas']['forms']}
    assert len({form for form,ridge in art['forms']})>=10 and sum(bool(ridge) for form,ridge in art['forms'])>800
    assert len(art['hips'])>500 and len(art['tiers'])>50
    assert sum(bool(entry[3]) for tile in data['tiles'].values() for entry in tile.get('b',[]))>1000
    blocks=json.loads((WEB/'campus-region.json').read_bytes())['blocks']
    assert blocks[3338][3]<5 and blocks[3334][3]<5
    assert len(art['tiers'].get('3553') or art['tiers'].get(3553) or [])>8
    assert counts['facades']==len(json.loads((WEB/'campus-region.json').read_bytes())['blocks'])
    assert len(data['tiles'])>450 and counts['pitched_roofs']>250
    assert counts['grandstand']==2 and counts['canadian_football']==1 and counts['track']>40
    assert counts['steps']>90 and counts['fence']>80 and counts['entrance']>40
    assert counts['street_lamp']>30 and counts['bus_stop']>40 and counts['bicycle_parking']>40
    assert len({p for p,i in data['landmarks']})>=24 and counts['surveyed_roof_runs']>2500
    assert counts['playground']>=8 and counts['runway']==4 and counts['baseball']==2
    assert all(url==PHOTOS+code+'.jpg' for code,url in data['sources']['photos'].items())
    ways=json.loads((WEB/'drive-network.json').read_bytes())['ways']
    surfaces=[LineString([(p[0],p[2]) for p in w['points']]).buffer(w['width']/2,quad_segs=5) for w in ways if w['kind']=='road']
    roads=STRtree(surfaces)
    for tile_data in data['tiles'].values():
        for kind,oid,x,y,z,*_ in tile_data.get('p',[]):
            if kind in ('stop','bus_stop','traffic_signals','street_lamp','bench','bicycle_parking','shelter'):
                target=Point(x,z)
                assert surfaces[roads.nearest(target)].distance(target)>=.54, (kind,oid)
    print(f"{len(data['tiles'])} populated tiles, {len(data['landmarks'])} reference-matched footprint sections. {dict(sorted(counts.items()))}")


if __name__=='__main__':
    check(json.loads(OUT.read_bytes()) if '--check' in sys.argv else compile_detail())
