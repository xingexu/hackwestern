import json
import math
from functools import lru_cache

import cv2
import numpy as np
import shapely
from affine import Affine
from PIL import Image
from rasterio.features import rasterize
from shapely.geometry import LineString,Polygon,box,shape

import campus_region as region
import city_streets
import geo
from campus_bounds import footprint


CONFIRMED_CONCRETE=14


def municipal_lines(kind,site):
    features=json.loads((region.CACHE/'municipal'/f'{kind}.geojson').read_bytes())
    geometries=[shapely.transform(shape(f['geometry']),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False) for f in features]
    return [g for g in geometries if site.intersects(g)]


def close_kerb_returns(outlines):
    lines=[g for group in outlines for g in shapely.get_parts(group) if g.geom_type in ('LineString','LinearRing')]
    index=shapely.STRtree(lines)
    links=[]
    for i,line in enumerate(lines):
        if line.is_closed or line.length<1:continue
        for start,inner in [(0,.7),(line.length,max(0,line.length-.7))]:
            tip=line.interpolate(start)
            axis=np.array(tip.coords[0])-line.interpolate(inner).coords[0]
            axis/=max(.01,np.linalg.norm(axis))
            candidates=[]
            joined=False
            for j in index.query(tip,predicate='dwithin',distance=1.25):
                if j==i:continue
                edge=shapely.shortest_line(tip,lines[j])
                if edge.length<.08:
                    joined=True
                    break
                direction=(np.array(edge.coords[-1])-edge.coords[0])/edge.length
                if direction@axis>.83:candidates.append(edge)
            if candidates and not joined:links.append(min(candidates,key=lambda g:g.length))
    return links


def cartography(network,site):
    parking=[Polygon(np.reshape(a['rings'][0],(-1,2)),[np.reshape(h,(-1,2)) for h in a['rings'][1:]]).buffer(0) for a in network['areas'] if a['kind']=='parking']
    floors=city_streets.solid_ground_floors(network)
    borders={k:municipal_lines(k,site) for k in ['sidewalk','parking','driveway']}
    outlines=[g.boundary for g in [*parking,*floors] if site.intersects(g)]
    outlines.extend(g for lines in borders.values() for g in lines)
    outlines.extend(Polygon(np.reshape(p,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]).boundary for p,*holes in city_streets.survey())
    outlines.extend(close_kerb_returns(outlines))
    lines=shapely.get_parts(shapely.union_all(outlines,grid_size=.08))
    faces=[p for p in shapely.get_parts(shapely.polygonize(lines)) if 1<p.area<62000 and site.intersects(p)]
    ways={k:[] for k in ['road','walk']}
    for way in network['ways']:
        if way.get('bridge') or way.get('level'):continue
        line=LineString([(x,z) for x,y,z in way['points']])
        if site.intersects(line):
            ways['road' if way['kind']=='road' else 'walk'].append(line.buffer(max(1,way['width']/2),cap_style='flat'))
    survey=json.loads((region.OUT.parents[1]/'build/survey_ground.json').read_bytes())
    fixed=[Polygon(p['rings'][0],p['rings'][1:]) for p in survey['patches']]
    fixed.extend(Polygon(p) for p in survey['islands'])
    fixed.extend(Polygon(np.reshape(r[0],(-1,2)),[np.reshape(h,(-1,2)) for h in r[1:]]) for r in network['water'])
    sports=json.loads((region.OUT.parents[1]/'build/survey_sports.json').read_bytes())
    fixed.extend([Polygon(sports['track'][0]).buffer(.5),*[Polygon(r) for r in sports['synthetic']]])
    for a in network['areas']:
        if a['kind']=='pitch':
            fixed.append(Polygon(np.reshape(a['rings'][0],(-1,2))))
    return {k:shapely.STRtree(v) for k,v in dict(fixed=fixed,faces=faces,floors=floors,lot=parking,side=borders['sidewalk'],rim=borders['parking'],access=borders['driveway'],**ways).items()}


def sampled(tree,bounds,transform,size,ids=False):
    indices=tree.query(box(*bounds),predicate='intersects')
    if not len(indices):return np.zeros(size,np.int32 if ids else np.uint8)
    return rasterize([(tree.geometries[i],int(i)+1 if ids else 1) for i in indices],out_shape=size,transform=transform,dtype='int32' if ids else 'uint8')


def distance(mask):
    return cv2.distanceTransform(np.uint8(mask==0),cv2.DIST_L2,5)*.25


def smooth(mask,radius,operation):
    k=2*radius+1
    return cv2.morphologyEx(np.uint8(mask),operation,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(k,k)))>0


@lru_cache(maxsize=12)
def photograph(x,z):
    from ground_observations import parcel,survey_tile_path
    if not parcel().intersects(box(x,z,x+150,z+150)):return None
    p=survey_tile_path(x,z)
    with Image.open(p) as im:return np.asarray(im.convert('RGB').resize((600,600),Image.Resampling.BOX))


def block_rgb(x,z,halo):
    image=np.zeros((600+2*halo,600+2*halo,3),np.uint8)
    for j in [-1,0,1]:
        for i in [-1,0,1]:
            tile=photograph(x+150*i,z+150*j)
            if tile is None:continue
            u,v=halo+600*i,halo+600*j
            l,t,r,b=max(0,u),max(0,v),min(image.shape[1],u+600),min(image.shape[0],v+600)
            image[t:b,l:r]=tile[t-v:b-v,l-u:r-u]
    return image


def surveyed_verges(layers,bounds,photo,labels,unbounded):
    left,top,right,bottom=bounds
    window=box(*bounds)
    strips=[]
    materials=[]
    for key,material in [('side',3),('rim',5),('access',5)]:
        tree=layers[key]
        for path in tree.geometries[tree.query(window)]:
            for line in shapely.get_parts(path.intersection(window)):
                if line.geom_type!='LineString' or line.length<2:continue
                stations=np.linspace(0,line.length,math.ceil(line.length/.8)+1)
                points=shapely.get_coordinates(shapely.line_interpolate_point(line,stations))
                axis=np.diff(points,axis=0)
                normals=np.column_stack([-axis[:,1],axis[:,0]])/np.maximum(.01,np.linalg.norm(axis,axis=1))[:,None]
                mid=(points[:-1]+points[1:])*.5
                offsets=np.array([-.65,-1.15,-1.75,.65,1.15,1.75])
                xy=np.floor((mid[:,None,:]+normals[:,None,:]*offsets[None,:,None]-[left,top])*4).astype(int)
                colors=photo[xy[:,:,1].clip(0,photo.shape[0]-1),xy[:,:,0].clip(0,photo.shape[1]-1)]
                rgb=np.median(colors.reshape(-1,2,3,3),axis=2)
                red,green,blue=rgb.transpose(2,0,1)
                lum=(red+2*green+blue)*.25
                olive=(red-blue>3+lum*.16)&(green-blue>2+lum*.095)
                planting=(olive|(green>red+5)&(green>blue+10))&(lum>37)
                solid=(red-blue<7+lum*.12)&(green-blue<6+lum*.10)&(np.abs(red-green)<15)&(lum>60)
                for side in (0,1):
                    other=1-side
                    agree=planting[:,side]&solid[:,other]&((lum[:,other]-lum[:,side]>18)|((green-red)[:,side]-(green-red)[:,other]>10))
                    supported=np.convolve(np.pad(agree.astype(int),(1,1),mode='edge'),np.ones(3,int),mode='valid')>=2
                    direction=normals*(2*side-1)
                    for k in np.flatnonzero(supported):
                        a,b=points[k:k+2]
                        for kind,depth in [(1,2.0),(material,-1.55)]:
                            strips.append([a,b,b+depth*direction[k],a+depth*direction[k]])
                            materials.append(kind)
    if strips:
        transform=Affine.translation(left,top)*Affine.scale(.25)
        surfaces=rasterize(zip(shapely.polygons(np.asarray(strips)),materials),out_shape=labels.shape,transform=transform,dtype='uint8')
        valid=unbounded&(surfaces>0)
        labels[valid]=surfaces[valid]


class Surfaces:
    def __init__(self):
        cv2.setNumThreads(1)
        self.site=footprint()
        self.layers=cartography(json.loads(region.OUT.with_name('drive-network.json').read_bytes()),self.site)
        from parking_stripes import lot_mask
        self.layers['surveyed_parking']=shapely.STRtree(shapely.get_parts(lot_mask()))
        self.faces=self.layers['faces'].geometries
        self.canopy=region.lidar('dsm')-region.lidar('dtm')
        self.bounds=[math.floor(self.site.bounds[0]/150)*150,math.floor(self.site.bounds[1]/150)*150,
                     math.ceil(self.site.bounds[2]/150)*150,math.ceil(self.site.bounds[3]/150)*150]
        l,t,r,b=self.bounds
        self.labels=np.zeros(((b-t)*4,(r-l)*4),np.uint8)
        evidence=np.zeros((len(self.faces)+1,7),np.float64)
        tiles=[(x,z) for x in range(l,r,150) for z in range(t,b,150) if self.site.intersects(box(x,z,x+150,z+150))]
        for x,z in tiles:
            records=self.evidence(x,z,0)
            ids,hard,soft,clear,lot,walk=records[:6]
            light=records[7]
            for col,mask in enumerate([hard&clear,soft&clear,clear,lot,walk,hard&clear&(light>140),hard&clear&(light<117)]):
                evidence[:,col]+=np.bincount(ids[mask],minlength=len(evidence))
        hard,soft,samples,lots,walks,pale,dark=evidence.T
        total=np.maximum(hard+soft,1)
        fraction=hard/total
        areas=np.r_[0,shapely.area(self.faces)]
        widths=2*areas/np.maximum(.1,np.r_[1,shapely.length(self.faces)])
        enough=(total>np.maximum(10,np.minimum(samples*.18,areas*.75)))&(areas>0)
        faces=np.zeros(len(evidence),np.uint8)
        faces[enough&(fraction<.19)]=1
        paved=enough&(fraction>.69)
        faces[paved]=np.where(((widths<3.7)&(lots<areas*4))|((walks>areas*5)&(lots<areas*3)),3,5)[paved]
        concrete=(faces==5)&(lots<areas*.22)&(pale>hard*.51)&(dark<hard*.21)
        self.pedestrian_faces=concrete
        self.face_classes=faces
        for x,z in tiles:
            block=self.classify(x,z)
            i,j=(x-l)*4,(z-t)*4
            self.labels[j:j+600,i:i+600]=block

    def evidence(self,x,z,halo):
        image=block_rgb(x,z,halo)
        rows,cols=image.shape[:2]
        bounds=x-halo*.25,z-halo*.25,x+150+halo*.25,z+150+halo*.25
        transform=Affine.translation(*bounds[:2])*Affine.scale(.25)
        def layer(key):return sampled(self.layers[key],bounds,transform,(rows,cols),key=='faces')
        r,g,b=cv2.medianBlur(image,3).astype(np.float32).transpose(2,0,1)
        lum=(r+2*g+b)*.25
        hard=(g-r<6)&(r-g<16)&(g-b<np.minimum(25,6+.085*lum))&(r-b<8+.125*lum)&(lum>53)
        dormant=(r-g>5+.022*lum)&(g-b>3+.115*lum)&(r-b>4+.20*lum)
        soft=(dormant|(g-r>5)&(g-b>12)|(g-b>9+.14*lum)&(r-b>13+.14*lum)|(r-g>19))&(lum>40)
        u,v=np.meshgrid(bounds[0]+(np.arange(cols)+.5)*.25,bounds[1]+(np.arange(rows)+.5)*.25)
        h=region.sample(self.canopy,u.ravel(),v.ravel()).reshape(g.shape)
        floor=layer('floors')>0
        clear=~floor&(h<2.9)&(lum>40)
        return layer('faces'),hard,soft,clear,layer('lot')>0,layer('walk')>0,floor,lum,layer,g>r+5

    def classify(self,x,z):
        halo=40
        ids,hard,soft,clear,lot,walk,floor,lum,layer,green=self.evidence(x,z,halo)
        faces=self.face_classes[ids]
        registered=layer('surveyed_parking')>0
        confirmed_face=self.pedestrian_faces[ids]&~registered
        faces[confirmed_face]=3
        curb=distance(layer('side'))
        near_lot=(distance(lot)<13)|(distance(layer('rim'))<14)
        near_road=distance(layer('road'))<3
        near_walk=(distance(walk)<8)|(curb<4)
        drive=distance(layer('access'))<6
        turf=smooth(soft&clear,2,cv2.MORPH_OPEN)
        concrete=smooth(hard,2,cv2.MORPH_OPEN)
        continuity=smooth(concrete,4,cv2.MORPH_CLOSE)
        labels=faces.copy()
        labels[(faces==0)&continuity&~floor]=np.where(near_lot|drive|near_road,5,3)[(faces==0)&continuity&~floor]
        labels[(faces==0)&turf]=1
        labels[(faces==0)&continuity&near_walk&~lot&~near_road&~drive]=3
        labels[(faces==5)&(curb<2.4)&near_walk&~lot&~near_road&concrete]=3
        neighborhood=cv2.blur(soft.astype(np.float32),(25,25))
        open_ground=(neighborhood>.54)&(cv2.blur(hard.astype(np.float32),(25,25))<.17)
        labels[(open_ground&~near_road&~lot)|smooth(turf,5,cv2.MORPH_OPEN)]=1
        courtyard=smooth(concrete&clear,5,cv2.MORPH_OPEN)&(faces==1)
        labels[courtyard]=np.where(near_lot|drive,5,3)[courtyard]
        labels[(labels==3)&turf&~walk]=1
        local_parking=cv2.blur((labels==5).astype('float32'),(37,37))
        green=cv2.blur(green.astype('float32'),(9,9))
        labels[lot&(labels==1)&(local_parking>.50)&(green<.15)]=5
        paved=((labels==3)|(labels==5)).astype('uint8')
        _,components,stats,_=cv2.connectedComponentsWithStats(paved)
        keep=(stats[:,cv2.CC_STAT_AREA]>=192)
        keep[0]=True
        keep[np.unique(components[walk|near_road|lot|(faces==3)|(faces==5)])]=True
        labels[~keep[components]]=1
        frame=(x-halo*.25,z-halo*.25,x+150+halo*.25,z+150+halo*.25)
        surveyed_verges(self.layers,frame,block_rgb(x,z,halo),labels,faces==0)
        from frontage_survey import material_grid
        frontage=material_grid(frame,(labels.shape[1],labels.shape[0]))
        planted=smooth(soft&clear,5,cv2.MORPH_OPEN)
        paved_face=(frontage!=0)&~planted&~floor
        labels[paved_face]=np.where(frontage[paved_face]==4,5,3)
        uncharted=(faces==0)&(frontage==0)&~floor&~lot&~walk&~near_road&~drive
        verge=cv2.blur((soft&clear).astype('float32'),(53,53))>.31
        mineral=cv2.blur((hard&clear&(lum>105)).astype('float32'),(35,35))
        shadow=smooth((lum<98)&verge&(mineral<.13),3,cv2.MORPH_CLOSE)
        labels[uncharted&shadow&np.isin(labels,[3,5])]=1
        outdoor=(frontage==0)&~floor&~lot&~registered
        hard_visible=cv2.blur((hard&clear&(lum>115)).astype('float32'),(21,21))
        shade=cv2.blur((~clear|(lum<98)).astype('float32'),(21,21))
        vegetation=cv2.blur(soft.astype('float32'),(61,61))
        shaded=uncharted&~registered&(vegetation>.12)&(shade>.28)&(hard_visible<.30)
        labels[shaded]=1
        court=outdoor&~near_road&(labels!=1)&confirmed_face
        daylight=cv2.blur((hard&clear&(lum>142)).astype('float32'),(35,35))
        mineral_samples=cv2.blur((hard&clear).astype('float32'),(35,35))
        planted_samples=cv2.blur((soft&clear).astype('float32'),(35,35))
        apron=outdoor&~near_road&drive&~near_lot&(faces==0)&(labels==5)
        light_apron=apron&(daylight>.17)&(daylight>mineral_samples*.63)&(planted_samples<.075)
        labels[court|light_apron]=CONFIRMED_CONCRETE
        labels[floor|(lum==0)|(layer('fixed')>0)]=0
        return labels[halo:-halo,halo:-halo]

    def unpaved_service(self,line,width):
        from shapely.ops import substring
        if line.length<9 or not self.site.intersects(line):return []
        d=np.linspace(0,line.length,math.ceil(line.length/2)+1)
        p=np.array([line.interpolate(v).coords[0] for v in d])
        axis=np.gradient(p,axis=0)
        n=np.column_stack([-axis[:,1],axis[:,0]])/np.maximum(.01,np.linalg.norm(axis,axis=1))[:,None]
        pts=p[:,None,:]+np.array([-.34,-.16,0,.16,.34])[None,:,None]*width*n[:,None,:]
        u=np.floor((pts[:,:,0]-self.bounds[0])*4).astype(int).clip(0,self.labels.shape[1]-1)
        v=np.floor((pts[:,:,1]-self.bounds[1])*4).astype(int).clip(0,self.labels.shape[0]-1)
        soft=(self.labels[v,u]==1).sum(axis=1)>=4
        ends=np.flatnonzero(np.diff(np.r_[False,soft,False]))
        removals=[]
        for a,b in ends.reshape(-1,2):
            if d[b-1]-d[a]<8:continue
            segment=substring(line,d[a],d[b-1]).buffer(width*.72,cap_style='flat')
            for k in (a,b-1):
                if k==0 or k==len(d)-1:
                    segment=segment.union(shapely.Point(p[k]).buffer(width*.72))
            removals.append(segment)
        return removals

    def sample(self,frame,size,offset=(.5,.5),confirmed_concrete=False):
        l,t,r,b=frame
        x=np.floor((l+(np.arange(size[0])+offset[0])*(r-l)/size[0]-self.bounds[0])*4).astype(int)
        z=np.floor((t+(np.arange(size[1])+offset[1])*(b-t)/size[1]-self.bounds[1])*4).astype(int)
        result=self.labels[np.ix_(z.clip(0,self.labels.shape[0]-1),x.clip(0,self.labels.shape[1]-1))]
        result[(z<0)|(z>=self.labels.shape[0])]=0
        result[:,(x<0)|(x>=self.labels.shape[1])]=0
        if confirmed_concrete:return result==CONFIRMED_CONCRETE
        result[result==CONFIRMED_CONCRETE]=3
        return result


@lru_cache(maxsize=1)
def survey():
    return Surfaces()
