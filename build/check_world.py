import base64
import io
import json
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

import geo
from voxelize import building_rasters, collect_layers

WEB = Path(__file__).resolve().parent.parent / "web"
REQUIRED_LABELS = {"University College", "Middlesex College", "Weldon Library", "Physics Building"}
MIN_LANDMARK_RISE = 30


def fail(message):
    print(f"FAIL {message}")
    sys.exit(1)


def column_top(volume, x0, x1, z0, z1):
    region = volume[:, z0:z1, x0:x1] != 0
    filled_levels = np.nonzero(region.any(axis=(1, 2)))[0]
    return int(filled_levels.max()) if len(filled_levels) else -1


def main():
    meta = json.loads((WEB / "world.json").read_text())
    width, height, depth = meta["width"], meta["height"], meta["depth"]
    ground = json.loads((WEB / "campus-ground.json").read_text())
    heights = np.frombuffer(zlib.decompress(base64.b64decode(ground["heightMillimeters"])), dtype="<u2")
    if heights.size != depth * width or np.mean(heights % 1000 != 0) < .5:
        fail("The campus ground lost its submeter lidar heights")
    buildings = collect_layers(geo.load_osm())[0]
    footprints = np.logical_or.reduce([mask for _, mask in building_rasters(buildings)])
    cut = np.frombuffer(zlib.decompress(base64.b64decode(ground["cut"])), dtype=np.uint8)
    if not np.array_equal(heights[footprints.ravel()], cut[footprints.ravel()].astype(np.uint32) * 1000):
        fail("Ground under mapped buildings must match their voxel foundations")
    with Image.open(io.BytesIO(base64.b64decode(ground["texture"]))) as texture:
        if texture.width < width * 4 or texture.height < depth * 4:
            fail("Campus ground must retain at least four texture samples per metre")
    raw = zlib.decompress((WEB / "world.bin").read_bytes())
    if len(raw) != width * height * depth:
        fail(f"world.bin holds {len(raw)} voxels, expected {width * height * depth}")
    volume = np.frombuffer(raw, dtype=np.uint8).reshape(height, depth, width)
    palette = meta["palette"]
    if int(volume.max()) >= len(palette):
        fail(f"voxel index {int(volume.max())} outside palette of {len(palette)}")
    names = {label["name"] for label in meta["labels"]}
    missing = REQUIRED_LABELS - names
    if missing:
        fail(f"missing labels {sorted(missing)}")
    if (volume[0] == 0).any():
        fail("terrain has holes at the bottom layer")
    if (volume[-1] != 0).any():
        fail("something touches the ceiling of the volume")
    ground_level = column_top(volume, 380, 420, 330, 360)
    for name, box in {"University College tower": (293, 310, 302, 319), "Middlesex clock tower": (522, 539, 191, 208)}.items():
        rise = column_top(volume, *box) - ground_level
        if rise < MIN_LANDMARK_RISE:
            fail(f"{name} rises only {rise} voxels above the lawn")
    print(f"ok {width}x{height}x{depth}, {int((volume != 0).sum())} solid voxels, {len(palette) - 1} colours, {len(names)} labels")


if __name__ == "__main__":
    main()
