import base64
import io
import json
import os
import zlib
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

import campus_region as region
import geo
import city_streets
import municipal_detail
import street_finishes

OUT = region.OUT.with_name("surface-tiles.json")
SOURCE = region.CITY + "Aerial2025/MapServer"
SUMMER_SOURCE = region.CITY + "AerialLeavesOnSeptember2015/MapServer"
SPACING = .45


def aerial_patch(pair, summer=False):
    col, row = pair
    west, south, east, north = region.BBOX
    dx, dy = (east-west)/4, (north-south)/4
    bbox = [west+col*dx, north-(row+1)*dy, west+(col+1)*dx, north-row*dy]
    height = round((region.Z1-region.Z0)/4/SPACING)
    width = round(height*dx/dy)
    source=SUMMER_SOURCE if summer else SOURCE
    prefix="aerial-summer" if summer else "aerial-fine"
    path = region.retrieve(f"{prefix}-{col}-{row}.jpg", source+"/export", dict(
        bbox=",".join(map(str,bbox)), bboxSR=4326, imageSR=4326, size=f"{width},{height}", format="jpg", f="image"))
    with Image.open(path) as photo:
        if photo.size != (width,height):
            raise ValueError(f"Unexpected image dimensions in {path}")
        return col,row,photo.convert("RGB")


def pixel_ring(ring, size):
    return [((x-region.X0)/(region.X1-region.X0)*size[0],
             (z-region.Z0)/(region.Z1-region.Z0)*size[1]) for x,z in zip(ring[::2],ring[1::2])]


def photographed_parking(current,summer):
    from shapely.geometry import shape
    size=(round(current.width/3),round(current.height/3))
    survey=Image.new('L',size)
    draw=ImageDraw.Draw(survey)
    metres=(region.X1-region.X0)/size[0]
    islands=[]
    for kind,radius in [('parking',16),('driveway',7)]:
        for feature in municipal_detail.fetch(kind)[1]:
            for line in municipal_detail.lines(shape(feature['geometry'])):
                ll=np.array(line.coords)
                x,z=geo.to_grid(ll[:,1],ll[:,0])
                points=pixel_ring(np.column_stack([x,z]).ravel(),size)
                draw.line(points,fill=1,width=round(2*radius/metres),joint='curve')
                span=(x.max()-x.min())*(z.max()-z.min())
                if line.is_ring and 6<span<1700:
                    islands.append(points)
    near=np.asarray(survey,dtype=bool)
    r,g,b=np.asarray(current.resize(size,Image.Resampling.BOX),dtype=np.int16).transpose(2,0,1)
    rs,gs,bs=np.asarray(summer.resize(size,Image.Resampling.BOX),dtype=np.int16).transpose(2,0,1)
    hard=(g-r<6)&(g-b<31)&(r-g<22)&(gs-rs<4)&(gs-bs<27)&(g>67)&(gs>55)
    paved=ndimage.binary_closing(hard&near,iterations=2)&near
    labels,count=ndimage.label(paved)
    sizes=np.bincount(labels.ravel(),minlength=count+1)
    paved=(labels>0)&(sizes[labels]>14)
    planted=(gs-rs>5)&(gs-bs>9)&((g-b>18)|(g<91))
    planted=ndimage.binary_closing(planted,iterations=1)
    zones=np.where(planted,3,np.where(paved,2,near)).astype(np.uint8)
    for ring in islands:
        u,v=np.array(ring).T
        x0,z0=max(0,int(u.min())),max(0,int(v.min()))
        x1,z1=min(size[0],int(u.max())+2),min(size[1],int(v.max())+2)
        if x1<=x0 or z1<=z0:
            continue
        footprint=Image.new('1',(x1-x0,z1-z0))
        ImageDraw.Draw(footprint).polygon([(x-x0,z-z0) for x,z in ring],fill=1)
        mask=np.asarray(footprint)
        samples=planted[z0:z1,x0:x1][mask]
        if samples.size and samples.mean()>.28:
            zones[z0:z1,x0:x1][mask]=4
    return np.asarray(Image.fromarray(zones).resize(current.size,Image.Resampling.NEAREST))


def cover_mask(size,network,road_rings):
    elements=json.loads((region.CACHE/"map.json").read_bytes())["elements"]
    nodes={e["id"]:geo.to_grid(e["lat"],e["lon"]) for e in elements if e["type"]=="node"}
    mask=Image.new("L",size)
    brush=ImageDraw.Draw(mask)
    turf={"grass","meadow","grassland","recreation_ground","forest","wood","scrub"}
    for way in elements:
        if way["type"]!="way" or len(way["nodes"])<4 or way["nodes"][0]!=way["nodes"][-1]:
            continue
        t=way.get("tags",{})
        if not (t.get("natural") in turf or t.get("landuse") in turf or
                t.get("leisure")=="pitch" and t.get("sport") in ("soccer","canadian_football","rugby_union")):
            continue
        if all(n in nodes for n in way["nodes"]):
            ring=[coord for n in way["nodes"] for coord in nodes[n]]
            brush.polygon(pixel_ring(ring,size),fill=1)
    for area in network["areas"]:
        shell,*holes=area["rings"]
        brush.polygon(pixel_ring(shell,size),fill=6 if area["kind"]=="parking" else 2)
        for loop in holes:
            brush.polygon(pixel_ring(loop,size),fill=0)
    for way in network["ways"]:
        if way["bridge"]:
            continue
        line=[coord for x,y,z in way["points"] for coord in (x,z)]
        brush.line(pixel_ring(line,size),2,max(1,round(way["width"]/SPACING)),joint="curve")
    asphalt=Image.new('1',size)
    surface=ImageDraw.Draw(asphalt)
    for rings in road_rings:
        surface.polygon(pixel_ring(rings[0],size),fill=1)
        for hole in rings[1:]:
            surface.polygon(pixel_ring(hole,size),fill=0)
    mask.paste(5,(0,0),asphalt)
    for [ring,holes,*rest] in json.loads(region.OUT.read_bytes())["blocks"]:
        brush.polygon(pixel_ring(ring,size),fill=3)
        for hole in holes:
            brush.polygon(pixel_ring(hole,size),fill=0)
    for rings in network["coreBuildings"]:
        brush.polygon(pixel_ring(rings[0],size),fill=3)
    for rings in network["water"]:
        brush.polygon(pixel_ring(rings[0],size),fill=4)
        for hole in rings[1:]:
            brush.polygon(pixel_ring(hole,size),fill=0)
    return np.asarray(mask)


def summer_ground(current,summer,network,road_rings):
    size=current.size
    cover=cover_mask(size,network,road_rings)
    parking_zones=photographed_parking(current,summer)
    current=np.asarray(current)
    summer=np.asarray(summer.filter(ImageFilter.GaussianBlur(1.5)))
    smooth=np.asarray(Image.fromarray(current).convert("L").filter(ImageFilter.GaussianBlur(3.8)))
    result=np.empty((size[1],size[0],4),np.uint8)
    for top in range(0,size[1],160):
        rows=slice(top,min(top+160,size[1]))
        src=current[rows].astype(np.float32)
        season=summer[rows].astype(np.float32)
        mask=cover[rows]
        r,g,b=season.transpose(2,0,1)
        seasonal=np.clip((g-.86*r-3)/14,0,1)*np.clip((g-.97*b-3)/11,0,1)
        new_r,new_g,new_b=src.transpose(2,0,1)
        warm=np.clip((new_g-new_b+4)/20,0,1)
        turf=np.maximum((mask==1)*.93,seasonal*warm*.94)*((mask==0)|(mask==1))
        zones=parking_zones[rows]
        lot=(mask==6)|((zones==2)&((mask==0)|(mask==1)))
        protected_planting=np.clip((g-r-3)/10,0,1)*np.clip((g-b-5)/12,0,1)*np.clip((new_g-new_b-9)/16,0,1)
        turf[lot]=np.where(zones[lot]==3,protected_planting[lot]*.96,0)
        island=(zones==4)&((mask==0)|(mask==1)|(mask==6))
        turf[island]=.96
        lum=src @ np.array([.299,.587,.114],np.float32)
        summer_lum=season @ np.array([.299,.587,.114],np.float32)
        soft=smooth[rows]
        turf_lum=60+.48*soft+.12*summer_lum+.18*np.clip(lum-soft,-25,22)
        saturation=np.clip((g-b)/95,.14,.43)
        lawn=np.stack([turf_lum*(.90-saturation*.21),turf_lum*(1.07+saturation*.10),turf_lum*(.70-saturation*.31)],axis=-1)
        neutral=src.copy()
        neutral[:,:,2]=np.minimum(255,new_b*1.04+3)
        out=neutral*(1-turf[:,:,None])+lawn*turf[:,:,None]
        shade=np.clip((soft-112)*.18+(lum-soft)*.34,-12,20)
        road=mask==5
        motor=np.stack([99+shade,105+shade,108+shade],axis=-1)
        out[road]=motor[road]
        parking=np.stack([106+shade,111+shade,114+shade],axis=-1)
        paint=np.clip((lum-soft-12)/30,0,1)*np.clip((lum-115)/50,0,1)
        parking+=paint[:,:,None]*35
        out[lot]=parking[lot]*(1.-turf[lot,None])+lawn[lot]*turf[lot,None]
        apron=mask==2
        paving=np.stack([129+shade,131+shade,129+shade],axis=-1)
        out[apron]=paving[apron]*.79+neutral[apron]*.21
        shadow=src.max(axis=2)<61
        lift=np.maximum(0,63-lum)*.61
        out[shadow]+=lift[shadow,None]
        wet=mask==4
        light=np.clip((soft-72)*.24+(lum-soft)*.17,-16,17)
        water=np.stack([57+light*.68,109+light,128+light*.92],axis=-1)
        out[wet]=water[wet]
        result[rows,:,:3]=np.clip(out,0,255).astype(np.uint8)
        alpha=np.where(lot,110+45*turf,255-100*turf)
        result[rows,:,3]=np.where(wet,40,np.where(road,92,alpha)).astype(np.uint8)
    return Image.fromarray(result)


def terrain_relief(network):
    ground=region.lidar("dtm").astype(np.float32)
    datum=ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4
    ground-=datum
    rows,cols=ground.shape
    ceiling=np.full((rows,cols),1000,dtype=np.float32)
    best=np.full((rows,cols),np.inf,dtype=np.float32)
    dx=(region.X1-region.X0)/cols
    dz=(region.Z1-region.Z0)/rows
    for way in network['ways']:
        if way['bridge'] or way['level']!=0:
            continue
        radius=(way['width']+1.3)*.5
        for (ax,ay,az),(bx,by,bz) in zip(way['points'],way['points'][1:]):
            x0=max(0,int((min(ax,bx)-radius-region.X0)/dx))
            x1=min(cols,int((max(ax,bx)+radius-region.X0)/dx)+1)
            z0=max(0,int((min(az,bz)-radius-region.Z0)/dz))
            z1=min(rows,int((max(az,bz)+radius-region.Z0)/dz)+1)
            if x1<=x0 or z1<=z0:
                continue
            x=region.X0+(np.arange(x0,x1)+.5)*dx
            z=region.Z0+(np.arange(z0,z1)[:,None]+.5)*dz
            vx=bx-ax;vz=bz-az
            t=np.clip(((x-ax)*vx+(z-az)*vz)/max(.0001,vx*vx+vz*vz),0,1)
            distance=np.hypot(x-ax-t*vx,z-az-t*vz)
            score=distance/radius+(0 if way['kind']=='road' else 1)
            block=best[z0:z1,x0:x1]
            selected=(distance<=radius)&(score<block)
            target=ceiling[z0:z1,x0:x1]
            target[selected]=(ay+t*(by-ay)-.19)[selected]
            block[selected]=score[selected]
    near=ceiling<999
    dist,index=ndimage.distance_transform_edt(~near,return_indices=True)
    low=ceiling[tuple(index)]+np.maximum(0,dist-1)*.55
    grade=ceiling[tuple(index)]
    influence=np.clip(1.-dist/2.8,0,1)
    blend=influence*influence*(3.-2.*influence)
    follow=ground+(grade+.15-ground)*blend
    ground=np.minimum(follow,low+.16)
    packed=np.rint(ground*32).astype('<i2')
    return dict(width=cols,height=rows,scale=32,samples=base64.b64encode(zlib.compress(packed.tobytes(),8)).decode())


def verge_cover(image):
    alpha=np.array(image.getchannel('A').resize(region.TERRAIN_SIZE,Image.Resampling.BOX))
    water=alpha<60
    grass=(alpha<187)&(alpha>127)
    grass=ndimage.binary_erosion(grass,iterations=1)
    shore=grass & ndimage.binary_dilation(water,iterations=3)
    cover=np.select([water,shore,grass],[1,3,2],default=0).astype(np.uint8)
    return dict(width=cover.shape[1],height=cover.shape[0],samples=base64.b64encode(zlib.compress(cover.tobytes(),8)).decode())


def image_bytes(image,quality):
    out=io.BytesIO()
    image.save(out,format="WEBP",quality=quality,method=4)
    return base64.b64encode(out.getvalue()).decode()


def carriageway_mask(road_rings,curbs,mask_size):
    road_grid=Image.new('1',(mask_size[0]*3,mask_size[1]*3))
    painter=ImageDraw.Draw(road_grid)
    for rings in sorted(road_rings,key=lambda rings:-len(rings[0])):
        painter.polygon(pixel_ring(rings[0],road_grid.size),fill=1)
        for hole in rings[1:]:
            painter.polygon(pixel_ring(hole,road_grid.size),fill=0)
    coverage=road_grid.convert('L').resize(mask_size,Image.Resampling.BOX).filter(ImageFilter.GaussianBlur(.82))
    return dict(width=coverage.width,height=coverage.height,samples=base64.b64encode(zlib.compress(coverage.tobytes(),8)).decode(),
                   format="coverage8",curbs=curbs,source=city_streets.SOURCE)


def build():
    terrain = json.loads(region.OUT.read_bytes())
    xs,zs = terrain["xs"],terrain["zs"]
    w,h = round((region.X1-region.X0)/4/SPACING), round((region.Z1-region.Z0)/4/SPACING)
    network=json.loads(region.OUT.with_name("drive-network.json").read_bytes())
    mosaic = Image.new("RGB",(w*4,h*4))
    with ThreadPoolExecutor(4) as pool:
        for col,row,photo in pool.map(aerial_patch,[(i,j) for j in range(4) for i in range(4)]):
            mosaic.paste(photo.resize((w,h), Image.Resampling.LANCZOS),(col*w,row*h))
    summer=Image.new("RGB",mosaic.size)
    with ThreadPoolExecutor(4) as pool:
        for col,row,photo in pool.map(lambda pair:aerial_patch(pair,True),[(i,j) for j in range(4) for i in range(4)]):
            summer.paste(photo.resize((w,h),Image.Resampling.LANCZOS),(col*w,row*h))
    road_rings,curbs=city_streets.mapped_network(network)
    mosaic=summer_ground(mosaic,summer,network,road_rings)
    del summer
    overview=mosaic.resize((round(mosaic.width*.30),round(mosaic.height*.30)),Image.Resampling.LANCZOS)
    road_mask=carriageway_mask(road_rings,curbs,(round(mosaic.width*.60),round(mosaic.height*.60)))
    tiles = {}
    for j in range(0,len(zs)-1,24):
        for i in range(0,len(xs)-1,24):
            bounds = xs[i],zs[j],xs[min(i+24,len(xs)-1)],zs[min(j+24,len(zs)-1)]
            left,top,right,bottom=bounds
            crop = mosaic.crop((round((left-region.X0)/(region.X1-region.X0)*mosaic.width),
                                round((top-region.Z0)/(region.Z1-region.Z0)*mosaic.height),
                                round((right-region.X0)/(region.X1-region.X0)*mosaic.width),
                                round((bottom-region.Z0)/(region.Z1-region.Z0)*mosaic.height)))
            tiles[f"{i},{j}"]=image_bytes(crop,82)
    core_image=mosaic.crop((round(-region.X0/(region.X1-region.X0)*mosaic.width),
                            round(-region.Z0/(region.Z1-region.Z0)*mosaic.height),
                            round((geo.WIDTH-region.X0)/(region.X1-region.X0)*mosaic.width),
                            round((geo.DEPTH-region.Z0)/(region.Z1-region.Z0)*mosaic.height)))
    staged=OUT.with_suffix(f'.{os.getpid()}.part')
    staged.write_text(json.dumps(dict(source=SOURCE,seasonalSource=SUMMER_SOURCE,spacing=SPACING,tiles=tiles,**street_finishes.compile_tiles(terrain,network,road_mask),core=image_bytes(core_image,82),
                                   preview=image_bytes(overview,85),relief=terrain_relief(network),groundCover=verge_cover(mosaic),carriageway=road_mask),separators=(",",":")))
    staged.replace(OUT)
    return len(tiles)


def check():
    data=json.loads(OUT.read_bytes())
    assert data["source"]==SOURCE and data["spacing"]==SPACING
    core_image=Image.open(io.BytesIO(base64.b64decode(data["core"])))
    assert abs(core_image.width*SPACING-geo.WIDTH)<1 and abs(core_image.height*SPACING-geo.DEPTH)<1
    terrain=json.loads(region.OUT.read_bytes())
    xs,zs=terrain["xs"],terrain["zs"]
    for j in range(0,len(zs)-1,24):
        for i in range(0,len(xs)-1,24):
            bounds=xs[i],zs[j],xs[min(i+24,len(xs)-1)],zs[min(j+24,len(zs)-1)]
            tile=Image.open(io.BytesIO(base64.b64decode(data["tiles"][f"{i},{j}"])))
            assert tile.format=="WEBP" and abs(tile.width*SPACING-(bounds[2]-bounds[0]))<1 and abs(tile.height*SPACING-(bounds[3]-bounds[1]))<1
            assert max(hi-lo for lo,hi in tile.convert("RGB").getextrema())>25
    assert data['seasonalSource']==SUMMER_SOURCE
    preview=Image.open(io.BytesIO(base64.b64decode(data['preview'])))
    assert preview.mode=='RGBA' and preview.getchannel('A').getextrema()[0]<50
    for x,z in [(1209.9,-817.6),(1241.1,-805.8),(-516,789),(-514,802)]:
        column,row=pixel_ring((x,z),preview.size)[0]
        assert 103<=preview.getpixel((round(column),round(row)))[3]<=119, f'Missing photographed parking apron at {x},{z}'
    for x,z in [(1251,-810.3),(-512,810)]:
        column,row=pixel_ring((x,z),preview.size)[0]
        assert 147<=preview.getpixel((round(column),round(row)))[3]<=172, f'Lost planted island or verge at {x},{z}'
    relief=data['relief']
    assert len(zlib.decompress(base64.b64decode(relief['samples'])))==relief['width']*relief['height']*2
    cover=data['groundCover']
    classes=np.frombuffer(zlib.decompress(base64.b64decode(cover['samples'])),np.uint8)
    assert classes.size==cover['width']*cover['height'] and set(classes)=={0,1,2,3}
    streets=data['carriageway']
    assert streets['format']=='coverage8' and streets['source']==city_streets.SOURCE
    coverage=np.frombuffer(zlib.decompress(base64.b64decode(streets['samples'])),np.uint8)
    assert coverage.size==streets['width']*streets['height'] and np.any((coverage>64)&(coverage<192))
    print(f'{len(data["tiles"])} seasonal regional orthophoto tiles verified at {SPACING} metres per pixel')


if __name__ == "__main__":
    import sys
    if "--check" not in sys.argv:
        build()
    check()
