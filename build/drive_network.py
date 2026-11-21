import base64
import heapq
import json
import re
import sys
import zlib
from collections import defaultdict

import numpy as np
from scipy import ndimage
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree

from building_access import resolve_drives, verify_drives
import campus_region as region
import geo
from drive_route import resample
from voxelize import collect_layers

WEB = region.OUT.parent
OUT = WEB / "drive-network.json"
BOUNDS = [region.X0, region.Z0, region.X1, region.Z1]
EXTENT = box(*BOUNDS)
ROAD_WIDTHS = {"primary": 13, "secondary": 11, "secondary_link": 6, "tertiary": 8.6,
               "residential": 7, "living_street": 5.5, "service": 5.2, "unclassified": 6}
PATH_WIDTHS = {"footway": 2.4, "path": 2.2, "cycleway": 3.2, "pedestrian": 4.4, "steps": 2.4,
               "track": 3.6, "bridleway": 2.6}
CIRCUITS = [
    ("college", "College Hill Circuit", [1558352448, 1558352521, 1558352517, 1557328179, 5292513911], {"Middlesex Drive","Elgin Drive","Oxford Drive","Lambton Drive"}),
    ("stadium", "Stadium Circuit", [1558352330, 1558352319, 1558352354, 5292513911], {"Phillip Aziz Avenue","Western Road","Lambton Drive","Huron Drive"}),
    ("campus", "Main Campus Circuit", [1558352521,1558352517,1558352373,1558352354,1558352319,1558352330,5292513911,1558352448], {"Middlesex Drive","Elgin Drive","Oxford Drive","Lambton Drive","Phillip Aziz Avenue","Western Road","Huron Drive"})
]


def components(geometry, kind):
    for piece in getattr(geometry, "geoms", [geometry]):
        if piece.geom_type == kind and not piece.is_empty:
            yield piece


def rings(poly):
    return [np.round(np.asarray(ring.coords)[:-1, :2], 2).ravel().tolist() for ring in [poly.exterior, *poly.interiors]]


def numeric(value, default):
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(?:\s*m)?", str(value))
    return float(match.group(1)) if match else default


def route_nodes(graph, a, b, preferred):
    queue, costs, parents = [(0, a)], {a: 0}, {}
    while queue:
        cost, key = heapq.heappop(queue)
        if key == b:
            chain = [b]
            while chain[-1] != a:
                chain.append(parents[chain[-1]])
            return chain[::-1]
        if cost != costs[key]:
            continue
        for nxt, length, name in graph[key]:
            total = cost + length * (1 if name in preferred else 15)
            if total >= costs.get(nxt, float("inf")):
                continue
            costs[nxt], parents[nxt] = total, key
            heapq.heappush(queue, (total, nxt))
    raise ValueError(f"Disconnected course between OSM nodes {a} and {b}")


def paved_area_kind(tags):
    if (tags.get("building", "no") != "no" or tags.get("building:part", "no") != "no"
            or tags.get("location") in ("underground", "rooftop", "roof", "overground")
            or tags.get("level", "0") not in ("0", "0.0", "ground")
            or tags.get("layer", "0") not in ("0", "0.0")
            or tags.get("indoor") == "yes"):
        return None
    if tags.get("amenity") == "parking":
        return "parking" if tags.get("parking", "surface") in ("surface", "street_side", "lane") else None
    highway = tags.get("area:highway", tags.get("highway") if tags.get("area") == "yes" else None)
    if tags.get("place") == "square" or highway == "pedestrian":
        return "plaza"
    if highway in ROAD_WIDTHS:
        return "road"
    if highway in ("footway", "path", "cycleway", "platform"):
        return "path"
    return None


def mapped_areas(elements, ways, nodes):
    def pieces(element):
        if element["type"] == "way":
            ids = element["nodes"]
            if len(ids)>3 and ids[0] == ids[-1] and all(n in nodes for n in ids):
                yield Polygon([nodes[n] for n in ids]).buffer(0)
        elif element["type"] == "relation" and element["tags"].get("type") == "multipolygon":
            lines = {"outer": [], "inner": []}
            for member in element["members"]:
                way = ways.get(member["ref"])
                role = member["role"] or "outer"
                if member["type"] != "way" or role not in lines or not way:
                    continue
                ids = way["nodes"]
                if len(ids)>1 and all(n in nodes for n in ids):
                    lines[role].append(LineString([nodes[n] for n in ids]))
            cavities = unary_union(list(polygonize(lines["inner"])))
            for outer in polygonize(lines["outer"]):
                yield outer.difference(cavities)

    landscaped = []
    for element in elements:
        t = element.get("tags", {})
        if t.get("landuse") in ("grass","flowerbed") or t.get("natural") in ("grassland","scrub","wood","water") or t.get("leisure")=="garden":
            landscaped.extend(pieces(element))
    green = STRtree(landscaped)
    relation_outlines = {
        member["ref"] for e in elements
        if e["type"]=="relation" and e.get("tags",{}).get("type")=="multipolygon" and paved_area_kind(e["tags"])
        for member in e["members"] if member["type"]=="way" and member["role"] in ("","outer")
    }
    areas = []
    for element in elements:
        if element["type"]=="way" and element["id"] in relation_outlines:
            continue
        tags = element.get("tags",{})
        kind = paved_area_kind(tags)
        if not kind or tags.get("surface") in ("grass","grass_paver","sand","mud"):
            continue
        material = tags.get("surface", "asphalt" if kind in ("parking","road") else "paving_stones")
        for geometry in pieces(element):
            geom = geometry.intersection(EXTENT)
            overlaps = green.query(geom,predicate="intersects")
            if len(overlaps):
                geom = geom.difference(unary_union([landscaped[i] for i in overlaps]))
            for part in components(geom,"Polygon"):
                if part.area > 1:
                    areas.append(dict(id=element["id"],kind=kind,material=material,
                                      name=tags.get("name",""),rings=rings(part)))
    survey=json.loads(WEB.parent.joinpath('build/survey_ground.json').read_bytes())
    for i,patch in enumerate(survey['patches']):
        shell,*holes=patch['rings']
        paved=patch['class']==5
        areas.append(dict(id=f'ortho-2025-{i}',kind='parking' if paved else 'plaza',material='asphalt' if paved else 'concrete',
                          name=patch['name'],rings=rings(Polygon(shell,holes))))
    return areas


def fit_bridge_decks(ways):
    datum = ndimage.gaussian_filter(geo.lidar_surfaces()[0], 1.2).min() - 4
    surface = region.lidar("dsm") - datum
    decks = []
    roads = []
    for w in ways:
        if not w["bridge"]:
            continue
        points = np.array(w["points"])
        coords = points[:,[0,2]]
        distance = np.r_[0,np.cumsum(np.linalg.norm(np.diff(coords,axis=0),axis=1))]
        tangent = np.gradient(coords,axis=0)
        normal = tangent[:,[1,0]] * [1,-1] / np.maximum(.001,np.linalg.norm(tangent,axis=1))[:,None]
        readings = [region.sample(surface,*(coords+offset*w["width"]*normal).T) for offset in (-.23,0,.23)]
        elevations = np.quantile(readings,.20,axis=0)
        covered = w["covered"]
        floor = np.max(points[[0,-1],1]) + (.1 if not covered else 2.6)
        ceiling = floor + (max(4,w["level"]*3.4) if covered else 6)
        third = max(1,(len(points)+2)//3)
        ends = np.array([np.quantile(sample,.20) for sample in (elevations[:third],elevations[-third:])])
        centre = np.clip(np.quantile(elevations,.22) - (3.1 if covered else 0),floor,ceiling)
        grade = np.clip((ends[-1]-ends[0])/distance[-1],-.025,.025)
        fitted = centre + (distance-.5*distance[-1])*grade
        decks.append((w,coords,fitted))
        if w["kind"]=="road":
            roads.append((LineString(coords),w,coords,fitted))
    nodes=defaultdict(list)
    for index,(w,coords,heights) in enumerate(decks):
        for (x,z),y in zip(coords,heights):
            nodes[x,z,w["level"]].append((index,y))
    equations=[]
    differences=[]
    for attached in nodes.values():
        first,h=attached[0]
        for other,y in attached[1:]:
            if first==other:
                continue
            equation=np.zeros(len(decks))
            equation[first],equation[other]=1,-1
            equations.append(equation)
            differences.append(y-h)
    if equations:
        corrections=np.linalg.lstsq(equations,differences,rcond=None)[0]
        for index,(w,coords,heights) in enumerate(decks):
            heights+=corrections[index]
    raised = {}
    for w,coords,fitted in decks:
        if w["class"]=="footway" and not w["covered"]:
            line = LineString(coords)
            if roads:
                road,vehicle,rcoords,rheights=min(roads,key=lambda entry:line.hausdorff_distance(entry[0]))
                if line.hausdorff_distance(road)<13 and line.length>.68*road.length:
                    projections=[road.project(Point(p))/road.length for p in coords]
                    fitted=rheights[0]+(rheights[-1]-rheights[0])*np.array(projections)+.12
                    adjacent=np.array([line.interpolate(line.project(Point(p))).coords[0] for p in rcoords])
                    tangent=np.gradient(rcoords,axis=0)
                    normal=tangent[:,[1,0]]*[1,-1]/np.linalg.norm(tangent,axis=1)[:,None]
                    offsets=np.sum((adjacent-rcoords)*normal,axis=1)
                    side=int(np.sign(np.median(offsets)))
                    if side and np.all(offsets*side>1.7):
                        vehicle.setdefault("deckWalks",[]).append(dict(side=side,width=w["width"],offsets=np.abs(offsets).round(2).tolist()))
                        w["onDeck"]=vehicle["id"]
        for p,h in zip(w["points"],fitted):
            p[1] = round(float(h),2)
        if not w["covered"] and w["level"]==0:
            for x,y,z in (w["points"][0],w["points"][-1]):
                raised[x,z] = max(y,raised.get((x,z),-np.inf))
    neighbors = defaultdict(list)
    for w in ways:
        if w["bridge"]:
            continue
        coords = [(p[0],p[2]) for p in w["points"]]
        for a,b in zip(coords,coords[1:]):
            drop = .065*np.hypot(b[0]-a[0],b[1]-a[1])
            neighbors[a].append((b,drop))
            neighbors[b].append((a,drop))
    base = {(x,z):y for w in ways if not w["bridge"] for x,y,z in w["points"]}
    queue = [(-h,node) for node,h in raised.items()]
    heapq.heapify(queue)
    while queue:
        cost,node = heapq.heappop(queue)
        h = -cost
        if h<raised[node]:
            continue
        for key,drop in neighbors[node]:
            new = h-drop
            if new <= max(base[key],raised.get(key,-np.inf)):
                continue
            raised[key] = new
            heapq.heappush(queue,(-new,key))
    for w in ways:
        if not w["bridge"]:
            for p in w["points"]:
                p[1] = round(max(p[1],raised.get((p[0],p[2]),-np.inf)),2)


def make_network():
    elements = json.loads((region.CACHE / "map.json").read_text())["elements"]
    nodes = {e["id"]: geo.to_grid(e["lat"], e["lon"]) for e in elements if e["type"] == "node"}
    by_id = {e["id"]: e for e in elements if e["type"] == "way"}
    groups = defaultdict(set)
    region_data = json.loads(region.OUT.read_text())
    xs, zs = np.array(region_data["xs"]), np.array(region_data["zs"])
    broad = np.frombuffer(base64.b64decode(region_data["elevation"]), dtype="<i2").reshape(len(zs),len(xs)) / 10
    core = json.loads((WEB / "campus-ground.json").read_text())
    near = np.frombuffer(zlib.decompress(base64.b64decode(core["heightMillimeters"])), dtype="<u2").reshape(geo.DEPTH,geo.WIDTH) * .001

    def elevation(points):
        x,z = points.T
        ix = np.maximum(0, np.minimum(len(xs)-2, xs.searchsorted(x, side="right")-1))
        iz = np.maximum(0, np.minimum(len(zs)-2, zs.searchsorted(z, side="right")-1))
        u = (x-xs[ix]) / (xs[ix+1]-xs[ix])
        v = (z-zs[iz]) / (zs[iz+1]-zs[iz])
        a,b,c,d = broad[iz,ix], broad[iz,ix+1], broad[iz+1,ix], broad[iz+1,ix+1]
        y = np.where(u+v <= 1, a+(b-a)*u+(c-a)*v, d+(c-d)*(1-u)+(b-d)*(1-v))
        core_mask = (0 <= x) & (x <= geo.WIDTH) & (0 <= z) & (z <= geo.DEPTH)
        y[core_mask] = ndimage.map_coordinates(near, [z[core_mask]-.5, x[core_mask]-.5], order=1, mode="nearest")
        return y

    ground_survey=json.loads(WEB.parent.joinpath("build/survey_ground.json").read_bytes())
    roads = []
    graph = defaultdict(list)
    for way in by_id.values():
        if way["id"] in ground_survey["absentServiceWays"]:continue
        tags = way.get("tags", {})
        h = tags.get("highway")
        if h not in ROAD_WIDTHS | PATH_WIDTHS or tags.get("area") == "yes" or tags.get("indoor") == "yes" or tags.get("location") == "underground":
            continue
        ids = [k for k in way["nodes"] if k in nodes]
        if len(ids) < 2:
            continue
        for key in ids:
            groups[key].add(way["id"])
        name = tags.get("name", tags.get("ref",""))
        roads.append((way, tags, ids, h, name))
        if h in ROAD_WIDTHS:
            for a,b in zip(ids,ids[1:]):
                if a == b:
                    continue
                length = np.hypot(nodes[a][0]-nodes[b][0], nodes[a][1]-nodes[b][1])
                direction = tags.get("oneway")
                if direction != "-1":
                    graph[a].append((b,length,name))
                if direction not in ("yes","1","true"):
                    graph[b].append((a,length,name))

    ways = []
    for way,tags,ids,h,name in roads:
        points = [nodes[key] for key in ids]
        line = LineString(points)
        width = numeric(tags.get("width"), ROAD_WIDTHS.get(h,PATH_WIDTHS.get(h)))
        lanes = int(numeric(tags.get("lanes"), 2 if h in ("secondary","tertiary","residential") else 1))
        if h == "service" and tags.get("service") in ("driveway","parking_aisle"):
            width = numeric(tags.get("width"), 3.6)
        if "width" not in tags and "lanes" in tags:
            width = 3.25 * lanes + .4
        width = round(float(np.clip(width, 1, 28)),2)
        bridge = tags.get("bridge") not in (None, "no")
        junction_points = np.array([nodes[key] for key in ids if len(groups[key]) > 1])
        for part in components(line.intersection(EXTENT), "LineString"):
            if part.length < .7:
                continue
            base = np.asarray(part.coords)
            delta = np.linalg.norm(np.diff(base,axis=0),axis=1)
            base = base[np.r_[True,delta>.02]]
            if len(base)<2:
                continue
            pieces = [np.linspace(a,b,int(np.ceil(np.linalg.norm(a-b)/5)),endpoint=False) for a,b in zip(base,base[1:])]
            coords = np.vstack([*pieces,base[-1:]])
            y = elevation(coords)
            distance = np.r_[0,np.cumsum(np.linalg.norm(np.diff(coords,axis=0),axis=1))]
            if bridge:
                y = np.interp(distance, [0,distance[-1]], [y[0],y[-1]]) + .16
            deck = np.round(np.c_[coords[:,0], y+.08, coords[:,1]],2)
            junctions = []
            for point in junction_points:
                err = ((coords-point)**2).sum(axis=1)
                index = int(err.argmin())
                if err[index] < .02:
                    junctions.append(index)
            ways.append(dict(id=way["id"], name=name, width=width, kind="road" if h in ROAD_WIDTHS else "steps" if h=="steps" else "path",
                             bridge=bridge, oneway=tags.get("oneway") in ("yes","1","true","-1"), covered=tags.get("covered")=="yes", level=numeric(tags.get("level"),0), material=tags.get("surface","asphalt" if h in ROAD_WIDTHS else "paving_stones"),
                             lanes=lanes, junctions=sorted(set(junctions)), points=deck.tolist(), **{"class":h}))

    tiers=json.loads((WEB / "region-detail.json").read_bytes())["architecture"]["tiers"]
    building_bases=resolve_drives(ways,region_data["blocks"],tiers,elevation)
    for lane in ground_survey['accessLanes']:
        points=np.asarray(LineString(lane['points']).segmentize(3).coords)
        heights=elevation(points)
        ways.append(dict(id=lane['id'],name=lane['name'],width=lane['width'],kind='road',bridge=False,oneway=False,
            covered=False,level=0,material='asphalt',lanes=1,junctions=[0,len(points)-1],
            points=np.stack([points[:,0],heights,points[:,1]],axis=1).round(3).tolist(),**{'class':'service'}))
    fit_bridge_decks(ways)
    circuits = []
    for slug,name,waypoints,preferred in CIRCUITS:
        path = []
        for a,b in zip(waypoints,waypoints[1:]+waypoints[:1]):
            leg = route_nodes(graph, a, b, preferred)
            path.extend(leg[:-1])
        if len(path) != len(set(path)):
            raise ValueError(f"{name} retraces its route")
        path.append(path[0])
        chain = np.array([nodes[k] for k in path])
        if not all(EXTENT.covers(Point(p)) for p in chain):
            raise ValueError(f"{name} exits the map")
        tight,_ = resample(chain,.75)
        rounded = ndimage.gaussian_filter1d(tight[:-1],sigma=2.3,axis=0,mode="wrap")
        points, lengths = resample(np.vstack([rounded, rounded[0]]),1.6)
        circuits.append(dict(id=slug,name=name,points=np.round(points,2).tolist(),streets=sorted(preferred)))
        print(f"{name}: {lengths[-1]:.1f} m, {len(path)-1} distinct connected OSM nodes")

    footprints = []
    for _,outers,inners in collect_layers(geo.load_osm())[0]:
        for ring in outers:
            outline = Polygon(ring).buffer(0)
            for hole in inners:
                cavity = Polygon(hole).buffer(0)
                outline = outline.difference(cavity)
            for part in components(outline.intersection(box(0,0,geo.WIDTH,geo.DEPTH)), "Polygon"):
                if part.area > .5:
                    footprints.append(rings(part))
    water = []
    for e in elements:
        tags = e.get("tags",{})
        if tags.get("natural") != "water":
            continue
        if e["type"] == "way":
            outer, inner = [e["nodes"]], []
        elif e["type"] == "relation":
            outer,inner = [],[]
            for m in e["members"]:
                if m["type"]=="way" and m["ref"] in by_id:
                    (inner if m["role"]=="inner" else outer).append(by_id[m["ref"]]["nodes"])
        else:
            continue
        for group in outer:
            if len(group)<4 or group[0]!=group[-1] or any(key not in nodes for key in group):
                continue
            wet = Polygon([nodes[k] for k in group]).buffer(0)
            for g in inner:
                if len(g)>3 and g[0]==g[-1] and all(k in nodes for k in g):
                    wet = wet.difference(Polygon([nodes[k] for k in g]).buffer(0))
            for poly in components(wet.intersection(EXTENT),"Polygon"):
                water.append(rings(poly.simplify(.3, preserve_topology=True)))
    barriers = []
    for e in elements:
        t = e.get("tags",{}).get("barrier")
        if e["type"]=="way" and t in ("fence","wall","retaining_wall","guard_rail"):
            for line in components(LineString([nodes[k] for k in e["nodes"] if k in nodes]).intersection(EXTENT),"LineString"):
                barriers.append([t,np.round(np.asarray(line.coords),2).ravel().tolist()])
        elif e["type"]=="node" and t in ("bollard","block","cycle_barrier"):
            barriers.append([t,np.round(nodes[e["id"]],2).tolist()])
    return dict(bounds=BOUNDS, ways=ways, buildingBases=building_bases, areas=mapped_areas(elements,by_id,nodes), circuits=circuits, water=water, coreBuildings=footprints, barriers=barriers)


def check(data):
    campus=json.loads(region.OUT.read_bytes())
    verify_drives(data,campus["blocks"]+[h["block"] for h in campus.get("southernHousing",[]) if h["index"] is None])
    assert len(data["ways"]) >= 1900 and len(data["circuits"])==3 and len(data["water"]) >= 4 and len(data["coreBuildings"]) >= 35
    assert sum(a["kind"]=="parking" for a in data["areas"])>100
    assert any(a["name"]=="Concrete Beach (UCC)" for a in data["areas"])
    for w in data["ways"]:
        p=np.array(w["points"])
        assert len(p)>=2 and np.isfinite(p).all() and np.linalg.norm(np.diff(p[:,[0,2]],axis=0),axis=1).max() < 5.03
        assert all(0<=j<len(p) for j in w["junctions"])
    print(f"{len(data['ways'])} road and path sections, {sum(w['bridge'] for w in data['ways'])} decks, {len(data['areas'])} paved areas, {len(data['barriers'])} mapped barriers, {len(data['water'])} water polygons")


if __name__ == "__main__":
    if "--check" in sys.argv:
        check(json.loads(OUT.read_text()))
    else:
        network=make_network()
        check(network)
        OUT.write_text(json.dumps(network,separators=(",",":"),allow_nan=False))
