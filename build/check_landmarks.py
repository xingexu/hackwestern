import json
import subprocess
import zlib

import numpy as np

from stonework import COPPER, DIAL, GALLERY_RED, axes
from voxelize import WEB


def main():
    meta = json.loads((WEB / "world.json").read_text())
    shape = (meta["height"], meta["depth"], meta["width"])
    world = np.frombuffer(zlib.decompress((WEB / "world.bin").read_bytes()), np.uint8).reshape(shape)
    palette = np.array(meta["palette"])
    tops = shape[0] - 1 - np.argmax(world[::-1] != 0, axis=0)
    labels = {label["name"]: label for label in meta["labels"]}
    assert labels["Stevenson Hall"]["z"] < labels["Lawson Hall"]["z"], "Lawson must be south of Stevenson"
    assert tops[307, 305] - tops[281, 302] >= 25, "Memorial Tower and northern range have lost their distinct heights"
    assert tops[199, 530] - tops[246, 537] >= 40, "Clock tower must rise over Middlesex's circular end wing"
    assert tops[368, 74] - tops[426, 108] >= 10, "Weldon must step down toward its south wing"

    def palette_index(colour):
        delta = np.linalg.norm(palette - colour, axis=1)
        assert delta.min() <= 8, f"Landmark colour {colour} was lost during quantisation"
        return delta.argmin()

    z, x = np.mgrid[191:208, 522:539]
    u, v = axes(x, z, 530.1, 199.4, -35)
    clock_tower = world[:, 191:208, 522:539]
    for face in (u, -u, v, -v):
        assert (clock_tower[:, (face > 4) & (face < 5.7)] == palette_index(DIAL)).sum() >= 6, "Missing clock dial"
    assert (clock_tower[-39:] == palette_index(COPPER)).sum() > 45, "Missing copper spire"
    assert (world[:, 194:200, 272:281] == palette_index(GALLERY_RED)).sum() >= 4, "Missing red gallery doors"
    subprocess.run(["node","web/dev/verify_campus_buildings.mjs"],cwd=WEB.parent,check=True)
    print("ok landmark positions, tower silhouettes, four clock faces, copper spire, red gallery doors and stepped library")


if __name__ == "__main__":
    main()
