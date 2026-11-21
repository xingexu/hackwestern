import hashlib
import html
import io
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse

import numpy as np
import requests
from PIL import Image
from scipy import ndimage
from shapely.geometry import MultiPoint, Point, Polygon
from shapely.strtree import STRtree

import geo
from campus_bounds import footprint
from street_segmentation import labels


CATALOG='https://www.uwo.ca/fm/client_services/building_info.html'
FOLDER=Path(__file__).resolve().parents[1]/'data'/'street'


def identity(name):
    return ' '.join(re.findall(r'[a-z0-9]+',name.lower().replace('center','centre').replace(' & ',' and ').replace('(residence)','')))


def catalogue():
    from region_detail import PROFILES
    text=(FOLDER/'buildings.html').read_text()
    for row in re.split(r'(?=<h3\b)',text,flags=re.I):
        title=re.search(r'<h3[^>]*>(.*?)</h3>',row,re.S|re.I)
        photo=re.search(r'class="center-3column".*?<img\b[^>]*?src="([^"]+)"',row,re.S|re.I)
        if not title or not photo:
            continue
        full=html.unescape(re.sub('<[^>]+>','',title[1])).strip()
        name=full.split('#')[0].strip()
        path=html.unescape(photo[1])
        if path.startswith('/img/what_we_do/bldg/'):
            path='/fm'+path
        image=urljoin(CATALOG,path)
        if not image.lower().endswith(('.jpg','.jpeg','.png')) or urlparse(image).netloc!='www.uwo.ca':
            continue
        code=Path(urlparse(image).path).stem
        coords=re.findall(r'!3d(-?[\d.]+)!4d(-?[\d.]+)',row)
        pin=geo.to_grid(*map(float,coords[-1])) if coords else None
        aliases={identity(name)}|{identity(alias) for alias,k in PROFILES.items() if k==code}
        yield name,image,aliases,pin


def matched_buildings(blocks,architecture,labels):
    footprints=[Polygon(np.reshape(r,(-1,2)),[np.reshape(h,(-1,2)) for h in hs]).buffer(0) for r,hs,*_ in blocks]
    names=[identity(block[-1]) for block in blocks]
    for _,_,segments,name in architecture['core']:
        coords=np.array(segments)[:,:4].reshape(-1,2)
        footprints.append(MultiPoint(coords).convex_hull)
        names.append(identity(name))
    index=STRtree(footprints)
    output={}
    site=footprint()
    entries=list(catalogue())
    owners={}
    for name,_,_,position in entries:
        if position is not None:
            for j in index.query(Point(position),predicate='intersects'):
                owners.setdefault(int(j),set()).add(name)
    for name,url,aliases,location in entries:
        reference='facilities'
        if location is None:
            matches=[v for v in labels if identity(v['name']) in aliases]
            if len(matches)!=1:
                continue
            location=(matches[0]['x'],matches[0]['z'])
            reference='named campus landmark'
        point=Point(location)
        if not site.covers(point):
            continue
        candidates=[]
        for j in index.query(point,predicate='dwithin',distance=28):
            shape=footprints[j]
            if shape.area<60:continue
            ident=names[j]
            exact=bool(ident and ident in aliases)
            partial=bool(ident and any(len(a.split())>=2 and len(ident.split())>=2 and
                         (a.startswith(ident+' ') or ident.startswith(a+' ')) for a in aliases))
            contained=shape.covers(point)
            if exact or partial and shape.distance(point)<10 or contained and not ident and len(owners.get(int(j),()))==1:
                score=(0 if exact else 1 if partial else 2,shape.distance(point),shape.centroid.distance(point))
                candidates.append((score,int(j)))
        if not candidates:continue
        candidates.sort()
        score,j=candidates[0]
        if j not in output or score<output[j][0]:
            output[j]=(score,dict(kind='facilities',name=name,url=url,pin=np.round(location,2).tolist(),pinSource=reference))
    return {i:entry for i,(_,entry) in output.items()}


def image_tones(source_bands,item):
    building,info=item
    url=info['url']
    path=FOLDER/Path(urlparse(url).path).name
    if not path.exists():
        try:
            response=requests.get(url,timeout=15)
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as original:
                original.verify()
            temp=path.with_suffix(f'.{os.getpid()}.part')
            temp.write_bytes(response.content)
            temp.replace(path)
        except (requests.RequestException,OSError):
            return None
    with Image.open(path) as image:
        key='western-'+hashlib.sha256(path.read_bytes()).hexdigest()[:14]
        mask=labels(key,image)==2
        components,count=ndimage.label(mask)
        if not count:return None
        yy,xx=np.indices(mask.shape)
        center=1.7-((xx/mask.shape[1]-.5)**2+(yy/mask.shape[0]-.5)**2)*2.4
        areas=np.bincount(components.ravel(),weights=center.ravel())
        target=components==np.argmax(areas[1:])+1
        top=np.argmax(target,axis=0)
        bottom=mask.shape[0]-np.argmax(target[::-1],axis=0)
        chosen=ndimage.binary_erosion(target)&(yy>top+.14*(bottom-top))
        if chosen.sum()<max(200,chosen.size*.055):return None
        rgb=np.asarray(image.convert('RGB').resize((mask.shape[1],mask.shape[0]),Image.Resampling.BOX))
        bands=source_bands(rgb[chosen])
        if bands is None:return None
    return building,bands,info


def facilities_observations(source_bands,blocks,architecture,labels,street):
    candidates=matched_buildings(blocks,architecture,labels)
    with ThreadPoolExecutor(max_workers=4) as pool:
        return [record for record in pool.map(lambda pair:image_tones(source_bands,pair),((k,v) for k,v in candidates.items() if k not in street)) if record]
