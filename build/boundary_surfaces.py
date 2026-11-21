import cv2
import numpy as np
import shapely
from affine import Affine
from PIL import Image
from rasterio.features import rasterize
from shapely.geometry import LineString,Polygon,box

import campus_region as region


def assign(cover,masks,bounds,site,heights,network):
    from city_streets import survey as civic_roads
    from frontage_survey import civic_walks
    from parcel_surfaces import municipal_lines
    cv2.setNumThreads(1)
    height,width=cover.shape
    left,top,right,bottom=bounds
    dx,dz=(right-left)/width,(bottom-top)/height
    transform=Affine.translation(left,top)*Affine.scale(dx,dz)
    belt=site.buffer(115,quad_segs=4).difference(site)
    city=[Polygon(np.reshape(p,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for p,*holes in civic_roads()]
    walks=[p.buffer(w*.5,cap_style='flat',join_style='round') for p,w in civic_walks(belt)]
    for way in network['ways']:
        if way['level'] or way['bridge'] or way['kind']=='road':continue
        line=LineString(np.asarray(way['points'])[:,[0,2]])
        if belt.intersects(line):walks.append(line.buffer(way['width']*.5,cap_style='flat'))
    parking=[]
    for a in network['areas']:
        if a['kind'] not in ('parking','plaza','paved','courtyard','platform','pedestrian'):continue
        shell,*holes=[np.reshape(r,(-1,2)) for r in a['rings']]
        floor=Polygon(shell,holes).buffer(0)
        if floor.intersects(belt):parking.append(floor)
    boundaries=[p.buffer(.85,quad_segs=2) for p in municipal_lines('sidewalk',belt)]
    trees={k:shapely.STRtree(v) for k,v in [('road',city),('walk',walks),('lot',parking),('edge',boundaries)]}
    from ground_observations import survey_coordinates,survey_tile_path
    changes=np.zeros(3,dtype=int)
    for x,z in survey_coordinates(belt):
        area=box(x,z,x+150,z+150)
        path=survey_tile_path(x,z)
        i0,i1=np.clip(np.ceil((np.array([x,x+150])-left)/dx-.5).astype(int),0,width)
        j0,j1=np.clip(np.ceil((np.array([z,z+150])-top)/dz-.5).astype(int),0,height)
        if i1<=i0 or j1<=j0:continue
        xs=left+(np.arange(i0,i1)+.5)*dx
        zs=top+(np.arange(j0,j1)+.5)*dz
        xx,zz=np.meshgrid(xs,zs)
        frame=transform*Affine.translation(i0,j0)
        dense=frame*Affine.scale(.25)
        rows,cols=xx.shape
        local_wet=masks[j0:j1,i0:i1,3]>40
        def layer(kind,coverage=False):
            tree=trees[kind]
            shapes=tree.geometries[tree.query(area,predicate='intersects')]
            shape=(4*rows,4*cols) if coverage else (rows,cols)
            if not len(shapes):return np.zeros((rows,cols),np.uint8)
            sampled=rasterize(shapes,out_shape=shape,transform=dense if coverage else frame,dtype='uint8')
            return np.rint(sampled.reshape(rows,4,cols,4).mean(axis=(1,3))*255).astype(np.uint8) if coverage else sampled
        native=np.asarray(Image.open(path).convert('RGB').resize((300,300),Image.Resampling.BOX),np.float32)
        r,g,b=native.transpose(2,0,1)
        lum=(r+2*g+b)*.25
        hard=(lum>84)&(g-r<4.5)&(r-g<14)&(r-b<7+.13*lum)&(g-b<5+.1*lum)
        plant=(g>58)&((g>r+5)&(g>b+12)|(r-g>4)&(g-b>3+.12*lum)&(r-b>6+.21*lum))
        def at(values,n):
            smooth=cv2.blur(values.astype('float32'),(n,n))
            return cv2.remap(smooth,((xx-x)*2-.5).astype('float32'),((zz-z)*2-.5).astype('float32'),cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
        pavement,plants=at(hard,5),at(plant,5)
        exposure=region.sample(heights,xx.ravel(),zz.ravel()).reshape(xx.shape)
        valid=shapely.contains_xy(belt,xx,zz)&~local_wet
        road,walk=layer('road',True),layer('walk',True)
        lot,edge=layer('lot')>0,layer('edge')>0
        tile=masks[j0:j1,i0:i1];coarse=cover[j0:j1,i0:i1]
        open_floor=(exposure<2.5)&(pavement>.78)&(plants<.12)
        clear_lawn=(exposure<2.4)&(plants>.75)&(pavement<.12)&(road==0)&(walk==0)
        paved=valid&open_floor&(lot|(coarse==1))&(road==0)&(walk==0)
        slab=valid&open_floor&(edge|(coarse==3))&(road==0)
        lawn=valid&clear_lawn
        for mask,code in [(lawn,0),(paved,1),(slab,3)]:
            tile[mask,:3]=0;coarse[mask]=code
            if code:tile[:,:,code-1][mask]=255
        for data,kind in [(walk,3),(road,1)]:
            select=valid&(data>0)&((plants<.50)|(data>=239))&((kind==1)|(road<100))
            tile[:,:,kind-1][select]=np.maximum(tile[:,:,kind-1][select],data[select])
            if kind==1:tile[:,:,2][select]=np.minimum(tile[:,:,2][select],255-data[select])
            coarse[select&(data>=128)]=kind
        changes+=[int(lawn.sum()),int(paved.sum()),int(slab.sum())]
    return changes.tolist()
