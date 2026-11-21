import json
import math
from functools import lru_cache

import numpy as np
import shapely
from shapely.geometry import Polygon,box

import campus_region as region
from campus_bounds import footprint
from ortho_road_paint import pigment
from parking_stripes import lot_mask

OUT=region.OUT.parents[1]/'build/survey_islands.json'


def samples(poly,step=.65):
    l,t,r,b=poly.bounds
    x,z=np.meshgrid(np.arange(l+step*.5,r,step),np.arange(t+step*.5,b,step))
    mask=shapely.contains_xy(poly,x,z)
    if not mask.any():return np.empty((0,3))
    cloud=np.column_stack([x[mask],z[mask]])
    return pigment(cloud[::max(1,len(cloud)//700)])


def material(poly,public):
    inner=poly.buffer(-.24)
    if inner.is_empty:return 0
    inside=samples(inner)
    outside=samples(poly.buffer(1.5).difference(poly.buffer(.50)))
    if min(len(inside),len(outside))<5:return 0
    def color(c):
        r,g,b=c.T
        lum=(r+2*g+b)*.25
        neutral=(np.abs(r-g)<14)&(g-b<29)&(lum>56)
        warm=(r-b)>.19*lum
        green=(g-r>3)&(g-b>14)
        return lum,neutral,warm|green
    lum,native,plant=color(inside)
    outer,hard,lawn=color(outside)
    if hard.mean()<.33 or np.median(outer)<75:return 0
    strength=plant.mean()-lawn.mean()
    if strength>.22 and np.median(outer)-np.median(lum)>9:return 1
    if native.mean()>.48 and (public or np.median(lum)>np.median(outer)+11 and plant.mean()<.30):return 3
    return 0


def extract():
    import city_streets
    from parcel_surfaces import municipal_lines,close_kerb_returns
    site=footprint()
    lots=lot_mask().buffer(5)
    city=shapely.union_all([Polygon(np.reshape(s,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for s,*holes in city_streets.survey()])
    parts=shapely.get_parts(city)
    holes=[Polygon(r) for p in parts for r in p.interiors]
    public=[p for p in holes if 5<p.area<3000 and site.intersects(p)]
    borders=municipal_lines('parking',site)
    connected=shapely.get_parts(shapely.union_all([*borders,*close_kerb_returns(borders)],grid_size=.08))
    faces=[g for g in shapely.get_parts(shapely.polygonize(connected)) if 3<g.area<1200 and lots.covers(g.representative_point())]
    results=[]
    for p,civic in [*[(g,True) for g in public],*[(g,False) for g in faces]]:
        width=2*p.area/p.length
        if not .33<width<5.9 or p.area/(width*width)<2.3 or len(p.interiors)>0:continue
        label=material(p,civic)
        if not label:continue
        pts=np.asarray(p.simplify(.08).exterior.coords)[:-1].round(2).tolist()
        results.append(dict(outer=pts,material=label,public=civic))
    return results


@lru_cache(maxsize=1)
def observed():
    return [(Polygon(rec['outer']),rec['material']) for rec in json.loads(OUT.read_bytes())]


def runtime():
    records=[]
    for island,material in observed():
        island=shapely.orient_polygons(island)
        left,top,right,bottom=island.bounds
        xs,zs=np.meshgrid(np.arange(math.floor(left/3)*3,right,3),np.arange(math.floor(top/3)*3,bottom,3))
        top_surface=island.buffer(-.15,quad_segs=3)
        clipped=shapely.intersection(top_surface,shapely.box(xs.ravel(),zs.ravel(),xs.ravel()+3,zs.ravel()+3))
        polys=shapely.get_parts(clipped)
        faces=shapely.get_parts(shapely.constrained_delaunay_triangles(polys[shapely.get_type_id(polys)==3]))
        coords=shapely.get_coordinates(faces).reshape(-1,4,2)[:,:3]
        records.append(dict(ring=np.asarray(island.exterior.coords)[:-1].round(2).tolist(),kind=material,triangles=coords.round(3).reshape(-1,6).tolist()))
    return records


if __name__=='__main__':
    records=extract()
    OUT.write_text(json.dumps(records,separators=(',',':')))
    print(len(records),'kerbed islands,',sum(r['public'] for r in records),'in public carriageways.')
