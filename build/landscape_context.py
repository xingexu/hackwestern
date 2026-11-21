import base64
import json
import zlib

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
import shapely
from shapely.geometry import Polygon

import campus_region as region
import driving_horizon
import geo


def packed(values):
    return base64.b64encode(zlib.compress(values.tobytes(), 9)).decode()


def south_survey():
    left, top, right, bottom = -1156, region.Z1, 1276, region.Z1 + 640
    width, height = 608, 160
    xs = np.linspace(left, right, width // 4 + 1)
    zs = np.linspace(top, bottom, height // 4 + 1)
    positions = np.stack(np.meshgrid(xs, zs), -1).reshape(-1, 2)
    datum = ndimage.gaussian_filter(geo.lidar_surfaces()[0], 1.2).min() - 4
    heights = np.rint((driving_horizon.elevations(positions) - datum) * 16).astype('<i2')
    cover = Image.new('L', (width, height), 2)
    draw = ImageDraw.Draw(cover)
    roads = []
    features = json.loads((region.CACHE / 'horizon-osm-band-2.json').read_bytes())['elements']
    nodes = {e['id']: geo.to_grid(e['lat'], e['lon']) for e in features if e['type'] == 'node'}
    for e in features:
        if e['type'] != 'way' or not all(n in nodes for n in e['nodes']):
            continue
        tags = e.get('tags', {})
        path = [((nodes[n][0]-left)/4, (nodes[n][1]-top)/4) for n in e['nodes']]
        if tags.get('highway') and tags['highway'] not in ('footway', 'path', 'steps', 'cycleway'):
            roads.append((path, 3 if tags['highway'] in ('primary', 'secondary') else 2))
        elif path[0] == path[-1] and len(path) >= 4:
            if tags.get('natural') == 'water' or 'water' in tags:
                draw.polygon(path, fill=1)
            elif tags.get('natural') in ('wood', 'scrub') or tags.get('landuse') == 'forest':
                draw.polygon(path, fill=0)
            elif tags.get('amenity') == 'parking':
                draw.polygon(path, fill=4)
    for path, line_width in roads:
        draw.line(path, fill=4, width=line_width)
    return dict(bounds=[left, top, right, bottom], width=width, height=height,
                elevation=packed(heights), surface=packed(np.asarray(cover)))


def outer_trees():
    parcels = json.loads(region.OUT.with_name('campus-boundary.json').read_bytes())['polygons']
    site = shapely.union_all([Polygon(np.asarray(p[0]).reshape(-1, 2), [np.asarray(h).reshape(-1, 2) for h in p[1:]]) for p in parcels])
    belt = site.buffer(230).difference(site)
    trees = json.loads(region.OUT.read_bytes())['trees']
    records = []
    for x, _, z, height, rgb, diameter in trees:
        if shapely.contains_xy(belt, x, z):
            records.append([round(2*x), round(2*z), round(height*8), round(diameter*8), round(np.mean(rgb))])
    return packed(np.array(records, dtype='<i2'))


if __name__ == '__main__':
    output = region.OUT.parent / 'look' / 'landscape-data.mjs'
    data = south_survey()
    data['trees'] = outer_trees()
    output.write_text('export default ' + json.dumps(data, separators=(',', ':')) + ';\n')
