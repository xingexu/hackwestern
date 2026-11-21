import base64
import json
import zlib
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter, maximum_filter
from rasterio import Affine
from rasterio.features import rasterize
from shapely.geometry import Polygon

import geo

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data' / 'region'
OUTPUT = ROOT / 'web' / 'look' / 'survey-weathering.mjs'


def boundary_ecology():
    parcel = json.loads((ROOT / 'web/campus-boundary.json').read_bytes())
    context = json.loads((ROOT / 'web/ground-materials.json').read_bytes())['landcover']['context']
    lx, nz, rx, sz = parcel['bounds']
    left, top = lx - 16, nz - 16
    step = 2.5
    w, h = int(np.ceil((rx + 16 - left) / step)), int(np.ceil((sz + 16 - top) / step))
    polygons = [Polygon(np.reshape(rings[0], (-1, 2)), [np.reshape(r, (-1, 2)) for r in rings[1:]]) for rings in parcel['polygons']]
    mask = rasterize(polygons, out_shape=(h, w), transform=Affine.translation(left, top) * Affine.scale(step), dtype='uint8')
    distance, nearest = distance_transform_edt(mask, return_indices=True)
    heights, widths = nearest
    x, z = left + (widths + .5) * step, top + (heights + .5) * step
    cl, ct, cr, cb = context['bounds']
    cw, ch = context['size']
    cover = np.frombuffer(zlib.decompress(base64.b64decode(context['coverage'])), 'uint8').reshape(ch, cw, 4)
    colors = cover[((z - ct) * ch / (cb - ct)).astype(int).clip(0, ch - 1), ((x - cl) * cw / (cr - cl)).astype(int).clip(0, cw - 1)]
    falloff = np.clip((distance * step - step) / 13, 0, 1)
    weight = (1 - falloff * falloff * (3 - 2 * falloff)) * (1 - colors[:, :, [0, 2, 3]].max(axis=2) / 255)
    near = distance_transform_edt(1 - mask) < 3
    pixels = np.dstack([np.rint(255 * weight * near), colors[:, :, 1] * near * (falloff < 1)]).astype('uint8')
    return {'width': w, 'height': h, 'bounds': [left, top, left + w * step, top + h * step],
            'samples': base64.b64encode(zlib.compress(pixels.tobytes(), 9)).decode()}


def pavement_weathering():
    size = 384
    mosaic = Image.new('RGB', (size, size))
    for row in range(4):
        for col in range(4):
            with Image.open(CACHE / f'aerial-fine-{col}-{row}.jpg') as tile:
                mosaic.paste(tile.resize((size // 4, size // 4), Image.Resampling.BOX), (col * size // 4, row * size // 4))
    surface = np.load(CACHE / 'regional-dsm.npy') - np.load(CACHE / 'regional-dtm.npy')
    relief = np.asarray(Image.fromarray(maximum_filter(surface, 5)).resize((size, size), Image.Resampling.BOX))
    rgb = np.asarray(mosaic, dtype=np.float32)
    r, g, b = rgb.transpose(2, 0, 1)
    value = .213 * r + .715 * g + .072 * b
    paved = (relief < .55) & (value > 72) & (value < 179) & (g - b < 18) & (abs(r - g) < 13)
    def level(radius):
        confidence = gaussian_filter(paved.astype(np.float32), radius)
        weighted = gaussian_filter(np.where(paved, value, 0), radius)
        return (weighted + 117 * .035) / (confidence + .035), confidence
    local, confidence = level(.72)
    regional, _ = level(5.0)
    grade = np.clip((local - regional) / 30, -1, 1) * np.clip(confidence * 2.5, 0, 1)
    sampled = (128 + 4 * np.rint(grade * 31)).astype(np.uint8)
    elements = json.loads((CACHE / 'map.json').read_bytes())['elements']
    nodes = {item['id']: item for item in elements if item['type'] == 'node'}
    covered = []
    for item in elements:
        tags = item.get('tags', {})
        if item['type'] != 'way' or tags.get('leisure') != 'pitch' or tags.get('surface', '').lower() != 'covered':
            continue
        ring = [geo.to_grid(nodes[n]['lat'], nodes[n]['lon']) for n in item['nodes']]
        apron = Polygon(ring).buffer(2.5, join_style='mitre')
        covered.append([round(v, 2) for point in apron.exterior.coords[:-1] for v in point])
    courts = json.dumps(covered, separators=(',', ':'))
    ecology = json.dumps(boundary_ecology(), separators=(',', ':'))
    return f'export const boundaryEcology={ecology};\nexport const coveredCourts={courts};\nexport const weatheringSize={size};\nexport const weatheringSamples=\'{base64.b64encode(zlib.compress(sampled.tobytes(), 9)).decode()}\';\n'


if __name__ == '__main__':
    OUTPUT.write_text(pavement_weathering())
