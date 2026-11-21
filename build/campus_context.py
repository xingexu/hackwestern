import base64
import json
import zlib

import numpy as np
import shapely
from scipy import ndimage
from rasterio import Affine
from rasterio.features import rasterize
from shapely.geometry import LineString,Polygon,box

import campus_region as region
import geo
from campus_bounds import footprint
from backdrop_join import join
from driving_horizon import elevations


def packed(values,dtype):
    return base64.b64encode(zlib.compress(np.asarray(values,dtype=dtype).tobytes(),8)).decode()


def context():
    site=footprint()
    ring=site.buffer(275,quad_segs=4).difference(site)
    left,top,right,bottom=ring.bounds
    xs=np.arange(left,right+8,8)
    zs=np.arange(top,bottom+8,8)
    x,z=np.meshgrid(xs[:-1],zs[:-1])
    grid=shapely.box(x.ravel(),z.ravel(),x.ravel()+8,z.ravel()+8)
    active=grid[shapely.intersects(grid,ring)]
    pieces=shapely.get_parts(shapely.intersection(active,ring))
    faces=shapely.get_parts(shapely.constrained_delaunay_triangles(pieces[shapely.get_type_id(pieces)==3]))
    corners=shapely.get_coordinates(faces).reshape(-1,4,2)[:,:3].reshape(-1,2)
    pts,idx=np.unique(np.round(corners,4),axis=0,return_inverse=True)
    datum=ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4
    height=elevations(pts)-datum
    distance=shapely.distance(shapely.points(pts),site)
    elements=json.loads((region.CACHE/'map.json').read_bytes())['elements']
    extra=region.CACHE/'platt-campus-edge.json'
    if extra.exists():
        elements+=json.loads(extra.read_bytes())['elements']
    nodes={e['id']:geo.to_grid(e['lat'],e['lon']) for e in elements if e['type']=='node'}
    land=[]
    streets=[]
    for e in {e['id']:e for e in elements if e['type']=='way'}.values():
        t=e.get('tags',{})
        coords=[nodes[n] for n in e['nodes'] if n in nodes]
        if len(coords)<2:
            continue
        if len(coords)>3 and coords[0]==coords[-1]:
            kind=2 if t.get('natural') in ('wood','scrub') or t.get('landuse')=='forest' else 4 if t.get('natural')=='water' or 'water' in t or t.get('waterway')=='riverbank' else 1 if t.get('amenity')=='parking' else 3 if t.get('surface') in ('concrete','paving_stones') else 0
            if kind:
                land.append((Polygon(coords).buffer(0),kind))
        road=t.get('highway')
        if road and road not in ('construction','proposed'):
            walk=road in ('path','footway','pedestrian','steps','cycleway','track')
            width=2 if walk else {'primary':14,'secondary':11,'tertiary':9,'residential':7,'service':4}.get(road,7)
            shape=LineString(coords).buffer(width/2,quad_segs=3)
            if not walk and not t.get('bridge'):
                shape=shape.difference(box(region.X0,region.Z0,region.X1,region.Z1))
            if not shape.is_empty:
                streets.append((shape,3 if walk else 1))
    net=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    for water in net['water']:
        shell,*holes=[np.reshape(r,(-1,2)) for r in water]
        land.append((Polygon(shell,holes),4))
    h,w=round(bottom-top),round(right-left)
    transform=Affine.translation(left,top)*Affine.scale((right-left)/w,(bottom-top)/h)
    shapes=[*land,*streets]
    cover=rasterize(shapes,out_shape=(h,w),transform=transform,dtype='uint8')
    masks=np.empty((h,w,4),np.uint8)
    oversample=4
    tree=shapely.STRtree([shape for shape,_ in shapes])
    for row in range(0,h,96):
        rows=min(96,h-row)
        north=top+row*transform.e
        south=north+rows*transform.e
        window=box(left,north,right,south)
        order=np.sort(tree.query(window,predicate='intersects'))
        pixels=np.zeros((rows*oversample,w*oversample),np.uint8)
        if len(order):
            rasterize([shapes[i] for i in order],out=pixels,
                      transform=transform*Affine.translation(0,row)*Affine.scale(1/oversample))
        cells=pixels.reshape(rows,oversample,w,oversample)
        for layer,kind in enumerate((1,2,3,4)):
            coverage=np.mean(cells==kind,axis=(1,3))
            masks[row:row+rows,:,layer]=np.rint(coverage*255)

    model=json.loads(region.OUT.read_bytes())
    canopy=region.lidar('dsm')-region.lidar('dtm')
    c=ndimage.uniform_filter((canopy>3.8).astype('float32'),7)
    roof=rasterize([(Polygon(np.reshape(p,(-1,2)),[np.reshape(q,(-1,2)) for q in holes]).buffer(2),1) for p,holes,*_ in model['blocks']],out_shape=(h,w),transform=transform,dtype='uint8')
    for row in range(0,h,192):
        zz=top+(np.arange(row,min(row+192,h))+.5)*(bottom-top)/h
        xx=left+(np.arange(w)+.5)*(right-left)/w
        x,z=np.meshgrid(xx,zz)
        sampled=region.sample(c,x.ravel(),z.ravel()).reshape(x.shape)
        wooded=(sampled>.55)&(x>=region.X0)&(x<region.X1)&(z>=region.Z0)&(z<region.Z1)
        tile=cover[row:row+len(zz)]
        exposed=(tile==0)&(roof[row:row+len(zz)]==0)&(x>=region.X0)&(x<region.X1)&(z>=region.Z0)&(z<region.Z1)
        tile[exposed&wooded]=2
        forest=masks[row:row+len(zz),:,1]
        density=np.rint(np.clip((sampled-.35)/.40,0,1)*255).astype(np.uint8)
        forest[exposed]=np.maximum(forest[exposed],density[exposed])
    tree_faces=shapely.STRtree(faces)
    ys=height[idx].reshape(-1,3)
    tree_corners=corners.reshape(-1,3,2)
    trees=[]
    for x,y,z,hgt,*rest in model['trees']:
        p=shapely.Point(x,z)
        if not ring.covers(p) or site.distance(p)<max(2,hgt*.28) or site.distance(p)>180:
            continue
        hits=tree_faces.query(p,predicate='intersects')
        if not len(hits):continue
        i=hits[0]
        a,b,c=tree_corners[i]
        uv=np.linalg.solve(np.column_stack([b-a,c-a]),np.array([x,z])-a)
        base=ys[i,0]+np.dot(uv,ys[i,1:]-ys[i,0])
        trees.append([x,z,hgt,round(float(base),3)])
    mesh=dict(bounds=[left,top,right,bottom],size=[w,h],cover=packed(cover,'u1'),coverage=packed(masks,'u1'),vertices=packed(np.column_stack([pts[:,0],height,pts[:,1],np.minimum(distance,20)]),'<f4'),
                indices=packed(idx,'<u4'),trees=packed(trees,'<f4'))
    mesh['backdrop']=join(mesh)
    return mesh
