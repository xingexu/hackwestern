import json
import math
import sys
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
import shapely
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

import campus_region as region
import geo
from area import NORTH, VOXEL_METERS, WEST

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "buildings"
STREET = ROOT / "data" / "streetview"
AERIAL_SERVICE = region.CITY + "Aerial2025/MapServer/export"
CAMERA_FOV = 64.0
MAX_RANGE = 65.0
FRAMES_PER_WALL = 6
SHEET_FRAMES = 12
MIN_WALL = 2.5
BUILDING_CLASS, VEGETATION_CLASS = 2, 8


def local_to_lat_lon(x, z):
    lon = x * VOXEL_METERS / geo.METERS_PER_DEGREE_LON + WEST
    lat = NORTH - z * VOXEL_METERS / geo.METERS_PER_DEGREE_LAT
    return lat, lon


def local_to_mercator(x, z):
    lat, lon = local_to_lat_lon(x, z)
    radius = 6378137.0
    return radius * math.radians(lon), radius * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def campus_polygon():
    boundary = json.loads((ROOT / "web" / "campus-boundary.json").read_text())
    flat = boundary["polygons"][0][0]
    return Polygon(list(zip(flat[0::2], flat[1::2])))


def valid(polygon):
    return polygon if polygon.is_valid else polygon.buffer(0)


def city_footprints(campus):
    blocks = json.loads((ROOT / "web" / "campus-region.json").read_text())["blocks"]
    found = []
    for index, block in enumerate(blocks):
        ring = block[0]
        polygon = valid(Polygon(list(zip(ring[0::2], ring[1::2])), [list(zip(h[0::2], h[1::2])) for h in block[1] if len(h) >= 6]))
        if polygon.area <= 0 or polygon.intersection(campus).area / polygon.area <= 0.5:
            continue
        found.append(dict(id=f"c{index}", source="london-city-footprints", sourceIndex=index, name=block[5] or "", polygon=polygon))
    return found


def osm_rings(element, nodes, ways):
    if element["type"] == "way":
        ring = [nodes[n] for n in element["nodes"] if n in nodes]
        return [ring], []
    outers, inners = [], []
    for role in ("outer", "inner"):
        segments = [[nodes[n] for n in ways[m["ref"]]["nodes"] if n in nodes] for m in element.get("members", [])
                    if m["type"] == "way" and m.get("role", "outer") == role and m["ref"] in ways]
        rings = []
        while segments:
            ring = segments.pop(0)
            changed = True
            while changed and ring[0] != ring[-1]:
                changed = False
                for i, segment in enumerate(segments):
                    if segment[0] == ring[-1]:
                        ring += segment[1:]
                    elif segment[-1] == ring[-1]:
                        ring += segment[::-1][1:]
                    elif segment[-1] == ring[0]:
                        ring = segment + ring[1:]
                    elif segment[0] == ring[0]:
                        ring = segment[::-1] + ring[1:]
                    else:
                        continue
                    segments.pop(i)
                    changed = True
                    break
            rings.append(ring)
        (outers if role == "outer" else inners).extend(rings)
    return outers, inners


def osm_footprints(campus):
    elements = json.loads((ROOT / "data" / "region" / "map.json").read_text())["elements"]
    nodes = {n["id"]: geo.to_grid(n["lat"], n["lon"]) for n in elements if n["type"] == "node"}
    ways = {w["id"]: w for w in elements if w["type"] == "way"}
    found = []
    for element in elements:
        tags = element.get("tags", {})
        if element["type"] not in ("way", "relation") or not tags.get("building") or tags.get("building") in ("roof", "no"):
            continue
        outers, inners = osm_rings(element, nodes, ways)
        holes = [h for h in inners if len(h) >= 4]
        for ring_index, ring in enumerate(outers):
            if len(ring) < 4:
                continue
            polygon = valid(Polygon(ring, [h for h in holes if Polygon(ring).buffer(0).contains(Polygon(h).buffer(0).representative_point())]))
            if polygon.area <= 0 or polygon.intersection(campus).area / polygon.area <= 0.5:
                continue
            suffix = f"-{ring_index}" if len(outers) > 1 else ""
            found.append(dict(id=f"{element['type'][0]}{element['id']}{suffix}", source="openstreetmap", osm=f"{element['type']}/{element['id']}",
                              name=tags.get("name", ""),
                              tags={k: v for k, v in tags.items() if k.startswith(("building", "name", "roof", "height", "addr", "ref", "amenity", "operator", "start_date", "architect", "min_height", "level"))},
                              polygon=polygon))
    return found


def merge_sources(city, osm):
    covered = unary_union([b["polygon"] for b in osm])
    merged = list(osm)
    for building in city:
        uncovered = building["polygon"].difference(covered)
        if uncovered.area / building["polygon"].area > 0.5:
            merged.append(building)
    return merged


def height_sampler():
    dtm, dsm = region.lidar("dtm"), region.lidar("dsm")
    datum = float(np.min(geo.lidar_surfaces()[0])) - 4
    core = geo.lidar_surfaces()

    def sample(polygon):
        minx, minz, maxx, maxz = polygon.bounds
        xs, zs = np.meshgrid(np.arange(minx + 0.5, maxx, 1.0), np.arange(minz + 0.5, maxz, 1.0))
        inner = polygon.buffer(-1.2)
        target = inner if inner.area > 4 else polygon
        mask = shapely.contains_xy(target, xs.ravel(), zs.ravel())
        if not mask.any():
            c = polygon.representative_point()
            px, pz = np.array([c.x]), np.array([c.y])
        else:
            px, pz = xs.ravel()[mask], zs.ravel()[mask]
        ring = polygon.buffer(4).difference(polygon.buffer(1.5))
        gx, gz = np.meshgrid(np.arange(minx - 5, maxx + 5, 1.0), np.arange(minz - 5, maxz + 5, 1.0))
        gmask = shapely.contains_xy(ring, gx.ravel(), gz.ravel())
        inside_core = core is not None and np.all((px >= 0) & (px < geo.WIDTH - 1) & (pz >= 0) & (pz < geo.DEPTH - 1))
        if inside_core:
            terrain, surface = core
            roof = surface[pz.astype(int), px.astype(int)]
            ground_x, ground_z = gx.ravel()[gmask].astype(int).clip(0, geo.WIDTH - 1), gz.ravel()[gmask].astype(int).clip(0, geo.DEPTH - 1)
            ground = terrain[ground_z, ground_x] if gmask.any() else terrain[pz.astype(int), px.astype(int)]
        else:
            roof = region.sample(dsm, px, pz)
            ground = region.sample(dtm, gx.ravel()[gmask], gz.ravel()[gmask]) if gmask.any() else region.sample(dtm, px, pz)
        base = float(np.percentile(ground, 20))
        rel = roof - base
        return dict(ground=round(base - datum, 2), groundAbsolute=round(base, 2), lidar="core-1m" if inside_core else "regional-2m",
                    heightP50=round(float(np.percentile(rel, 50)), 2), heightP90=round(float(np.percentile(rel, 90)), 2),
                    heightMax=round(float(rel.max()), 2), roofSpread=round(float(np.percentile(rel, 90) - np.percentile(rel, 10)), 2))

    return sample


def walls_of(polygon):
    exterior = polygon.exterior.simplify(0.25)
    coords = list(exterior.coords)[:-1]
    if len(coords) < 3:
        return []
    edges = []
    for i in range(len(coords)):
        a, b = np.array(coords[i]), np.array(coords[(i + 1) % len(coords)])
        edges.append([a, b])
    merged = []
    for a, b in edges:
        if merged:
            pa, pb = merged[-1]
            d1 = (pb - pa) / max(np.linalg.norm(pb - pa), 1e-9)
            d2 = (b - a) / max(np.linalg.norm(b - a), 1e-9)
            if float(np.dot(d1, d2)) > math.cos(math.radians(10)):
                merged[-1] = [pa, b]
                continue
        merged.append([a, b])
    if len(merged) > 1:
        pa, pb = merged[-1]
        a, b = merged[0]
        d1 = (pb - pa) / max(np.linalg.norm(pb - pa), 1e-9)
        d2 = (b - a) / max(np.linalg.norm(b - a), 1e-9)
        if float(np.dot(d1, d2)) > math.cos(math.radians(10)):
            merged[0] = [pa, b]
            merged.pop()
    walls = []
    for a, b in merged:
        length = float(np.linalg.norm(b - a))
        if length < MIN_WALL:
            continue
        direction = (b - a) / length
        normal = np.array([direction[1], -direction[0]])
        mid = (a + b) / 2
        if polygon.contains(Point(*(mid + normal * 0.6))):
            normal = -normal
        bearing = (math.degrees(math.atan2(normal[0], -normal[1])) + 360) % 360
        walls.append(dict(a=[round(float(a[0]), 2), round(float(a[1]), 2)], b=[round(float(b[0]), 2), round(float(b[1]), 2)],
                          length=round(length, 2), normal=[round(float(normal[0]), 4), round(float(normal[1]), 4)],
                          faces=compass(bearing), bearing=round(bearing, 1)))
    for i, wall in enumerate(walls):
        wall["index"] = i
    return walls


def compass(bearing):
    names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
    return names[int(((bearing + 22.5) % 360) // 45)]


def load_frames():
    frames = [f for f in json.loads((STREET / "frames.json").read_text()) if f.get("heading") is not None]
    quality = {}
    folder = STREET / "quality-v1"
    for frame in frames:
        path = folder / f"{frame['id']}.txt"
        if path.exists():
            quality[frame["id"]] = path.read_text().strip()
    return frames, quality


@lru_cache(maxsize=4000)
def semantic_labels(frame_id):
    path = STREET / "semantics" / f"{frame_id}.png"
    return np.asarray(Image.open(path)) if path.exists() else None


def semantic_share(frame_id, offset_degrees):
    labels = semantic_labels(frame_id)
    if labels is None:
        return None, None
    height, width = labels.shape
    column = int(round(width / 2 + offset_degrees / CAMERA_FOV * width))
    half = max(6, width // 18)
    band = labels[: int(height * 0.72), max(0, column - half): min(width, column + half)]
    if band.size == 0:
        return None, None
    return float(np.mean(band == BUILDING_CLASS)), float(np.mean(band == VEGETATION_CLASS))


def rank_frames(walls, building_polygon, others_tree, others, frames, quality, positions, headings):
    for wall in walls:
        a, b, normal = np.array(wall["a"]), np.array(wall["b"]), np.array(wall["normal"])
        mid = (a + b) / 2
        delta = positions - mid
        distance = np.linalg.norm(delta, axis=1)
        front = delta @ normal
        candidates = np.where((distance < MAX_RANGE) & (distance > 4) & (front > 2.5))[0]
        scored = []
        for i in candidates:
            frame = frames[i]
            to_wall = mid - positions[i]
            bearing = math.degrees(math.atan2(to_wall[0], -to_wall[1]))
            offset = (bearing - headings[i] + 540) % 360 - 180
            if abs(offset) > CAMERA_FOV * 0.55:
                continue
            sight = LineString([tuple(positions[i]), tuple(mid + normal * 0.4)])
            blocked = any(others[j].intersects(sight) for j in others_tree.query(sight))
            if blocked:
                continue
            obliquity = float(np.dot(-to_wall / max(np.linalg.norm(to_wall), 1e-9), -normal))
            building_share, vegetation_share = semantic_share(frame["id"], offset)
            score = (1 - abs(offset) / (CAMERA_FOV * 0.55)) * 0.3 + max(0.0, obliquity) * 0.2 + (1 - min(distance[i], 65) / 65) * 0.35
            if building_share is not None:
                if building_share < 0.08:
                    continue
                score += building_share * 0.45 - vegetation_share * 0.3
            if quality.get(frame["id"], "clear") != "clear":
                score -= 0.4
            scored.append(dict(frame=frame["id"], path=f"data/streetview/{frame['path']}", distance=round(float(distance[i]), 1),
                               headingOffset=round(offset, 1), facingCosine=round(obliquity, 2), date=frame.get("date"),
                               buildingShare=None if building_share is None else round(building_share, 2),
                               vegetationShare=None if vegetation_share is None else round(vegetation_share, 2),
                               quality=quality.get(frame["id"], "unknown"), score=round(score, 3)))
        scored.sort(key=lambda s: -s["score"])
        wall["frames"] = scored[:FRAMES_PER_WALL]
        wall["frameCandidates"] = len(scored)


def sheet_selection(walls):
    queues = [list(w["frames"]) for w in sorted(walls, key=lambda w: -w["length"])]
    picked, used = [], set()
    while len(picked) < SHEET_FRAMES and any(queues):
        for queue, wall in zip(queues, sorted(walls, key=lambda w: -w["length"])):
            while queue and queue[0]["frame"] in used:
                queue.pop(0)
            if queue:
                item = queue.pop(0)
                used.add(item["frame"])
                picked.append((wall["index"], item))
                if len(picked) >= SHEET_FRAMES:
                    break
    return picked


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def contact_sheet(building, picked, folder):
    if not picked:
        return None
    thumb_w, thumb_h, columns = 560, 420, 3
    rows = math.ceil(len(picked) / columns)
    sheet = Image.new("RGB", (thumb_w * columns, (thumb_h + 30) * rows + 40), (20, 24, 24))
    draw = ImageDraw.Draw(sheet)
    draw.text((10, 8), f"{building['id']}  {building['name'] or '(unnamed)'}  street frames by wall", fill=(240, 240, 230), font=font(22))
    for n, (wall_index, item) in enumerate(picked):
        photo = Image.open(ROOT / item["path"]).convert("RGB")
        photo.thumbnail((thumb_w, thumb_h))
        x, y = (n % columns) * thumb_w, 40 + (n // columns) * (thumb_h + 30)
        sheet.paste(photo, (x + (thumb_w - photo.width) // 2, y + (thumb_h - photo.height) // 2))
        label = f"#{n + 1} wall {wall_index} | frame {item['frame']} | {item['distance']} m | off {item['headingOffset']}°"
        draw.text((x + 6, y + thumb_h + 4), label, fill=(230, 220, 160), font=font(16))
    path = folder / "street-sheet.jpg"
    sheet.save(path, quality=86)
    return str(path.relative_to(ROOT))


def aerial_view(building, picked, frames_by_id, folder):
    polygon = building["polygon"]
    minx, minz, maxx, maxz = polygon.bounds
    margin = 18
    minx, minz, maxx, maxz = minx - margin, minz - margin, maxx + margin, maxz + margin
    left, top = local_to_mercator(minx, minz)
    right, bottom = local_to_mercator(maxx, maxz)
    span = max(right - left, top - bottom)
    pixels_per_unit = min(1600 / span, 1 / 0.12 / (span / max(maxx - minx, maxz - minz)) if span else 1)
    width, height = max(64, int(round((right - left) * pixels_per_unit))), max(64, int(round((top - bottom) * pixels_per_unit)))
    meters_per_pixel = (maxx - minx) / width
    target = folder / "aerial-source.jpg"
    if not target.exists():
        params = dict(bbox=f"{left},{bottom},{right},{top}", bboxSR=3857, imageSR=3857, size=f"{width},{height}", format="jpg", f="image")
        response = requests.get(AERIAL_SERVICE, params=params, headers={"User-Agent": "WesternCampusModel/1.0"}, timeout=120)
        response.raise_for_status()
        target.write_bytes(response.content)
    image = Image.open(target).convert("RGB").resize((width, height))
    draw = ImageDraw.Draw(image)

    def px(x, z):
        mx, my = local_to_mercator(x, z)
        return ((mx - left) * pixels_per_unit, (top - my) * pixels_per_unit)

    for ring in [polygon.exterior, *polygon.interiors]:
        draw.line([px(*c) for c in ring.coords], fill=(255, 40, 40), width=3)
    for wall in building["walls"]:
        a, b, normal = np.array(wall["a"]), np.array(wall["b"]), np.array(wall["normal"])
        mid = (a + b) / 2 + normal * 3.5
        x, y = px(*mid)
        draw.rectangle([x - 13, y - 11, x + 13, y + 11], fill=(255, 255, 255))
        draw.text((x - 9, y - 9), str(wall["index"]), fill=(200, 0, 0), font=font(17))
    for n, (wall_index, item) in enumerate(picked):
        frame = frames_by_id[item["frame"]]
        x, y = px(frame["x"], frame["z"])
        heading = math.radians(frame["heading"])
        tip = (x + math.sin(heading) * 26, y - math.cos(heading) * 26)
        draw.line([(x, y), tip], fill=(40, 200, 255), width=3)
        draw.ellipse([x - 5, y - 5, x + 5, y + 5], fill=(40, 200, 255))
        draw.text((x + 6, y + 4), f"#{n + 1}", fill=(20, 230, 255), font=font(15))
    scale_px = 10 / meters_per_pixel
    draw.rectangle([12, height - 30, 12 + scale_px, height - 22], fill=(255, 255, 255))
    draw.text((16 + scale_px, height - 36), "10 m  (north up)", fill=(255, 255, 255), font=font(15))
    path = folder / "aerial.jpg"
    image.save(path, quality=88)
    return str(path.relative_to(ROOT)), round(meters_per_pixel, 3)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    campus = campus_polygon()
    survey = json.loads((ROOT / "build/specs/survey-footprints.json").read_text())
    additions = [{**{k:v for k,v in r.items() if k!="footprint"}, "source":r.get("source","london-2025-orthophoto"), "polygon":Polygon(r["footprint"])} for r in survey]
    only_survey = "--survey-only" in sys.argv
    previous = []
    if only_survey:
        selected = {r["id"] for r in additions}
        previous = [r for r in json.loads((OUT/"inventory.json").read_text())["buildingsList"] if r["id"] not in selected]
        buildings = additions
    else:
        original = merge_sources(city_footprints(campus), osm_footprints(campus))
        survey_ids = {r["id"] for r in additions}
        buildings = [b for b in original if b["polygon"].area >= 12 and b["id"] not in survey_ids] + additions
    union = unary_union([b["polygon"] for b in buildings])
    sample_heights = height_sampler()
    frames, quality = load_frames()
    positions = np.array([[f["x"], f["z"]] for f in frames])
    headings = np.array([f["heading"] for f in frames])
    frames_by_id = {f["id"]: f for f in frames}
    polygons = [b["polygon"].buffer(-0.3) for b in buildings]
    polygons.extend(Polygon(r["footprint"],r["holes"]).buffer(-.3) for r in previous)
    tree = STRtree(polygons)
    for n, building in enumerate(buildings):
        polygon = building["polygon"]
        building.update(sample_heights(polygon))
        building["walls"] = walls_of(polygon)
        others = [p if i != n else Polygon() for i, p in enumerate(polygons)]
        rank_frames(building["walls"], polygon, tree, others, frames, quality, positions, headings)
        c = polygon.centroid
        building["centroid"] = [round(c.x, 2), round(c.y, 2)]
        building["area"] = round(polygon.area, 1)
        building["footprint"] = [[round(x, 2), round(z, 2)] for x, z in list(polygon.exterior.coords)[:-1]]
        building["holes"] = [[[round(x, 2), round(z, 2)] for x, z in list(r.coords)[:-1]] for r in polygon.interiors]
        sys.stdout.write(f"\r{n + 1}/{len(buildings)} {building['id']} {building['name'][:40]:40}")
        sys.stdout.flush()
    print()

    def evidence(building):
        folder = OUT / "evidence" / building["id"]
        folder.mkdir(parents=True, exist_ok=True)
        picked = sheet_selection(building["walls"])
        building["streetSheet"] = contact_sheet(building, picked, folder)
        building["sheetFrames"] = [dict(n=i + 1, wall=w, frame=item["frame"], path=item["path"]) for i, (w, item) in enumerate(picked)]
        try:
            building["aerial"], building["aerialMetersPerPixel"] = aerial_view(building, picked, frames_by_id, folder)
        except Exception as error:
            building["aerial"] = None
            building["aerialError"] = str(error)[:200]
        return building

    with ThreadPoolExecutor(6) as pool:
        list(pool.map(evidence, buildings))
    records = list(previous)
    for building in sorted(buildings, key=lambda b: -b["area"]):
        record = {k: v for k, v in building.items() if k != "polygon"}
        record["framesUsable"] = sum(len(w["frames"]) for w in building["walls"])
        records.append(record)
    summary = dict(campusArea=round(campus.area), buildings=len(records), withStreetFrames=sum(1 for r in records if r["framesUsable"]),
                   coordinateSystem="local metres: x east, z south, y up; same frame as web/campus-region.json and data/streetview/frames.json",
                   cameraFovAssumed=CAMERA_FOV, buildingsList=records)
    (OUT / "inventory.json").write_text(json.dumps(summary, indent=1))
    print(f"{len(records)} campus buildings, {summary['withStreetFrames']} with usable street frames -> {OUT / 'inventory.json'}")


if __name__ == "__main__":
    main()
