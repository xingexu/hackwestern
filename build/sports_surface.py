import json
import math
import numpy as np
from scipy import ndimage
from rasterio import Affine
from rasterio.features import shapes
from shapely.geometry import Polygon,shape

import campus_region as region
from ground_observations import orthophoto


def surveyed_sports():
    l,t,r,b=170,1160,310,1360
    rgb=np.asarray(orthophoto((l,t,r,b),(4*(r-l),4*(b-t))),dtype=np.int16)
    red,green,blue=rgb.transpose(2,0,1)
    purple=(green>65)&(green<170)&(red>green+4)&(blue>green+3)&(red<green+25)
    solid=ndimage.binary_closing(purple,iterations=3)
    labels,n=ndimage.label(solid)
    largest=1+np.argmax(np.bincount(labels.ravel(),minlength=n+1)[1:])
    mask=ndimage.binary_opening(labels==largest,iterations=2)
    solids=sorted([shape(g) for g,_ in shapes(mask.astype(np.uint8),mask=mask,transform=Affine.translation(l,t)*Affine.scale(.25))],key=lambda g:-g.area)
    track=solids[0].simplify(.26,preserve_topology=True)
    rings=[np.round(np.asarray(ring.coords),2).tolist() for ring in [track.exterior,*track.interiors] if Polygon(ring).area>2.5]
    rugby=[[154,1474.8],[231.5,1432.0],[295.4,1545.3],[215.7,1589.1]]
    soccer=[[240.6,1434.5],[367.5,1366.6],[406.0,1436.3],[279.3,1501.0]]
    return dict(track=rings,synthetic=[rugby,soccer],trackBounds=[l,t,r,b],bleachers=[[175,1520,-1.09],[181,1532,-1.09],[188,1545,-1.09]])


def stadium_lanes(sports):
    from scipy.optimize import least_squares
    from shapely.geometry import LineString
    border=LineString(max(sports['track'][1:],key=lambda r:Polygon(r).area))
    points=np.array([border.interpolate(d).coords[0] for d in np.arange(0,border.length,.75)])
    center=points.mean(axis=0)
    _,_,axes=np.linalg.svd(points-center,full_matrices=False)
    angle=np.arctan2(*axes[0,::-1])
    def residual(params):
        x,z,theta,half,radius=params
        axis=np.array([np.cos(theta),np.sin(theta)])
        offset=points-[x,z]
        projection=np.clip((offset*axis).sum(axis=1),-half,half)
        return np.linalg.norm(offset-projection[:,None]*axis,axis=1)-radius
    guess=least_squares(residual,[*center,angle,43,36],loss='soft_l1',f_scale=.35).x
    def loop(params,width,steps=80):
        x,z,angle,length,radius=params
        axis=np.array([np.cos(angle),np.sin(angle)])
        side=np.array([-axis[1],axis[0]])
        start,end=np.array([x,z])-length*axis,np.array([x,z])+length*axis
        arcs=np.linspace(-np.pi*.5,np.pi*.5,steps,endpoint=False)
        rad=radius+width
        arc=(np.cos(arcs)[:,None]*axis+np.sin(arcs)[:,None]*side)*rad
        straight=np.linspace(start,end,steps,endpoint=False)
        reverse=np.linspace(end,start,steps,endpoint=False)
        return np.vstack([straight-rad*side,end+arc,reverse+rad*side,start-arc])
    l,t,r,b=sports['trackBounds']
    import cv2
    source=np.asarray(orthophoto((l,t,r,b),(int((r-l)*4),int((b-t)*4))),dtype='float32')
    luminance=.29*source[:,:,0]+.55*source[:,:,1]+.16*source[:,:,2]
    contrast=luminance-cv2.GaussianBlur(luminance,(0,0),1.25)
    def score(params):
        probes=np.concatenate([loop(params,width,48) for width in np.arange(9)*1.22])
        uv=((probes-[l,t])*4-.5).astype('float32').reshape(-1,1,2)
        bright=cv2.remap(contrast,uv,None,cv2.INTER_LINEAR)
        return -float(np.mean(np.clip(bright,-8,13)))
    best=guess.copy()
    for factor in [1,.45,.19,.075]:
        for _ in range(3):
            for j,amount in enumerate([.6,.6,.008,.5,.35]):
                moves=np.eye(5)[j]*amount*factor*np.array([-1.,0.,1.])[:,None]
                best=min((best+move for move in moves),key=score)
    x,z,theta,half,radius=best
    axis=np.array([np.cos(theta),np.sin(theta)])
    ends=np.r_[np.array([x,z])-half*axis,np.array([x,z])+half*axis,radius].round(4)
    line=loop(best,4.88,80).round(3)
    lanes=np.column_stack([line,np.roll(line,-1,axis=0)]).tolist()
    return ends.tolist(),lanes


def practice_areas(sports):
    import cv2
    import shapely
    source=json.loads(region.OUT.with_name('region-detail.json').read_bytes())
    programs=[p for tile in source['tiles'].values() for p in tile.get('a',[]) if p[0] in ('runway','sandpit')]
    l,t,r,b=Polygon(sports['track'][0]).bounds
    west,north,east,south=math.floor(l-56),math.floor(b-12),math.ceil(r+18),math.ceil(b+87)
    frame=(west,north,east,south)
    size=((east-west)*4,(south-north)*4)
    rgb=np.asarray(orthophoto(frame,size),dtype='int16')
    red,green,blue=rgb.transpose(2,0,1)
    hard=(red-green<15)&(green-red<7)&(green-blue<25)&(red-blue<34)&(green>103)
    def kernel(radius):return cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*radius+1,2*radius+1))
    hard=cv2.morphologyEx(hard.astype('uint8'),cv2.MORPH_CLOSE,kernel(3))
    hard=cv2.morphologyEx(hard,cv2.MORPH_OPEN,kernel(2))
    polygons=[shape(g).simplify(.32) for g,_ in shapes(hard,mask=hard>0,transform=Affine.translation(west,north)*Affine.scale(.25))]
    result=[]
    suppressed=[]
    surveyed=set()
    def add(poly,color):
        if not poly.is_valid:poly=poly.buffer(0)
        for piece in shapely.get_parts(poly):
            if piece.geom_type!='Polygon':continue
            design=Polygon(piece.exterior,[ring for ring in piece.interiors if Polygon(ring).area>5])
            mesh=shapely.get_parts(shapely.constrained_delaunay_triangles(design))
            triangles=shapely.get_coordinates(mesh).reshape(-1,4,2)[:,:3].round(2).tolist()
            result.append(dict(color=color,triangles=triangles))
    for feature in programs:
        _,oid,x,_,z,*_=feature
        point=shapely.Point(x,z)
        patch=next((p for p in polygons if 120<p.area<3200 and p.buffer(.7).covers(point)),None)
        if patch is None:continue
        suppressed.append(oid)
        if patch in surveyed:continue
        surveyed.add(patch)
        add(patch,0xb4b0a2)
    candidates=[]
    for p in polygons:
        rect=p.minimum_rotated_rectangle
        corners=np.array(rect.exterior.coords)[:4]
        edges=np.roll(corners,-1,axis=0)-corners
        length=np.linalg.norm(edges,axis=1)
        if 29<length.max()<90 and .7<length.min()<3 and p.area/rect.area>.56:
            candidates.append((p,edges[length.argmax()]/length.max()))
    for j,(a,v) in enumerate(candidates):
        for b,w in candidates[j+1:]:
            if abs(v@w)<.99 or not 3<a.distance(b)<12:continue
            if min(a.length,b.length)<.55*max(a.length,b.length):continue
            c,d=np.array(a.centroid.coords[0]),np.array(b.centroid.coords[0])
            if abs((c-d)@v)>20:continue
            add(a,0xb8b6a8)
            add(b,0xb8b6a8)
            strip=shapely.union_all([a,b]).convex_hull.difference(shapely.union_all([a,b]))
            add(strip,0x546d42)
    if not any(p['color']==0xb8b6a8 for p in result):
        gray=(.29*red+.55*green+.16*blue).astype('float32')
        luminous=gray-cv2.morphologyEx(gray,cv2.MORPH_OPEN,kernel(6))
        segments=cv2.HoughLinesP(((luminous>11)&hard.astype(bool)).astype('uint8'),1,np.pi/360,62,minLineLength=87,maxLineGap=10)
        candidates=[]
        for row in ([] if segments is None else segments[:,0]):
            a,b=row[:2],row[2:]
            along=(b-a)/np.linalg.norm(b-a)
            normal=np.array([-along[1],along[0]])
            path=np.linspace(a,b,70)
            def light(offset):
                i,j=np.rint(path+offset*normal).astype(int).T
                return gray[j.clip(0,gray.shape[0]-1),i.clip(0,gray.shape[1]-1)]
            shift=max(np.arange(-3.,3.1,.5),key=lambda d:np.median(light(d)-np.maximum(light(d-5),light(d+5))))
            measured=light(shift)-np.maximum(light(shift-5),light(shift+5))
            if (measured>11).mean()<.69:continue
            line=(np.array([a,b])+shift*normal+.5)*.25+[west,north]
            candidates.append((np.linalg.norm(b-a)*np.mean(measured>11),line,along,normal))
        pairs=[]
        for j,(score,a,axis,n) in enumerate(candidates):
            for weight,b,v,_ in candidates[j+1:]:
                offset=b.mean(axis=0)-a.mean(axis=0)
                if abs(axis@v)<.999 or not 4<abs(offset@n)<12 or abs(offset@axis)>10:continue
                pairs.append((score+weight,a,b,axis,n))
        if pairs:
            _,a,b,axis,n=max(pairs,key=lambda pair:pair[0])
            for line in [a,b]:
                add(Polygon([line[0]-.65*n,line[1]-.65*n,line[1]+.65*n,line[0]+.65*n]),0xb8b6a8)
            u,v=sorted([a,b],key=lambda line:line.mean(axis=0)@n)
            if (u[1]-u[0])@(v[1]-v[0])<0:v=v[::-1]
            add(Polygon([u[0]+.65*n,u[1]+.65*n,v[1]-.65*n,v[0]-.65*n]),0x546d42)
    return dict(suppressed=sorted(set(suppressed)),surfaces=result)


if __name__=='__main__':
    data=surveyed_sports()
    data['laneBasis'],data['lanes']=stadium_lanes(data)
    data['practice']=practice_areas(data)
    from gridiron_survey import surveyed_gridiron
    data['gridiron']=surveyed_gridiron()
    from field_edge_survey import measured_borders
    data['fieldEdgeMarks']=measured_borders()
    import shapely
    track=Polygon(data['track'][0],data['track'][1:])
    triangles=shapely.get_parts(shapely.constrained_delaunay_triangles(track))
    data['rubber']=shapely.get_coordinates(triangles).reshape(-1,4,2)[:,:3].round(2).tolist()
    path=region.OUT.parents[1]/'build/survey_sports.json'
    path.write_text(json.dumps(data,separators=(',',':')))
    print('Stadium track',Polygon(data['track'][0],data['track'][1:]).area,'m² and',len(data['lanes']),'lane sections')
