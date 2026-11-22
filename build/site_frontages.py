import json
from functools import lru_cache
from pathlib import Path

import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import LineString,Polygon,box


MATERIAL={'planting':1,'walk':3,'gravel':4,'drive':5,'traffic':5}


@lru_cache(maxsize=1)
def observations():
    rows=json.loads(Path(__file__).with_name('survey_site_frontages.json').read_bytes())
    polygons=[Polygon(row['outline']) for row in rows]
    for row,polygon in zip(rows,polygons):
        if not polygon.is_valid:raise ValueError((row['name'],shapely.is_valid_reason(polygon)))
    return rows,shapely.STRtree(polygons)


def mask(bounds,size):
    rows,tree=observations()
    ids=tree.query(box(*bounds),predicate='intersects')
    if not len(ids):return None
    w,h=size
    l,t,r,b=bounds
    transform=Affine.translation(l,t)*Affine.scale((r-l)/w,(b-t)/h)
    return rasterize([(tree.geometries[i],MATERIAL[rows[i]['kind']]) for i in sorted(ids)],out_shape=(h,w),transform=transform,dtype='uint8')


@lru_cache(maxsize=6)
def geometry(kind):
    rows,tree=observations()
    return shapely.union_all([tree.geometries[i] for i,r in enumerate(rows) if r['kind']==kind])


def finish_samples(bounds,size,areas):
    from parking_archive import dated_pigment
    rows,tree=observations()
    left,top,right,bottom=bounds
    width,height=size
    dx,dz=(right-left)/width,(bottom-top)/height
    packet=np.zeros((height,width,2),dtype='uint8')
    lots=shapely.union_all([Polygon(np.reshape(a['rings'][0],(-1,2)),[np.reshape(r,(-1,2)) for r in a['rings'][1:]]) for a in areas if a['kind']=='parking'])
    colors={}
    for index,(row,poly) in enumerate(zip(rows,tree.geometries)):
        if row['kind'] not in ('drive','traffic'):continue
        west,north,east,south=poly.bounds
        xs,zs=np.meshgrid(np.arange(west+.3,east,.8),np.arange(north+.3,south,.8))
        points=np.column_stack((xs.ravel(),zs.ravel()))
        points=points[shapely.contains_xy(poly,*points.T)]
        rgb=dated_pigment(points,row['year'])
        light=.3*rgb[:,0]+.55*rgb[:,1]+.15*rgb[:,2]
        visible=(light>112)&(light<228)&(np.ptp(rgb,axis=1)<40)
        if visible.sum()<10:continue
        tone=np.median(light[visible])
        lightness=np.clip((tone-131)/70,0,1)
        tint=.38+.49*lightness
        if row['kind']=='traffic':
            parking_share=poly.intersection(lots).area/poly.area
            tint=.41+.30*lightness-.20*parking_share
        colors[index]=round(tint*255)
    factor=8
    for j in range(0,height,64):
        for i in range(0,width,64):
            w,h=min(64,width-i),min(64,height-j)
            x,z=left+i*dx,top+j*dz
            touching=sorted(tree.query(box(x,z,x+w*dx,z+h*dz),predicate='intersects'))
            if not touching:continue
            transform=Affine.translation(x,z)*Affine.scale(dx/factor,dz/factor)
            source=rasterize([(tree.geometries[k],k+1) for k in touching],out_shape=(h*factor,w*factor),transform=transform,dtype='uint16')
            counts=np.zeros((h,w),dtype='uint8')
            tile=packet[j:j+h,i:i+w]
            for k in touching:
                coverage=(source==k+1).reshape(h,factor,w,factor).sum(axis=(1,3))
                keep=coverage>counts
                counts[keep]=coverage[keep]
                kind=rows[k]['kind']
                label=6 if kind=='traffic' else MATERIAL[kind]
                tile[:,:,0][keep]=(np.rint(coverage[keep]*31/factor**2).astype('uint8')<<3)|label
                tile[:,:,1][keep]=colors.get(k,0)
    return packet


def registered_kerbs(previous):
    rows,tree=observations()
    measured=[(LineString(line),side) for row in rows for line,side in row.get('kerbs',[])]
    replaced=shapely.union_all([poly.buffer(-.38) for poly in tree.geometries]+[line.buffer(.55) for line,_ in measured])
    result=[]
    for flat,side in previous:
        line=LineString(np.asarray(flat).reshape(-1,2))
        if not line.intersects(replaced):
            result.append([flat,side])
            continue
        for part in shapely.get_parts(line.difference(replaced)):
            if part.geom_type=='LineString' and part.length>=1.1:
                result.append([np.asarray(part.coords).round(2).ravel().tolist(),side])
    return result+[[np.asarray(line.coords).ravel().tolist(),side] for line,side in measured]


@lru_cache(maxsize=1)
def exposed_core():
    import geo
    material=mask((0,0,geo.WIDTH,geo.DEPTH),(geo.WIDTH,geo.DEPTH))
    distance=ndimage.distance_transform_edt(material==0)
    exposure=np.clip(1-distance/3,0,1)
    return np.rint(255*exposure*exposure*(3-2*exposure)).astype('uint8')


def exposed_rows():
    rows=[]
    for z,line in enumerate(exposed_core()):
        edges=np.flatnonzero(np.diff(line,prepend=0,append=0))
        for start,end in zip(edges,edges[1:]):
            weight=line[start]
            if weight:rows.append([z,int(start),int(end),int(weight)])
    return rows
