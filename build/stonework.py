import numpy as np

from voxels import color_key

STONE = (176, 166, 146)
TRIM = (204, 193, 171)
REVEAL = (125, 115, 98)
COPING = (184, 178, 159)
SLATE = (81, 88, 93)
GLASS = (48, 62, 70)
REFLECTION = (83, 103, 111)
WOOD = (70, 48, 40)
COPPER = (100, 139, 125)
COPPER_SEAM = (79, 113, 105)
GALLERY_RED = (161, 37, 44)
DIAL = (240, 228, 201)
LANDMARK_COLOURS = (COPPER, COPPER_SEAM, GALLERY_RED, DIAL, SLATE)


def axes(x, z, cx, cz, angle):
    angle = np.deg2rad(angle)
    dx, dz = x - cx, z - cz
    return dx * np.cos(angle) + dz * np.sin(angle), dz * np.cos(angle) - dx * np.sin(angle)


class Stonework:
    def __init__(self, volume, base, centre, angle, radius, height):
        cx, cz = centre
        x0 = max(0, int(cx - radius))
        z0 = max(0, int(cz - radius))
        x1 = min(volume.width, int(cx + radius + 1))
        z1 = min(volume.depth, int(cz + radius + 1))
        self.cells = volume.keys[base + 1:base + height + 1, z0:z1, x0:x1]
        z, x = np.mgrid[z0:z1, x0:x1]
        self.u, self.v = axes(x, z, cx, cz, angle)
        self.y = np.arange(1, self.cells.shape[0] + 1)[:, None, None]
        self.grain = ((x // 2 * 19 + z * 7 + self.y * 13) % 11 - 5)[..., None]
        self.masonry = color_key(np.array(STONE) + self.grain)

    def paint(self, shape, colour):
        np.copyto(self.cells, color_key(colour), where=shape)

    def stone(self, shape):
        np.copyto(self.cells, self.masonry, where=shape)

    def cut(self, shape):
        np.copyto(self.cells, 0, where=shape)

    def faces(self, radius):
        u, v = self.u, self.v
        for along, depth in ((u, v), (-u, -v), (v, -u), (-v, u)):
            yield along, radius - depth

    def opening(self, inset, opening, glass=GLASS):
        self.cut(opening & (inset >= -0.15) & (inset < 0.95))
        self.paint(opening & (inset >= 0.95) & (inset < 2.35), glass)


def arch_shape(along, y, width, sill, spring, rise):
    scaled = np.minimum(1, np.abs(along) / width)
    return (np.abs(along) <= width) & (y >= sill) & (y <= spring + rise * (1 - scaled ** 1.7))


def conron_hall(volume, base):
    s = Stonework(volume, base, (301, 310), 10, 38, 20)
    u, v, y = s.u, s.v, s.y
    end_walls = (v >= 4.5) & (v <= 34.3)
    front = (u >= 0.4) & (u <= 1.95) & end_walls
    s.stone(front & (y <= 15))
    offset = (v - 4.5) % 5.72 - 2.86
    surrounds = arch_shape(offset, y, 2.39, 6, 12.4, 2.55)
    openings = arch_shape(offset, y, 1.88, 7, 12.2, 1.82)
    s.paint(front & surrounds, TRIM)
    s.cut(end_walls & openings & (u >= 0.6) & (u < 2.4))
    s.paint(end_walls & openings & (u > -0.65) & (u < 0.72), REFLECTION)
    glazing_bar = (abs(offset) < 0.37) | (y == 9)
    s.paint(end_walls & openings & glazing_bar & (u > -0.6) & (u < 0.7), REVEAL)
    sash = (y >= 2) & (y <= 4) & (abs(offset) < 1.75)
    s.paint(front & sash, REFLECTION)
    s.paint(front & sash & (abs(offset) < 0.46), TRIM)
    pilasters = (abs(offset) > 2.35) & end_walls & (u >= 1.05) & (u < 2.75)
    s.stone(pilasters & (y >= 5) & (y <= 16))
    s.paint(pilasters & (u < 2.1) & (y == 17), COPING)
    s.paint(front & (y == 5), TRIM)


def university_tower(volume, base):
    conron_hall(volume, base)
    s = Stonework(volume, base, (300.6, 309.5), 10, 14, 47)
    u, v, y = s.u, s.v, s.y
    radius = np.maximum(abs(u), abs(v))
    shaft = radius <= 4.65
    s.stone(shaft & (y <= 35))
    for height, width in ((7, 5), (10, 4.95), (24, 4.95), (34, 5.05)):
        s.paint((radius <= width) & (y == height), TRIM)
    for along, inset in s.faces(4.65):
        pair = abs(abs(along) - 1.8)
        surround = arch_shape(pair, y, 1.64, 26, 30.8, 2.2)
        s.paint(surround & (inset >= -0.15) & (inset < 1.2), TRIM)
        opening = arch_shape(pair, y, 1.05, 26, 30.5, 1.6)
        s.opening(inset, opening)
        s.paint(opening & (inset > 1.6) & (inset < 3.2), (37, 44, 46))
        s.cut(opening & (inset >= -0.15) & (inset <= 1.58))
        s.paint(opening & (inset > 1.58) & (inset < 2.8) & (y == 27), REVEAL)
        for sill in (12, 17, 22):
            slit = (abs(along) < 0.67) & (y >= sill) & (y < sill + 2)
            s.opening(inset, slit)
        merlon = (abs(along) < 1.15) | ((abs(along) >= 3.15) & (abs(along) < 4.7))
        s.stone((abs(along) < 4.8) & (inset >= -0.3) & (inset <= 0.9) & ((y == 36) | ((y == 37) & merlon)))
    s.paint((radius < 3.55) & (y == 35), SLATE)
    for a, b in ((-1, -1), (-1, 1), (1, 1)):
        r = np.maximum(abs(u - 4.35 * a), abs(v - 4.35 * b))
        s.stone((r < np.where(y < 11, 1.43, 1.06)) & (y <= 38))
        s.paint((r <= 0.8) & (y == 39), COPING)
    turret = np.hypot(u - 4.25, v + 3.95)
    s.stone((turret < 1.68) & (y <= 40))
    s.paint((turret < 1.84) & ((y == 34) | (y == 39)), TRIM)
    s.paint((turret < 0.74) & (y >= 40) & (y <= 46), (119, 111, 98))
    s.paint((u >= 4) & (u <= 7.7) & (abs(v + 3.95) < 0.68) & (y >= 44) & (y <= 45), (156, 54, 58))
    entry = abs(v)
    reveal = arch_shape(entry, y, 3.25, 2, 4, 2.5)
    s.paint(reveal & (u >= 4.05) & (u <= 5.3), TRIM)
    door = arch_shape(entry, y, 2.15, 2, 3.85, 1.65)
    s.cut(door & (u >= 3) & (u <= 5.5))
    s.paint(door & (u >= 2.2) & (u < 3.15), WOOD)
    s.paint((entry <= 3.7) & (u > 4) & (u < 8.4) & (y == 1), COPING)


def middlesex_tower(volume, base):
    s = Stonework(volume, base, (530.1, 199.4), -35, 14, 62)
    u, v, y = s.u, s.v, s.y
    radius = np.maximum(abs(u), abs(v))
    s.stone((radius <= 4.85) & (y <= 40))
    for a, b in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        r = np.maximum(abs(u - a * 4.35), abs(v - b * 4.35))
        pier = np.select([y < 13, y < 24, y < 39], [1.8, 1.48, 1.11], default=0.94)
        s.stone((r <= pier) & (y <= 42))
        s.paint((r < (47.3 - y) * 0.25) & (y > 42) & (y < 47), TRIM)
        s.paint((r == r.min()) & (y >= 44) & (y <= 46), TRIM)
    for along, inset in s.faces(4.85):
        panels = (abs(along) <= 2.35) & (abs(along) >= 0.45)
        for sill in (9, 14, 19):
            s.opening(inset, panels & (y >= sill) & (y <= sill + 2), REFLECTION)
        arch = arch_shape(along, y, 2.8, 24, 35.5, 2.1)
        s.paint(arch & (inset >= -0.15) & (inset < 1.1), TRIM)
        lancets = arch_shape(along, y, 2.04, 24, 30.8, 2.4) & (abs(along) > 0.42)
        s.opening(inset, lancets)
        d = np.hypot(along, y - 35)
        face = (inset >= -0.85) & (inset < 1.05)
        s.paint(face & (d < 2.7), REVEAL)
        s.paint(face & (d < 2.35), DIAL)
        hand = ((abs(along) <= 0.53) & (y >= 35) & (y < 37)) | ((along > -1.24) & (along < 0.3) & (y == 35))
        s.paint(face & (d <= 1.7) & hand, (40, 42, 43))
    s.paint((radius < 4.25) & (y == 41), COPPER_SEAM)
    octagon = np.maximum(radius, (abs(u) + abs(v)) / 1.45)
    s.paint((octagon < 3.25) & (y > 40) & (y <= 48), COPPER)
    for along, inset in s.faces(3.25):
        vents = (abs(along) <= 1.45) & (inset >= 0) & (inset <= 1.2) & (y >= 43) & (y <= 46)
        s.paint(vents, COPPER_SEAM)
    taper = np.interp(y, [47, 49, 53, 58, 60], [3.2, 2.65, 1.7, 0.79, 0.62])
    s.paint((octagon <= taper) & (y >= 48) & (y <= 60), COPPER)
    s.paint((octagon <= 0.73) & (y == 61), (128, 113, 80))
    surround = arch_shape(v, y, 3.05, 2, 5.5, 1.65)
    s.paint(surround & (u >= -5.9) & (u < -4.0), TRIM)
    door = arch_shape(v, y, 2.15, 2, 4.9, 1.1)
    s.cut(door & (u > -6.1) & (u < -3.1))
    s.paint(door & (u >= -3.3) & (u <= -2), WOOD)
    s.paint((abs(v) < 3.9) & (u >= -8.6) & (u < -4) & (y == 1), COPING)
