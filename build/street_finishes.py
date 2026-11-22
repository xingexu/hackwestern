import base64
import io
import json
import math
import zlib
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon, box, shape
from scipy import ndimage
from rasterio import Affine
from rasterio.features import geometry_mask, shapes
from shapely.ops import substring
from shapely.affinity import affine_transform

import campus_region as region
from campus_bounds import footprint
import city_streets
import geo
import ground_observations

DENSITY=4
SCALE=2
WALK, PAVERS, TRAIL, BLACKTOP, JOINT, WHITE, YELLOW, BLUE=range(1,9)
COLORS=np.array([(0,0,0,255),(0,0,255,255),(0,0,255,198),(0,0,255,145),(0,0,255,55),
                 (0,0,255,171),(255,0,0,255),(0,255,0,255)],dtype=np.uint8)


def xy(flat):
    return np.asarray(flat).reshape(-1,2)


class Features:
    def __init__(self):
        self.geometry=[]
        self.ink=[]

    def add(self,geometry,ink=1):
        if not geometry.is_empty:
            self.geometry.append(geometry)
            self.ink.append(ink)

    def seal(self):
        self.index=STRtree(self.geometry)

    def draw(self,frame,size):
        left,top,right,bottom=frame
        sx,sz=size[0]/(right-left),size[1]/(bottom-top)
        image=Image.new('L',size)
        pen=ImageDraw.Draw(image)
        def coords(ring):
            points=np.asarray(ring.coords)
            return list(zip((points[:,0]-left)*sx-.5,(points[:,1]-top)*sz-.5))
        for i in sorted(self.index.query(box(*frame))):
            g=self.geometry[i]
            for poly in getattr(g,'geoms',[g]):
                if poly.geom_type!='Polygon':
                    continue
                pen.polygon(coords(poly.exterior),fill=self.ink[i])
                for hole in poly.interiors:
                    pen.polygon(coords(hole),fill=0)
        return np.asarray(image)


def accessible_parking(parking,registry):
    for row in registry:
        angle=math.radians(row['heading'])
        side=np.array([math.cos(angle),math.sin(angle)])
        forward=np.array([-side[1],side[0]])
        centers=np.asarray(row['centers'])
        scale=row.get('width',1.26)/1.26
        for center in centers:
            def point(x,y):
                return center+scale*(x*side+y*forward)
            def stroke(coords,width):
                return LineString([point(x,y) for x,y in coords]).buffer(width*scale,cap_style='round',join_style='round')
            panel=Polygon([point(x,y) for x,y in [(-.63,-.63),(.63,-.63),(.63,.63),(-.63,.63)]])
            arc=[(-.09+.26*math.cos(t),-.13+.26*math.sin(t)) for t in np.linspace(.59*math.pi,1.97*math.pi,22)]
            icon=shapely.union_all([stroke(arc,.043),stroke([(-.14,.27),(-.08,-.005),(.163,-.014),(.28,-.26),(.35,-.23)],.050),
                                   stroke([(-.11,.16),(.13,.13)],.038),Point(point(-.17,.40)).buffer(.09,quad_segs=8)])
            parking.add(panel.difference(icon),BLUE)
            parking.add(icon,WHITE)
        for a,b in zip(centers,centers[1:]):
            center=(a+b)*.5
            corners=[center+forward*f+side*n for f,n in [(-1.4,-.65),(2.4,-.65),(2.4,.65),(-1.4,.65)]]
            parking.add(LineString([*corners,corners[0]]).buffer(.05,cap_style='flat'),YELLOW)
            for f in [-1.15,-.23,.69,1.61]:
                stripe=LineString([center+forward*f-side*.65,center+forward*(f+.69)+side*.65])
                parking.add(stripe.buffer(.048,cap_style='flat'),YELLOW)


def source_layers(network,municipal,region_detail,core,road,control_layout=None,center_layout=None):
    road_survey={}
    if control_layout is None or center_layout is None:
        road_survey=json.loads((region.OUT.parents[1]/'build/survey_road_paint.json').read_bytes())
    if control_layout is None:
        def control_layout(key,shapes):
            transform=road_survey['controls'].get(key)
            if transform is None:return shapes
            if not transform:return []
            origin=shapely.union_all(shapes).centroid
            from shapely.affinity import rotate,translate
            return [translate(rotate(s,transform[2],origin=origin),*transform[:2]) for s in shapes]
    if center_layout is None:
        def center_layout(key,line):
            return [LineString(xy(r)) for r in road_survey.get('centers',{}).get(key,[])] or [line]
    elements=json.loads((region.CACHE/'map.json').read_bytes())['elements']
    tags={e['id']:e.get('tags',{}) for e in elements if e['type']=='way'}
    nodes={e['id']:e.get('tags',{}) for e in elements if e['type']=='node'}
    walk,slabs,paint,junctions,overhead=(Features() for _ in range(5))
    arms=defaultdict(list)
    controls=Features()
    control_nodes={e['id']:Point(geo.to_grid(e['lat'],e['lon'])) for e in elements if e['type']=='node' and e.get('tags',{}).get('highway') in ('stop','traffic_signals')}
    control_positions=STRtree(list(control_nodes.values()))
    roads=[(w,LineString([(x,z) for x,_,z in w['points']])) for w in network['ways'] if w['kind']=='road' and w['level']==0 and not w['bridge']]
    roads_index=STRtree([line for _,line in roads])
    for i,(way,line) in enumerate(roads):
        for j in roads_index.query(line,predicate='intersects'):
            if j<=i:
                continue
            other,branch=roads[j]
            for node in shapely.get_parts(line.intersection(branch)):
                if node.geom_type!='Point':
                    continue
                d=line.project(node)
                e=branch.project(node)
                if max(min(d,line.length-d),min(e,branch.length-e))<.15:
                    continue
                junctions.add(node.buffer(max(way['width'],other['width'])*.58+1.8))
    def approach_mark(geometry,line,station,direction):
        a=line.interpolate(max(0,station-.5))
        b=line.interpolate(min(line.length,station+.5))
        p=line.interpolate(station)
        length=a.distance(b)
        if length<.01:
            return
        dx=direction*(b.x-a.x)/length
        dz=direction*(b.y-a.y)/length
        controls.add(affine_transform(geometry,[-dz,dx,dx,dz,p.x,p.y]),WHITE)
    deck_lanes={tuple(p[::2]):w['lanes'] for w in network['ways'] if w['bridge'] and w['kind']=='road' for p in (w['points'][0],w['points'][-1])}
    raw=np.asarray(road)
    west,north,east,south=network['bounds']
    rx,rz=road.width/(east-west),road.height/(south-north)
    def follow_pavement(line,nominal):
        points=np.asarray(line.segmentize(3).coords)
        tangent=np.gradient(points,axis=0)
        normal=np.stack([-tangent[:,1],tangent[:,0]],axis=1)/np.maximum(.001,np.linalg.norm(tangent,axis=1))[:,None]
        offsets=np.arange(-18,18.01,.25)
        samples=points[:,None,:]+normal[:,None,:]*offsets[None,:,None]
        i=np.clip(((samples[:,:,0]-west)*rx).astype(int),0,road.width-1)
        j=np.clip(((samples[:,:,1]-north)*rz).astype(int),0,road.height-1)
        asphalt=raw[j,i]>=128
        mid=len(offsets)//2
        negative=np.argmax(np.pad(~asphalt[:,mid::-1],((0,0),(0,1)),constant_values=True),axis=1)*.25
        positive=np.argmax(np.pad(~asphalt[:,mid:],((0,0),(0,1)),constant_values=True),axis=1)*.25
        widths=positive+negative-.25
        valid=asphalt[:,mid]&(widths>nominal*.65)&(widths<nominal*1.65)
        if not valid.any():
            return line,nominal
        weight=ndimage.gaussian_filter1d(valid.astype(float),2.4,mode='nearest')
        drift=ndimage.gaussian_filter1d(np.where(valid,(positive-negative)*.5,0.),2.4,mode='nearest')/np.maximum(.1,weight)
        station=np.r_[0,np.cumsum(np.linalg.norm(np.diff(points,axis=0),axis=1))]
        taper=np.minimum(1,np.minimum(station,station[-1]-station)/9)
        center=points+normal*(np.clip(drift,-2.8,2.8)*taper)[:,None]
        return LineString(center),float(np.median(widths[valid]))
    for way in network['ways']:
        if way['bridge'] or way['level']!=0:
            continue
        line=LineString([(x,z) for x,y,z in way['points']])
        width=way['width']
        if way['kind']!='road':
            surface=tags.get(way['id'],{}).get('surface','concrete')
            ink=TRAIL if surface in ('gravel','dirt','earth','ground','compacted','grass','fine_gravel') else BLACKTOP if surface=='asphalt' else PAVERS if surface=='paving_stones' else WALK
            walk.add(line.buffer(width/2,quad_segs=3),ink)
            continue
        for i in way['junctions']:
            x,y,z=way['points'][i]
            for j in [i-1,i+1]:
                if 0<=j<len(way['points']):
                    nx,_,nz=way['points'][j]
                    yaw=math.atan2(nx-x,nz-z)
                    arms[x,z].append((yaw,width))
        t=tags.get(way['id'],{})
        if way['lanes']<2 or way['class'] in ('residential','service','living_street') or t.get('junction')=='roundabout':
            continue
        one=t.get('oneway') in ('yes','-1','1','true')
        lanes=way['lanes']
        line,measured=follow_pavement(line,width)
        if one:
            bridge_lanes=min(deck_lanes.get(tuple(p[::2]),lanes) for p in (way['points'][0],way['points'][-1]))
            if lanes>bridge_lanes and measured<lanes*3.0:
                lanes=bridge_lanes
            lanes=max(1,min(lanes,int((measured+.25)/2.9)))
        left_bike=t.get('cycleway:left',t.get('cycleway:both'))=='lane'
        right_bike=t.get('cycleway:right',t.get('cycleway:both'))=='lane'
        bike_width=min(1.5,max(.8,(measured-lanes*2.7)/max(1,left_bike+right_bike)))
        width=measured-bike_width*(left_bike+right_bike)
        lane_center=(int(left_bike)-int(right_bike))*bike_width*.5
        directional=t.get('lanes:backward','')
        backward=min(lanes-1,max(1,int(directional))) if directional.isdigit() else lanes//2
        center=lane_center+((backward/lanes-.5)*width if directional else 0)
        if not one:
            guide=line.offset_curve(center) if center else line
            key=str(way['id'])+'@'+','.join(str(round(v,1)) for v in line.coords[0])
            for stripe in center_layout(key,guide):
                paint.add(stripe.buffer(.075,cap_style='flat',join_style='round'),YELLOW)
        for direction in ([1] if one else [-1,1]):
            end=line.interpolate(line.length if direction==1 else 0)
            if not len(control_positions.query(end.buffer(7),predicate='intersects')):
                continue
            lane_count=lanes if one else lanes-backward if direction==1 else backward
            span=width*lane_count/lanes
            outer=width*.5-.38+direction*lane_center
            inner=outer-span+.76
            if line.length<14 or inner>=outer:
                continue
            setback=max(5.8,width*.48+2.9)
            if line.length<=setback+2:
                continue
            d=line.length-setback if direction==1 else setback
            approach_mark(box(inner,-.18,outer,.18),line,d,direction)
            turns=t.get('turn:lanes', '') if one else t.get('turn:lanes:'+('forward' if direction==1 else 'backward'),'')
            if not turns or len(turns.split('|'))!=lane_count or line.length<setback+15:
                continue
            station=d-direction*9
            for index,turn in enumerate(turns.split('|')):
                if turn not in ('left','right'):
                    continue
                u=inner+(index+.5)*(outer-inner)/lane_count
                side=1 if turn=='right' else -1
                arrow=Polygon([(u-.13,-1.9),(u+.13,-1.9),(u+.13,.2),(u+side*.72,.82),(u+side*.98,.56),(u+side*1.04,1.67),(u+side*.05,1.54),(u+side*.34,1.19),(u-.13,.42)]).buffer(0)
                approach_mark(arrow,line,station,direction)
        for key,side in [('cycleway:left',1),('cycleway:right',-1)]:
            if t.get(key)!='lane' and t.get('cycleway:both')!='lane':
                continue
            offset=lane_center-side*width*.5
            bike=line.offset_curve(offset,join_style='round')
            paint.add(bike.buffer(.072,cap_style='flat'),WHITE)
        for n in range(1,lanes):
            if not one and (n==backward or (lanes%2==1 and not directional)):
                continue
            offset=lane_center+(n/lanes-.5)*width
            guide=line.offset_curve(offset,join_style='round') if offset else line
            for piece in getattr(guide,'geoms',[guide]):
                for start in np.arange(0,piece.length,9):
                    dash=substring(piece,float(start),min(start+3,piece.length))
                    if dash.length>.10:
                        paint.add(dash.buffer(.074,cap_style='flat',quad_segs=2),WHITE)
    from carriageway_ink import measured_tracks
    measured_lanes,replaced=measured_tracks()
    paint.geometry=[g.difference(replaced[int(ink==YELLOW)]) for g,ink in zip(paint.geometry,paint.ink)]
    stripe_index=STRtree(paint.geometry)
    for i,guide in enumerate(paint.geometry):
        for j in stripe_index.query(guide,predicate='overlaps'):
            if j<=i:
                continue
            overlap=guide.intersection(paint.geometry[j])
            if overlap.area>1e-5:
                junctions.add(overlap.buffer(1.8))
    for (x,z),rays in arms.items():
        directions=[]
        for a,w in rays:
            if not any(math.cos(a-b)>.94 for b in directions):
                directions.append(a)
        if len(directions)>=3:
            junctions.add(Point(x,z).buffer(max(w for _,w in rays)*.52+1.5,quad_segs=7))
    for tile in municipal['tiles'].values():
        for flat in tile.get('slabs',[]):
            points=xy(flat)
            face=Polygon(points)
            if not face.is_valid:
                face=face.buffer(0)
            slabs.add(face,WALK)
            a,b,c,d=points
            along=b-a
            length=np.linalg.norm(along)
            if length<.6:
                continue
            origin=np.dot(a,along/length)
            for v in np.arange(math.ceil(origin/1.8)*1.8-origin,length,1.8):
                fraction=v/length
                seam=LineString([a+along*fraction,d+(c-d)*fraction])
                slabs.add(seam.buffer(.022,cap_style='flat'),JOINT)
    pavement=json.loads((region.OUT.parents[1]/'build/survey_pavement.json').read_bytes())
    cross=Features()
    from ladder_crossings import registered
    measured=[]
    for group in registered():
        stripes=[Polygon(xy(ring)) for ring in group['bars']+group['rails']]
        belt=shapely.union_all(stripes).convex_hull.buffer(.32)
        measured.append(belt)
        junctions.add(belt)
        for stripe in stripes:cross.add(stripe,WHITE)
    ladder_area=shapely.union_all(measured)
    for group in pavement['crossings']:
        stripes=[Polygon(xy(ring)) for ring in group]
        belt=shapely.union_all(stripes).convex_hull.buffer(.42)
        measured.append(belt)
        junctions.add(belt)
        for stripe in stripes:
            if not ladder_area.intersects(stripe):cross.add(stripe,WHITE)
    measured=shapely.union_all(measured)
    crossings={p[1]:p for tile in region_detail['tiles'].values() for p in tile.get('p',[]) if p[0] in ('crossing','parallel_crossing')}
    for f in core['features']:
        if f['kind']=='crossing' and f['id'] not in crossings:
            crossings[f['id']]=['crossing',f['id'],f['x'],f['y'],f['z'],f['yaw'],8.2]
    for kind,oid,x,y,z,yaw,width,*_ in crossings.values():
        t=nodes.get(oid,{})
        photographed=road_survey.get('crosswalks',{}).get(str(oid))
        p=Point(x,z)
        if measured.distance(p)<2:
            if photographed and ladder_area.distance(p)<2:
                for ring in photographed:
                    stripe=Polygon(xy(ring))
                    if not measured.intersects(stripe):
                        cross.add(stripe,WHITE)
                        junctions.add(stripe.buffer(.25))
            continue
        if photographed is None and t.get('crossing:markings','') in ('','no') and t.get('crossing') not in ('traffic_signals','zebra','marked'):
            continue
        c,s=math.cos(yaw),math.sin(yaw)
        def point(u,v):
            return (x+c*u+s*v,z-s*u+c*v)
        def rect(u,v,w,h):
            return Polygon([point(u+i*w/2,v+j*h/2) for i,j in [(-1,-1),(1,-1),(1,1),(-1,1)]])
        junctions.add(rect(0,0,width+3,4.5))
        if kind=='parallel_crossing':
            marks=[rect(0,v,width,.15) for v in [-1.12,1.12]]
        else:
            marks=[rect(u,0,.40,2.35) for u in np.arange(-width*.47+.19,width*.47,.85)]
        if photographed is None:marks=control_layout(str(oid),marks)
        else:marks=[Polygon(xy(ring)) for ring in photographed]
        for mark in marks:
            cross.add(mark,WHITE)
            junctions.add(mark.buffer(.25))
    access=json.loads((region.OUT.parents[1]/'build/survey_access_arrows.json').read_bytes())
    for ring in [*pavement['arrows'],*access]:
        arrow=Polygon(xy(ring)).buffer(0)
        if not any(arrow.distance(other)<.22 for other in cross.geometry):
            cross.add(arrow,WHITE)
            junctions.add(arrow.buffer(.42))
    registered=[g for i,geom in enumerate(controls.geometry) for g in control_layout('approach-'+str(i),[geom])]
    for mark in registered:
        if not any(mark.intersects(other) for other in cross.geometry):
            cross.add(mark,WHITE)
            junctions.add(mark.buffer(.5))
    if road_survey:
        for kind,ink,ring in road_survey['marks']:
            mark=Polygon(xy(ring)).buffer(0)
            if kind=='line':
                paint.add(mark,YELLOW if ink==2 else WHITE)
            elif ink==1 and not any(mark.distance(other)<.35 for other in cross.geometry):
                cross.add(mark,WHITE)
                junctions.add(mark.buffer(.40))
    for line,amber in measured_lanes:
        paint.add(line.buffer(.061 if amber else .069,cap_style='flat',join_style='round'),YELLOW if amber else WHITE)
    parking=Features()
    arrow_registry=json.loads((region.OUT.parents[1]/'build/survey_traffic_arrows.json').read_bytes())
    for flat,amber,lot in arrow_registry:
        arrow=Polygon(xy(flat)).buffer(0)
        if lot:parking.add(arrow,YELLOW if amber else WHITE)
        elif not amber and not any(arrow.distance(other)<.22 for other in cross.geometry):
            cross.add(arrow,WHITE)
            junctions.add(arrow.buffer(.40))
    stalls={p[1] for tile in region_detail['tiles'].values() for p in tile.get('a',[]) if p[0]=='parking_space'}
    geo_nodes={e['id']:geo.to_grid(e['lat'],e['lon']) for e in elements if e['type']=='node'}
    for item in elements:
        if item['type']=='way' and item['id'] in stalls and all(i in geo_nodes for i in item['nodes']):
            outline=LineString([geo_nodes[i] for i in item['nodes']])
            from parking_bays import measured_edge
            for a,b in zip(outline.coords,list(outline.coords)[1:]):
                if measured_edge(a,b):
                    parking.add(LineString([a,b]).buffer(.060,cap_style='flat'),WHITE)
    dividers=json.loads(region.OUT.parents[1].joinpath('build/survey_parking.json').read_bytes())
    for key,color in [('lines',WHITE),('amber',YELLOW)]:
        for ax,az,bx,bz in dividers.get(key,[]):
            parking.add(LineString([(ax,az),(bx,bz)]).buffer(.054,cap_style='flat'),color)
    registry=json.loads(region.OUT.parents[1].joinpath('build/survey_parking_rows.json').read_bytes())
    accessible_parking(parking,registry['accessible'])
    bays=json.loads((region.OUT.parents[1]/'build/survey_bays.json').read_bytes())
    observed_lots=json.loads((region.OUT.parents[1]/'build/survey_lot_markings.json').read_bytes())
    for shell,*holes in observed_lots['hatching']:
        parking.add(Polygon(shell,holes).buffer(0),YELLOW)
    registered=[p for row in registry['accessible'] for p in row['centers']]
    accessible_parking(parking,[dict(centers=[p['center']],heading=p['heading'],width=p['width']) for p in observed_lots['accessible'] if not any(math.dist(q,p['center'])<.9 for q in registered)])
    observed_ranks=json.loads((region.OUT.parents[1]/'build/survey_parking_ink.json').read_bytes())
    seasonal=json.loads((region.OUT.parents[1]/'build/survey_parking_archive.json').read_bytes())
    grids=json.loads((region.OUT.parents[1]/'build/survey_parking_grids.json').read_bytes())
    for coords,amber,proof,year in grids:
        parking.add(LineString(xy(coords)).buffer(.054,cap_style='flat'),YELLOW if amber else WHITE)
    aisles=json.loads((region.OUT.parents[1]/'build/survey_aisle_paint.json').read_bytes())
    prior=shapely.STRtree(parking.geometry)
    registered.extend(p['center'] for p in observed_lots['accessible'])
    for group in aisles:
        for coords,amber,strength,peers,row in group['lines']:
            line=LineString(xy(coords))
            if group['kerbside']:
                paint.add(line.buffer(.054,cap_style='flat'),YELLOW if amber else WHITE)
                continue
            overlap=prior.query(line,predicate='dwithin',distance=.24)
            stripe=line.buffer(.054,cap_style='flat')
            if len(overlap):stripe=stripe.difference(shapely.union_all(prior.geometries[overlap]).buffer(.02))
            parking.add(stripe,YELLOW if amber else WHITE)
        accessible_parking(parking,[p for p in group['accessible'] if all(math.dist(q,p['centers'][0])>1.0 for q in registered)])
    continuations=json.loads((region.OUT.parents[1]/'build/survey_retained_parking.json').read_bytes())
    for flat,amber,_ in [*seasonal['dividers'],*continuations]:
        parking.add(LineString(xy(flat)).buffer(.054,cap_style='flat'),YELLOW if amber else WHITE)
    for flat,amber in [*observed_lots['dividers'],*observed_ranks]:
        parking.add(LineString(xy(flat)).buffer(.054,cap_style='flat'),YELLOW if amber else WHITE)
    for flat,amber,_ in bays['rows']:
        parking.add(LineString(xy(flat)).buffer(.058,cap_style='flat'),YELLOW if amber else WHITE)
    for ax,az,bx,bz,amber in [*pavement['hatches'],*[[*flat,ink] for flat,ink in bays['borders']]]:
        stripe=LineString([(ax,az),(bx,bz)]).buffer(.058,cap_style='flat')
        ink=YELLOW if amber else WHITE
        parking.add(stripe,ink)
        if not any(stripe.distance(other)<.3 for other in cross.geometry):
            from road_hatch_pigment import street_ink
            dye=street_ink(LineString([(ax,az),(bx,bz)]))
            if dye is not None:paint.add(stripe,YELLOW if dye else WHITE)
    observations=json.loads((region.OUT.parents[1]/'build/parking_paint_observations.json').read_bytes())
    for points in observations['lines']:
        parking.add(LineString(points).buffer(.055,cap_style='flat'),YELLOW)
    survey=json.loads(region.OUT.parents[1].joinpath('build/survey_ground.json').read_bytes())
    from kerb_islands import observed as islands
    for poly,kind in islands():
        overhead.add(poly.buffer(.32,quad_segs=3))
    for island in survey['islands']:
        overhead.add(Polygon(island))
    for patch in survey['patches']:
        shell,*holes=patch['rings']
        outline=Polygon(shell,holes)
        if patch['class']==3:
            slabs.add(outline,WALK)
        for row in [*patch.get('stallRows',[]),*([patch['joints']] if 'joints' in patch else [])]:
            a,b=np.asarray(row['start']),np.asarray(row['end'])
            axis=(b-a)/np.linalg.norm(b-a)
            normal=np.array([axis[1],-axis[0]])
            joint='rows' in row
            count=row['rows'] if joint else row['bays']
            for center in np.linspace(a,b,count+1):
                ends=(center-14*normal,center+14*normal) if joint else (center,center+normal*row['width']*row['side'])
                strip=LineString(ends).buffer(.045 if joint else .052,cap_style='flat').intersection(outline)
                if joint:slabs.add(strip,JOINT)
                else:parking.add(strip,WHITE)
    for line in network['ways']:
        if line['bridge']:
            center=LineString([(x,z) for x,_,z in line['points']])
            overhead.add(center.buffer(line['width']/2,cap_style='flat',quad_segs=3))
    outer=json.loads(region.OUT.read_bytes())
    for i,(shell,holes,*_) in enumerate(outer['blocks']):
        base=network.get('buildingBases',{}).get(str(i))
        for floor in base['floors'] if base else [[shell,*holes]]:
            overhead.add(Polygon(xy(floor[0]),[xy(hole) for hole in floor[1:]]))
    for rings in [*network['coreBuildings'],*network['water']]:
        shell,*holes=rings
        overhead.add(Polygon(xy(shell),[xy(hole) for hole in holes]))
    layers=walk,slabs,paint,cross,junctions,overhead,parking
    for layer in layers:
        layer.seal()
    return layers


def patches(xs,zs):
    for j in range(0,len(zs)-1,24):
        for i in range(0,len(xs)-1,24):
            yield f'{i},{j}',(xs[i],zs[j],xs[min(i+24,len(xs)-1)],zs[min(j+24,len(zs)-1)])


def coverage(meta):
    return Image.frombytes('L',(meta['width'],meta['height']),zlib.decompress(base64.b64decode(meta['samples'])))


def sample_road(image,frame,bounds,size):
    x,z,u,v=frame
    left,top,right,bottom=bounds
    sx=image.width/(right-left)
    sz=image.height/(bottom-top)
    return np.asarray(image.transform(size,Image.Transform.EXTENT,((x-left)*sx,(z-top)*sz,(u-left)*sx,(v-top)*sz),Image.Resampling.BILINEAR))


def terrain_axis(source,limit,start,end):
    out=[]
    for a,b in zip(source,source[1:]):
        if a<start or b>end:
            continue
        steps=math.ceil((b-a)/(2.01 if 0<=a and b<=limit else 4.01))
        out.extend(a+(b-a)*k/steps for k in range(steps))
    return np.array([*out,end])


def facet_paint(markings,terrain,frame):
    x,z,u,v=frame
    xs=terrain_axis(terrain['xs'],geo.WIDTH,x,u)
    zs=terrain_axis(terrain['zs'],geo.DEPTH,z,v)
    X,Z=np.meshgrid(xs,zs)
    corners=np.stack((X,Z),axis=-1)
    nw,ne,sw,se=corners[:-1,:-1],corners[:-1,1:],corners[1:,:-1],corners[1:,1:]
    upper=np.stack([nw,sw,ne,nw],axis=2).reshape(-1,4,2)
    lower=np.stack([ne,sw,se,ne],axis=2).reshape(-1,4,2)
    faces=shapely.polygons(np.vstack([upper,lower]))
    result=[]
    for marking in markings:
        if marking.is_empty:
            result.append('')
            continue
        shapely.prepare(marking)
        active=faces[shapely.intersects(marking,faces)]
        clipped=shapely.intersection(active,marking)
        pieces=shapely.get_parts(clipped)
        pieces=pieces[shapely.get_type_id(pieces)==3]
        tris=shapely.get_parts(shapely.constrained_delaunay_triangles(pieces))
        vertices=shapely.get_coordinates(tris).reshape(-1,4,2)[:,:3]
        packed=np.rint((vertices-[x,z])*128).astype('<u2')
        result.append(base64.b64encode(packed.tobytes()).decode())
    return result


def compile_tiles(terrain,network,carriageway):
    municipal,detail,core=[json.loads(region.OUT.with_name(name+'.json').read_bytes()) for name in ('municipal-detail','region-detail','street-detail')]
    road=coverage(carriageway)
    walk,slabs,lanes,cross,junctions,overhead,parking=source_layers(network,municipal,detail,core,road)
    street,curbs=city_streets.mapped_network(network)
    surveyed_street=shapely.union_all([Polygon(xy(outer),[xy(h) for h in holes]) for outer,*holes in street])
    allowed=surveyed_street.buffer(-.5)
    west,north,east,south=terrain['bounds']
    cells=np.asarray(road)>=184
    pixels_to_world=Affine.translation(west,north)*Affine.scale((east-west)/road.width,(south-north)/road.height)
    paved=shapely.union_all([shape(geometry) for geometry,value in shapes(cells.astype(np.uint8),mask=cells,transform=pixels_to_world)])
    allowed=allowed.intersection(paved.buffer(-.32,quad_segs=2))
    exclusions=shapely.union_all([shapely.make_valid(g) for g in overhead.geometry])
    frontage=json.loads((region.OUT.parents[1]/'build/survey_frontages.json').read_bytes())
    from site_frontages import registered_kerbs as frontage_edges
    registered_kerbs=frontage_edges(frontage['kerbs'])
    kerbs=shapely.union_all([LineString(xy(flat)).buffer(.36,quad_segs=3) for flat,_ in registered_kerbs])
    exclusions=exclusions.union(kerbs)
    allowed=allowed.difference(exclusions)
    no_lines=shapely.union_all(junctions.geometry)
    residential=json.loads((region.OUT.parents[1]/'build/survey_residential_centers.json').read_bytes())
    for _,coordinates,_ in residential:
        lanes.add(LineString(xy(coordinates)).buffer(.069,cap_style='flat',join_style='round'),YELLOW)
    white=shapely.union_all([g for g,i in zip(lanes.geometry,lanes.ink) if i==WHITE]).difference(no_lines)
    amber=shapely.union_all([g for g,i in zip(lanes.geometry,lanes.ink) if i==YELLOW]).difference(no_lines)
    from parcel_surfaces import survey
    lots=survey().paint_lots
    lots_layer=Features()
    for lot in shapely.get_parts(lots):
        lots_layer.add(lot)
    lots_layer.seal()
    lot_paint=shapely.union_all(parking.geometry).intersection(lots.buffer(-.035)).difference(exclusions).difference(surveyed_street.buffer(.8))
    if not lot_paint.is_empty:
        cover=json.loads(region.OUT.with_name('ground-materials.json').read_bytes())['landcover']
        width,height=cover['width'],cover['height']
        l,t,r,b=cover['bounds']
        paint_grid=Affine.translation(l,t)*Affine.scale((r-l)/width,(b-t)/height)
        opacity=np.frombuffer(zlib.decompress(base64.b64decode(cover['transitions'])),dtype=np.uint8).reshape(height,width,4)[:,:,3]
        occupied=geometry_mask([lot_paint.buffer(2)],out_shape=(height,width),transform=paint_grid,invert=True)
        material=survey().sample(cover['bounds'],(width,height))
        safe=(opacity>190)&occupied&(material!=3)
        interior=shapely.union_all([shape(g) for g,value in shapes(safe.astype(np.uint8),mask=safe,transform=paint_grid)])
        lot_paint=lot_paint.intersection(interior.buffer(-.34,quad_segs=2))
    white=white.union(shapely.union_all(cross.geometry)).intersection(allowed)
    from ladder_crossings import registered
    registered_stripes=shapely.union_all([Polygon(xy(ring)) for group in registered() for ring in group['bars']+group['rails']])
    crossing_floor=surveyed_street.buffer(-.24).intersection(paved).difference(exclusions)
    white=white.union(registered_stripes.intersection(crossing_floor))
    amber=amber.intersection(allowed)
    conflicts=white.intersection(amber)
    if not conflicts.is_empty:
        clearance=conflicts.buffer(2.5)
        white=white.difference(clearance)
        amber=amber.difference(clearance)
    from painted_gores import markings as gore_markings
    channel,_=gore_markings()
    observed_amber=shapely.union_all([line.buffer(.061,cap_style='flat',join_style='round') for line,_ in channel]).intersection(allowed).difference(no_lines)
    white=white.difference(observed_amber.buffer(.025))
    amber=amber.union(observed_amber)
    yellow_stalls=shapely.union_all([g for g,ink in zip(parking.geometry,parking.ink) if ink==YELLOW]).intersection(lot_paint)
    accessible=shapely.union_all([g for g,ink in zip(parking.geometry,parking.ink) if ink==BLUE]).intersection(lot_paint)
    yellow_stalls=yellow_stalls.difference(accessible)
    white_stalls=shapely.union_all([g for g,ink in zip(parking.geometry,parking.ink) if ink==WHITE]).intersection(lot_paint)
    white_stalls=white_stalls.difference(yellow_stalls.buffer(.16,quad_segs=2)).difference(accessible)
    global_paint=[white,amber,white_stalls,yellow_stalls,accessible]
    trees=[STRtree(list(shapely.get_parts(p))) for p in global_paint]
    seams=Features()
    for coords,contrast in json.loads((region.OUT.parents[1]/'build/survey_seams.json').read_bytes()):
        points=xy(coords)
        axis=points[1]-points[0]
        length=np.linalg.norm(axis)
        normal=np.array([-axis[1],axis[0]])/length
        d=np.linspace(0,1,max(3,round(length/.29)))
        guide=points[0]+d[:,None]*axis
        from ortho_road_paint import pigment
        probes=guide[:,None,:]+np.linspace(-.17,.17,5)[None,:,None]*normal
        colors=pigment(probes.reshape(-1,2)).reshape(len(guide),5,3)
        gray=(colors*[.28,.54,.18]).sum(axis=2)
        drift=ndimage.median_filter(np.linspace(-.17,.17,5)[gray.argmin(axis=1)],size=3)
        center=guide+drift[:,None]*normal
        width=(.046+.00085*contrast)*np.minimum(1,np.minimum(d,1-d)*length/.26)
        profile=Polygon(np.vstack([center+width[:,None]*normal,(center-width[:,None]*normal)[::-1]])).buffer(0)
        seams.add(profile,int(np.clip(contrast*7,35,205)))
    seams.seal()
    tiles={}
    precision={}
    for key,frame in patches(terrain['xs'],terrain['zs']):
        x,z,u,v=frame
        patch=box(*frame)
        local=[shapely.union_all(tree.geometries[tree.query(patch)]).intersection(patch) for tree in trees]
        size=(max(1,round((u-x)*DENSITY)),max(1,round((v-z)*DENSITY)))
        high=tuple(n*SCALE for n in size)
        pavement=sample_road(road,frame,terrain['bounds'],high)
        foot=walk.draw(frame,high)
        slab=slabs.draw(frame,high)
        labels=np.where(slab>0,slab,foot)
        if ground_observations.parcel().intersects(patch):
            feet=Image.fromarray(labels).resize(size,Image.Resampling.NEAREST)
            surveyed=Image.fromarray(slab).resize(size,Image.Resampling.NEAREST)
            street=sample_road(road,frame,terrain['bounds'],size)
            refined=ground_observations.rectify_walks(frame,size,np.array(feet),np.asarray(surveyed),street,
                lots_layer.draw(frame,size)>0,overhead.draw(frame,size)>0)
            change=Image.fromarray(np.where(refined!=np.asarray(feet),refined+1,0).astype('uint8')).resize(high,Image.Resampling.NEAREST)
            changed=np.asarray(change)
            labels=np.where(changed>0,changed-1,labels)
        labels[pavement>64]=0
        markings=lanes.draw(frame,high).copy()
        markings[junctions.draw(frame,high)>0]=0
        crosswalk=cross.draw(frame,high)
        markings=np.where(crosswalk>0,crosswalk,markings)
        visible=(markings>0)&(pavement>=184)
        labels[visible]=markings[visible]
        labels[overhead.draw(frame,high)>0]=0
        channels=[Image.fromarray(COLORS[:,i][labels]).resize(size,Image.Resampling.BOX) for i in range(4)]
        seal=np.where((labels==0)&(pavement>196),seams.draw(frame,high),0).astype('uint8')
        if seal.any():
            alpha=np.asarray(channels[3]).astype('int16')-np.asarray(Image.fromarray(seal).resize(size,Image.Resampling.BOX))
            channels[3]=Image.fromarray(alpha.clip(0,255).astype('uint8'))
        pedestrians=np.asarray(channels[2])>=96
        stall_marks=shapely.union_all(local[2:])
        if pedestrians.any() and not stall_marks.is_empty:
            grid=Affine.translation(x,z)*Affine.scale((u-x)/size[0],(v-z)/size[1])
            nearby=geometry_mask([stall_marks.buffer(.65)],out_shape=pedestrians.shape,transform=grid,invert=True)
            sidewalk=pedestrians&nearby
            if sidewalk.any():
                footprint=shapely.union_all([shape(geom) for geom,_ in shapes(sidewalk.astype('uint8'),mask=sidewalk,transform=grid)])
                edge=footprint.buffer(.20,quad_segs=2)
                local[2:]=[mark.difference(edge) for mark in local[2:]]
        precision[key]=facet_paint(local,terrain,frame)
        out=io.BytesIO()
        Image.merge('RGBA',channels).save(out,format='PNG',compress_level=6)
        tiles[key]=base64.b64encode(out.getvalue()).decode()
    observed=json.loads((region.OUT.parents[1]/'build/survey_pavement.json').read_bytes())
    from kerb_islands import runtime as kerbed_islands
    from walkway_outlines import outline_pack
    return dict(finishes=tiles,strokes=precision,walkways=walkway_spans(tiles,terrain),walkwayOutlines=outline_pack(tiles,terrain),
                pavementSurvey=dict(islands=kerbed_islands(),kerbs=registered_kerbs,seams=json.loads((region.OUT.parents[1]/'build/survey_seams.json').read_bytes()),**{k:observed[k] for k in ('ramps','pads','tables','covers')}))


def walkway_spans(tiles,terrain):
    frames=dict(patches(terrain['xs'],terrain['zs']))
    rows=[]
    for key,encoded in tiles.items():
        image=np.asarray(Image.open(io.BytesIO(base64.b64decode(encoded))))[:,:,2]
        row,x=np.nonzero(np.diff(np.pad(image,((0,0),(1,1))),axis=1))
        keep=(x<image.shape[1])&(image[row,x.clip(max=image.shape[1]-1)]>0)
        start=x[keep]
        ends=x[np.flatnonzero(keep)+1]
        run=np.stack([start,ends,image[row[keep],start]],axis=1)
        counts=np.bincount(row[keep],minlength=len(image))*3
        data=np.concatenate([counts,run.ravel()]).astype('<u2')
        rows.append(dict(format=2,bounds=frames[key],width=image.shape[1],height=len(image),samples=base64.b64encode(zlib.compress(data.tobytes(),8)).decode()))
    return rows


def check(data,terrain):
    from walkway_outlines import outline_pack
    assert data.get('walkwayOutlines')==outline_pack(data['finishes'],terrain), 'Rendered sidewalk outlines differ from the current ground survey'
    paint_count=walk_count=compared=0
    campus_pixels=campus_paint=campus_walk=0
    campus=footprint()
    road=coverage(data['carriageway'])
    frames=dict(patches(terrain['xs'],terrain['zs']))
    assert frames.keys()==data['finishes'].keys()
    for key,encoded in data['finishes'].items():
        image=Image.open(io.BytesIO(base64.b64decode(encoded)))
        rgb=np.asarray(image)
        coverage_tile=sample_road(road,frames[key],terrain['bounds'],image.size)
        paint=(rgb[:,:,0].astype('uint16')+rgb[:,:,1])>38
        walk=rgb[:,:,2]>38
        assert not np.any(paint&walk),f'Overlapping paint and sidewalk on {key}'
        assert not np.any(paint&(coverage_tile<127)),f'Paint left the carriageway on {key}'
        assert not np.any(walk&(coverage_tile>127)),f'Sidewalk crosses carriageway on {key}'
        paint_count+=np.count_nonzero(paint)
        walk_count+=np.count_nonzero(walk)
        compared+=paint.size
        if campus.intersects(box(*frames[key])):
            x,z,u,v=frames[key]
            transform=Affine.translation(x,z)*Affine.scale((u-x)/image.width,(v-z)/image.height)
            inside=geometry_mask([campus],out_shape=paint.shape,transform=transform,invert=True)
            campus_pixels+=np.count_nonzero(inside)
            campus_paint+=np.count_nonzero(paint&inside)
            campus_walk+=np.count_nonzero(walk&inside)
    network=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    floors=city_streets.solid_ground_floors(network)
    left,top,right,bottom=terrain['bounds']
    transform=Affine.translation(left,top)*Affine.scale((right-left)/road.width,(bottom-top)/road.height)
    interiors=[p for polygon in floors if not (p:=polygon.buffer(-.80,quad_segs=2)).is_empty]
    solid=geometry_mask(interiors,out_shape=(road.height,road.width),transform=transform,invert=True)
    assert not np.any(solid&(np.asarray(road)>=128)), 'Street interior crosses a solid ground-floor footprint'
    assert paint_count>80000 and walk_count>800000
    estates=json.loads(region.OUT.with_name('ground-materials.json').read_bytes())['estates']
    cells=np.frombuffer(zlib.decompress(base64.b64decode(estates['samples'])),np.uint8)
    assert cells.size==estates['width']*estates['height'] and set(cells)<={0,2,5,12,13,255}
    left,top,right,bottom=estates['bounds']
    x=left+(np.arange(estates['width'])+.5)*(right-left)/estates['width']
    west,_,east,_=terrain['bounds']
    north=np.asarray(road)[-1,np.clip(((x-west)*road.width/(east-west)).astype(int),0,road.width-1)]>=128
    edge=cells[:estates['width']]
    assert np.array_equal((edge==12)[edge!=255],north[edge!=255]), 'A southern driveway is spliced at the survey seam'
    estate_coverage=np.count_nonzero(cells!=255)
    campus_pixels+=estate_coverage
    campus_walk+=np.count_nonzero(cells==13)
    assert abs(campus_pixels/16-campus.area)<campus.area*.002
    print(f'{campus_pixels:,} finish texels on Western campus, including {campus_paint:,} lane-marking and {campus_walk:,} walkway texels with zero overlapping ownership.')
    print(f'{compared:,} ground finish pixels, {paint_count:,} road paint pixels and {walk_count:,} walkway pixels checked across {len(frames)} tiles.')


if __name__=='__main__':
    import sys
    path=region.OUT.with_name('surface-tiles.json')
    terrain=json.loads(region.OUT.read_bytes())
    data=json.loads(path.read_bytes())
    if '--refresh' in sys.argv:
        data.update(compile_tiles(terrain,json.loads(region.OUT.with_name('drive-network.json').read_bytes()),data['carriageway']))
        tmp=path.with_suffix('.pending')
        tmp.write_text(json.dumps(data,separators=(',',':')))
        tmp.replace(path)
        from street_projection import reproject
        reproject()
    check(data,terrain)
