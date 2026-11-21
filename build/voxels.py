import numpy as np

AIR = 0


def color_key(rgb):
    rgb = np.clip(np.asarray(rgb), 0, 255).astype(np.uint16)
    return ((rgb[..., 0] >> 3) << 10 | (rgb[..., 1] >> 3) << 5 | (rgb[..., 2] >> 3)) + 1


def key_to_rgb(keys):
    raw = keys.astype(np.int32) - 1
    r = ((raw >> 10) & 31) * 8 + 4
    g = ((raw >> 5) & 31) * 8 + 4
    b = (raw & 31) * 8 + 4
    return np.stack([r, g, b], axis=-1)


class Volume:
    def __init__(self, width, height, depth, seed=7):
        self.width = width
        self.height = height
        self.depth = depth
        self.keys = np.zeros((height, depth, width), dtype=np.uint16)
        self.random = np.random.default_rng(seed)

    def inside(self, x, y, z):
        return 0 <= x < self.width and 0 <= y < self.height and 0 <= z < self.depth

    def put(self, x, y, z, rgb, jitter=0):
        if not self.inside(x, y, z):
            return
        color = np.asarray(rgb, dtype=np.float32)
        if jitter:
            color = color + self.random.uniform(-jitter, jitter)
        self.keys[y, z, x] = color_key(color)

    def clear(self, x, y, z):
        if self.inside(x, y, z):
            self.keys[y, z, x] = AIR

    def box(self, x0, x1, y0, y1, z0, z1, rgb, jitter=0):
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                for x in range(x0, x1 + 1):
                    self.put(x, y, z, rgb, jitter)

    def jittered(self, rgb, shape, amount):
        noise = self.random.uniform(-amount, amount, size=shape + (1,))
        return np.asarray(rgb, dtype=np.float32) + noise
