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
    coverage = gaussian_filter(image, .65, mode='nearest') > 127
    output = []
    for item, _ in shapes(coverage.astype(np.uint8), mask=coverage):
        original = shape(item)
        if original.area < 6:
            continue
        polygon = original.simplify(.8).buffer(1.5, quad_segs=3).buffer(-1.5, quad_segs=3)
        for part in get_parts(polygon.simplify(.8, preserve_topology=True)):
            if not isinstance(part, Polygon):
                continue
            for ring in [part.exterior, *part.interiors]:
                points = np.asarray(ring.coords[:-1])
                points = np.rint(points / [image.shape[1], image.shape[0]] * 32767).clip(0, 32767).astype('<u2')
                if len(points) >= 3:
                    output.extend([len(points), *points.flatten()])
    return np.asarray(output, dtype='<u2').tobytes()


def outline_pack(finishes, region):
    ends, chunks, offset = [], [], 0
    for key, tile in finishes.items():
        i, j = map(int, key.split(','))
        paths = contours(tile)
        ends.append([region['xs'][i], region['zs'][j], offset, len(paths) // 2])
        chunks.append(paths)
        offset += len(paths) // 2
    packed = base64.b64encode(zlib.compress(b''.join(chunks), 9)).decode()
    return dict(tiles=ends,coordinates=packed)


if __name__ == '__main__':
    from tempfile import NamedTemporaryFile
    tiles=ROOT/'web/surface-tiles.json'
    data=json.loads(tiles.read_bytes())
    region=json.loads((ROOT/'web/campus-region.json').read_bytes())
    data['walkwayOutlines']=outline_pack(data['finishes'],region)
    with NamedTemporaryFile(dir=tiles.parent,suffix='.pending',delete=False,mode='w') as target:
        json.dump(data,target,separators=(',',':'))
    produced=Path(target.name)
    produced.chmod(tiles.stat().st_mode)
    produced.replace(tiles)
