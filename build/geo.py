import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from area import SOUTH, WEST, NORTH, EAST, VOXEL_METERS
from fetch import DATA, IMAGERY_ZOOM, TERRAIN_ZOOM, tile_xy, tile_range

METERS_PER_DEGREE_LAT = 111320.0
CENTER_LAT = (SOUTH + NORTH) / 2
METERS_PER_DEGREE_LON = METERS_PER_DEGREE_LAT * math.cos(math.radians(CENTER_LAT))
WIDTH = int(round((EAST - WEST) * METERS_PER_DEGREE_LON / VOXEL_METERS))
DEPTH = int(round((NORTH - SOUTH) * METERS_PER_DEGREE_LAT / VOXEL_METERS))


def to_grid(lat, lon):
    x = (lon - WEST) * METERS_PER_DEGREE_LON / VOXEL_METERS
    z = (NORTH - lat) * METERS_PER_DEGREE_LAT / VOXEL_METERS
    return x, z


def grid_lat_lon():
    xs = (np.arange(WIDTH) + 0.5) * VOXEL_METERS / METERS_PER_DEGREE_LON + WEST
    zs = NORTH - (np.arange(DEPTH) + 0.5) * VOXEL_METERS / METERS_PER_DEGREE_LAT
    lon, lat = np.meshgrid(xs, zs)
    return lat, lon


def load_osm():
    return json.loads((DATA / "osm.json").read_text())["elements"]


def mosaic(folder, zoom):
    xs, ys = tile_range(zoom)
    image = Image.new("RGB", (256 * len(xs), 256 * len(ys)))
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            tile = Image.open(folder / f"{zoom}_{x}_{y}.png").convert("RGB")
            image.paste(tile, (256 * i, 256 * j))
    return np.asarray(image).astype(np.float32), xs.start, ys.start


def sample_mosaic(pixels, origin_x, origin_y, zoom):
    lat, lon = grid_lat_lon()
    tx, ty = tile_xy(lat, lon, zoom)
    px = (tx - origin_x) * 256 - 0.5
    py = (ty - origin_y) * 256 - 0.5
    x0 = np.clip(np.floor(px).astype(int), 0, pixels.shape[1] - 2)
    y0 = np.clip(np.floor(py).astype(int), 0, pixels.shape[0] - 2)
    fx = np.clip(px - x0, 0, 1)[..., None]
    fy = np.clip(py - y0, 0, 1)[..., None]
    top = pixels[y0, x0] * (1 - fx) + pixels[y0, x0 + 1] * fx
    bottom = pixels[y0 + 1, x0] * (1 - fx) + pixels[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bottom * fy


def imagery():
    pixels, ox, oy = mosaic(DATA / "imagery", IMAGERY_ZOOM)
    return sample_mosaic(pixels, ox, oy, IMAGERY_ZOOM)


def elevation():
    pixels, ox, oy = mosaic(DATA / "terrain", TERRAIN_ZOOM)
    meters = pixels[..., 0] * 256 + pixels[..., 1] + pixels[..., 2] / 256 - 32768
    return sample_mosaic(meters[..., None], ox, oy, TERRAIN_ZOOM)[..., 0]


LIDAR = DATA / "lidar"


def lidar_surfaces():
    terrain_path, surface_path = LIDAR / "dtm.npy", LIDAR / "dsm.npy"
    if not terrain_path.exists() or not surface_path.exists():
        return None
    return np.load(terrain_path).astype(np.float32), np.load(surface_path).astype(np.float32)


def way_rings(element):
    if element["type"] == "way" and "geometry" in element:
        return [[to_grid(p["lat"], p["lon"]) for p in element["geometry"]]], []
    if element["type"] == "relation":
        outers, inners = [], []
        for member in element.get("members", []):
            if "geometry" not in member:
                continue
            ring = [to_grid(p["lat"], p["lon"]) for p in member["geometry"]]
            (inners if member.get("role") == "inner" else outers).append(ring)
        return outers, inners
    return [], []


def rasterize(polygons_with_holes, value=1):
    from PIL import ImageDraw

    canvas = Image.new("L", (WIDTH, DEPTH), 0)
    draw = ImageDraw.Draw(canvas)
    for outers, inners in polygons_with_holes:
        for ring in outers:
            if len(ring) >= 3:
                draw.polygon(ring, fill=value)
        for ring in inners:
            if len(ring) >= 3:
                draw.polygon(ring, fill=0)
    return np.asarray(canvas)


def rasterize_lines(lines, width_meters):
    from PIL import ImageDraw

    canvas = Image.new("L", (WIDTH, DEPTH), 0)
    draw = ImageDraw.Draw(canvas)
    pixel_width = max(1, int(round(width_meters / VOXEL_METERS)))
    for line in lines:
        if len(line) >= 2:
            draw.line(line, fill=1, width=pixel_width, joint="curve")
            radius = pixel_width / 2
            for x, z in (line[0], line[-1]):
                draw.ellipse([x - radius, z - radius, x + radius, z + radius], fill=1)
    return np.asarray(canvas).astype(bool)


def debug_dir():
    folder = Path(__file__).resolve().parent.parent / "data" / "debug"
    folder.mkdir(exist_ok=True)
    return folder
