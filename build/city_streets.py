import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from shapely import transform
from shapely.geometry import box, shape
from shapely.ops import unary_union

import campus_region as region
import geo

SOURCE=region.CITY+"SidewalksDrivewaysParkingLots/MapServer/3"


def survey():
    params=dict(where="1=1",geometry=",".join(map(str,region.BBOX)),geometryType="esriGeometryEnvelope",
                spatialRel="esriSpatialRelIntersects",inSR=4326,f="json",returnIdsOnly="true")
    ids=json.loads(region.retrieve("street-polygon-ids.json",SOURCE+"/query",params).read_bytes())["objectIds"]
    bounds=box(region.X0,region.Z0,region.X1,region.Z1)
    def fetch(oid):
        params=dict(f="geojson",objectIds=str(oid),outSR=4326,outFields="OBJECTID,SurfaceType",geometryPrecision=7,maxAllowableOffset=.0000025)
        data=json.loads(region.retrieve(f"street-polygon-{oid}.geojson",SOURCE+"/query",params).read_bytes())
        return [transform(shape(f["geometry"]),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False).buffer(0).intersection(bounds) for f in data["features"]]
    with ThreadPoolExecutor(4) as pool:
        parts=[poly for polygons in pool.map(fetch,sorted(ids)) for poly in polygons]
    mapped=unary_union(parts).simplify(.21,preserve_topology=True)
    polys=[mapped] if mapped.geom_type=="Polygon" else mapped.geoms
    return [[np.round(np.asarray(ring.coords)[:-1],2).ravel().tolist() for ring in [poly.exterior,*poly.interiors]]
            for poly in polys if poly.geom_type=="Polygon" and poly.area>2]


if __name__=="__main__":
    ways=survey()
    print(f'{len(ways)} city pavement polygons, {sum(sum(len(ring)//2 for ring in rings) for rings in ways)} vertices')


def solid_ground_floors(network):
    from building_access import polygon
    floors=[polygon(rings) for rings in network['coreBuildings']]
    for i,(shell,holes,*_) in enumerate(json.loads(region.OUT.read_bytes())['blocks']):
        base=network.get('buildingBases',{}).get(str(i))
        for rings in base['floors'] if base else [[shell,*holes]]:
            floors.append(polygon(rings))
    return floors


def mapped_network(network,registered_crossings=True):
    from shapely.geometry import Polygon, LineString
    from shapely.ops import substring
    from shapely import STRtree
    city=unary_union([Polygon(np.array(rings[0]).reshape(-1,2),[np.array(h).reshape(-1,2) for h in rings[1:]]) for rings in survey()])
    near=city.buffer(2)
    roads=[city]
    for way in network['ways']:
        if way['kind']!='road' or way['bridge']:
            continue
        line=LineString([(p[0],p[2]) for p in way['points']])
        orphan=line.difference(near)
        if orphan.length<.5:
            continue
        for part in getattr(orphan,'geoms',[orphan]):
            if not isinstance(part,LineString) or part.length<.3:
                continue
            start=line.project(part.interpolate(0))
            end=start+part.length
            if line.is_ring and part.length+9>=line.length:
                merged=line
            elif line.is_ring:
                loop=LineString([*line.coords,*list(line.coords)[1:]])
                start=(start-4.5)%line.length
                merged=substring(loop,start,start+part.length+9)
            else:
                merged=substring(line,max(0,start-4.5),min(line.length,end+4.5))
            face=merged.buffer(way['width']/2,quad_segs=7)
            if way['class']=='service':
                from parcel_surfaces import survey as observed_parcel
                missing=observed_parcel().unpaved_service(merged,way['width'])
                if missing:face=face.difference(unary_union(missing))
            roads.append(face)
    extent=box(region.X0,region.Z0,region.X1,region.Z1)
    road=unary_union(roads).buffer(1.4,quad_segs=4).buffer(-1.4,quad_segs=4).intersection(extent).simplify(.13,preserve_topology=True)
    observed=json.loads(region.OUT.parents[1].joinpath('build/survey_ground.json').read_bytes())
    road=road.union(unary_union([Polygon(lane['outline']) for lane in observed['accessLanes']]))
    paint=json.loads(region.OUT.parents[1].joinpath('build/survey_road_paint.json').read_bytes()) if registered_crossings else {}
    crossings=[]
    travel=road.buffer(1)
    extra=json.loads(region.OUT.parents[1].joinpath('build/survey_pavement.json').read_bytes())['crossings'] if registered_crossings else []
    if registered_crossings:
        from ladder_crossings import registered
        extra=[*extra,*[row['bars']+row['rails'] for row in registered()]]
    for stripes in [*paint.get('crosswalks',{}).values(),*extra]:
        if len(stripes)<4:continue
        bars=unary_union([Polygon(np.asarray(p).reshape(-1,2)) for p in stripes])
        if not travel.intersects(bars):continue
        crossings.append(bars.convex_hull.buffer(.90,quad_segs=3))
    if crossings:road=road.union(unary_union(crossings).intersection(extent))

    road=road.difference(unary_union([Polygon(ring) for ring in observed['islands']]))
    from kerb_islands import observed as observed_islands
    islands=unary_union([poly for poly,_ in observed_islands()])
    from parking_bays import bay_floors
    road=road.difference(islands.union(bay_floors().difference(city.buffer(.12))))
    from site_frontages import geometry as site_geometry
    road=road.union(site_geometry('traffic')).difference(site_geometry('planting')).difference(site_geometry('walk')).difference(site_geometry('gravel'))
    floors=solid_ground_floors(network)
    index=STRtree(floors)
    adjacent=index.query(road,predicate='intersects')
    road=road.difference(unary_union([floors[i] for i in adjacent]).buffer(.025,quad_segs=2))
    parts=road.geoms if road.geom_type=='MultiPolygon' else [road]
    rings=[[np.round(np.asarray(ring.coords)[:-1],2).ravel().tolist() for ring in [poly.exterior,*poly.interiors]] for poly in parts if poly.area>1]
    city_edges=city.boundary.difference(islands.boundary.buffer(.42)).intersection(road.boundary.buffer(.32)).intersection(extent.buffer(-.5))
    lines=[line for line in getattr(city_edges,'geoms',[city_edges]) if line.geom_type=='LineString' and line.length>1]
    curbs=[np.round(np.asarray(line.simplify(.2).coords),2).ravel().tolist() for line in lines]
    return rings,curbs
