import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import laspy
import numpy as np
import requests
from pyproj import Transformer
from scipy import ndimage

import geo
from area import WEST, NORTH

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/buildings/lidar"
SERVICE = "https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/lidar_point_cloud_canelevation_en/MapServer/1/query"


def download(tile):
    path = CACHE / (tile["tile_name"] + ".laz")
    if not path.exists():
        response = requests.get(tile["url"], timeout=120)
        response.raise_for_status()
        path.write_bytes(response.content)
    return path


def run():
    CACHE.mkdir(exist_ok=True)
    inventory = json.loads((ROOT / "data/buildings/inventory.json").read_text())["buildingsList"]
    coords = np.concatenate([b["footprint"] for b in inventory])
    (left, top), (right, bottom) = np.floor(coords.min(axis=0)).astype(int)-4, np.ceil(coords.max(axis=0)).astype(int)+4
    width, height = right-left, bottom-top
    def lon(x):
        return WEST+x/geo.METERS_PER_DEGREE_LON
    def lat(z):
        return NORTH-z/geo.METERS_PER_DEGREE_LAT
    response = requests.get(SERVICE, params=dict(geometry=f"{lon(left)},{lat(bottom)},{lon(right)},{lat(top)}", geometryType="esriGeometryEnvelope", inSR=4326, where="1=1", outFields="*", returnGeometry="false", f="json"), timeout=30)
    response.raise_for_status()
    tiles = [f["attributes"] for f in response.json()["features"] if f["attributes"]["project"] == "2017-LakeErie"]
    surface = np.full((height,width), -np.inf, np.float32)
    with ThreadPoolExecutor(3) as pool:
        for path in pool.map(download, tiles):
            with laspy.open(path) as source:
                transform = Transformer.from_crs(source.header.parse_crs() or 26917, 4326, always_xy=True)
                for points in source.chunk_iterator(300000):
                    first = (points.return_number == 1) & ~np.isin(points.classification,[7,18])
                    lon_a,lat_a = transform.transform(points.x[first],points.y[first])
                    x,z=geo.to_grid(lat_a,lon_a)
                    ix,iz=np.floor(x).astype(int)-left,np.floor(z).astype(int)-top
                    inside=(ix>=0)&(ix<width)&(iz>=0)&(iz<height)
                    np.maximum.at(surface,(iz[inside],ix[inside]),np.array(points.z[first])[inside])
            print(path.name,flush=True)
    holes = ~np.isfinite(surface)
    nearest=ndimage.distance_transform_edt(holes,return_distances=False,return_indices=True)
    surface[holes]=surface[tuple(nearest[:,holes])]
    np.savez_compressed(CACHE/"roof-grid.npz",surface=surface,origin=[left,top])
    print(surface.shape,len(tiles))


if __name__ == "__main__":
    run()
