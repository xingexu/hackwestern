import base64
import json
import zlib

import numpy as np
import shapely

import campus_region as region


def unpack(blob,dtype,width):
    return np.frombuffer(zlib.decompress(base64.b64decode(blob)),dtype).reshape(-1,width)


def pack(data,dtype):
    return base64.b64encode(zlib.compress(np.asarray(data,dtype=dtype).tobytes(),8)).decode()


def join(context):
    site=json.loads(region.OUT.with_name('campus-boundary.json').read_bytes())['bounds']
    west,north,east,south=site
    survey=json.loads((region.OUT.parent/'look/landscape-data.mjs').read_text().removeprefix('export default ').strip().removesuffix(';'))
    x0,z0=max(region.X0,west-500),max(region.Z0,north-500)
    x1,z1=min(region.X1,east+500),min(survey['bounds'][3],south+500)
    points=unpack(context['vertices'],'<f4',4)
    faces=unpack(context['indices'],'<u4',3)
    sides=np.concatenate([faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]]])
    sides,counts=np.unique(np.sort(sides,axis=1),axis=0,return_counts=True)
    sides=sides[(counts==1)&(points[sides[:,0],3]>19)&(points[sides[:,1],3]>19)]
    ends=points[sides][:,:,[0,2]]
    lines=shapely.linestrings(ends)
    shells=shapely.get_parts(shapely.polygonize(lines))
    assert len(shells) and shapely.area(shells).max()>3e6
    near=shapely.union_all(shells)
    bounds=shapely.box(x0,z0,x1,z1)
    domain=shapely.difference(bounds,near)
    xs=np.linspace(x0,x1,int(np.ceil((x1-x0)/12))+1)
    zs=np.linspace(z0,z1,int(np.ceil((z1-z0)/12))+1)
    cells=shapely.box(*(a.ravel() for a in np.broadcast_arrays(xs[:-1,None],zs[None,:-1],xs[1:,None],zs[None,1:])))
    parts=shapely.get_parts(shapely.intersection(cells[shapely.intersects(cells,domain)],domain))
    tiles=shapely.get_parts(shapely.constrained_delaunay_triangles(parts[shapely.get_type_id(parts)==3]))
    assert abs(shapely.area(tiles).sum()-domain.area)<.01
    vertices,indices=np.unique(shapely.get_coordinates(tiles).reshape(-1,4,2)[:,:3].reshape(-1,2),axis=0,return_inverse=True)
    heights=np.full(len(vertices),np.nan)
    seam=shapely.STRtree(lines)
    vi,si=seam.query(shapely.points(vertices),predicate='dwithin',distance=.0001)
    delta=ends[si,1]-ends[si,0]
    t=np.sum((vertices[vi]-ends[si,0])*delta,axis=1)/np.sum(delta*delta,axis=1)
    heights[vi]=points[sides[si,0],1]+t*(points[sides[si,1],1]-points[sides[si,0],1])
    assert np.isfinite(heights).sum()>900
    vertices=np.column_stack([vertices[:,0],heights,vertices[:,1]])
    tris=indices.reshape(-1,3)
    corners=vertices[tris][:,:,[0,2]]
    d=corners[:,1:]-corners[:,:1]
    swap=d[:,0,0]*d[:,1,1]>d[:,0,1]*d[:,1,0]
    tris[swap]=tris[swap][:,[0,2,1]]
    trees=unpack(survey['trees'],'<i2',5)
    near_trees=unpack(context['trees'],'<f4',4)
    existing={tuple(p) for p in np.rint(2*near_trees[:,:2]).astype(int)}
    pts=points[:,[0,2]]
    tree_faces=shapely.STRtree(shapely.polygons(pts[faces]))
    def bindings(sites):
        anchors=[]
        for i,p in sites:
            hit=tree_faces.query(shapely.Point(p),predicate='intersects')
            if not len(hit):
                continue
            a,b,c=faces[hit[0]]
            u,v=np.linalg.solve(np.stack([pts[b]-pts[a],pts[c]-pts[a]],axis=1),p-pts[a])
            anchors.append([i,a,b,c,u,v])
        return pack(anchors,'<f4')
    retained=((i,t[:2]*.5) for i,t in enumerate(trees) if tuple(t[:2]) not in existing)
    return dict(vertices=pack(vertices,'<f4'),indices=pack(tris,'<u4'),stems=bindings(retained),
                nearStems=bindings(enumerate(near_trees[:,:2])))



if __name__=='__main__':
    target=region.OUT.with_name('ground-materials.json')
    data=json.loads(target.read_bytes())
    context=data['landcover']['context']
    context['backdrop']=join(context)
    target.write_text(json.dumps(data,separators=(',',':')))
