import io
import json
import math
from functools import lru_cache
from uuid import uuid4

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import box

import campus_region as region
from campus_bounds import footprint


@lru_cache(maxsize=1)
def parcel():
    return footprint()


def survey_tile_path(x,z):
    from building_inventory import AERIAL_SERVICE,local_to_mercator
    path=region.CACHE.parent/'audit'/'ortho-2025'/f'{x}_{z}.jpg'
    if not path.exists():
        import requests
        left,top=local_to_mercator(x,z)
        right,bottom=local_to_mercator(x+150,z+150)
        response=requests.get(AERIAL_SERVICE,params=dict(bbox=f'{left},{bottom},{right},{top}',bboxSR=3857,imageSR=3857,
            size='1500,1500',adjustAspectRatio='false',format='jpg',f='image'),timeout=90)
        response.raise_for_status()
        path.parent.mkdir(parents=True,exist_ok=True)
        with Image.open(io.BytesIO(response.content)) as photo:
            photo.load()
            if photo.size != (1500,1500):
                raise ValueError(f"Unexpected orthophoto dimensions {photo.size}")
        pending=path.with_suffix(f'.{uuid4().hex}.pending')
        pending.write_bytes(response.content)
        pending.replace(path)
    return path


@lru_cache(maxsize=18)
def survey_tile(x,z):
    with Image.open(survey_tile_path(x,z)) as img:
        return img.convert('RGB').resize((600,600),Image.Resampling.BOX)


def survey_coordinates(area):
    left,top,right,bottom=area.bounds
    for i in range(math.floor(left/150),math.ceil(right/150)):
        for j in range(math.floor(top/150),math.ceil(bottom/150)):
            x,z=i*150,j*150
            if area.intersects(box(x,z,x+150,z+150)):yield x,z


def orthophoto(frame,size):
    left,top,right,bottom=frame
    result=Image.new('RGB',size)
    for j in range(math.floor(top/150),math.ceil(bottom/150)):
        for i in range(math.floor(left/150),math.ceil(right/150)):
            x,z=150*i,150*j
            if not parcel().intersects(box(x,z,x+150,z+150)):
                continue
            u,v=round((x-left)*size[0]/(right-left)),round((z-top)*size[1]/(bottom-top))
            e,s=round((x+150-left)*size[0]/(right-left)),round((z+150-top)*size[1]/(bottom-top))
            photo=survey_tile(x,z)
            result.paste(photo.resize((e-u,s-v),Image.Resampling.BILINEAR),(u,v))
    return result


def material_evidence(frame,size):
    rgb=np.asarray(orthophoto(frame,size),dtype=np.float32)
    r,g,b=rgb.transpose(2,0,1)
    lum=(r+2*g+b)*.25
    dx=size[0]/(frame[2]-frame[0])
    mean=ndimage.uniform_filter(lum,size=max(3,round(1.0*dx)|1))
    noise=np.sqrt(np.maximum(0,ndimage.uniform_filter(lum*lum,size=max(3,round(1.0*dx)|1))-mean*mean))
    neutral=(r-g<15)&(g-r<8)&(g-b<29)&(r-b<40)
    hard=(g>145)&neutral&(noise<11)
    strong=(g>166)&neutral&(noise<6.2)
    soft=(g>60)&((g-b>31)|(r-g>15)|((g<125)&(r>b+11)&(noise>4)))
    return hard,strong,soft,lum


def connected_area(mask,min_pixels):
    regions,count=ndimage.label(mask)
    area=np.bincount(regions.ravel(),minlength=count+1)
    return (regions>0)&(area[regions]>=min_pixels)


@lru_cache(maxsize=1)
def ramp_aprons():
    import shapely
    from shapely.geometry import Polygon
    records=json.loads((region.OUT.parents[1]/'build/survey_pavement.json').read_bytes())
    polygons=[]
    for x,z,dx,dz,width in records['ramps']:
        def point(u,v):return x+dx*u-dz*v,z+dz*u+dx*v
        polygons.append(Polygon([point(u,v) for u,v in [(-width/2,-1.65),(width/2,-1.65),(width/2+.5,-.35),(width/2+.5,.35),(width/2,1.65),(-width/2,1.65),(-width/2-.5,.35),(-width/2-.5,-.35)]]))
    return shapely.STRtree(polygons)


def rectify_walks(frame,size,labels,slabs,road,parking,overhead):
    density=size[0]/(frame[2]-frame[0])
    hard,strong,soft,lum=material_evidence(frame,size)
    source=labels>0
    if not np.any(lum):
        return labels
    forbidden=(road>64)|overhead|parking
    eligible=~forbidden
    source_near=ndimage.distance_transform_edt(~source)/density
    reliable=hard&eligible
    frontage=ndimage.distance_transform_edt(~overhead)/density
    candidate=((source_near<=14)|(frontage<11))&reliable
    courts=connected_area((frontage<8)&strong&eligible,max(30,round(14*density*density)))
    seed=((source_near<1.8)&strong|courts)&candidate
    added=ndimage.binary_propagation(seed,mask=candidate)
    added=ndimage.binary_closing(added,iterations=max(1,round(.65*density)))&eligible
    added=connected_area(added,max(5,round(2.4*density*density)))
    confirmed=strong&added
    near_confirmed=ndimage.maximum_filter(confirmed,size=round(5*density)|1)
    reject=(source&(labels==1)&soft&near_confirmed&(slabs==0))
    reject=ndimage.binary_opening(reject,iterations=max(1,round(.30*density)))
    labels[reject]=0
    labels[added&(labels==0)]=1
    from parcel_surfaces import survey
    surfaces=survey()
    measured=surfaces.sample(frame,size)
    exposed=~overhead&(road<=64)
    keep_slab=(source|added)&hard&(lum>164)
    labels[exposed&((measured==1)|((measured==5)&~keep_slab))]=0
    labels[exposed&(measured==3)&~soft&(labels==0)]=1
    courts=surfaces.sample(frame,size,confirmed_concrete=True)
    labels[exposed&courts&(labels==0)]=1
    from frontage_survey import material_grid
    front=material_grid(frame,size)
    concrete=exposed&(measured==3)
    labels[(front==1)&concrete]=1
    labels[(front==5)&exposed]=1
    labels[(front==2)&concrete]=2
    labels[(front==3)&exposed]=3
    labels[(front==4)&(measured==5)&exposed]=0
    aprons=ramp_aprons()
    near=aprons.query(box(*frame),predicate='intersects')
    if len(near):
        from rasterio.features import rasterize
        from affine import Affine
        grid=Affine.translation(*frame[:2])*Affine.scale((frame[2]-frame[0])/size[0],(frame[3]-frame[1])/size[1])
        mask=rasterize(aprons.geometries[near],out_shape=labels.shape,transform=grid).astype(bool)
        labels[exposed&mask&hard&~soft&(labels==0)]=1
    from sidewalk_ribbons import masks as sidewalk_ribbons
    ribbon=sidewalk_ribbons(frame,size)
    if ribbon is not None:
        labels[exposed&(ribbon==1)&(labels==0)]=1
        labels[exposed&(ribbon==2)&soft&~hard&(slabs==0)&(front==0)&(labels==1)]=0
    from planting_verges import mask as planting_mask
    labels[exposed&(planting_mask(frame,size)|surfaces.sample(frame,size,parking_bays=True))]=0
    from site_frontages import mask as site_materials
    chart=site_materials(frame,size)
    if chart is not None:
        labels[chart>0]=0
        labels[chart==3]=1
    return labels


def parking_and_woodland(classes,bounds,network):
    from rasterio import Affine
    from rasterio.features import rasterize
    from shapely.geometry import LineString,Polygon
    from shapely import transform
    from shapely.geometry import shape
    import municipal_detail
    import city_streets
    import geo
    left,top,right,bottom=bounds
    height,width=classes.shape
    dx=(right-left)/width
    dz=(bottom-top)/height
    transform_grid=Affine.translation(left,top)*Affine.scale(dx,dz)
    def mask(shapes):
        return rasterize([(g,1) for g in shapes if not g.is_empty],out_shape=classes.shape,transform=transform_grid,dtype='uint8').astype(bool)
    raw_lots=[]
    for f in municipal_detail.fetch('parking')[1]:
        geom=transform(shape(f['geometry']),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False)
        if parcel().intersects(geom):
            raw_lots.append(geom.buffer(8,quad_segs=2))
    near=mask(raw_lots)|(classes==5)
    surveyed_lots=[]
    for area in network['areas']:
        if area['kind']=='parking':
            shell,*holes=[np.reshape(r,(-1,2)) for r in area['rings']]
            surveyed_lots.append(Polygon(shell,holes).buffer(-.20))
    lot=mask(surveyed_lots)
    registered=json.loads((region.OUT.parents[1]/'build/survey_parking_rows.json').read_bytes())
    stalls=mask([LineString([a,b]).buffer(width*.50,cap_style='flat') for a,b,width in registered['rows']])&lot
    tw,th=region.TERRAIN_SIZE
    summer=Image.new('RGB',(tw,th))
    for j in range(4):
        for i in range(4):
            a,b,e,s=round(tw*i/4),round(th*j/4),round(tw*(i+1)/4),round(th*(j+1)/4)
            with Image.open(region.CACHE/f'aerial-summer-{i}-{j}.jpg') as tile:
                summer.paste(tile.resize((e-a,s-b),Image.Resampling.BOX),(a,b))
    red,green,blue=np.asarray(summer,dtype=np.int16).transpose(2,0,1)
    leaf=ndimage.uniform_filter(((green>red+5)&(green>blue+14)).astype('float32'),3)
    floors=mask(city_streets.solid_ground_floors(network))
    road=mask([LineString([(x,z) for x,y,z in w['points']]).buffer(w['width']*.46,quad_segs=2)
        for w in network['ways'] if w['kind']=='road' and not w['bridge']])
    canopy=region.lidar('dsm')-region.lidar('dtm')
    input_classes=classes.copy()
    for v in range(0,height,384):
        for u in range(0,width,384):
            a,b=max(0,u-42),max(0,v-42)
            e,s=min(width,u+426),min(height,v+426)
            frame=(left+a*dx,top+b*dz,left+e*dx,top+s*dz)
            if not parcel().intersects(box(*frame)):continue
            hard,strong,soft,lum=material_evidence(frame,(e-a,s-b))
            ref=input_classes[b:s,a:e]
            eligible=np.isin(ref,[0,1,2,3,4,5,11])&~floors[b:s,a:e]&~road[b:s,a:e]
            current=ref==5
            source=near[b:s,a:e]
            walls=ndimage.maximum_filter(floors[b:s,a:e],size=round(20/dx)|1)
            apron=connected_area(walls&hard&(lum>133)&(lum<192)&eligible,max(28,round(25/dx**2)))
            source=source|apron
            envelope=ndimage.maximum_filter(source,size=round(17/dx)|1)
            confirmed=ndimage.binary_propagation(strong&source&eligible,mask=hard&envelope&eligible)
            connected=connected_area(confirmed,max(8,round(22/dx**2)))
            supported=ndimage.binary_closing(connected,iterations=max(1,round(2.35/dx)))
            cars=(ndimage.uniform_filter(connected.astype('float32'),size=round(7/dx)|1)>.43)&~soft
            asphalt=eligible&(connected|(supported&(cars|~soft)))
            x,z=np.meshgrid(left+(np.arange(a,e)+.5)*dx,top+(np.arange(b,s)+.5)*dz)
            growing=region.sample(leaf,x.ravel(),z.ravel()).reshape(z.shape)>.48
            in_lot=lot[b:s,a:e]
            marked=stalls[b:s,a:e]
            remove=current&eligible&soft&(lum>63)&(~in_lot|growing)&~marked
            remove=ndimage.binary_opening(remove,iterations=max(1,round(.70/dx)))
            asphalt|=eligible&(marked|(in_lot&~growing&~soft))

            crowns=region.sample(canopy,x.ravel(),z.ravel()).reshape(z.shape)>3.0
            canopy_support=(crowns&~floors[b:s,a:e]).astype('float32')
            wood=(ndimage.uniform_filter(canopy_support,size=round(14/dx)|1)>.59)&(ndimage.uniform_filter(canopy_support,size=round(44/dx)|1)>.45)
            revised=ref.copy()
            revised[wood&eligible&(ref<=1)&(lum<155)]=2
            revised[remove]=0
            revised[asphalt]=5
            ya=min(384,height-v);xa=min(384,width-u)
            classes[v:v+ya,u:u+xa]=revised[v-b:v-b+ya,u-a:u-a+xa]
    return classes


def shaded_lawn(bounds,size,classes,network):
    from rasterio import Affine
    from rasterio.features import rasterize
    from city_streets import solid_ground_floors
    left,top,right,bottom=bounds
    w,h=size
    dx,dz=(right-left)/w,(bottom-top)/h
    lawn=np.asarray(Image.fromarray(np.uint8(classes<=1)*255).resize(size,Image.Resampling.BOX),np.float32)/255
    buildings=rasterize(solid_ground_floors(network),out_shape=(h,w),transform=Affine.translation(left,top)*Affine.scale(dx,dz),dtype='uint8')
    canopy=region.lidar('dsm')-region.lidar('dtm')
    xs,zs=np.meshgrid(left+(np.arange(w)+.5)*dx,top+(np.arange(h)+.5)*dz)
    relative_height=region.sample(canopy,xs.ravel(),zs.ravel()).reshape(h,w)
    crown=np.clip((relative_height-2)/6,0,1)*(buildings==0)
    shade=ndimage.gaussian_filter(crown.astype('float32'),1.25/dx)
    return np.rint(255*shade*lawn).astype('uint8')


def court_finish(classes,interior):
    height,width=classes.shape
    columns,rows=interior.size
    native=np.asarray(interior.resize((width,height),Image.Resampling.BILINEAR))
    radius=math.ceil(1.5*max(width/columns,height/rows))
    near=ndimage.maximum_filter(native,size=radius*2+1)>90
    mineral=near&np.isin(classes,(3,5))
    joint=Image.fromarray(np.uint8(mineral)*255).resize((columns,rows),Image.Resampling.BOX)
    return np.maximum(np.asarray(interior),np.asarray(joint))


def paving_tone(bounds,network,classes,courts):
    import base64
    import zlib
    from rasterio import Affine
    from rasterio.features import rasterize
    from shapely.geometry import LineString,Polygon
    left,top,right,bottom=bounds
    w,h=round((right-left)/1.45),round((bottom-top)/1.45)
    dx,dz=(right-left)/w,(bottom-top)/h
    value=np.zeros((h,w),dtype=np.uint8)
    mineral=np.zeros_like(value)
    for z in range(0,h,160):
        for x in range(0,w,160):
            a,b,e,s=max(0,x-16),max(0,z-16),min(w,x+176),min(h,z+176)
            frame=(left+a*dx,top+b*dz,left+e*dx,top+s*dz)
            if not parcel().intersects(box(*frame)):continue
            hard,strong,soft,luma=material_evidence(frame,(e-a,s-b))
            valid=hard&(luma>127)&(luma<232)
            weight=ndimage.gaussian_filter(valid.astype('float32'),2.6)
            mean=ndimage.gaussian_filter(np.where(valid,luma,0),2.6)/np.maximum(.001,weight)
            blend=np.clip((mean-132)/65,0,1)*np.minimum(1,weight*3)
            rows,cols=min(160,h-z),min(160,w-x)
            value[z:z+rows,x:x+cols]=np.rint(7*blend[z-b:z-b+rows,x-a:x-a+cols]).astype('uint8')*34
            red,green,blue=np.asarray(orthophoto(frame,(e-a,s-b)),np.float32).transpose(2,0,1)
            neutral=(red-green<12)&(green-red<5)&(green-blue<31)&(red-blue<40)&(luma>135)&(luma<224)
            support=ndimage.gaussian_filter(neutral.astype('float32'),3.2)
            diffuse=ndimage.gaussian_filter(np.where(neutral,luma,0),3.2)/np.maximum(.001,support)
            chroma=ndimage.gaussian_filter(np.where(neutral,red-blue,0),3.2)/np.maximum(.001,support)
            tint=np.clip((diffuse-151)/35,0,1)*np.clip((chroma-7)/13,0,1)*np.clip(support*2.6,0,1)
            mineral[z:z+rows,x:x+cols]=np.rint(255*tint[z-b:z-b+rows,x-a:x-a+cols]).astype('uint8')
    surfaces=[]
    for area in network['areas']:
        if area['kind'] in ('parking','road'):
            shell,*holes=[np.reshape(r,(-1,2)) for r in area['rings']]
            surfaces.append((Polygon(shell,holes),area['material']))
    from parking_stripes import OUT as parking_inventory
    for shell,*holes in json.loads(parking_inventory.read_bytes()).get('surveyedLots',[]):
        surfaces.append((Polygon(np.reshape(shell,(-1,2)),[np.reshape(r,(-1,2)) for r in holes]),'asphalt'))
    for road in network['ways']:
        if road['kind']=='road':
            surfaces.append((LineString([(x,z) for x,y,z in road['points']]).buffer(road['width']/2,quad_segs=3),road['material']))
    colors=[]
    for poly,material in surfaces:
        if not parcel().intersects(poly):
            continue
        if material in ('concrete','concrete:plates','paving_stones'):
            tone=255
        else:
            a,b,e,s=poly.bounds
            i,j=max(0,int((a-left)/dx)),max(0,int((b-top)/dz))
            k,n=min(w,math.ceil((e-left)/dx)),min(h,math.ceil((s-top)/dz))
            if i>=k or j>=n:continue
            local=Affine.translation(left+i*dx,top+j*dz)*Affine.scale(dx,dz)
            mask=rasterize([(poly,1)],out_shape=(n-j,k-i),transform=local,dtype='uint8')>0
            samples=value[j:n,i:k][mask&(value[j:n,i:k]>0)]
            tone=round(np.percentile(samples,60)/34)*34 if len(samples) else 102
        colors.append((poly,tone))
    fallback=np.where(value>0,value,102).astype(np.uint8)
    value=rasterize(colors,out=fallback,transform=Affine.translation(left,top)*Affine.scale(dx,dz))
    from parking_stripes import lot_mask
    transform=Affine.translation(left,top)*Affine.scale(dx,dz)
    lots=rasterize([lot_mask()],out_shape=value.shape,transform=transform,dtype='uint8')
    mineral*=lots
    from service_materials import reflectance
    service=reflectance(bounds,(w,h))
    mineral=np.maximum(mineral,np.rint(service*.74).astype(np.uint8)*(lots==0))
    rivers=[Polygon(np.reshape(p,(-1,2)),[np.reshape(q,(-1,2)) for q in holes]) for p,*holes in network['water']]
    water=rasterize(rivers,out_shape=value.shape,transform=transform,dtype='uint8')
    bank=np.uint8(np.rint(255*np.clip((12-ndimage.distance_transform_edt(water==0,sampling=(dz,dx)))/4,0,1)))
    forest=Image.fromarray(np.uint8(classes==2)*255).resize((w,h),Image.Resampling.BOX)
    duff=np.rint(ndimage.gaussian_filter(np.asarray(forest).astype(np.float32),2.4/dx)).astype(np.uint8)
    from site_frontages import finish_samples
    pixels=np.stack([value,mineral,bank,duff],axis=-1)
    shade=shaded_lawn(bounds,(w,h),classes,network)
    frontages=finish_samples(bounds,(w,h),network['areas'])
    court=Image.fromarray(np.uint8(courts&(classes==3))*255).resize((w,h),Image.Resampling.BOX)
    return dict(width=w,height=h,samples=base64.b64encode(zlib.compress(value.tobytes(),8)).decode(),
                courts=base64.b64encode(zlib.compress(court_finish(classes,court).tobytes(),8)).decode(),
                frontages=base64.b64encode(zlib.compress(frontages.tobytes(),8)).decode(),
                shadedLawn=base64.b64encode(zlib.compress(shade.tobytes(),8)).decode(),woodlandEdges=True,aggregate=base64.b64encode(zlib.compress(pixels.tobytes(),8)).decode())
