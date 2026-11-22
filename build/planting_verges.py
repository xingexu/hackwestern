import json
from functools import lru_cache

import cv2
import numpy as np
import shapely
from shapely.geometry import LineString,Polygon
from shapely.geometry.polygon import orient

import campus_region as region
from campus_bounds import footprint
from ortho_road_paint import rgb_tile
from parcel_surfaces import cartography
from parking_archive import archive

OUT=region.OUT.parents[1]/'build/survey_planting_verges.json'
YEARS=(2025,2024,2021,2020)


@lru_cache(maxsize=20)
def averaged_photo(year,x,z):
    photo=rgb_tile(x,z) if year==2025 else archive(year,x,z)
    return cv2.blur(photo,(5,5))


def material_fractions(face):
    west,north,east,south=face.bounds
    x,z=np.meshgrid(np.arange(west+.275,east,.55),np.arange(north+.275,south,.55))
    inside=shapely.contains_xy(face,x,z)
    points=np.column_stack([x[inside],z[inside]])
    if len(points)<8:return
    cells=np.floor(points/150).astype(int)*150
    colors=np.empty((len(YEARS),len(points),3),'float32')
    for tile in np.unique(cells,axis=0):
        keep=(cells==tile).all(axis=1)
        u,v=np.floor((points[keep]-tile)*10).astype(int).T
        for i,year in enumerate(YEARS):
            colors[i,keep]=averaged_photo(year,*tile)[v,u]
    red,green,blue=colors.transpose(2,0,1)
    light=.29*red+.55*green+.16*blue
    living=(green>red+1)&(green>blue+13)&(light<185)
    dormant=(red-blue>11+.115*light)&(green-blue>5+.078*light)&(light<186)
    mineral=(np.abs(green-red)<10)&(red-blue<7+.105*light)&(green-blue<6+.085*light)&(light>145)
    clear=light>74
    counts=np.maximum(1,clear.sum(axis=1))
    return ((living|dormant)&clear).sum(axis=1)/counts,mineral.sum(axis=1)/counts


def confirmed_planting(face,edges):
    if not 4<face.area<2400:return False
    rim=face.boundary
    near=edges.query(rim,predicate='dwithin',distance=.32)
    if not len(near):return False
    kerbs=shapely.union_all(edges.geometries[near]).buffer(.32,quad_segs=2)
    traced=rim.intersection(kerbs).length/rim.length
    if traced<.18 or (face.minimum_rotated_rectangle.length**2/face.area<=19 and traced<.44):return False
    interior=face.buffer(-.24)
    if interior.is_empty:return False
    fractions=material_fractions(interior)
    if fractions is None:return False
    grass,stone=fractions
    if not face.buffer(-3.2).is_empty and (np.median(grass)<.70 or np.max(stone)>.23):return False
    return max(grass[:2])>.56 and np.count_nonzero(grass>.37)>=2 and np.median(stone)<.28 and max(stone)<.42


def aerial_samples(points):
    cells=np.floor(points/150).astype(int)*150
    colors=np.empty((len(points),len(YEARS),3),'float32')
    for tile in np.unique(cells,axis=0):
        keep=(cells==tile).all(axis=1)
        u,v=np.floor((points[keep]-tile)*10).astype(int).T
        for i,year in enumerate(YEARS):
            photo=rgb_tile(*tile) if year==2025 else archive(year,*tile)
            colors[keep,i]=photo[v,u]
    return colors


def registered_edge_vertices(coords):
    ring=np.asarray(coords)[:-1]
    deltas=np.roll(ring,-1,axis=0)-ring
    lengths=np.linalg.norm(deltas,axis=1)
    axes=deltas/np.maximum(.001,lengths)[:,None]
    normals=axes[:,[1,0]]*[1,-1]
    shifts=np.zeros(len(ring))
    weights=np.zeros(len(ring))
    steps=np.arange(-.78,.79,.06)
    offsets=steps[:,None]+np.array([-.27,-.17,-.07,.07,.17,.27])[None,:]
    luminance=np.array([.29,.55,.16])
    foliage=np.array([-.40,1.,-.60])
    for i,(point,axis,normal,length) in enumerate(zip(ring,axes,normals,lengths)):
        if length<1.55:
            continue
        count=min(65,max(6,round(length/.65)))
        stations=point+np.linspace(.45,length-.45,count)[:,None]*axis
        positions=stations[None,:,None,:]+offsets[:,None,:,None]*normal
        rgb=aerial_samples(positions.reshape(-1,2)).reshape(len(steps),count,6,len(YEARS),3)
        inside=rgb[:,:,:3].mean(axis=2)
        outside=rgb[:,:,3:].mean(axis=2)
        strength=(outside-inside)@luminance+(inside-outside)@foliage*.90
        profiles=np.quantile(strength,.58,axis=1)
        peaks=np.argmax(profiles,axis=0)
        best=steps[peaks]
        maximum=profiles[peaks,np.arange(len(YEARS))]
        present=(maximum>10)&(np.abs(best-best[0])<.36)
        if maximum[0]<11 or present.sum()<2:
            continue
        shifts[i]=.65*best[0]+.35*np.median(best[present])
        weights[i]=min(1,(np.median(maximum[present])-8)/20)
    moved=[]
    for i,point in enumerate(ring):
        incident=[i-1,i]
        normal=normals[incident]
        weight=weights[incident]
        target=normal.T@(weight*shifts[incident])
        system=normal.T@(weight[:,None]*normal)+np.eye(2)*.045
        delta=np.linalg.solve(system,target)
        moved.append(point+delta*min(1,.77/max(.001,np.linalg.norm(delta))))
    return np.asarray(moved)


def registered_face(poly):
    original=orient(poly,sign=1.)
    rings=[registered_edge_vertices(r.coords) for r in (original.exterior,*original.interiors)]
    new=Polygon(rings[0],rings[1:])
    if not new.is_valid or not .82<new.area/poly.area<1.18:return poly
    return new


def survey():
    site=footprint()
    network=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    layers=cartography(network,site)
    records=[]
    for face in layers['faces'].geometries:
        if not confirmed_planting(face,layers['side']):continue
        simple=registered_face(face.simplify(.065))
        rings=[np.asarray(edge.coords)[:-1].round(2).tolist() for edge in [simple.exterior,*simple.interiors]]
        records.append(rings)
    OUT.write_text(json.dumps(records,separators=(',',':')))
    print(len(records),'cadastral planting strips confirmed by repeated municipal aerial photography.')


@lru_cache(maxsize=1)
def planting_polygons():
    shapes=[Polygon(outer,holes) for outer,*holes in json.loads(OUT.read_bytes())]
    furniture=json.loads(OUT.with_name('survey_furniture.json').read_bytes())
    measured=[(flat,width) for flat,height,width,*finish in furniture.get('sitePlantings',[])+furniture.get('bedRows',[])]
    measured.extend((flat,width) for garden in furniture['gardens'] for flat,width,*rest in garden['beds'])
    for flat,width in measured:
        center=LineString(np.reshape(flat,(-1,2)))
        shapes.append(center.buffer(width*.51,cap_style='flat',join_style='round'))
    return shapely.STRtree(shapes)


def mask(frame,size):
    from affine import Affine
    from rasterio.features import rasterize
    from shapely.geometry import box
    west,north,east,south=frame
    width,height=size
    tree=planting_polygons()
    ids=tree.query(box(*frame),predicate='intersects')
    if not len(ids):return np.zeros((height,width),bool)
    transform=Affine.translation(west,north)*Affine.scale((east-west)/width,(south-north)/height)
    return rasterize(tree.geometries[ids],out_shape=(height,width),transform=transform,dtype='uint8')>0


if __name__=='__main__':
    survey()
