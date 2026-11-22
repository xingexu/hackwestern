from backdrop_join import join
import base64
import io
import json
import zlib

import numpy as np
from PIL import Image
import shapely
from scipy.spatial import cKDTree

import campus_region as region
from campus_bounds import footprint
from street_projection import Survey
from parking_stripes import OUT as stripes,lot_mask


def load(name):
    return json.loads(region.OUT.with_name(name+'.json').read_bytes())


def decode(data,dtype):
    return np.frombuffer(zlib.decompress(base64.b64decode(data)),dtype=dtype)


land=load('ground-materials')['landcover']
data=load('surface-tiles')
survey=Survey()
points=np.array([(166,272.5),(174.5,273),(176,273.5),(361,367.5),(359.5,380),(340,260)])
assert (survey.classes(*points.T)==2).all()
left,top,right,bottom=land['bounds']
def land_at(x,z):
    u=int((x-left)/(right-left)*land['width'])
    v=int((z-top)/(bottom-top)*land['height'])
    return classes[v,u]
classes=decode(land['samples'],'uint8').reshape(land['height'],land['width'])
drive_samples=np.array([[-343.5,727.5],[-342,730],[-339.2,732]])
assert (survey.classes(*drive_samples.T)==1).all() and land_at(-325,727.5)<=2
absent=np.array([[-245,660],[-307,720]])
assert not survey.classes(*absent.T).any() and all(land_at(*p)<=2 for p in absent)
assert land_at(232.5,1450)==8 and land_at(12,-58)==5
shaded_verges=np.array([(-230.7,917.5),(-232.5,912.7),(-116,126),(-120,133),(-114,132)])
assert not survey.classes(*shaded_verges.T).any() and all(land_at(*p)<=2 for p in shaded_verges)
from parking_archive import dated_pigment
huron_yard=np.array([[-139.3,122.7]])
assert survey.classes(*huron_yard.T)[0]==0 and land_at(*huron_yard[0])==4
for year in (2020,2021,2024,2025):
    yard=dated_pigment(huron_yard,year).mean()
    grove=dated_pigment(shaded_verges[-3:],year).mean(axis=1)
    assert (yard>grove+26).all(),(year,yard,grove)
forecourts=np.array([(305.9,1322.7),(312.7,135.1),(324.3,121.7),(127.7,159.9)])
assert (survey.classes(*forecourts.T)==2).all() and all(land_at(*p)==3 for p in forecourts)
tone=land['pavingTone']
court_mask=decode(tone['courts'],'uint8').reshape(tone['height'],tone['width'])
for x,z in forecourts:
    column=int((x-left)/(right-left)*tone['width'])
    row=int((z-top)/(bottom-top)*tone['height'])
    assert court_mask[row,column]>127,(x,z)
carriage=data['carriageway']
asphalt=decode(carriage['samples'],'uint8').reshape(carriage['height'],carriage['width'])
for x,z in [(-254,849.5),(-289,863.6)]:
    row=int((z-region.Z0)*carriage['height']/(region.Z1-region.Z0))
    col=int((x-region.X0)*carriage['width']/(region.X1-region.X0))
    assert asphalt[row,col]==0 and land_at(x,z)<=2
sports=land['observations']['sports']
track=shapely.Polygon(sports['track'][0],sports['track'][1:])
surface=shapely.union_all(shapely.polygons(sports['rubber']))
assert track.symmetric_difference(surface).area<.01
assert len(sports['bleachers'])==3 and len(sports['lanes'])>=60
lane=np.array(sports['lanes']).reshape(-1,2,2)
assert np.array_equal(lane[:,1],np.roll(lane[:,0],-1,axis=0))
edges=lane[:,1]-lane[:,0]
length=np.linalg.norm(edges,axis=1)
unit=edges/length[:,None]
assert length.max()<2 and np.min(np.sum(unit*np.roll(unit,1,axis=0),axis=1))>.995
assert shapely.covers(track,shapely.linestrings(lane)).all()
start,end,radius=sports['laneBasis'][:2],sports['laneBasis'][2:4],sports['laneBasis'][4]
axis=np.subtract(end,start)
delta=lane[:,0]-start
t=np.clip(np.sum(delta*axis,axis=1)/np.dot(axis,axis),0,1)
assert np.max(np.abs(np.linalg.norm(delta-t[:,None]*axis,axis=1)-radius-4.88))<.002
assert sports==json.loads(stripes.with_name('survey_sports.json').read_bytes())
practice=sports['practice']
assert len(practice['suppressed'])>=2
practice_surfaces=[shapely.union_all(shapely.polygons(np.asarray(p['triangles']))) for p in practice['surfaces']]
assert any(800<p.area<2700 and p.covers(shapely.Point(277,1372)) for p in practice_surfaces)
runways=[p for p in practice_surfaces if 45<p.area<110 and p.minimum_rotated_rectangle.length>85]
assert len(runways)==2 and 4<runways[0].distance(runways[1])<10
assert land_at(-245,1245)==5 and land_at(-325,1115)<=2
assert all(land_at(x,z)==5 for x,z in [(-528.5,913.5),(-208.5,71.5),(416.5,-412.5),(375.5,-460),(384.6,-464),(375.4,-457.2),(385,-458.8),(-482.5,885.5)])
from kerb_islands import observed as kerbed_islands
median=shapely.Point(380.5,-459.5)
assert land_at(median.x,median.y)==1 and survey.classes(np.array([median.x]),np.array([median.y]))[0]==0
assert any(g.contains(median) and 32<g.area<42 and material==1 for g,material in kerbed_islands())
shed=shapely.Point(-173.41,763.92)
hedges=[shapely.LineString(np.reshape(line,(-1,2))) for t in load('municipal-detail')['tiles'].values() for line,height in t.get('hedge',[])]
assert min(shed.distance(line) for line in hedges)>2
trees=np.asarray(land['observations']['trees'])
grove=trees[(trees[:,0]>=-351)&(trees[:,0]<=-318)&(trees[:,1]>=1100)&(trees[:,1]<1127)]
assert len(grove)>=10 and (grove[:,2]>=2.5).all() and (grove[:,3]<grove[:,2]).all()
woods=trees[(trees[:,0]>=-250)&(trees[:,0]<-200)&(trees[:,1]>=250)&(trees[:,1]<300)]
assert len(woods)>=12
ht=region.sample(region.lidar('dsm')-region.lidar('dtm'),woods[:,0],woods[:,1])
assert np.median(ht)>7
assert cKDTree(land['observations']['lamps']).query([395,382])[0]<.2
parking=json.loads(stripes.read_bytes())
lines=parking['lines']+parking['amber']
centers=np.asarray(parking['amber']).reshape(-1,2,2).mean(axis=1)
for west,north in [(-350,550),(350,-500),(-550,900)]:
    assert np.count_nonzero((centers[:,0]>=west)&(centers[:,0]<west+50)&(centers[:,1]>=north)&(centers[:,1]<north+50))>=8
lots=lot_mask().buffer(.008)
assert len(lines)>250 and all(lots.covers(shapely.LineString(np.reshape(s,(2,2)))) for s in lines)
network=load('drive-network')
before_aprons={**network,'areas':[a for a in network['areas'] if not str(a['id']).startswith('city-painted-parking-')]}
assert lot_mask(network=before_aprons).difference(lots).area<.001

winter_lawns=np.array([(-309,869),(-311,882),(-323,865),(15,615),(18,620)])
assert all(land_at(x,z)<=2 for x,z in winter_lawns)
assert not survey.classes(*winter_lawns.T).any()
assert all(land_at(x,z)==5 for x,z in [(125,-209),(130,-203),(64,1164)])
assert len(parking['surveyedLots'])>85 and len(parking['amber'])>800 and len(parking['lines'])>1000
registration=json.loads(stripes.with_name('survey_road_paint.json').read_bytes())
assert len(registration['controls'])>=100 and any(not row for row in registration['controls'].values())
assert all(len(row)==3 and max(abs(row[0]),abs(row[1]))<=4.5 and abs(row[2])<=30 for row in registration['controls'].values() if row)
assert sum(len(lines)>1 for lines in registration['centers'].values())>=2
crosswalks=registration['crosswalks']
assert len(crosswalks)>24 and sum(len(group) for group in crosswalks.values())>285
for oid in ('14143212743','14143212744'):
    bars=np.asarray(crosswalks[oid]).reshape(-1,4,2)
    mid=bars.mean(axis=1)
    assert len(bars)>=7 and (survey.classes(*mid.T)==1).all()
    assert all(shapely.Polygon(row).is_valid for row in bars)
from ortho_road_paint import pigment
verge_start=np.array([212.5,1141.745])
verge_end=np.array([217.5,1144.52])
edge=np.linspace(verge_start,verge_end,21)
axis=verge_end-verge_start
normal=np.array([axis[1],-axis[0]])/np.linalg.norm(axis)
lawn=edge+normal*.78
apron=edge-normal*.78
assert np.median(pigment(apron)-pigment(lawn),axis=0).min()>30
assert all(land_at(*p)<=2 for p in lawn) and not survey.classes(*lawn.T).any()
assert all(land_at(*p)==5 for p in apron)
centers=[shapely.LineString(np.reshape(r,(-1,2))) for group in registration['centers'].values() for r in group]
points=[]
sides=[]
for center in centers:
    for station in np.arange(1,center.length-1,1.5):
        location=np.array(center.interpolate(station).coords[0])
        direction=np.array(center.interpolate(station+.4).coords[0])-center.interpolate(station-.4).coords[0]
        normal=np.array([direction[1],-direction[0]])/np.linalg.norm(direction)
        points.append(location)
        sides.extend([location-.6*normal,location+.6*normal])
center_colors=pigment(np.array(points))
side_colors=pigment(np.array(sides)).reshape(-1,2,3).mean(axis=1)
difference=center_colors-side_colors
pigment_gain=.73*difference[:,0]+.51*difference[:,1]-.42*difference[:,2]
assert np.median(pigment_gain)>4 and (pigment_gain>10).sum()>400
walk_pixels=0
for tile,encoded in zip(data['walkways'],data['finishes'].values(),strict=True):
    width,height=tile['width'],tile['height']
    reference=np.asarray(Image.open(io.BytesIO(base64.b64decode(encoded))))[:,:,2]
    assert reference.shape==(height,width) and tile['format']==2
    sparse=decode(tile['samples'],'<u2')
    runs=sparse[height:].reshape(-1,3)
    row=np.repeat(np.arange(height),sparse[:height]//3)
    jumps=np.zeros((height,width+1),np.int16)
    np.add.at(jumps,(row,runs[:,0]),runs[:,2].astype('int16'))
    np.add.at(jumps,(row,runs[:,1]),-runs[:,2].astype('int16'))
    assert np.array_equal(reference,jumps.cumsum(1)[:,:-1])
    walk_pixels+=reference.size
outer=land['context']
verts=decode(outer['vertices'],'<f4').reshape(-1,4)
faces=verts[decode(outer['indices'],'<u4').reshape(-1,3)]
geoms=shapely.polygons(faces[:,:,[0,2]])
site=footprint()
centers=faces.mean(axis=1)
assert not shapely.contains_xy(site,centers[:,0],centers[:,2]).any()
assert abs(shapely.area(geoms).sum()-site.buffer(275,quad_segs=4).difference(site).area)<1
shade=decode(outer['cover'],'uint8')
assert {0,1,2,3,4}==set(np.unique(shade))
cw,ch=outer['size']
west,north,east,south=outer['bounds']
coverage=decode(outer['coverage'],'uint8').reshape(ch,cw,4)
assert all(np.any((channel>0)&(channel<255)) for channel in coverage.transpose(2,0,1))
cx=np.floor((np.array([460,520])-west)*cw/(east-west)).astype(int)
cz=np.floor((np.array([-500,-440])-north)*ch/(south-north)).astype(int)
richmond_walk=coverage[cz[0]:cz[1],cx[0]:cx[1],2]
assert np.unique(richmond_walk).size==17 and ((richmond_walk>0)&(richmond_walk<255)).sum()>180
assert set(np.unique(decode(land['pavingTone']['samples'],'uint8'))) <= set(range(0,239,34))|{255}
print(f'{walk_pixels:,} antialiased walk texels reproduced exactly. Verified {len(lines)} surveyed stall dividers and hatch stripes, {len(grove)} Sarnia grove stems, photographed forecourts and {len(faces):,} exterior terrain triangles.')

assert join(land['context'])==land['context']['backdrop']
print('The surrounding landscape shares its inner rim heights with the surveyed parcel belt and uses each exterior tree once.')

obstruction=shapely.Polygon([(239.60,1338.84),(241.58,1338.72),(241.55,1339.20),(239.65,1339.25)])
assert track.covers(obstruction) and surface.covers(obstruction)
western_kerb=shapely.LineString([(2.65,1726.6),(3.35,1728.6)])
kerbs=[shapely.LineString(np.reshape(flat,(-1,2))) for flat,side in data['pavementSurvey']['kerbs']]
assert western_kerb.difference(shapely.union_all(kerbs).buffer(.19)).length==0
observed_ink=json.loads((region.OUT.parents[1]/'build/parking_paint_observations.json').read_bytes())['lines']
assert all(shapely.LineString(row).distance(western_kerb)>1 for row in observed_ink)
for a,b in [([17.2,1719.45],[18.3,1722.15]),([20.05,1718.8],[20.95,1721.2])]:
    assert all(land_at(*p)==5 for p in np.linspace(a,b,9)[1:-1])
assert land_at(39.5,1713)<=2 and land_at(32.3,1731.1)<=2 and land_at(12.3,1720.3)==3
print('The western parking bay ends at its municipal kerb, both dividers sit on pavement and the stadium bend has continuous rubber.')
