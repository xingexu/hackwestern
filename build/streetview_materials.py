import base64
import io
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image
from facilities_materials import facilities_observations


WEB = Path(__file__).resolve().parents[1]/'web'
LUMA = np.array([.2126, .7152, .0722])


def pixels(encoded):
    with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
        return np.asarray(image).copy()


def surface_bands(rgb):
    color = rgb.reshape(-1, 3).astype(float)/255
    light = color @ LUMA
    r,g,b = color.T
    mask = (light > .075) & (light < .96) & (g < np.maximum(r,b)*1.14+.018) & (b < r*1.60+.065)
    color,light = color[mask],light[mask]
    if len(light) < 95:
        return None
    a,b,c,d = np.quantile(light, [.10,.34,.53,.84])
    if d-a < .08:
        return None
    dark = np.median(color[(light>=a)&(light<=b)],axis=0)
    light_color = np.median(color[(light>=c)&(light<=d)],axis=0)
    return np.stack([dark,light_color])


def building_materials(tiles, sources=None):
    observations=defaultdict(lambda:defaultdict(list))
    for tile in tiles:
        sheet=pixels(tile['image'])
        size=tile['size']
        for panel in tile['panels']:
            u,v,uu,vv=np.rint(np.array(panel[8:12])*size).astype(int)
            crop=sheet[v:vv,u:uu]
            visible=crop[:,:,3]>=210
            if visible.sum()<150:
                continue
            tones=surface_bands(crop[:,:,:3][visible])
            if tones is not None:
                observations[panel[13]][panel[12]].append(tones)
    architecture=json.loads((WEB/'region-detail.json').read_bytes())['architecture']
    region=json.loads((WEB/'campus-region.json').read_bytes())
    world=json.loads((WEB/'world.json').read_bytes())
    provenance={building:dict(kind='street',frames=sorted(map(str,frames))) for building,frames in observations.items()}
    for building,bands,info in facilities_observations(surface_bands,region['blocks'],architecture,[*region['labels'],*world['labels']],observations):
        observations[building]['facilities'].append(bands)
        provenance[building]=info
    atlas=architecture['atlas']
    styles=[f['name'] for f in atlas['forms']]
    from architecture import BAYS
    references=[]
    for name in styles:
        wall,glass=BAYS[name][2:4]
        references.append(np.array([[(color>>shift)&255 for shift in (16,8,0)] for color in (glass,wall)])/255)
    building_styles=[style for style,_ in architecture['forms']]+[styles.index(item[0]) for item in architecture['core']]
    materials={}
    for building,frames in observations.items():
        base=references[building_styles[building]]
        if base is None:
            continue
        observed=np.median([np.median(patches,axis=0) for patches in frames.values()],axis=0)
        shift=np.log2((observed+.035)/(base+.035))
        exposure=shift@LUMA
        confidence=min(.86,.51+.115*np.log2(len(frames)+1))
        daylight=np.clip(exposure[1],-.24,.28)*.50
        contrast=np.array([np.clip(exposure[0]-exposure[1],-.40,.40)*.58,0])
        gains=2.15*confidence*((shift-exposure[:,None])*.86+(daylight+contrast)[:,None])
        gains=np.clip(gains,-.88,.88)
        reference=((base+.055)/1.055)**2.4 @ LUMA
        materials[str(building)]=np.round(np.r_[gains.ravel(),reference],4).tolist()
        if sources is not None:
            sources[str(building)]=provenance[building]
    return materials


if __name__=='__main__':
    manifest=json.loads((WEB/'streetview-facades.json').read_bytes())
    sources={}
    raw=json.loads((WEB.parent/'data/streetview/wall-observations.json').read_bytes())
    assert all('image' not in tile for tile in manifest['tiles'])
    expected=building_materials(raw['tiles'],sources)
    assert expected==manifest['materials']
    ids={str(panel[13]) for tile in raw['tiles'] for panel in tile['panels']}
    assert sources==manifest['materialSources']
    street={i for i,v in sources.items() if v['kind']=='street'}
    facilities={i for i,v in sources.items() if v['kind']=='facilities'}
    from campus_bounds import footprint
    from shapely.geometry import Point
    campus=footprint()
    assert street<=ids and len(street)>.65*len(ids) and set(expected)==street|facilities
    surveyed={'Arts & Humanities Building','Dental Sciences Building','Facilities Management','Lawson Hall','Somerville House','Stevenson Hall','Taylor Library (Allyn & Betty)','University College','University Community Centre','West Valley Building','Ausable Hall Residence'}
    assert surveyed<={v['name'] for v in sources.values() if v['kind']=='facilities'}
    for i in street:
        assert set(sources[i]['frames'])<=set(raw['frames'])
    for i in facilities:
        item=sources[i]
        assert campus.covers(Point(item['pin']))
        assert item['name'] and item['url'].startswith('https://www.uwo.ca/fm/') and len(item['pin'])==2
    for values in expected.values():
        assert len(values)==8 and 0<values[6]<values[7]<1 and np.max(np.abs(values[:6]))<=.88
    print(f'{len(street)} street-registered and {len(facilities)} identity-matched Western Facilities building material responses verified')
