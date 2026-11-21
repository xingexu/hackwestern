import json
import math
import sys

import numpy as np
from scipy import ndimage
import shapely
from shapely.geometry import Polygon, box

import campus_region as region
import geo
from street_finishes import terrain_axis


OUT=region.OUT.with_name('driving-horizon.json')


def polygon(data):
    return shapely.union_all([Polygon(np.array(p[0]).reshape(-1,2),[np.array(h).reshape(-1,2) for h in p[1:]]) for p in data['polygons']])


def elevations(coords):
    import rasterio
    cache=region.CACHE/'horizon-heights-dtm.npy'
    if cache.exists():
        terrain=np.load(cache)
        x,z=coords.T
        u=(x-region.X0+1350)/(region.X1-region.X0+2700)*(terrain.shape[1]-1)
        v=(z-region.Z0+1350)/(region.Z1-region.Z0+2700)*(terrain.shape[0]-1)
        return ndimage.map_coordinates(terrain,[v,u],order=1,mode='nearest')
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR'),rasterio.open(region.LIDAR.format('dtm')) as raster:
        x,z=coords.T
        lon,lat=geo.WEST+x/geo.METERS_PER_DEGREE_LON,geo.NORTH-z/geo.METERS_PER_DEGREE_LAT
        from rasterio.warp import transform
        east,north=transform('EPSG:4326',raster.crs,lon,lat)
        return np.array([float(p[0]) for p in raster.sample(zip(east,north))])


def campus_water(parcel):
    network=json.loads(OUT.with_name('drive-network.json').read_bytes())
    terrain=region.lidar('dtm')
    level_origin=ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4
    records=[]
    for rings in network['water']:
        shape=Polygon(np.reshape(rings[0],(-1,2)),[np.reshape(h,(-1,2)) for h in rings[1:]]).buffer(0).intersection(parcel)
        if shape.area<8:continue
        l,t,r,b=shape.bounds
        xs=np.arange(l,r+6,6)
        zs=np.arange(t,b+6,6)
        cells=shapely.box(*[np.asarray(a).ravel() for a in np.broadcast_arrays(xs[:-1,None],zs[None,:-1],xs[1:,None],zs[None,1:])])
        pieces=shapely.get_parts(shapely.intersection(cells[shapely.intersects(cells,shape)],shape))
        triangles=shapely.get_parts(shapely.constrained_delaunay_triangles(pieces[shapely.get_type_id(pieces)==3]))
        verts=shapely.get_coordinates(triangles).reshape(-1,4,2)[:,:3,:].reshape(-1,2)
        pts,idx=np.unique(np.round(verts,4),axis=0,return_inverse=True)
        y=region.sample(terrain,*pts.T)-level_origin
        levels=[]
        for x,z in pts:
            near=np.hypot(pts[:,0]-x,pts[:,1]-z)<27
            levels.append(float(np.percentile(y[near],34))+.10)
        records.append(dict(vertices=np.column_stack([pts[:,0],levels,pts[:,1]]).round(4).tolist(),indices=idx.tolist()))
    return records


def build():
    model=json.loads(region.OUT.read_bytes())
    parcel=polygon(json.loads(OUT.with_name('campus-boundary.json').read_bytes()))
    edge=model['zs'][-1]
    wedge=parcel.difference(box(model['xs'][0],model['zs'][0],model['xs'][-1],edge))
    l,t,r,b=wedge.bounds
    assert t>edge-.01 and b>edge
    source=terrain_axis(model['xs'],geo.WIDTH,model['xs'][0],model['xs'][-1])
    xs=np.r_[l,source[(source>l)&(source<r)],r]
    zs=np.linspace(edge,b,math.ceil((b-edge)/5)+1)
    cells=shapely.box(*[np.asarray(a).ravel() for a in np.broadcast_arrays(xs[:-1,None],zs[None,:-1],xs[1:,None],zs[None,1:])])
    pieces=shapely.get_parts(shapely.intersection(cells[shapely.intersects(cells,wedge)],wedge))
    triangles=shapely.get_parts(shapely.constrained_delaunay_triangles(pieces[shapely.get_type_id(pieces)==3]))
    verts=shapely.get_coordinates(triangles).reshape(-1,4,2)[:,:3,:].reshape(-1,2)
    points,indices=np.unique(np.round(verts,4),axis=0,return_inverse=True)
    datum=ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4
    heights=elevations(points)-datum
    shore=elevations(np.stack((points[:,0],np.full(len(points),edge)),axis=1))-datum
    vertices=np.column_stack([points[:,0],heights,points[:,1],shore]).round(4)
    data=dict(source=region.LIDAR.format('dtm'),area=round(wedge.area,2),edge=edge,vertices=vertices.tolist(),indices=indices.tolist(),water=campus_water(parcel))
    pending=OUT.with_suffix('.tmp')
    pending.write_text(json.dumps(data,separators=(',',':')))
    pending.replace(OUT)


def check():
    data=json.loads(OUT.read_bytes())
    parcel=polygon(json.loads(OUT.with_name('campus-boundary.json').read_bytes()))
    model=json.loads(region.OUT.read_bytes())
    wedge=parcel.difference(box(model['xs'][0],model['zs'][0],model['xs'][-1],model['zs'][-1]))
    triangles=np.asarray(data['vertices'])[np.asarray(data['indices']).reshape(-1,3)][:,:,[0,2]]
    coverage=shapely.union_all(shapely.polygons(triangles))
    assert coverage.symmetric_difference(wedge).area<.15
    assert abs(data['area']-wedge.area)<.01 and set(data)=={'source','area','edge','vertices','indices','water'}
    water=[shapely.polygons(np.asarray(c['vertices'])[np.asarray(c['indices']).reshape(-1,3)][:,:,[0,2]]) for c in data['water']]
    surface=shapely.union_all(np.concatenate(water))
    from shapely.geometry import Point
    assert surface.covers(Point(720,390)) and surface.difference(parcel).area<.04
    print(f"{len(triangles):,} terrain triangles cover the campus parkland beyond the survey grid ({wedge.area:,.0f} m²).")


if __name__=='__main__':
    if '--check' not in sys.argv:build()
    check()
