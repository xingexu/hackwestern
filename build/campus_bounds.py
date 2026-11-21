import json

import numpy as np
from shapely.geometry import LineString, Point, Polygon, box

import campus_region as region
import geo

OUT=region.OUT.with_name('campus-boundary.json')
CAMPUS_WAY=174869710
ENTRANCE_BRIDGE=142399227


def extent():
    data=json.loads((region.CACHE/'map.json').read_bytes())['elements']
    nodes={n['id']:geo.to_grid(n['lat'],n['lon']) for n in data if n['type']=='node'}
    ways={w['id']:w for w in data if w['type']=='way'}
    outline=Polygon([nodes[n] for n in ways[CAMPUS_WAY]['nodes']])
    entrance=LineString([nodes[n] for n in ways[ENTRANCE_BRIDGE]['nodes']])
    return outline.union(entrance.buffer(13,quad_segs=4))


def save():
    site=extent()
    polygons=[np.round(np.asarray(r.coords)[:-1],3).ravel().tolist() for r in [site.exterior,*site.interiors]]
    out=dict(name='Western University campus',polygons=[polygons],bounds=np.round(site.bounds,3).tolist(),area=round(site.area),sources=[f'https://www.openstreetmap.org/way/{w}' for w in (CAMPUS_WAY,ENTRANCE_BRIDGE)])
    OUT.write_text(json.dumps(out,separators=(',',':')))
    print('Western University grounds and University Drive entrance bridge:',out['area'],'square metres')


def footprint():
    data=json.loads(OUT.read_bytes())
    from shapely.ops import unary_union
    return unary_union([Polygon(np.reshape(r[0],(-1,2)),[np.reshape(h,(-1,2)) for h in r[1:]]) for r in data['polygons']])


if __name__=='__main__':
    import sys
    if '--check' not in sys.argv:
        save()
    area=footprint()
    assert area.symmetric_difference(extent()).area<3
    for x,z in [(300,305),(530,198),(240,1263),(-264,1199),(-503,849),(719,388)]:
        assert area.covers(Point(x,z))
    for x,z in [(1298,322),(675,-390),(1260,-800),(-900,1515)]:
        assert not area.covers(Point(x,z))
    print('Verified academic core, residences, athletics, Brescia and the campus entry bridge; surrounding neighbourhoods excluded.')
