import base64
import io
import json
import zlib

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

import geo


def packed(array):
    return base64.b64encode(zlib.compress(array.tobytes(), 9)).decode("ascii")


def write_ground(path, terrain, base, ground, footprints, imagery, roads, paths, parking, paved, water, grass):
    scale = 4
    size = (geo.WIDTH * scale, geo.DEPTH * scale)
    classes = Image.new("L", size)
    draw = ImageDraw.Draw(classes)

    def points(line):
        return [(round(x * scale), round(z * scale)) for x, z in line]

    def areas(polygons, value):
        for outers, holes in polygons:
            for ring in outers:
                if len(ring) >= 3:
                    draw.polygon(points(ring), fill=value)
            for ring in holes:
                if len(ring) >= 3:
                    draw.polygon(points(ring), fill=0)

    def lanes(lines, value):
        for line, width in lines:
            draw.line(points(line), fill=value, width=round(width * scale), joint="curve")

    areas(water, 3)
    areas(paved, 2)
    lanes(paths, 2)
    areas(parking, 1)
    lanes(roads, 1)
    palette = np.asarray([np.clip(grass, [100, 126, 68], [145, 159, 100]), [106, 107, 103], [177, 171, 150], [83, 115, 121]])
    mask = np.asarray(classes)
    light = imagery @ np.array([.299, .587, .114])
    broad = ndimage.gaussian_filter(light, 2.3) - ndimage.gaussian_filter(light, 17)
    broad = Image.fromarray(np.clip(128 + broad * .40, 100, 154).astype(np.uint8)).resize(size, Image.Resampling.BILINEAR)
    noise = np.random.default_rng(947).normal(0, 2.8, mask.shape)
    shade = (np.asarray(broad).astype(np.float32) - 128 + noise) * np.where(mask == 0, 1, .40)
    image = Image.fromarray(np.clip(palette[mask] + shade[..., None], 0, 255).astype(np.uint8))
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=85, subsampling=0, optimize=True)
    heights = terrain - terrain.min() + base + 1
    building_surface = np.where(footprints, ground + 1, heights)
    heights = np.where(footprints, building_surface, ndimage.gaussian_filter(building_surface, .8))
    millimeters = np.rint(heights * 1000).astype("<u2")
    cut = (ground + 1).astype(np.uint8)
    data = {"width": geo.WIDTH, "depth": geo.DEPTH, "texelsPerMeter": scale, "heightMillimeters": packed(millimeters),
            "cut": packed(cut), "texture": base64.b64encode(encoded.getvalue()).decode("ascii")}
    path.write_text(json.dumps(data, separators=(",", ":")))
