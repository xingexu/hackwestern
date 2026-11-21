import json
import math

import numpy as np
import sys
from pathlib import Path

import requests

from area import SOUTH, WEST, NORTH, EAST

DATA = Path(__file__).resolve().parent.parent / "data"
USER_AGENT = "campus-voxel-demo/0.1"
OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
IMAGERY_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TERRAIN_ZOOM = 15
IMAGERY_ZOOM = 18
MARGIN_DEGREES = 0.002


def tile_xy(lat, lon, zoom):
    n = 2 ** zoom
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tile_range(zoom):
    x0, y0 = tile_xy(NORTH, WEST, zoom)
    x1, y1 = tile_xy(SOUTH, EAST, zoom)
    return range(int(x0), int(x1) + 1), range(int(y0), int(y1) + 1)


def download(url, target):
    if target.exists():
        return
    response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=60)
    response.raise_for_status()
    target.write_bytes(response.content)


def fetch_osm():
    target = DATA / "osm.json"
    if target.exists():
        return
    bbox = f"{SOUTH - MARGIN_DEGREES},{WEST - MARGIN_DEGREES},{NORTH + MARGIN_DEGREES},{EAST + MARGIN_DEGREES}"
    query = f"[out:json][timeout:120];(way({bbox});relation({bbox});node[natural=tree]({bbox}););out geom tags;"
    for url in OVERPASS_URLS:
        response = requests.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=180)
        if response.ok:
            target.write_text(response.text)
            return
        print(f"overpass {url} returned {response.status_code}")
    raise RuntimeError("every overpass mirror failed")


def fetch_tiles(url_template, zoom, folder):
    folder.mkdir(parents=True, exist_ok=True)
    xs, ys = tile_range(zoom)
    for x in xs:
        for y in ys:
            download(url_template.format(z=zoom, x=x, y=y), folder / f"{zoom}_{x}_{y}.png")
    return len(xs) * len(ys)


def main():
    DATA.mkdir(exist_ok=True)
    fetch_osm()
    terrain_count = fetch_tiles(TERRAIN_URL, TERRAIN_ZOOM, DATA / "terrain")
    imagery_count = fetch_tiles(IMAGERY_URL, IMAGERY_ZOOM, DATA / "imagery")
    elements = json.loads((DATA / "osm.json").read_text())["elements"]
    print(f"osm elements {len(elements)} terrain tiles {terrain_count} imagery tiles {imagery_count}")


if __name__ == "__main__":
    sys.exit(main())
