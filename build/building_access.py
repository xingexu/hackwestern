import numpy as np
from shapely import set_precision
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree


FRONT_DRIVES = {
    1119589806: [(-135.0, 1412.8), (-151.9, 1420.7), (-155.1, 1421.0)],
    637644027: [(1472.5, 1724.7), (1483.2, 1721.2), (1491.5, 1721.4), (1504.4, 1720.1)],
}
ROOFED_DRIVES = {144650295: 3.3, 153275339: 3.05, 562334870: 3.45, 562334877: 4.35, 1554621133: 4.25, 778714473: 3.6}


def polygon(rings):
    return Polygon(np.reshape(rings[0], (-1, 2)), [np.reshape(h, (-1, 2)) for h in rings[1:]]).buffer(0)


def rings(poly):
    return [np.round(np.asarray(r.coords)[:-1], 3).ravel().tolist() for r in (poly.exterior, *poly.interiors)]


def pieces(geometry, kind):
    if kind == "Polygon":
        geometry = set_precision(geometry, .01)
    return [part for part in getattr(geometry, "geoms", (geometry,)) if part.geom_type == kind and not part.is_empty]


def resolve_drives(ways, blocks, tiers, elevation):
    footprints = [polygon([ring, *holes]) for ring, holes, *_ in blocks]
    index = STRtree(footprints)
    openings = {}
    revised = []
    for way in ways:
        wid = way["id"]
        if wid == 733439739:
            continue
        original = np.asarray(way["points"])[:, [0, 2]]
        junctions = original[way["junctions"]]
        line = LineString(original)

        hits = [int(i) for i in index.query(line, predicate="intersects") if line.intersection(footprints[i]).length > .02]
        ends = [Point(original[0]), Point(original[-1])]
        touches_front_door = way["kind"] == "road" and not way["bridge"] and any(
            line.intersection(footprints[i]).length < 1 and any(footprints[i].covers(p) for p in ends) for i in hits)
        if wid not in FRONT_DRIVES and wid not in ROOFED_DRIVES and wid != 636125364 and not touches_front_door:
            revised.append(way)
            continue

        def section(path, covered=False):
            coords = np.array(path.segmentize(4.95).coords)
            indices = []
            for point in junctions:
                d = np.linalg.norm(coords - point, axis=1)
                if d.min() < .04:
                    indices.append(int(d.argmin()))
            heights = elevation(coords) + .08
            revised.append(dict(way, junctions=sorted(set(indices)), covered=covered,
                                points=np.round(np.c_[coords[:, 0], heights, coords[:, 1]], 2).tolist()))

        if wid in FRONT_DRIVES:
            section(LineString([original[0], *FRONT_DRIVES[wid], original[-1]]))
            continue
        if wid == 636125364 or touches_front_door and wid not in ROOFED_DRIVES:
            for part in pieces(line.difference(unary_union([footprints[i] for i in hits]).buffer(.12)), "LineString"):
                section(part)
            continue
        portals = [0, line.length]
        spans = []
        for i in hits:
            footprint = footprints[i]
            for part in pieces(line.intersection(footprint), "LineString"):
                start, end = sorted(line.project(Point(p)) for p in (part.coords[0], part.coords[-1]))
                portals.extend([start, end])
                spans.append((start, end))
                width = way["width"] * .5 + .65
                sweep = substring(line, max(0, start-width), min(line.length, end+width)).buffer(width, quad_segs=4)
                ceiling = round(float(elevation(np.array(part.coords)).max()) + ROOFED_DRIVES[wid], 2)
                openings.setdefault(i, []).append((sweep, ceiling))
        for a, b in zip(sorted(set(portals)), sorted(set(portals))[1:]):
            if b-a > .025:
                section(substring(line, a, b), any(x <= (a+b)/2 <= y for x,y in spans))
    ways[:] = revised
    bases = {}
    for i, gates in openings.items():
        base = blocks[i][2]
        footprint = footprints[i]
        floor = footprint.difference(unary_union([cut for cut, _ in gates]))
        patches = {}
        for k, (height, outline) in enumerate(tiers[str(i)]):
            band = polygon(outline)
            cuts = [(cut.intersection(band), ceiling) for cut,ceiling in gates if band.intersects(cut)]
            cuts = [(cut,ceiling) for cut,ceiling in cuts if cut.area > .001]
            if not cuts:
                continue
            remaining = band.difference(unary_union([sweep for sweep,_ in gates]))
            patch = [[height,rings(p)] for p in pieces(remaining, "Polygon") if p.area > .001]
            for cut, ceiling in cuts:
                patch.extend([round(max(height, ceiling-base+.23), 3),rings(p),round(ceiling-base, 3)]
                             for p in pieces(cut, "Polygon") if p.area > .001)
            patches[k] = patch
        bases[i] = dict(floors=[rings(p) for p in pieces(floor, "Polygon")],
                        passages=[[h, rings(p)] for cut,h in gates for p in pieces(footprint.intersection(cut), "Polygon")], tiers=patches)
    return bases


def verify_drives(network, blocks):
    floor = []
    for i, (ring, holes, *_) in enumerate(blocks):
        entry = network["buildingBases"].get(str(i), network["buildingBases"].get(i))
        floor.extend(polygon(shape) for shape in (entry["floors"] if entry else [[ring, *holes]]))
    floor.extend(polygon(shape) for shape in network["coreBuildings"])
    index = STRtree(floor)
    overlaps = []
    covered = set()
    for way in network["ways"]:
        if way["kind"] != "road" or way["bridge"]:
            continue
        line = LineString(np.asarray(way["points"])[:, [0,2]])
        overlap = sum(line.intersection(floor[i]).length for i in index.query(line, predicate="intersects"))
        if overlap > .15:
            overlaps.append((way["id"],round(overlap, 2)))
        if way["covered"]:
            covered.add(way["id"])
    assert not overlaps, overlaps
    assert set(ROOFED_DRIVES) <= covered
    assert all(w["id"] != 733439739 for w in network["ways"])
    print(f"{len(floor)} solid ground-floor footprints audited against all drivable centerlines; {len(ROOFED_DRIVES)} surveyed roofed driveways")
