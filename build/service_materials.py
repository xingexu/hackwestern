import base64
import io
import json

import cv2
import numpy as np
import shapely
from affine import Affine
from PIL import Image
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import LineString,Polygon,box

import campus_region as region
import city_streets
from building_access import polygon
from campus_bounds import footprint
from ortho_road_paint import rgb_tile
from parcel_surfaces import municipal_lines
from parking_archive import aligned_photo,lot_tiles

OUT=region.OUT.parents[1]/'build/survey_service_materials.json'


def photograph_samples(image):
    rgb=cv2.resize(image,(300,300),interpolation=cv2.INTER_AREA).astype('float32')
    red,green,blue=rgb.transpose(2,0,1)
    light=.29*red+.55*green+.16*blue
    stone=(red-green<16)&(green-red<7)&(red-blue<10+.12*light)&(green-blue<9+.098*light)
    vegetation=((green-red>7)&(green-blue>12))|((red-blue>14+.15*light)&(green-blue>6+.115*light))
    return light,stone,vegetation


def region_layers(site,network):
    lots=[polygon(area['rings']) for area in network['areas'] if area['kind']=='parking']
    roads=[Polygon(np.reshape(shell,(-1,2)),[np.reshape(hole,(-1,2)) for hole in holes]) for shell,*holes in city_streets.survey()]
    drives=municipal_lines('driveway',site)
    for way in network['ways']:
        if way['kind']=='road' and not way.get('bridge') and way['class'] in ('service','residential','living_street','unclassified'):
            center=LineString([(x,z) for x,_,z in way['points']])
            drives.append(center.buffer(way['width']*.54))
    return [shapely.STRtree(records) for records in [lots,roads,city_streets.solid_ground_floors(network),drives,municipal_lines('sidewalk',site)]]


def tile_material(x,z,layers,site):
    tile=box(x,z,x+150,z+150)
    transform=Affine.translation(x,z)*Affine.scale(.5)
    def mask(geometries):
        if len(geometries)==0:return np.zeros((300,300),'uint8')
        return rasterize(geometries,out_shape=(300,300),transform=transform,dtype='uint8')
    def distance(mask):
        return cv2.distanceTransform(1-mask,cv2.DIST_L2,5)*.5
    lots,roads,walls,drives,walks=[mask(layer.geometries[layer.query(tile,predicate='intersects')]) for layer in layers]
    private=(distance(drives)<8)|(distance(walls)<11)|(distance(lots)<6)|(distance(walks)<4)
    eligible=private&(distance(roads)>=.8)&(walls==0)&(lots==0)&(mask([site])>0)
    if eligible.sum()<30:return np.zeros_like(roads)
    current=rgb_tile(x,z)
    anchors=cv2.resize(np.uint8(eligible)*255,(1500,1500),interpolation=cv2.INTER_NEAREST)
    captures=[photograph_samples(current)]
    for year in (2020,2021,2024):
        archived=aligned_photo(year,x,z,current,anchors)
        if archived is not None:captures.append(photograph_samples(archived))
    if len(captures)<3:return np.zeros_like(roads)
    light,stone,vegetation=map(np.stack,zip(*captures))
    pale=stone&(light>146)
    second_brightest=np.sort(np.where(pale,light,0),axis=0)[-2]
    planted=(vegetation.sum(axis=0)>=2)|vegetation[0]
    stable_dark=np.count_nonzero(stone&(light>95)&(light<143),axis=0)>=2
    permitted=eligible&~planted
    confirmed=(pale.sum(axis=0)>=2)&permitted&(stone[0]|(light[0]<125))
    supported=cv2.GaussianBlur(np.float32(confirmed),(0,0),1.45)
    source=confirmed&(supported>.47)
    if not source.any():return np.zeros_like(roads)
    nearest,indices=ndimage.distance_transform_edt(~source,return_indices=True)
    broad=(nearest<=4.5)&permitted&~stable_dark
    diffuse=np.clip((second_brightest-138)/39,.33,1)
    weights=cv2.GaussianBlur(np.float32(source),(0,0),2.4)
    shade=cv2.GaussianBlur(np.float32(source*diffuse),(0,0),2.4)/np.maximum(.001,weights)
    tone=np.where(source|broad,shade[tuple(indices)],0)
    return np.uint8(np.rint(np.clip(tone,0,1)*255))


def survey():
    cv2.setNumThreads(1)
    site=footprint()
    network=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    layers=region_layers(site,network)
    tiles={}
    for x,z in lot_tiles(site):
        samples=tile_material(x,z,layers,site)
        if not samples.any():continue
        pixels=Image.fromarray(samples).resize((150,150),Image.Resampling.BOX)
        out=io.BytesIO()
        pixels.save(out,format='PNG',compress_level=9)
        tiles[f'{x},{z}']=base64.b64encode(out.getvalue()).decode()
    OUT.write_text(json.dumps(tiles,separators=(',',':')))
    print(len(tiles),'tiles of independently photographed private paving.')


def reflectance(bounds,size):
    left,top,right,bottom=bounds
    width,height=size
    x=left+(np.arange(width)+.5)*(right-left)/width
    z=top+(np.arange(height)+.5)*(bottom-top)/height
    output=np.zeros((height,width),'uint8')
    for key,packed in json.loads(OUT.read_bytes()).items():
        west,north=map(int,key.split(','))
        cols=np.flatnonzero((x>=west)&(x<west+150))
        rows=np.flatnonzero((z>=north)&(z<north+150))
        if not len(cols) or not len(rows):continue
        with Image.open(io.BytesIO(base64.b64decode(packed))) as tile:
            source=np.asarray(tile)
            source_rows=(z[rows]-north).astype(int)
            source_cols=(x[cols]-west).astype(int)
            output[np.ix_(rows,cols)]=source[np.ix_(source_rows,source_cols)]
    return output


if __name__=='__main__':
    survey()
