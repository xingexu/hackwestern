import argparse
import json
import re
import zlib

import numpy as np
from PIL import Image, ImageDraw

import geo
from buildings import campus_tags
from landmarks import FABRIC, LANDMARKS
from voxelize import HEIGHT, WEB, build_building, ground_heights
from voxels import Volume

CAMERAS = {
    "University College": (102, 150, 275),
    "Middlesex College": (239, 172, 315),
    "Physics Building": (165, 211, 35),
    "McIntosh Art Gallery": (174, 220, 32),
    "Weldon Library": (130, 231, 322),
}


def exposed_faces(cells, axis, sign):
    padded = np.pad(cells, 1)
    neighbor = [slice(1, -1)] * 3
    neighbor[axis] = slice(2, None) if sign > 0 else slice(None, -2)
    return np.nonzero((cells != 0) & (padded[tuple(neighbor)] == 0))


def shade_from_sky(cells):
    occupied = cells != 0
    high = np.where(occupied.any(axis=0), len(cells) - 1 - np.argmax(occupied[::-1], axis=0), -1)
    horizon = high.copy()
    for step in range(2, 51, 2):
        dx, dz = round(step * 0.76), round(step * 0.55)
        if dz >= high.shape[0] or dx >= high.shape[1]:
            break
        horizon[:-dz, :-dx] = np.maximum(horizon[:-dz, :-dx], high[dz:, dx:] - step)
    return horizon


def render(cells, palette, heading, scale, sky):
    angle, elevation = np.deg2rad([heading, 23])
    cx, cz = np.sin(angle), -np.cos(angle)
    horizontal = np.array([cz, -cx, 0])
    vertical = np.array([cx * np.sin(elevation), cz * np.sin(elevation), -np.cos(elevation)])
    towards = np.array([cx * np.cos(elevation), cz * np.cos(elevation), np.sin(elevation)])
    project = np.stack([horizontal, vertical], axis=1) * scale
    polygons, depths, colours = [], [], []
    for axis, sign, tone in [(0, 1, 1.08), (1, 1 if cz >= 0 else -1, 0.97 if cz >= 0 else 0.76), (2, 1 if cx >= 0 else -1, 1.01 if cx >= 0 else 0.80)]:
        y, z, x = exposed_faces(cells, axis, sign)
        centers = np.stack([x, z, y], axis=1).astype(float)
        direction = (2, 1, 0)[axis]
        centers[:, direction] += sign * 0.5
        basis = np.delete(np.eye(3), direction, axis=0)
        a, b = basis * 0.5
        corners = np.array([-a-b, a-b, a+b, -a+b]) @ project
        polygons.append((centers @ project)[:, None, :] + corners)
        depths.append(centers @ towards)
        outside_z = np.clip(z + (sign if axis == 1 else 0), 0, cells.shape[1] - 1)
        outside_x = np.clip(x + (sign if axis == 2 else 0), 0, cells.shape[2] - 1)
        occluded = sky[outside_z, outside_x] > y + 1
        colours.append(np.clip(palette[cells[y, z, x]] * np.where(occluded, tone * 0.82, tone)[:, None], 0, 255))
    polygons = np.concatenate(polygons)
    minimum = polygons.min(axis=(0, 1))
    polygons = np.rint(polygons - minimum + 8).astype(int)
    width, height = polygons.max(axis=(0, 1)) + 10
    image = Image.new("RGB", (width, height), (234, 233, 225))
    draw = ImageDraw.Draw(image)
    colours = np.concatenate(colours).astype(np.uint8).tolist()
    outlines = polygons.reshape(len(polygons), 8).tolist()
    for face in np.argsort(np.concatenate(depths)):
        draw.polygon(outlines[face], fill=tuple(colours[face]))
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="*")
    parser.add_argument("--scale", type=int, default=4)
    args = parser.parse_args()
    names = args.names or list(FABRIC)
    meta = json.loads((WEB / "world.json").read_text())
    world = np.frombuffer(zlib.decompress((WEB / "world.bin").read_bytes()), np.uint8).reshape(meta["height"], meta["depth"], meta["width"])
    palette = np.array(meta["palette"])
    imagery = geo.imagery()
    surfaces = geo.lidar_surfaces()
    ground = ground_heights(surfaces[0], 1.2) if surfaces is not None else ground_heights(geo.elevation(), 4)
    elements = {}
    for element in geo.load_osm():
        tags = campus_tags(element)
        if tags.get("building") and tags.get("name") in names:
            elements[tags["name"]] = element
    folder = geo.debug_dir() / "landmarks"
    folder.mkdir(exist_ok=True)
    for name in names:
        element = elements[name]
        mask = geo.rasterize([geo.way_rings(element)]).astype(bool)
        volume = Volume(geo.WIDTH, HEIGHT, geo.DEPTH)
        _, base, *_ = build_building(volume, campus_tags(element), mask, ground.copy(), imagery, np.ones(mask.shape))
        if name in LANDMARKS:
            LANDMARKS[name](volume, base)
        occupied = volume.keys[base:] != 0
        y, z, x = np.where(occupied)
        bounds = np.s_[0:y.max()+1, z.min():z.max()+1, x.min():x.max()+1]
        cells = np.where(occupied[bounds], world[base:][bounds], 0)
        sky = shade_from_sky(cells)
        views = [render(cells, palette, a, args.scale, sky) for a in CAMERAS.get(name, (140, 220, 315))]
        sheet = Image.new("RGB", (sum(v.width for v in views), max(v.height for v in views)), (234, 233, 225))
        left = 0
        for view in views:
            sheet.paste(view, (left, (sheet.height - view.height) // 2))
            left += view.width
        filename = re.sub(r"[^a-z]+", "-", name.lower()).strip("-") + ".png"
        sheet.save(folder / filename)
        print(name, sheet.size)


if __name__ == "__main__":
    main()
