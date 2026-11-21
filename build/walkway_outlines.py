import base64
import io
import json
import zlib
from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.features import shapes
from scipy.ndimage import gaussian_filter
from shapely import get_parts
from shapely.geometry import Polygon, shape

ROOT = Path(__file__).resolve().parents[1]


def contours(tile):
    image = np.asarray(Image.open(io.BytesIO(base64.b64decode(tile))).getchannel('B'), dtype=np.float32)
    coverage = gaussian_filter(image, .95, mode='nearest') > 127
    output = []
    for item, _ in shapes(coverage.astype(np.uint8), mask=coverage):
        original = shape(item)
        if original.area < 6:
            continue
        polygon = original.simplify(1.35).buffer(4, quad_segs=3).buffer(-4, quad_segs=3)
        for part in get_parts(polygon.simplify(3.25, preserve_topology=True)):
            if not isinstance(part, Polygon):
                continue
            for ring in [part.exterior, *part.interiors]:
                points = np.asarray(ring.coords[:-1])
                points = np.rint(points / [image.shape[1], image.shape[0]] * 32767).clip(0, 32767).astype('<u2')
                if len(points) >= 3:
                    output.extend([len(points), *points.flatten()])
    return np.asarray(output, dtype='<u2').tobytes()


def build():
    terrain = json.loads((ROOT / 'web/surface-tiles.json').read_bytes())
    region = json.loads((ROOT / 'web/campus-region.json').read_bytes())
    ends, chunks, offset = [], [], 0
    for key, tile in terrain['finishes'].items():
        i, j = map(int, key.split(','))
        paths = contours(tile)
        ends.append([region['xs'][i], region['zs'][j], offset, len(paths) // 2])
        chunks.append(paths)
        offset += len(paths) // 2
    packed = base64.b64encode(zlib.compress(b''.join(chunks), 9)).decode()
    return 'export const pathTiles=' + json.dumps(ends, separators=(',', ':')) + ';\nexport const pathContours=\'' + packed + '\';\n'


if __name__ == '__main__':
    (ROOT / 'web/look/walkway-outlines.mjs').write_text(build())
