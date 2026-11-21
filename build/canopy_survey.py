import base64
import json
import sys
import zlib
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

import campus_region as region
import geo
from surface_tiles import aerial_patch,SUMMER_SOURCE

OUT=region.OUT.with_name("canopy-survey.json")
TILE=128
RECORD=np.dtype([("x","<i2"),("z","<i2"),("y","<i2"),("normal","i1",(2,)),("color","u1",(3,)),("width","u1")])


def travel_clearance(roads):
    surface=json.loads(region.OUT.with_name("surface-tiles.json").read_bytes())
    sizes=region.TERRAIN_SIZE
    def raster(key,dtype):
        meta=surface[key]
        raw=zlib.decompress(base64.b64decode(meta["samples"]))
        return np.frombuffer(raw,dtype=dtype).reshape(meta["height"],meta["width"])
    pavement=Image.fromarray(raster("carriageway","u1")).resize(sizes,Image.Resampling.BOX)
    relief=raster("relief","<i2").astype(np.float32)/surface["relief"]["scale"]
    ground=np.asarray(Image.fromarray(relief).resize(sizes,Image.Resampling.BILINEAR))
    road=ndimage.maximum_filter(np.asarray(pavement),size=3)>=128
    floor=Image.fromarray(np.where(road,ground+4.4,-256).astype(np.float32))
    brush=ImageDraw.Draw(floor)
    segments=[]
    metres=(region.X1-region.X0)/sizes[0]
    for way in roads["ways"]:
        clearance=4.4 if way["kind"]=="road" else 2.7
        width=int(np.ceil((way["width"]+4.4)/metres))+1
        for a,b in zip(way["points"],way["points"][1:]):
            segments.append((max(a[1],b[1])+clearance,width,(region.pix(a[0],a[2]),region.pix(b[0],b[2]))))
    for elevation,width,endpoints in sorted(segments,key=lambda s:s[0]):
        brush.line(endpoints,fill=elevation,width=width)
    return np.maximum(np.asarray(floor),np.where(road,ground+4.4,-256))


def crown_clear(records,x,z,floor):
    col=np.clip(((x-region.X0)*floor.shape[1]/(region.X1-region.X0)).astype(int),0,floor.shape[1]-1)
    row=np.clip(((z-region.Z0)*floor.shape[0]/(region.Z1-region.Z0)).astype(int),0,floor.shape[0]-1)
    bottom=records["y"].astype(float)/32-.85*records["width"]/32
    return bottom>floor[row,col]


def build():
    dsm=region.lidar("dsm")
    dtm=region.lidar("dtm")
    rows,cols=dsm.shape
    image=Image.new("RGB",(cols*4,rows*4))
    with ThreadPoolExecutor(4) as pool:
        for col,row,patch in pool.map(lambda pair:aerial_patch(pair,True),[(x,z) for z in range(4) for x in range(4)]):
            image.paste(patch.resize((cols,rows),Image.Resampling.LANCZOS),(col*cols,row*rows))
    rgb=np.asarray(image.resize((cols,rows),Image.Resampling.LANCZOS)).astype(float)
    red,green,blue=rgb.transpose(2,0,1)
    exclusion=Image.new("1",(cols,rows))
    pen=ImageDraw.Draw(exclusion)
    roads=json.loads(region.OUT.with_name("drive-network.json").read_bytes())
    model=json.loads(region.OUT.read_bytes())
    for shell,holes,*_ in model["blocks"]:
        loops=[shell,*holes]
        for i,ring in enumerate(loops):
            pen.polygon([region.pix(x,z) for x,z in zip(ring[::2],ring[1::2])],fill=i==0)
    for loops in roads["coreBuildings"]:
        for i,ring in enumerate(loops):
            pen.polygon([region.pix(x,z) for x,z in zip(ring[::2],ring[1::2])],fill=i==0)
    for outer,*holes in roads["water"]:
        for i,ring in enumerate([outer,*holes]):
            pen.polygon([region.pix(x,z) for x,z in zip(ring[::2],ring[1::2])],fill=i==0)
    for road in roads["ways"]:
        if road["kind"]=="road":
            pen.line([region.pix(x,z) for x,_,z in road["points"]],fill=1,width=max(1,round(road["width"]*.30)))
    core_trees=json.loads(region.OUT.with_name("drive-trees.json").read_bytes())["trees"]
    municipal=json.loads(region.OUT.with_name("municipal-detail.json").read_bytes())
    crowns=[(t[0],t[2],t[5]*.5 if len(t)>5 else min(6.8,t[3]*.34)) for t in model["trees"]]
    crowns.extend((x,z,r) for x,_,z,r,*_ in core_trees)
    crowns.extend((x,z,r) for tile in municipal["tiles"].values() for x,z,_,r,*_ in tile.get("trees",[]))
    for x,z,r in crowns:
        ax,az=region.pix(x-r*.96,z-r*.96)
        bx,bz=region.pix(x+r*.96,z+r*.96)
        pen.ellipse((ax,az,bx,bz),fill=1)
    height=dsm-dtm
    leafy=(green>red*.96)&(green>blue*1.04)&(green-red+green-blue>9)
    candidate=(height>2.8)&(height<38)&(ndimage.uniform_filter(leafy.astype(np.float32),3)>.47)
    candidate&=~ndimage.binary_dilation(np.asarray(exclusion),iterations=1)
    candidate&=ndimage.uniform_filter((height>2.4).astype(np.float32),3)>.54
    components,count=ndimage.label(candidate)
    areas=np.bincount(components.ravel())
    candidate&=areas[components]>=5
    iz,ix=np.where(candidate)
    x=region.X0+(ix+.5)*(region.X1-region.X0)/cols
    z=region.Z0+(iz+.5)*(region.Z1-region.Z0)/rows
    datum=float(ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4)
    field=ndimage.gaussian_filter(dsm,.75)
    dz,dx=np.gradient(field,(region.Z1-region.Z0)/rows,(region.X1-region.X0)/cols)
    tx=np.floor(x/TILE).astype(int)
    tz=np.floor(z/TILE).astype(int)
    points=np.zeros(ix.size,dtype=RECORD)
    points["x"]=np.rint((x-tx*TILE)*32)
    points["z"]=np.rint((z-tz*TILE)*32)
    points["y"]=np.rint((.72*dsm[iz,ix]+.28*field[iz,ix]-datum)*32)
    length=np.sqrt(dx[iz,ix]**2+dz[iz,ix]**2+1)
    points["normal"]=np.rint(-np.c_[dx[iz,ix],dz[iz,ix]]/length[:,None]*126)
    points["color"]=np.clip(rgb[iz,ix]*[.68,.78,.66]+[23,37,22],0,255)
    points["width"]=np.rint(np.clip(1.15+.08*height[iz,ix],1.15,2)*32)
    clearance=travel_clearance(roads)
    visible=crown_clear(points,x,z,clearance)
    candidate[iz[~visible],ix[~visible]]=False
    points,tx,tz=points[visible],tx[visible],tz[visible]
    x,z=x[visible],z[visible]
    smooth=ndimage.gaussian_filter(height,1)
    local=ndimage.maximum_filter(np.where(candidate,smooth,0),5)
    peaks=(smooth==local)&candidate&(height>3.2)
    root_z,root_x=np.where(peaks)
    xs=region.X0+(root_x+.5)*(region.X1-region.X0)/cols
    zs=region.Z0+(root_z+.5)*(region.Z1-region.Z0)/rows
    base=dtm[root_z,root_x]-datum
    crown_height=height[root_z,root_x]
    tree_index=cKDTree(np.column_stack([xs,zs]))
    distance,nearest=tree_index.query(np.column_stack([x,z]),k=4)
    relative=points['y'][:,None]/32-base[nearest]
    reach=np.clip(crown_height[nearest]*.49,2,10)
    feasible=(distance<=reach)&(relative>crown_height[nearest]*.29)&(relative<crown_height[nearest]*1.18+1)
    costs=np.where(feasible,distance/reach+.17*np.abs(relative/crown_height[nearest]-1),np.inf)
    owner=nearest[np.arange(len(x)),costs.argmin(axis=1)]
    good=feasible.any(axis=1)
    owner=owner[good];x=x[good];z=z[good];points=points[good]
    sort=np.argsort(owner,kind='stable')
    unique,start,count=np.unique(owner[sort],return_index=True,return_counts=True)
    tiles={}
    for parent,first,n in zip(unique,start,count):
        a,b=int(np.floor(round(xs[parent],2)/TILE)),int(np.floor(round(zs[parent],2)/TILE))
        records=sort[first:first+n]
        data=points[records].copy()
        data['x']=np.rint((x[records]-a*TILE)*32)
        data['z']=np.rint((z[records]-b*TILE)*32)
        tile=tiles.setdefault(f'{a},{b}',dict(count=0,groups=[],stems=[]))
        tile['stems'].append([round(xs[parent],2),round(zs[parent],2),round(float(crown_height[parent]),2),tile['count'],int(n),round(float(base[parent]),3)])
        tile['groups'].append(data)
        tile['count']+=int(n)
    for tile in tiles.values():
        tile['data']=base64.b64encode(np.concatenate(tile.pop('groups')).tobytes()).decode()
    data=dict(tileSize=TILE,recordBytes=RECORD.itemsize,tiles=tiles,sources=[region.LIDAR.format("dsm"),region.LIDAR.format("dtm"),SUMMER_SOURCE])
    OUT.write_text(json.dumps(data,separators=(",",":")))


def check():
    data=json.loads(OUT.read_bytes())
    total=0
    roads=json.loads(region.OUT.with_name("drive-network.json").read_bytes())
    clearance=travel_clearance(roads)
    conflicts=0
    for key,tile in data["tiles"].items():
        raw=np.frombuffer(base64.b64decode(tile["data"]),dtype=RECORD)
        assert len(raw)==tile["count"] and len(raw)>0
        count=0
        for x,z,h,first,n,base in tile['stems']:
            assert first==count and n>0
            records=raw[first:first+n]
            col,row=map(int,key.split(","))
            assert col==int(np.floor(x/TILE)) and row==int(np.floor(z/TILE))
            reach=np.hypot(col*TILE+records['x']/32-x,row*TILE+records['z']/32-z)
            vertical=records['y']/32-base
            assert np.all(reach<=np.clip(h*.49,2,10)+.04)
            assert np.all((vertical>h*.29-.025)&(vertical<h*1.18+1.025))
            count+=n
        assert count==tile['count']
        assert raw["width"].min()>0
        col,row=map(int,key.split(","))
        conflicts+=int((~crown_clear(raw,col*TILE+raw["x"]/32,row*TILE+raw["z"]/32,clearance)).sum())
        total+=len(raw)
    assert conflicts==0,f"{conflicts} canopy clusters intrude into road or footpath clearance"
    assert len(data["tiles"])>300 and total>40000
    print(f'{total:,} aerial-coloured LiDAR canopy samples across {len(data["tiles"])} tiles.')


if __name__=="__main__":
    if "--check" not in sys.argv:
        build()
    check()
