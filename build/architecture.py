import base64
import io
import json
import math
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from shapely.geometry import Polygon, box
from shapely import contains_xy, distance, points
from shapely.ops import triangulate
from scipy.spatial import Delaunay

import geo
from buildings import style_for
from campus_region import CACHE, X0, X1, Z0, Z1
from voxelize import collect_layers

WESTERN_REFERENCES = {
    '880x500_uc':'https://www.uwo.ca/fm/img/projects/880x500_uc.jpg',
    'middlesex-construction':'https://www.uwo.ca/earth/geocollections/resources/displays/whirlpool_images/Middlesex%20college.png'
}

BAYS = {
    'universityBay':(5.7,4.6,0xB5A78D,0x526571,0), 'conronTracery':(5.72,9.0,0xAD9D82,0x43586B,0),
    'middlesexBay':(3.85,4.18,0xA69B86,0x536777,0), 'limestone':(4.5,3.85,0xBCB3A0,0x566C78,0),
    'gothic':(4.15,3.9,0xB2A38E,0x546873,0), 'concrete':(4.4,3.5,0xA49F93,0x536873,1),
    'brickPier':(5.5,3.9,0xA47962,0x516977,2), 'strip':(4.0,3.7,0xB0AA9C,0x506879,3),
    'dorm':(3.8,3.15,0xAE9481,0x57727C,1), 'glass':(4.5,3.8,0x8B9DA0,0x557987,3),
    'metal':(3.4,3.6,0xADB2AA,0x536D78,5), 'lab':(4.8,4.2,0xAF9F89,0x547381,3),
    'library':(4.2,3.8,0xAEA799,0x516675,3), 'balcony':(6.8,3.1,0xAA9984,0x566C78,1),
    'stoneBay':(4.5,3.85,0xBBAF98,0x566B75,0), 'bronze':(3.5,3.15,0x9E826E,0x536A76,1),
    'brick':(3,3,0xA16F5C,0x526575,4), 'stone':(2.2,2.5,0xACA18E,0x526674,4),
    'panel':(4.5,4.5,0xA8A79D,0x586D76,5), 'brickHome':(3.8,3.05,0xA77462,0x566E7B,6),
    'sidingHome':(3.4,3.05,0xB5B8A7,0x58737E,8), 'garageDoor':(3.7,3.05,0xA6A498,0x5A7077,7)
}

NAMED = {
    'AH':'stone','TRAC':'panel','SEB':'gothic','OHR':'dorm','SMHR':'dorm','EHR':'dorm','PHR':'dorm',
    'BAHR':'balcony','BIO':'brickPier','SSB':'strip','FNB':'lab','WIRB':'glass','PHFM':'metal','CC':'glass',
    'WSSB':'glass','NCB':'stoneBay','SC':'glass','WAS':'panel','WH':'gothic','HSB':'stoneBay','TEB':'brickPier',
    'UCC':'concrete','PP':'brickPier','CO':'stone','AFAR':'metal','WSRC':'metal'
}
CORE = {
    'University College':'universityBay','Middlesex College':'middlesexBay','Physics Building':'gothic','Somerville House':'stoneBay',
    'Lawson Hall':'stoneBay','Stevenson Hall':'limestone','Natural Sciences Building':'stoneBay','Weldon Library':'library',
    'Social Science Center':'concrete','Biological & Geological Sciences':'stoneBay','Thames Hall':'limestone',
    'Law School':'strip','Health Sciences Building':'gothic','Talbot College':'stone','Music Building':'glass',
    'Kresge Building':'strip','Siebens Centre':'brickPier','Greenhouses':'glass','McIntosh Art Gallery':'stone'
}
PORTALS = {
    'University College':[(301,310,12),(299,331,15)],'Middlesex College':[(530,199,12)],
    'Physics Building':[(349,184,8)],'McIntosh Art Gallery':[(260,184,20)]
}
SOURCES = {
    '39253104': 'https://kartaview.org/details/393142/435',
    '39253176': 'https://kartaview.org/details/393142/448',
    '89741133': 'https://kartaview.org/details/519133/422'
}


def encoded(image,quality):
    output=io.BytesIO()
    image.save(output,format='WEBP',quality=quality,method=5)
    return base64.b64encode(output.getvalue()).decode()


def atlas():
    return dict(forms=[dict(name=name,bay=bay,floor=floor,wall=wall,glass=glass,pattern=pattern)
                       for name,(bay,floor,wall,glass,pattern) in BAYS.items()])


def choose_style(name,tags,profile,polygon,height,index):
    if profile in NAMED:
        return NAMED[profile]
    if name in CORE:
        return CORE[name]
    kind=tags.get('building', '')
    if kind in ('garage','garages','shed','carport') or not name and polygon.area<48 and height<6:
        return 'garageDoor'
    if kind in ('detached','house','semidetached_house','bungalow','residential','terrace') or not name and polygon.area<260 and height<9:
        return 'brickHome' if index%4<2 else 'sidingHome'
    if kind in ('apartments','dormitory') or 'Residence' in name: return 'dorm'
    if kind in ('warehouse','service','utility','industrial','retail'): return 'panel'
    if tags.get('building:material')=='brick': return 'brickPier'
    if tags.get('building:material')=='glass': return 'glass'
    return ('limestone','strip','brickPier','stoneBay')[index%4] if name else 'strip' if height>10 else 'brickPier'


def roof_atlas(region):
    side=3072
    mosaic=Image.new('RGB',(side,side))
    for r in range(4):
        for c in range(4):
            with Image.open(CACHE/f'aerial-fine-{c}-{r}.jpg') as patch:
                mosaic.paste(patch.convert('RGB').resize((side//4,side//4),Image.Resampling.LANCZOS),(c*side//4,r*side//4))
    mask=Image.new('L',(side,side))
    d=ImageDraw.Draw(mask)
    def pixels(ring):
        return [((x-X0)/(X1-X0)*side,(z-Z0)/(Z1-Z0)*side) for x,z in zip(ring[::2],ring[1::2])]
    for shell,holes,*_ in region['blocks']:
        d.polygon(pixels(shell),fill=255)
        for hole in holes:d.polygon(pixels(hole),fill=0)
    mask=mask.filter(ImageFilter.MaxFilter(5))
    return encoded(Image.composite(mosaic,Image.new('RGB',mosaic.size,(120,121,119)),mask),88)


def core_frontages(web,ground):
    world=json.loads((web/'world.json').read_bytes())
    h,depth,width=world['height'],world['depth'],world['width']
    occupied=np.frombuffer(zlib.decompress((web/'world.bin').read_bytes()),dtype=np.uint8).reshape(h,depth,width)!=0
    top=h-np.argmax(occupied[::-1],axis=0)
    core=box(0,0,width,depth)
    result=[]
    for tags,outers,holes in collect_layers(geo.load_osm())[0]:
        name=tags.get('name','')
        for shell in outers:
            if len(shell)<4: continue
            footprint=Polygon(shell).buffer(0)
            if footprint.geom_type!='Polygon' or footprint.area<20 or not footprint.intersects(core): continue
            for hole in holes:
                if len(hole)>=4:footprint=footprint.difference(Polygon(hole).buffer(0))
            clipped=footprint.intersection(core)
            if clipped.geom_type!='Polygon' or clipped.area<12: continue
            probe=clipped.representative_point()
            base=float(ground[min(depth-1,int(probe.y)),min(width-1,int(probe.x))])*.001
            style=CORE.get(name,{'stone':'stoneBay','glass':'glass','brick':'brickPier','concrete':'strip'}[style_for(tags).wall])
            rows=[]
            for poly_ring in [clipped.exterior,*clipped.interiors]:
                pts=list(poly_ring.coords)
                exterior=poly_ring==clipped.exterior
                sign=(1 if poly_ring.is_ccw else -1)*(1 if exterior else -1)
                for (x,z),(ex,ez) in zip(pts,pts[1:]):
                    length=math.hypot(ex-x,ez-z)
                    if length<1.4 or (x==ex and x in (0,width)) or (z==ez and z in (0,depth)):continue
                    tx,tz=(ex-x)/length,(ez-z)/length
                    nx,nz=sign*tz,-sign*tx
                    cells=max(1,round(length/3.6)); run=length/cells
                    for k in range(cells):
                        cx=x+run*(k+.5)*tx; cz=z+run*(k+.5)*tz
                        if any(math.hypot(cx-px,cz-pz)<r for px,pz,r in PORTALS.get(name,[])):continue
                        idx=[(min(depth-1,max(0,int(cz-nz*s))),min(width-1,max(0,int(cx-nx*s)))) for s in (1.2,1.8,2.4)]
                        eave=min(float(np.median([top[iz,ix] for iz,ix in idx]))-.65,base+style_for(tags).height+3.4)
                        if eave-base<2.7:continue
                        if rows and k and rows[-1][4]==round(eave,1) and math.hypot(rows[-1][2]-(cx-tx*run/2+.5+nx*.86),rows[-1][3]-(cz-tz*run/2+.5+nz*.86))<.1:
                            rows[-1][2:4]=[round(cx+tx*run/2+.5+nx*.86,2),round(cz+tz*run/2+.5+nz*.86,2)]
                        else:
                            rows.append([round(cx-tx*run/2+.5+nx*.86,2),round(cz-tz*run/2+.5+nz*.86,2),
                                         round(cx+tx*run/2+.5+nx*.86,2),round(cz+tz*run/2+.5+nz*.86,2),round(eave,1),round(nx,3),round(nz,3)])
            if rows:result.append([style,round(base,2),rows,name])
    return result



def hip_roof(polygon, measured_height):
    edge_points=[]
    for loop in [polygon.exterior,*polygon.interiors]:
        coords=np.array(loop.coords)
        for a,b in zip(coords,coords[1:]):
            count=max(1,math.ceil(np.linalg.norm(b-a)/3.1))
            edge_points.extend(a+(b-a)*j/count for j in range(count))
    west,north,east,south=polygon.bounds
    gx,gz=np.meshgrid(np.arange(west+1.7,east,3.1),np.arange(north+1.7,south,3.1))
    inside=contains_xy(polygon,gx,gz)
    interior=list(np.c_[gx[inside],gz[inside]])
    seeds=np.unique(np.round(np.array([*edge_points,*interior,polygon.representative_point().coords[0]]),3),axis=0)
    mesh=Delaunay(seeds)
    probes=[]
    cells=[]
    seen={}
    def index(q):
        xy=tuple(np.round(q,2))
        if xy not in seen:
            seen[xy]=len(probes)
            probes.append(xy)
        return seen[xy]
    for cell in mesh.simplices:
        shape=Polygon(seeds[cell])
        if polygon.covers(shape):
            cells.extend(index(p) for p in seeds[cell])
            continue
        clipped=polygon.intersection(shape)
        for part in getattr(clipped,'geoms',[clipped]):
            if part.geom_type!='Polygon' or part.area<.003:continue
            for sub in triangulate(part):
                if sub.area>.003 and part.covers(sub.representative_point()):
                    cells.extend(index(p) for p in list(sub.exterior.coords)[:3])
    if not probes:return None
    xy=np.array(probes)
    inset=distance(points(xy),polygon.boundary)
    width=float(np.max(inset))
    if width<.6:return None
    rise=min(width*.74, max(width*.30,measured_height))
    return [round(rise,2),np.round(np.c_[xy,rise*inset/width],2).ravel().tolist(),cells]


def surveyed_tiers(polygon,surface,base,height):
    from scipy.ndimage import distance_transform_edt, median_filter, grey_opening
    from rasterio import features
    from rasterio.transform import Affine
    from shapely.geometry import shape
    from campus_region import sample

    step=2.5
    west,north,east,south=polygon.bounds
    gx=np.arange(math.floor(west/step)*step-step,east+2*step,step)
    gz=np.arange(math.floor(north/step)*step-step,south+2*step,step)
    xx,zz=np.meshgrid(gx+step/2,gz+step/2)
    interior=contains_xy(polygon.buffer(-1.3),xx,zz)
    if interior.sum()<12:return []
    raw=sample(surface,xx.ravel(),zz.ravel()).reshape(xx.shape)-base
    actual=interior & (raw>2.7)
    if actual.sum()<interior.sum()*.60:return []
    nearest=distance_transform_edt(~actual,return_distances=False,return_indices=True)
    filled=raw[tuple(nearest)]
    smoothed=grey_opening(median_filter(filled,size=3),size=(3,3))
    low,high=np.percentile(smoothed[actual],[9,94])
    if high-low<3.8:return []
    if low>height+5 or high<height*.55:return []
    levels=np.clip(np.rint(smoothed/2)*2,3,90).astype('int16')
    mask=contains_xy(polygon.buffer(step*1.5),xx,zz)
    result=[]
    for geojson,level in features.shapes(levels,mask=mask,transform=Affine.translation(gx[0],gz[0])*Affine.scale(step,step)):
        clipped=shape(geojson).intersection(polygon)
        for part in getattr(clipped,'geoms',[clipped]):
            if part.geom_type!='Polygon' or part.area<.08:continue
            rings=[np.round(np.array(r.coords)[:-1],2).ravel().tolist() for r in [part.exterior,*part.interiors]]
            result.append([int(level),rings])
    if len(result)<2:return []
    return result
