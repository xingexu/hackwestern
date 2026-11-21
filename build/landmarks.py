from functools import lru_cache

import numpy as np
from scipy import ndimage

import geo
from buildings import BRICK, CONCRETE, GLASS
from stonework import COPING, GALLERY_RED, REFLECTION, REVEAL, SLATE, STONE, TRIM, WOOD, Stonework, arch_shape, axes, middlesex_tower, university_tower
from voxels import color_key


AFTER_SURVEY = {
    "Ronald D. Schmeichel Building for Entrepreneurship and Innovation",
    "Music Building",
}

ANGLES = {
    "Physics Building": -21,
    "Natural Sciences Building": -21,
    "Taylor Library": -21,
    "Kresge Building": -21,
    "Medical Sciences Building": -21,
    "Collip Medical Research Building": -21,
    "Western Science Centre": -21,
    "Weldon Library": -35,
    "Middlesex College": 35,
}

FABRIC = {
    "Lawson Hall": ((163, 153, 135), 4.7, 4.4),
    "Physics Building": ((170, 164, 148), 5.0, 4.3),
    "Natural Sciences Building": ((182, 175, 155), 6.1, 4.8),
    "Stevenson Hall": ((191, 188, 177), 7.6, 4.0),
    "Somerville House": ((167, 161, 144), 4.2, 4.1),
    "Thames Hall": ((170, 166, 149), 5.1, 4.2),
    "Talbot College": ((178, 172, 153), 5.2, 3.95),
    "Arts & Humanities": ((172, 166, 146), 4.8, 4.1),
    "McIntosh Art Gallery": ((158, 156, 142), 5.7, 4.6),
    "Middlesex College": ((189, 176, 149), 4.55, 4.05),
    "University College": ((172, 158, 139), 4.5, 4.2),
    "Weldon Library": ((170, 167, 153), 18.0, 4.25),
    "Social Science Center": ((177, 171, 155), 17.0, 4.05),
    "University Community Center": ((170, 169, 162), 7.5, 4.05),
}


@lru_cache(maxsize=1)
def lidar():
    return geo.lidar_surfaces()


def inside_distance(mask):
    return ndimage.distance_transform_edt(np.pad(mask, 1))[1:-1, 1:-1]


def surveyed_roof(name, mask, origin):
    surfaces = lidar()
    if surfaces is None or name in AFTER_SURVEY:
        return None
    x, z = origin
    rows, cols = mask.shape
    terrain, surface = (part[z:z + rows, x:x + cols] for part in surfaces)
    heights = ndimage.median_filter(surface, size=3) - np.median(terrain[mask])
    interior = (inside_distance(mask) >= 2.8) & (heights > 2.7)
    if not interior.any() or np.mean(heights[mask] > 2) < 0.55:
        return None
    source = ndimage.distance_transform_edt(~interior, return_distances=False, return_indices=True)
    levels = heights[tuple(source)]
    flat = (ndimage.maximum_filter(levels, 3) - ndimage.minimum_filter(levels, 3)) < 1.4
    if flat.any():
        distance, index = ndimage.distance_transform_edt(~flat, return_indices=True)
        levels = np.where(distance <= 3, levels[tuple(index)], levels)
    return np.rint(levels).astype(int).clip(3, 58)


def college_roof(name, x, z):
    if name == "University College":
        u, v = axes(x, z, 301, 310, 10)
        south = (v >= 1) & (u > -16)
        north = (v < -44) & (u >= -18) & (u <= -6.4)
        roof = np.where(v < -43, np.where(north, 14, 11), 15)
        roof = np.where((v >= -42) & (v < 1) & (u >= -13), 11, roof)
        roof = np.where((v > 22) & (u < -23), 15.4 + 2.0 * (1 - np.minimum(1, abs(v - 28) / 6)), roof)
        roof = np.where(south, 19.2 - 0.42 * abs(u + 6.3), roof)
        return np.rint(roof).astype(int), south, (u, v)
    if name == "Middlesex College":
        u, v = axes(x, z, 530, 199, -35)
        west_range, _ = axes(x, z, 540, 226, 7)
        angled_wing = (z > 210) & (z < 239)
        ridge = 18.6 - 0.42 * abs(west_range)
        roof = np.where((z > 182) & (z < 219) & (u < 13) & (v > -16) & (v < 21), 20, 16)
        roof = np.where(angled_wing, np.maximum(ridge, 15), roof)
        roof = np.where(z >= 239, 17, roof)
        return np.rint(roof).astype(int), angled_wing, (u, v)
    if name == "McIntosh Art Gallery":
        u, v = axes(x, z, 277, 195, 10)
        rise = np.minimum.reduce([4.3 - abs(v + 4.4), u + 16.6, 10.2 - u])
        return np.rint(6.4 + 0.74 * np.maximum(0, rise)).astype(int), v < 0, (u, v)
    return None


def facade_axis(mask, x, z, name):
    angle = ANGLES.get(name, 10)
    if name == "Middlesex College":
        angle = np.where(z >= 208, 7, angle)
    u, v = axes(x, z, 0, 0, angle)
    blurred = ndimage.gaussian_filter(np.pad(mask.astype(float), 4), 1.8)
    gz, gx = (a[4:-4, 4:-4] for a in np.gradient(blurred))
    normal_u, normal_v = axes(gx, gz, 0, 0, angle)
    return np.where(abs(normal_u) > abs(normal_v), v, u)


def roof_finish(imagery, mask):
    light = imagery.mean(axis=-1)
    median = np.percentile(light[mask], 60)
    roof = np.clip(median * 0.75 + 32, 85, 174)
    detail = np.clip(ndimage.gaussian_filter(light, 0.9) - median, -44, 44) * 0.32
    return color_key(np.array([roof + 4, roof + 3, roof]) + detail[..., None])


def build_architecture(volume, name, style, base, mask, origin, imagery):
    z, x = np.indices(mask.shape)
    x, z = x + origin[0], z + origin[1]
    college = college_roof(name, x, z)
    pitched = np.zeros_like(mask)
    if college is not None:
        top, pitched, (u, v) = college
    else:
        top = surveyed_roof(name, mask, origin)
        if top is None:
            if name not in FABRIC:
                return False
            top = np.full(mask.shape, round(style.height), dtype=int)
    if name == "Physics Building":
        _, v = axes(x, z, 349, 184, -21)
        top = np.where(v >= -10, 16 + ((v > 2) & (top >= 17)), top)
    if name == "Weldon Library":
        top = np.select([top >= 27, top >= 24, top >= 19, top >= 14, top >= 8], [28, 24, 22, 15, 8], default=6)
    material, bay, storey = FABRIC.get(name, ({
        BRICK: (158, 115, 91), CONCRETE: (168, 167, 154), GLASS: (181, 184, 177),
    }.get(style.wall, STONE), 4.5, 4.05))
    high = int(top[mask].max())
    footprint_depth = inside_distance(mask)
    roof = roof_finish(imagery, mask)
    roof = np.where(pitched, color_key(SLATE), roof)
    concrete_bands = name in ("Social Science Center", "Weldon Library")
    pale_frame = (name in FABRIC and style.wall not in (CONCRETE, GLASS))
    glass = color_key((56, 76, 84) if pale_frame else (63, 77, 82))
    low_glass = color_key((74, 90, 94))
    trim = color_key(TRIM if pale_frame else (162, 161, 150))
    plinth = color_key(np.array(material) - 23)
    masonry = np.array(material)
    rows, cols = mask.shape
    region = volume.keys[:, origin[1]:origin[1] + rows, origin[0]:origin[0] + cols]
    max_height = volume.height - base - 1
    last_shape = None
    for y in range(max(-2, -base), min(high + 1, max_height) + 1):
        covered = mask & (y <= top)
        if not covered.any():
            continue
        if last_shape is None or not np.array_equal(last_shape, covered):
            depth = inside_distance(covered)
            along = facade_axis(covered, x, z, name)
            phase = (along + bay / 2) % bay - bay / 2
            last_shape = covered
        band = (y - 1) % storey
        width = bay * (0.45 if concrete_bands or style.wall == GLASS else 0.32)
        window = (abs(phase) <= width) & (band >= 0.9) & (band < storey - 0.50)
        if concrete_bands:
            window &= (band >= 1.75) & (band < 3.35)
        if name == "Talbot College":
            width_on_site, _ = axes(x, z, 496, 446, 10)
            window &= (width_on_site > -4) | (y <= 4)
        if name == "Weldon Library":
            window &= ((along + 9) % 43 < 35) & ((y < 8) | ((y > 11) & (band < 3.05)))
        if name == "Middlesex College" and y < 4:
            window &= (y == 2) & (abs(phase) < 1.30)
        lintel = (abs(phase) <= width + 0.34) & (band < 0.98)
        reveal = depth <= 2.25
        face = depth <= 1.05
        course = ((x // 2 * 3 + z // 2 * 5 + y * 7) % 13 - 6)
        if style.wall == CONCRETE:
            course = ((np.floor(along / 3).astype(int) * 7 + int(y / storey) * 3) % 5 - 2)
        cells = color_key(masonry + course[..., None])
        if y <= 1:
            cells = np.where(reveal, plinth, cells)
        if name == "University College":
            hall = (u > -1.0) & (v > 5) & (v <= 33.6)
            arch_offset = (v - 6.2) % 5.4 - 2.7
            hall_light = arch_shape(arch_offset, y, 1.95, 7, 12.4, 1.7)
            window = np.where(hall & (y > 5), hall_light, window)
            lintel = np.where(hall & (y > 5), arch_shape(arch_offset, y, 2.4, 6, 12.9, 2.15) & ~hall_light, lintel)
        if name == "Natural Sciences Building":
            south = (z > 61) & (z < 109) & (x < 316)
            window = np.where(south, (abs(phase) <= 1.4) & (y >= 3) & (y < 8), window)
        window &= (y >= 2) & (y < top - 1)
        if pale_frame and y > 1:
            cells = np.where(lintel & reveal & ~window, trim, cells)
        cells = np.where(window & reveal, np.where(band >= 2.5, glass, low_glass), cells)
        cells = np.where(window & face, 0, cells)
        if name == "Weldon Library" and 1 <= y <= 4:
            cantilever = (top >= 15) & ((along + 4) % 16 > 3.5)
            cells = np.where(cantilever & (depth < 3.3), glass, cells)
            cells = np.where(cantilever & (depth <= 1.65), 0, cells)
        cap = (y == top) & mask
        perimeter = footprint_depth <= 1.3
        cells = np.where(cap, np.where(perimeter & ~pitched, color_key(masonry), roof), cells)
        region[base + y][covered] = cells[covered]
    coping = mask & (footprint_depth < 1.5) & ~pitched
    zc, xc = np.where(coping & (top + 1 <= max_height))
    region[base + top[zc, xc] + 1, zc, xc] = color_key(masonry + 6)
    return True


def portal(volume, base, centre, angle, width=3.3, height=7, door_colour=WOOD):
    s = Stonework(volume, base, centre, angle, width + 8, height + 2)
    u, v, y = s.u, s.v, s.y
    bay = (abs(u) <= width + 0.68) & (v > -2.4) & (v <= 1.15)
    s.stone(bay & (y <= height))
    s.paint(bay & (y == height), COPING)
    frame = arch_shape(u, y, width - 0.1, 2, 3.4, 2.35)
    s.paint(frame & (v >= -0.25) & (v <= 1.65), TRIM)
    door = arch_shape(u, y, width - 1.05, 2, 3.0, 1.6)
    s.cut(door & (v > -1.25) & (v <= 1.7))
    s.paint(door & (v >= -2.3) & (v <= -1.05), door_colour)
    s.paint((abs(u) < width + 0.6) & (v > 0.5) & (v <= 3.55) & (y == 1), COPING)


def physics(volume, base):
    s = Stonework(volume, base, (349, 184.8), -21, 13, 20)
    u, v, y = s.u, s.v, s.y
    bow = np.maximum(abs(u) - 2.4, 0) + v * 0.77
    oriel = (abs(u) <= 3.7) & (v >= -1.55) & (bow <= 2.55)
    s.stone(oriel & (y >= 4) & (y <= 15))
    s.paint(oriel & ((y == 7) | (y == 12)), TRIM)
    s.paint(oriel & (bow >= 1.6) & (abs(u) > 0.42) & (y > 8) & (y < 12), REFLECTION)
    s.paint(oriel & arch_shape(u, y, 2.9, 13, 13.2, 2.2) & (bow >= 1.4), REFLECTION)
    portal(volume, base, (348.8, 186.9), -21, 2.9, 6)


def gallery(volume, base):
    s = Stonework(volume, base, (276.4, 197.0), 10, 8, 10)
    u, v, y = s.u, s.v, s.y
    stone_pediment = (abs(u) < 2.7) & (v >= -1.7) & (v < 0.9) & (y <= 8.5 - abs(u) * 0.7)
    s.stone(stone_pediment)
    s.paint(stone_pediment & (y > 7.6 - abs(u) * 0.7), TRIM)
    s.paint((abs(u) <= 2) & (v >= -0.35) & (v <= 0.95) & (y <= 5), TRIM)
    s.paint((abs(u) <= 1.29) & (v >= -0.33) & (v < 1.0) & (y >= 2) & (y <= 4), GALLERY_RED)
    s.paint((abs(u) < 2.9) & (v > 0.2) & (v <= 4.2) & (y == 1), COPING)


def sciences(volume, base):
    s = Stonework(volume, base, (322, 87), -21, 13, 12)
    u, v, y = s.u, s.v, s.y
    radius = np.hypot(u / 8.2, v / 8.9)
    front = (v >= 0.2) & (radius <= 1.03)
    s.paint(front & (y >= 1) & (y <= 6), (92, 111, 113))
    mullions = (abs((u + 2) % 3.7 - 1.85) < 0.62) | (y == 3)
    s.paint(front & (radius > 0.82) & mullions & (y <= 6), (185, 183, 168))
    s.paint((v >= 0) & (radius <= 1.13) & (y == 7), TRIM)


def lawson(volume, base):
    s = Stonework(volume, base, (202.4, 296.2), 100, 21, 14)
    u, v, y = s.u, s.v, s.y
    facade = (abs(u) < 17) & (v > -1.0) & (v <= 0.9)
    s.stone(facade & (y >= 2) & (y <= 10))
    offset = (u + 2.35) % 4.7 - 2.35
    frame = arch_shape(offset, y, 1.84, 5, 8.15, 1.95)
    sash = arch_shape(offset, y, 1.38, 6, 8.05, 1.25)
    s.paint(facade & frame, TRIM)
    s.paint(facade & sash, REFLECTION)
    s.paint(facade & sash & (abs(offset) < 0.35), REVEAL)
    s.paint(facade & (abs(offset) < 1.48) & (y >= 2) & (y <= 3), REFLECTION)
    pilaster = (abs(offset) >= 2.02) & (abs(u) < 17) & (v >= -0.2) & (v <= 1.45)
    s.stone(pilaster & (y >= 4) & (y <= 11))
    portal(volume, base, (201.4, 295.95), 100, 3.2, 10)


def community_centre(volume, base):
    s = Stonework(volume, base, (68.2, 288.7), -34, 13, 18)
    u, v, y = s.u, s.v, s.y
    front = (abs(u) < 6.9) & (v >= -1.8) & (v <= 1.3)
    s.paint(front & (y <= 16.1 - abs(u) * 0.42), (164, 157, 151))
    arch = arch_shape(u, y, 5.35, 2, 8.0, 5.6)
    s.paint(front & arch, (82, 102, 107))
    grid = (abs((u + 1.55) % 3.1 - 1.55) < 0.42) | (y % 3 == 0)
    s.paint(front & arch & grid, (123, 118, 112))
    s.paint((abs(u) <= 6.55) & (abs(v - 1.15) < 2.6) & (y == 5), (139, 131, 124))
    s.paint(front & (abs(u) < 4.35) & (y >= 1) & (y < 4), (60, 76, 79))


def somerville(volume, base):
    s = Stonework(volume, base, (190, 385), 100, 9, 18)
    u, v, y = s.u, s.v, s.y
    shaft = (abs(u) <= 3.45) & (abs(v) <= 3.65)
    s.stone(shaft & (y <= 15))
    s.paint(shaft & ((y == 7) | (y == 14)), TRIM)
    for sill in (8, 12):
        s.paint((abs(u) <= 2.3) & (abs(u) > 0.52) & (v >= 2.55) & (v <= 3.65) & (y >= sill) & (y < sill + 2), REFLECTION)
    s.stone(shaft & ((abs(u) > 2.55) | (abs(v) > 2.6)) & (y == 16))
    portal(volume, base, (186.6, 384.5), 100, 2.6, 6)


LANDMARKS = {
    "University College": university_tower,
    "Middlesex College": middlesex_tower,
    "Physics Building": physics,
    "Natural Sciences Building": sciences,
    "McIntosh Art Gallery": gallery,
    "Somerville House": somerville,
    "Lawson Hall": lawson,
    "University Community Center": community_centre,
    "Arts & Humanities": lambda volume, base: portal(volume, base, (285.5, 407), 100, 3.0, 12),
    "Thames Hall": lambda volume, base: portal(volume, base, (186, 515), 10, 3.0, 8),
}
