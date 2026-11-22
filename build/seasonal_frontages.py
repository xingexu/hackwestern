import json

import cv2
import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize,shapes
from shapely.geometry import LineString,Polygon,box,shape

import campus_region as region
import city_streets
from campus_bounds import footprint
from frontage_survey import civic_walks
from ortho_road_paint import rgb_tile
from parcel_surfaces import municipal_lines
from parking_archive import aligned_photo,lot_tiles


def extract_material(photo):
    rgb=cv2.resize(photo,(600,600),interpolation=cv2.INTER_AREA).astype('float32')
    red,green,blue=rgb.transpose(2,0,1)
    light=(red+2*green+blue)*.25
    neutral=(red-green<15)&(green-red<5)&(red-blue<8+.123*light)&(green-blue<8+.10*light)
    green_cover=((green-red>7)&(green-blue>12))|((red-blue>12+.16*light)&(green-blue>9+.095*light))|(red-green>18)
    return cv2.medianBlur(np.uint8(neutral&(light>137)),3),cv2.medianBlur(np.uint8(green_cover),3),light


def area_masks(network,site):
    borders=municipal_lines('sidewalk',site)
    borders.extend(line for line,width in civic_walks(site))
    parking=municipal_lines('parking',site)
    roadway=[Polygon(np.reshape(shell,(-1,2)),[np.reshape(r,(-1,2)) for r in holes]) for shell,*holes in city_streets.survey()]
    for way in network['ways']:
        if way['kind']=='road' and not way['bridge']:
            path=LineString([(x,z) for x,y,z in way['points']])
            roadway.append(path.buffer(way['width']*.47,quad_segs=2))
    lots=[]
    for item in network['areas']:
        if item['kind'] in ('parking','water','road'):
            shell,*holes=[np.reshape(r,(-1,2)) for r in item['rings']]
            lots.append(Polygon(shell,holes).buffer(0))
    return [shapely.STRtree(items) for items in [borders,parking,roadway+lots,city_streets.solid_ground_floors(network)]]


def tile_frontages(x,z,site,layers,canopy):
    tile=box(x,z,x+150,z+150)
    transform=Affine.translation(x,z)*Affine.scale(.25)
    def mask(geometries):
        return rasterize(geometries,out_shape=(600,600),transform=transform,dtype='uint8') if len(geometries) else np.zeros((600,600),'uint8')
    sidewalks,kerbs,roads,walls=[mask(t.geometries[t.query(tile,predicate='intersects')]) for t in layers]
    if not sidewalks.any():return []
    def distance(layer):
        return cv2.distanceTransform(1-layer,cv2.DIST_L2,5)*.25
    sidewalk=distance(sidewalks)
    wall=distance(walls)
    xx,zz=np.meshgrid(x+.125+np.arange(600)*.25,z+.125+np.arange(600)*.25)
    high=region.sample(canopy,xx.ravel(),zz.ravel()).reshape(wall.shape)>2.4
    permitted=(sidewalk<4.2)|((distance(kerbs)<4.8)&(sidewalk<8.8))|((wall<4.7)&(sidewalk<7.4))
    eligible=(mask([site.intersection(tile)])>0)&permitted&(roads==0)&(walls==0)&(~high|(wall>6))
    if eligible.sum()<60:return []
    now=rgb_tile(x,z)
    pavement,vegetation,light=extract_material(now)
    votes=np.zeros_like(pavement)
    negatives=vegetation.copy()
    register_mask=cv2.resize(eligible.astype('uint8')*255,(1500,1500),interpolation=cv2.INTER_NEAREST)
    for year in (2020,2021,2024):
        photo=aligned_photo(year,x,z,now,register_mask)
        if photo is None:continue
        hard,green,_=extract_material(photo)
        votes+=hard
        negatives+=green
    observed=(votes>=2)&(negatives<2)&((light<114)|(pavement>0))&eligible
    disk=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5))
    observed=(cv2.morphologyEx(np.uint8(observed),cv2.MORPH_CLOSE,disk)>0)&eligible
    count,labels,sizes,_=cv2.connectedComponentsWithStats(observed.astype('uint8'))
    shadow=np.bincount(labels[(light<114)&observed],minlength=count)
    surveyed=np.bincount(labels[(sidewalk<.85)&observed],minlength=count)
    open_paving=np.bincount(labels[(pavement>0)&observed],minlength=count)
    selected=(shadow>=20)&(surveyed>=12)&(open_paving>=14)&(sizes[:,cv2.CC_STAT_AREA]>=75)
    selected[0]=False
    surface=np.uint8(selected[labels])
    return [shape(poly) for poly,val in shapes(surface,mask=surface>0,transform=transform)]


def survey():
    network=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    site=footprint()
    layers=area_masks(network,site)
    canopy=region.lidar('dsm')-region.lidar('dtm')
    faces=[]
    for x,z in lot_tiles(site):
        faces.extend(tile_frontages(x,z,site,layers,canopy))
    merged=shapely.union_all(faces)
    records=[]
    for part in shapely.get_parts(merged):
        if part.geom_type!='Polygon' or part.area<5:continue
        polygon=part.simplify(.18)
        rings=[np.asarray(r.coords)[:-1].round(2).tolist() for r in [polygon.exterior,*polygon.interiors]]
        records.append([5,rings])
    return records


if __name__=='__main__':
    cv2.setNumThreads(1)
    faces=survey()
    (region.OUT.parents[1]/'build/survey_seasonal_frontages.json').write_text(json.dumps(faces,separators=(',',':')))
    print(len(faces),'seasonally photographed sidewalk faces')
