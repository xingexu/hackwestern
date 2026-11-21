import base64
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely import transform
from shapely.strtree import STRtree

import geo

BBOX = (-81.291, 42.995, -81.258, 43.021)
CITY = "https://maps.london.ca/server/rest/services/"
OSM = "https://api.openstreetmap.org/api/0.6/map.json"
LIDAR = "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/ON-2017-LakeErie-1m-{}.tif"
CACHE = geo.DATA / "region"
OUT = Path(__file__).resolve().parents[1] / "web" / "campus-region.json"
X0, Z0 = geo.to_grid(BBOX[3], BBOX[0])
X1, Z1 = geo.to_grid(BBOX[1], BBOX[2])
TERRAIN_SIZE = (1350, 1450)


def retrieve(name, url, params):
    target = CACHE / name
    if not target.exists():
        response = requests.get(url, params=params, headers={"User-Agent": "WesternCampusModel/1.0"}, timeout=120)
        response.raise_for_status()
        target.write_bytes(response.content)
    return target


def lidar(kind):
    path = CACHE / f"regional-{kind}.npy"
    if not path.exists():
        import rasterio
        from rasterio.warp import transform_bounds, reproject, Resampling
        from rasterio.transform import from_bounds
        from rasterio.windows import from_bounds as window_bounds, Window
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="60"), rasterio.open(LIDAR.format(kind)) as src:
            win = window_bounds(*transform_bounds("EPSG:4326", src.crs, *BBOX), transform=src.transform).round_offsets().round_lengths()
            win = Window(win.col_off-4, win.row_off-4, win.width+8, win.height+8)
            grid = np.zeros(TERRAIN_SIZE[::-1], np.float32)
            reproject(src.read(1, window=win), grid, src_transform=src.window_transform(win), src_crs=src.crs,
                      dst_transform=from_bounds(*BBOX, *TERRAIN_SIZE), dst_crs="EPSG:4326", resampling=Resampling.bilinear)
            if not np.all((grid > 100) & (grid < 450)):
                raise ValueError("Missing regional lidar")
            np.save(path, grid)
    return np.load(path)


def city_footprints():
    offset = 0
    while True:
        params = dict(geometry=",".join(map(str, BBOX)), geometryType="esriGeometryEnvelope", inSR=4326,
                      outSR=4326, spatialRel="esriSpatialRelIntersects", where="1=1", outFields="OBJECTID",
                      orderByFields="OBJECTID", resultOffset=offset, resultRecordCount=1000, f="geojson")
        page = json.loads(retrieve(f"city-{offset}.json", CITY+"Buildings/MapServer/0/query", params).read_bytes())
        yield from page["features"]
        if not page.get("exceededTransferLimit"):
            break
        offset += len(page["features"])


def pix(x, z):
    return ((x-X0)/(X1-X0)*TERRAIN_SIZE[0], (z-Z0)/(Z1-Z0)*TERRAIN_SIZE[1])


def sample(data, x, z):
    col, row = pix(x, z)
    return ndimage.map_coordinates(data, [row-.5, col-.5], order=1, mode="nearest")


def ring_data(ring):
    return np.round(np.asarray(ring.coords)[:-1], 1).ravel().tolist()


def measure_crowns(trees,height):
    x=np.array([t[0] for t in trees])
    z=np.array([t[2] for t in trees])
    peak=np.array([t[3] for t in trees])
    rays=[]
    for angle in np.arange(12)*np.pi/6:
        radius=np.ones(len(trees))
        active=np.ones(len(trees),bool)
        for distance in np.arange(1.5,11,.75):
            canopy=sample(height,x+distance*np.cos(angle),z+distance*np.sin(angle))
            active&=(canopy>peak*.38)&(canopy<peak*1.29)&(distance<peak*.63)
            radius[active]=distance
        rays.append(radius)
    diameters=np.median(rays,axis=0)*2
    for tree,diameter in zip(trees,diameters):
        tree[5:]=[round(float(diameter),2)]


def compile_region():
    CACHE.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(2) as pool:
        dtm, dsm = pool.map(lidar, ("dtm", "dsm"))
    datum = ndimage.gaussian_filter(geo.lidar_surfaces()[0], 1.2).min() - 4
    height = dsm - dtm
    dtm -= datum
    bbox = ",".join(map(str, BBOX))
    elements = json.loads(retrieve("map.json", OSM, {"bbox": bbox}).read_bytes())["elements"]
    nodes = {n["id"]: geo.to_grid(n["lat"], n["lon"]) for n in elements if n["type"] == "node"}
    ways = [(w.get("tags", {}), [nodes[n] for n in w["nodes"] if n in nodes]) for w in elements if w["type"] == "way"]
    aerial = Image.open(retrieve("aerial.jpg", CITY+"Aerial2025/MapServer/export", dict(bbox=bbox,bboxSR=4326,imageSR=4326,size="2048,1614",format="jpg",f="image"))).convert("RGB").resize(TERRAIN_SIZE, Image.Resampling.LANCZOS)
    raw_rgb = np.asarray(aerial)
    surface = np.array(aerial)
    roadmask = Image.new("L", TERRAIN_SIZE)
    brush = ImageDraw.Draw(roadmask)
    bridges = []
    labels = {}
    roads = 0
    pitches = 0
    for tags, line in ways:
        highway = tags.get("highway")
        if len(line) < 2:
            continue
        points = [pix(*p) for p in line]
        name=tags.get("name","")
        if name == "Western Alumni Stadium" or tags.get("bridge") and name in ("University Drive","Westminster Bridge"):
            x,z=np.mean(line,axis=0)
            label="University Drive Bridge" if name == "University Drive" else name
            labels[label]=dict(name=label,x=round(x,1),y=round(float(sample(dtm,np.array([x]),np.array([z]))[0])+3,1),z=round(z,1))
        if tags.get("leisure") in ("pitch", "track") and len(points) >= 4 and points[0] == points[-1]:
            pitches += 1
        if not highway or tags.get("area") == "yes":
            continue
        roads += 1
        drive = highway not in ("footway", "path", "steps", "cycleway", "bridleway", "pedestrian")
        width = {"primary": 14, "secondary": 10, "tertiary": 8, "service": 5, "residential": 7}.get(highway, 6 if drive else 2.2)
        brush.line(points, fill=190 if drive else 80, width=max(1,round(width*TERRAIN_SIZE[0]/(X1-X0))))
        if tags.get("bridge") not in (None, "no") and all(X0 < x < X1 and Z0 < z < Z1 for x,z in line) and not any(0<x<geo.WIDTH and 0<z<geo.DEPTH for x,z in line):
            coords=np.array(line)
            heights=sample(dtm,coords[:,0],coords[:,1])
            bridges.append([round(width,1),np.round(np.c_[coords[:,0],np.linspace(heights[0]+.35,heights[-1]+.35,len(coords)),coords[:,1]],2).ravel().tolist()])
    rm=np.asarray(roadmask)
    for val, base in [(190,[103,105,101]),(80,[166,159,142])]:
        surface[rm==val] = surface[rm==val] * .36 + np.array(base)*.64
    water = Image.new("1", TERRAIN_SIZE)
    water_draw = ImageDraw.Draw(water)
    water_ways={w["id"]:w for w in elements if w["type"]=="way"}
    def draw_water(rings):
        fragments=list(rings)
        while fragments:
            chain=list(fragments.pop())
            while chain and chain[0]!=chain[-1]:
                next_index=next((i for i,n in enumerate(fragments) if n[0]==chain[-1] or n[-1]==chain[-1]),None)
                if next_index is None: break
                n=fragments.pop(next_index)
                chain.extend((n if n[0]==chain[-1] else n[::-1])[1:])
            if len(chain)>3 and chain[0]==chain[-1] and all(n in nodes for n in chain):
                water_draw.polygon([pix(*nodes[n]) for n in chain], fill=1)
    for element in elements:
        tags=element.get("tags",{})
        if tags.get("natural")!="water":continue
        if element["type"]=="way" and element["nodes"][0]==element["nodes"][-1]:
            draw_water([element["nodes"]])
        if element["type"]=="relation":
            draw_water([water_ways[m["ref"]]["nodes"] for m in element["members"] if m["role"]=="outer" and m["ref"] in water_ways])
    wet=np.asarray(water) & (rm==0)
    surface[wet]=.45*surface[wet]+.55*np.array([72,107,109])
    osm_buildings = [(tags, Polygon(coords).buffer(0)) for tags,coords in ways if tags.get("building") and len(coords)>=4]
    tree = STRtree([p for _,p in osm_buildings])
    cover = box(X0,Z0,X1,Z1).difference(box(0,0,geo.WIDTH,geo.DEPTH))
    roofs = Image.new("1", TERRAIN_SIZE)
    painter = ImageDraw.Draw(roofs)
    blocks=[]
    huron_houses=MultiPolygon([Polygon([nodes[n] for n in way["nodes"]]) for way in elements
                               if way["type"]=="way" and way["id"] in (778155829,778155832)])
    for feature in city_footprints():
        survey=huron_houses if feature["properties"]["OBJECTID"]==1500479 else transform(shape(feature["geometry"]),lambda lon,lat: geo.to_grid(lat,lon),interleaved=False).buffer(0)
        geom=survey.intersection(cover)
        for poly in getattr(geom,"geoms",[geom]):
            if poly.geom_type!="Polygon" or poly.area<8: continue
            poly=poly.simplify(.45,preserve_topology=True)
            coords=np.asarray(poly.exterior.coords)
            pixels=[pix(x,z) for x,z in coords]
            painter.polygon(pixels, fill=1)
            px0,py0=np.maximum(0,np.floor(np.min(pixels,axis=0)).astype(int))
            px1,py1=np.minimum(TERRAIN_SIZE,np.ceil(np.max(pixels,axis=0)).astype(int)+1)
            if px1<=px0 or py1<=py0: continue
            raster=Image.new("1",(px1-px0,py1-py0)); d=ImageDraw.Draw(raster)
            d.polygon([(x-px0,y-py0) for x,y in pixels],fill=1)
            holes=[]
            for ring in poly.interiors:
                if Polygon(ring).area < 6: continue
                holes.append(ring_data(ring))
                hole=[pix(x,z) for x,z in ring.coords]; d.polygon([(x-px0,y-py0) for x,y in hole],fill=0);painter.polygon(hole,fill=0)
            mask=np.asarray(raster)
            heights=height[py0:py1,px0:px1][mask]
            if not heights.size: continue
            tags={}
            ids=tree.query(poly,predicate='intersects')
            if len(ids):
                idx=max(ids,key=lambda i: poly.intersection(osm_buildings[i][1]).area)
                if poly.intersection(osm_buildings[idx][1]).area>.28*poly.area:tags=osm_buildings[idx][0]
            top=float(np.percentile(heights,65))
            if top<2.5:
                try: top=float(tags.get("height",str(float(tags.get("building:levels",2))*3.4)).split()[0])
                except ValueError:top=6.8
            ancillary=survey.area<48 and not tags.get("name") and tags.get("building","yes") in ("yes","garage","garages","shed","carport","roof","house")
            if ancillary:
                measured=tags.get("height")
                levels=tags.get("building:levels")
                if measured or levels:
                    try:top=float(measured.split()[0]) if measured else float(levels)*3.1
                    except ValueError:pass
                elif top>5.0:
                    low=float(np.percentile(heights,18))
                    top=low if 2.5<=low<=4.5 else (3.1 if survey.area<24 else 3.75)
            floor=float(np.median(dtm[py0:py1,px0:px1][mask]))
            roof=np.median(raw_rgb[py0:py1,px0:px1][mask],axis=0).astype(int)
            name=tags.get("name","")
            if name in ("Alumni Hall","Thompson Arena","Ontario Hall","Huron University College","Brescia University College","Saugeen Maitland Hall (Residence)","Spencer Engineering Building","North Campus Building") and name not in labels:
                centroid=poly.representative_point()
                labels[name]=dict(name=name,x=round(centroid.x,1),y=round(floor+top+2,1),z=round(centroid.y,1))
            blocks.append([ring_data(poly.exterior),holes,round(floor,2),round(np.clip(top,2.5,100),2),roof.tolist(),tags.get("name","")])
    h=ndimage.gaussian_filter(height,1.35)
    peaks=(h==ndimage.maximum_filter(h,7)) & (h>3.5) & (h<37) & ~ndimage.binary_dilation(np.asarray(roofs),iterations=2) & (rm==0)
    trees=[]
    for z,x in np.argwhere(peaks):
        xx=X0+(x+.5)/TERRAIN_SIZE[0]*(X1-X0);zz=Z0+(z+.5)/TERRAIN_SIZE[1]*(Z1-Z0)
        if 0<xx<geo.WIDTH and 0<zz<geo.DEPTH:continue
        colour=raw_rgb[z,x].astype(int)
        if colour[1] < colour[0]*.90 or colour[1] < colour[2]*1.04:continue
        trees.append([round(xx,1),round(float(dtm[z,x]),1),round(zz,1),round(float(h[z,x]),1),colour.tolist()])
    measure_crowns(trees,height)
    xs=np.unique(np.r_[np.arange(X0,X1,12),0,geo.WIDTH,X1]);zs=np.unique(np.r_[np.arange(Z0,Z1,12),0,geo.DEPTH,Z1])
    xx,zz=np.meshgrid(xs,zs)
    elev=sample(dtm,xx.ravel(),zz.ravel())
    coarse=(np.round(elev*10)).astype("<i2")
    ortho=Image.fromarray(surface).quantize(colors=256,dither=Image.Dither.NONE)
    encode=lambda data:base64.b64encode(data).decode()
    result=dict(bounds=[X0,Z0,X1,Z1],sources=[CITY+"Aerial2025/MapServer",CITY+"Buildings/MapServer/0",OSM,LIDAR.format("dtm"),LIDAR.format("dsm")],roads=roads,pitches=pitches,labels=list(labels.values()),
        xs=np.round(xs,3).tolist(),zs=np.round(zs,3).tolist(),elevation=encode(coarse.tobytes()),blocks=blocks,trees=trees,bridges=bridges,
        ortho=dict(width=ortho.width,height=ortho.height,palette=encode(bytes(ortho.getpalette())),pixels=encode(ortho.tobytes())))
    from southern_housing import extend_housing
    extend_housing(result)
    if len(blocks)<250 or roads<400 or not any(t.get("name")=="Western Alumni Stadium" for t,_ in ways):raise ValueError("Regional map coverage is incomplete")
    OUT.write_text(json.dumps(result,separators=(",",":")))
    print(f"Regional campus: {len(blocks)} footprints, {roads} mapped routes, {pitches} sports areas, {len(trees)} lidar canopy peaks, {len(bridges)} bridge decks, {len(elev)} elevations")


def check_region():
    region=json.loads(OUT.read_text())
    x0,z0,x1,z1=region["bounds"]
    assert x0 < -1050 < 0 < 1400 < x1 and z0 < -900 < 0 < 1700 < z1
    assert len(region["blocks"])>1000 and len(region["trees"])>500 and region["roads"]>500
    assert {"Western Alumni Stadium","Thompson Arena","University Drive Bridge"} <= {item["name"] for item in region["labels"]}
    core=box(0,0,geo.WIDTH,geo.DEPTH)
    for points,holes,base,height,_,_ in region["blocks"]:
        outline=Polygon(np.reshape(points,(-1,2)),[np.reshape(ring,(-1,2)) for ring in holes]).buffer(0)
        assert outline.intersection(core).area < .11 and -100 < base < 100 and 2 <= height <= 100
    housing=region['southernHousing']
    assert len(housing)==3 and sum(h['index'] is None for h in housing)==1
    for h in housing:
        ring,_,floor,height,*_=h['block']
        assert Polygon(np.reshape(ring,(-1,2))).area>350 and max(ring[1::2])>1815 and 4<height<9
        assert h['index'] is None or region['blocks'][h['index']]==h['block']
    xs,zs=region["xs"],region["zs"]
    assert 0 in xs and geo.WIDTH in xs and 0 in zs and geo.DEPTH in zs
    assert len(base64.b64decode(region["elevation"]))==2*len(xs)*len(zs)
    tex=region["ortho"]
    assert len(base64.b64decode(tex["pixels"]))==tex["width"]*tex["height"]
    print(f"Regional geometry verified: {len(region['blocks'])} buildings outside the core and {len(region['labels'])} named landmarks")


if __name__=="__main__":
    if "--check" not in sys.argv:
        compile_region()
    check_region()
