import base64
import json
import zlib
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

import geo
from ground_detail import write_ground
from buildings import BRICK, CONCRETE, FLAT, GLASS, HIP, STONE, campus_tags, style_for
from landmarks import LANDMARKS, build_architecture
from stonework import LANDMARK_COLOURS
from voxels import AIR, Volume, color_key, key_to_rgb

WEB = Path(__file__).resolve().parent.parent / "web"
HEIGHT = 96
GROUND_FLOOR = 3
PALETTE_SIZE = 160
ROAD_WIDTHS = {
    "primary": 14, "secondary": 12, "tertiary": 9, "unclassified": 7, "residential": 7,
    "service": 5, "living_street": 6, "pedestrian": 5, "footway": 3, "path": 2,
    "cycleway": 3, "steps": 3, "track": 3,
}
FOOT_WAYS = {"footway", "path", "cycleway", "steps", "pedestrian", "track"}
GRASS_TAGS = {("landuse", "grass"), ("leisure", "park"), ("leisure", "garden"), ("leisure", "pitch"), ("landuse", "recreation_ground"), ("surface", "grass")}
WOOD_TAGS = {("natural", "wood"), ("landuse", "forest")}
WALL_COLORS = {
    STONE: (186, 168, 136),
    CONCRETE: (168, 164, 154),
    BRICK: (156, 104, 78),
    GLASS: (196, 196, 190),
}
WINDOW_COLORS = {
    STONE: (40, 48, 58),
    CONCRETE: (52, 60, 70),
    BRICK: (44, 52, 62),
    GLASS: (78, 104, 122),
}
ASPHALT = (92, 94, 96)
PAVEMENT = (178, 174, 164)
SOIL = (104, 84, 62)
TRUNK = (84, 64, 48)


def tagged(tags, pairs):
    return any(tags.get(key) == value for key, value in pairs)


def luminance(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def collect_layers(elements):
    buildings = []
    roads, paths = [], []
    asphalt_areas, paved_areas, grass_areas, wood_areas, water_areas = [], [], [], [], []
    tree_points = []
    for element in elements:
        tags = campus_tags(element)
        if element["type"] == "node":
            if tags.get("natural") == "tree":
                tree_points.append(geo.to_grid(element["lat"], element["lon"]))
            continue
        if "building" in tags and "geometry" in element or ("building" in tags and element["type"] == "relation"):
            outers, inners = geo.way_rings(element)
            if outers:
                buildings.append((tags, outers, inners))
            continue
        highway = tags.get("highway")
        if highway in ROAD_WIDTHS and element["type"] == "way":
            line = [geo.to_grid(p["lat"], p["lon"]) for p in element["geometry"]]
            if tags.get("area") == "yes":
                (paved_areas if highway in FOOT_WAYS else asphalt_areas).append((([line]), []))
            elif highway in FOOT_WAYS:
                paths.append((line, ROAD_WIDTHS[highway]))
            else:
                roads.append((line, ROAD_WIDTHS[highway]))
            continue
        rings = geo.way_rings(element)
        if not rings[0]:
            continue
        if tags.get("amenity") == "parking" or tags.get("area:highway"):
            asphalt_areas.append(rings)
        elif tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
            water_areas.append(rings)
        elif tagged(tags, WOOD_TAGS):
            wood_areas.append(rings)
        elif tagged(tags, GRASS_TAGS):
            grass_areas.append(rings)
        elif tags.get("place") == "square" or tags.get("highway") == "pedestrian":
            paved_areas.append(rings)
    return buildings, roads, paths, asphalt_areas, paved_areas, grass_areas, wood_areas, water_areas, tree_points


def line_mask(lines):
    mask = np.zeros((geo.DEPTH, geo.WIDTH), dtype=bool)
    for line, width in lines:
        mask |= geo.rasterize_lines([line], width)
    return mask


def ground_heights(elevation, smoothing):
    smooth = ndimage.gaussian_filter(elevation, smoothing)
    return np.round(smooth - smooth.min()).astype(np.int32) + GROUND_FLOOR


def vegetation_masks(imagery, building_mask, hard_surface):
    red, green, blue = imagery[..., 0], imagery[..., 1], imagery[..., 2]
    excess_green = (2 * green - red - blue) / np.maximum(red + green + blue, 1)
    light = luminance(imagery)
    texture = ndimage.generic_filter(light, np.std, size=5)
    warm_foliage = (red > green * 1.05) & (red > blue * 1.35) & (texture > 14)
    vegetated = ((excess_green > 0.06) | warm_foliage) & ~building_mask
    canopy = vegetated & ((texture > 15) | ((light < 60) & (texture > 8))) & ~hard_surface
    canopy = ndimage.binary_opening(canopy, iterations=2)
    canopy = ndimage.binary_closing(canopy, iterations=2) & ~building_mask
    return vegetated, canopy


def class_color(imagery, mask, fallback):
    light = luminance(imagery)
    pick = mask & (light > np.percentile(light[mask], 40)) if mask.sum() > 50 else mask
    if pick.sum() < 20:
        return np.asarray(fallback, dtype=np.float32)
    return np.median(imagery[pick], axis=0)


def ground_colors(imagery, classes, random):
    light = luminance(imagery)
    detail = light - ndimage.gaussian_filter(light, 6)
    detail = np.clip(detail / 40.0, -0.35, 0.35)
    colors = np.zeros_like(imagery)
    for mask, base in classes:
        colors[mask] = base
    grain = random.uniform(-0.05, 0.05, size=light.shape)
    return colors * (1 + detail + grain)[..., None]


def building_rasters(buildings):
    rasters = []
    for tags, outers, inners in buildings:
        mask = geo.rasterize([(outers, inners)]).astype(bool)
        if mask.sum() < 4:
            continue
        rasters.append((tags, mask))
    rasters.sort(key=lambda item: -item[1].sum())
    return rasters


def build_building(volume, tags, mask, ground, imagery, wall_noise):
    style = style_for(tags)
    zs, xs = np.nonzero(mask)
    z0, z1, x0, x1 = zs.min(), zs.max() + 1, xs.min(), xs.max() + 1
    local = mask[z0:z1, x0:x1]
    base = int(np.median(ground[z0:z1, x0:x1][local]))
    ground[z0:z1, x0:x1][local] = base
    eave = base + max(3, int(round(style.height)))
    name = tags.get("name")
    if build_architecture(volume, name, style, base, local, (x0, z0), imagery[z0:z1, x0:x1]):
        return name, base, eave, local, (x0, z0)
    inside_distance = ndimage.distance_transform_edt(np.pad(local, 1))[1:-1, 1:-1]
    edge = local & (inside_distance <= 1.0)
    if style.roof == HIP:
        roof_rise = np.floor((inside_distance - 0.5) * style.pitch).astype(np.int32)
        top = eave + np.maximum(roof_rise, 0)
    else:
        top = np.full(local.shape, eave, dtype=np.int32) + edge.astype(np.int32)
    top = np.minimum(top, volume.height - 1)
    roof_pixels = imagery[z0:z1, x0:x1][local]
    light = luminance(roof_pixels)
    roof_base = np.median(roof_pixels[light >= np.percentile(light, 35)], axis=0)
    roof_tone = imagery[z0:z1, x0:x1] * 0.35 + roof_base * 0.65
    wall = np.asarray(WALL_COLORS[style.wall], dtype=np.float32)
    window = np.asarray(WINDOW_COLORS[style.wall], dtype=np.float32)
    ys = np.arange(volume.height)[:, None, None]
    filled = (ys > base - 3) & (ys <= top[None]) & local[None]
    storey = (ys - base) % 4
    along = (np.arange(x0, x1)[None, None, :] + np.arange(z0, z1)[None, :, None])
    if style.wall == GLASS:
        is_window = (storey != 0) & (along % 4 != 0)
    elif style.wall == CONCRETE:
        is_window = np.isin(storey, (2, 3)) & np.isin(along % 4, (1, 2))
    elif style.wall == BRICK:
        is_window = np.isin(storey, (2, 3)) & (along % 3 == 1)
    else:
        is_window = np.isin(storey, (2, 3)) & (along % 3 == 1)
    is_window = is_window & (ys > base + 1) & (ys < eave - 1) & edge[None]
    is_roof = ys > eave
    if style.roof == FLAT:
        is_roof = (ys == top[None]) & ~edge[None]
    wall_shade = wall[None, None, None, :] * wall_noise[z0:z1, x0:x1][None, :, :, None]
    plinth = (ys <= base + 1)[..., None]
    colors = np.where(plinth, wall_shade * 0.82, wall_shade)
    colors = np.where(is_window[..., None], window, colors)
    colors = np.where(is_roof[..., None], roof_tone[None], colors)
    keys = color_key(colors)
    region = volume.keys[:, z0:z1, x0:x1]
    region[filled] = keys[filled]
    return tags.get("name"), base, eave, local, (x0, z0)


def plant_trees(volume, canopy, ground, imagery, extra_points, random, canopy_height):
    drive_cells = np.zeros(volume.keys.shape, dtype=bool)
    roadside_trees = []
    distance = ndimage.distance_transform_edt(canopy)
    candidates = np.argwhere(canopy)
    random.shuffle(candidates)
    occupied = np.zeros_like(canopy)
    centers = [(int(round(z)), int(round(x)), 3.5) for x, z in extra_points if 0 <= int(x) < geo.WIDTH and 0 <= int(z) < geo.DEPTH]
    for z, x in candidates:
        if occupied[z, x]:
            continue
        measured = canopy_height[max(0, z - 1):z + 2, max(0, x - 1):x + 2].max() if canopy_height is not None else 0
        spread = distance[z, x] * 0.9 + random.uniform(1.5, 3.0)
        radius = float(np.clip(max(spread, measured * 0.32), 2.5, 7.5))
        spacing = int(radius * 1.25)
        occupied[max(0, z - spacing):z + spacing + 1, max(0, x - spacing):x + spacing + 1] = True
        centers.append((z, x, radius))
    for z, x, radius in centers:
        sample = imagery[max(0, z - 2):z + 3, max(0, x - 2):x + 3].reshape(-1, 3)
        leaf = np.median(sample, axis=0)
        if luminance(leaf) < 55:
            leaf = leaf * (55 / max(luminance(leaf), 1))
        base = int(ground[z, x])
        measured = canopy_height[max(0, z - 1):z + 2, max(0, x - 1):x + 2].max() if canopy_height is not None else 0
        if measured > radius * 1.6 + 2:
            center_y = base + measured - radius * 0.8
        else:
            center_y = base + int(radius * 0.9 + random.uniform(2, 4)) + radius * 0.7
        trunk = slice(base + 1, int(center_y))
        drive_cells[trunk, z, x] |= volume.keys[trunk, z, x] == AIR
        roadside_trees.append([x + 0.5, base + 1, z + 0.5, round(float(radius), 2), round(float(center_y), 2), *leaf.clip(0, 255).astype(int).tolist()])
        for y in range(base + 1, int(center_y)):
            volume.put(int(x), y, int(z), TRUNK, 6)
        r = int(np.ceil(radius)) + 1
        dz, dy, dx = np.mgrid[-r:r + 1, -r:r + 1, -r:r + 1]
        shape_noise = random.uniform(-0.9, 0.9, size=dz.shape)
        inside = (dx ** 2 + dz ** 2) / radius ** 2 + (dy ** 2) / (radius * 0.82) ** 2 <= 1 + shape_noise * 0.25
        shade = 0.72 + 0.34 * (dy + r) / (2 * r)
        variation = random.uniform(0.88, 1.12, size=dz.shape)
        colors = leaf[None, None, None, :] * (shade * variation)[..., None]
        ys = (dy + int(center_y)).ravel()
        zs = (dz + z).ravel()
        xs = (dx + x).ravel()
        flat_inside = inside.ravel()
        valid = flat_inside & (ys >= 0) & (ys < volume.height) & (zs >= 0) & (zs < volume.depth) & (xs >= 0) & (xs < volume.width)
        keys = color_key(colors.reshape(-1, 3))
        target = volume.keys[ys[valid], zs[valid], xs[valid]]
        free = target == AIR
        volume.keys[ys[valid][free], zs[valid][free], xs[valid][free]] = keys[valid][free]
        drive_cells[ys[valid][free], zs[valid][free], xs[valid][free]] = True
    packed = np.packbits(drive_cells, bitorder="little")
    if canopy_height is not None:
        from woodlot_survey import core_crowns
        roadside_trees=core_crowns(roadside_trees,canopy_height,ground,imagery,len(extra_points))
    trees = {"trees": roadside_trees, "cells": base64.b64encode(zlib.compress(packed.tobytes(), 9)).decode("ascii")}
    (WEB / "drive-trees.json").write_text(json.dumps(trees, separators=(",", ":")))
    return len(centers)


def quantize(keys):
    used = np.unique(keys[keys != AIR])
    counts = np.bincount(keys.ravel(), minlength=int(used.max()) + 1)[used]
    rgb = key_to_rgb(used).astype(np.uint8)
    weights = np.maximum(1, np.sqrt(counts / counts.max()) * 400).astype(int)
    sample = np.repeat(rgb, weights, axis=0)
    side = int(np.ceil(np.sqrt(len(sample))))
    canvas = np.zeros((side * side, 3), dtype=np.uint8)
    canvas[: len(sample)] = sample
    canvas[len(sample):] = sample[0]
    image = Image.fromarray(canvas.reshape(side, side, 3))
    sampled_colours = PALETTE_SIZE - len(LANDMARK_COLOURS)
    quantized = image.quantize(colors=sampled_colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    palette = np.asarray(quantized.getpalette()[: sampled_colours * 3], dtype=np.int32).reshape(-1, 3)
    palette = np.vstack([palette, key_to_rgb(color_key(LANDMARK_COLOURS))])
    distances = ((rgb[:, None, :].astype(np.int32) - palette[None]) ** 2).sum(-1)
    nearest = distances.argmin(1) + 1
    lookup = np.zeros(int(used.max()) + 1, dtype=np.uint8)
    lookup[used] = nearest
    return lookup[keys], [[0, 0, 0]] + palette.tolist()


def main():
    random = np.random.default_rng(11)
    elements = geo.load_osm()
    imagery = geo.imagery()
    lidar = geo.lidar_surfaces()
    if lidar is None:
        ground = ground_heights(geo.elevation(), 4)
        canopy_height = None
    else:
        terrain_model, surface_model = lidar
        ground = ground_heights(terrain_model, 1.2)
        canopy_height = np.clip(surface_model - terrain_model, 0, 40)
    buildings, roads, paths, asphalt_areas, paved_areas, grass_areas, wood_areas, water_areas, tree_points = collect_layers(elements)
    rasters = building_rasters(buildings)
    building_mask = np.zeros((geo.DEPTH, geo.WIDTH), dtype=bool)
    for _, mask in rasters:
        building_mask |= mask
    road_mask = line_mask(roads) | (geo.rasterize(asphalt_areas).astype(bool) if asphalt_areas else False)
    path_mask = line_mask(paths) | (geo.rasterize(paved_areas).astype(bool) if paved_areas else False)
    path_mask &= ~road_mask
    water_mask = geo.rasterize(water_areas).astype(bool) if water_areas else np.zeros_like(building_mask)
    hard_surface = road_mask | path_mask | water_mask
    vegetated, canopy = vegetation_masks(imagery, building_mask, hard_surface)
    if canopy_height is not None:
        canopy = (canopy & (canopy_height > 2.5)) | (vegetated & (canopy_height > 4.5) & ~building_mask)
    if wood_areas:
        canopy |= geo.rasterize(wood_areas).astype(bool) & ~building_mask & ~hard_surface
    hill = [geo.way_rings(e) for e in elements if e.get("tags", {}).get("name") == "UC Hill"]
    if hill:
        canopy &= ~geo.rasterize(hill).astype(bool)
    grass_mask = ~building_mask & ~hard_surface
    grass_tone = class_color(imagery, vegetated & ~canopy, (112, 140, 76))
    grass_tone = np.clip(grass_tone * np.array([1.0, 1.12, 0.85]) * 1.1, 0, 255)
    classes = [
        (grass_mask, grass_tone),
        (road_mask, class_color(imagery, road_mask & ~canopy, ASPHALT)),
        (path_mask, class_color(imagery, path_mask & ~canopy, PAVEMENT)),
        (water_mask, np.array([70, 104, 120], dtype=np.float32)),
        (building_mask, np.array(PAVEMENT, dtype=np.float32)),
    ]
    surface = ground_colors(imagery, classes, random)
    volume = Volume(geo.WIDTH, HEIGHT, geo.DEPTH)
    wall_noise = random.uniform(0.92, 1.06, size=(geo.DEPTH, geo.WIDTH)).astype(np.float32)
    built = []
    for tags, mask in rasters:
        built.append(build_building(volume, tags, mask, ground, imagery, wall_noise))
    ys = np.arange(HEIGHT)[:, None, None]
    soil = (ys < ground[None]) & (volume.keys == AIR)
    volume.keys[soil] = color_key(np.asarray(SOIL))
    top_layer = (ys == ground[None]) & (volume.keys == AIR)
    surface_keys = np.broadcast_to(color_key(surface)[None], volume.keys.shape)
    volume.keys[top_layer] = surface_keys[top_layer]
    labels = []
    for name, base, eave, local, (x0, z0) in built:
        if name in LANDMARKS:
            LANDMARKS[name](volume, base)
        if name:
            zs, xs = np.nonzero(local)
            labels.append({"name": name, "x": float(xs.mean() + x0), "y": float(eave + 2), "z": float(zs.mean() + z0)})
    terrain = ndimage.gaussian_filter(lidar[0] if lidar is not None else geo.elevation(), 1.2 if lidar is not None else 4)
    write_ground(WEB / "campus-ground.json", terrain, GROUND_FLOOR, ground, building_mask, imagery, roads, paths,
                 asphalt_areas, paved_areas, water_areas, grass_tone)
    tree_count = plant_trees(volume, canopy, ground, imagery, tree_points, random, canopy_height)
    indices, palette = quantize(volume.keys)
    WEB.mkdir(exist_ok=True)
    compressed = zlib.compress(np.ascontiguousarray(indices).tobytes(), 9)
    (WEB / "world.bin").write_bytes(compressed)
    (WEB / "world.b64.txt").write_text(base64.b64encode(compressed).decode("ascii"))
    meta = {"driveCourse": "uc-hill", "width": geo.WIDTH, "height": HEIGHT, "depth": geo.DEPTH, "voxelMeters": 1, "palette": palette, "labels": labels}
    (WEB / "world.json").write_text(json.dumps(meta))
    solid = int((indices != 0).sum())
    print(f"grid {geo.WIDTH}x{HEIGHT}x{geo.DEPTH} solid voxels {solid} buildings {len(built)} trees {tree_count} palette {len(palette) - 1} bin {(WEB / 'world.bin').stat().st_size} bytes")
    preview(indices, palette)


def preview(indices, palette):
    colors = np.asarray(palette, dtype=np.uint8)
    solid = indices != 0
    height_index = indices.shape[0] - 1 - np.argmax(solid[::-1], axis=0)
    top = np.take_along_axis(indices, height_index[None], axis=0)[0]
    shade = 0.6 + 0.4 * (height_index / height_index.max())
    image = colors[top] * shade[..., None]
    Image.fromarray(image.clip(0, 255).astype(np.uint8)).resize((geo.WIDTH * 2, geo.DEPTH * 2), Image.NEAREST).save(geo.debug_dir() / "topdown.png")


if __name__ == "__main__":
    main()
