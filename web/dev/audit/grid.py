import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon, box

ROOT = Path(__file__).resolve().parents[3]


def campus_cells():
    data = json.loads((ROOT / "web/campus-boundary.json").read_text())
    polygons = []
    for rings in data["polygons"]:
        outer, *holes = [list(zip(r[::2], r[1::2])) for r in rings]
        polygons.append(Polygon(outer, holes))
    campus = shapely.union_all(polygons)
    x0, z0, x1, z1 = campus.bounds
    cells = []
    for j in range(math.floor(z0 / 50), math.ceil(z1 / 50)):
        for i in range(math.floor(x0 / 50), math.ceil(x1 / 50)):
            x, z = i * 50, j * 50
            clipped = campus.intersection(box(x, z, x + 50, z + 50))
            if clipped.area <= 0:
                continue
            cell = dict(id=f"x{i}z{j}", x=x, z=z, area=clipped.area)
            if clipped.area < 2500:
                xs, zs = np.meshgrid(np.arange(x, x+50), np.arange(z, z+50))
                squares = shapely.box(xs.ravel(), zs.ravel(), xs.ravel()+1, zs.ravel()+1)
                pieces = shapely.intersection(squares, clipped)
                areas = shapely.area(pieces)
                cell["samples"] = []
                for k in np.flatnonzero(areas > 0):
                    p = pieces[k]
                    if areas[k] == 1:
                        cell["samples"].append(int(k))
                    else:
                        for part in shapely.get_parts(p):
                            if part.area > 0:
                                point = part.representative_point()
                                cell["samples"].append([point.x, point.y, part.area])
                assert abs(areas.sum() - clipped.area) < 1e-6
            cells.append(cell)
    assert abs(sum(c["area"] for c in cells) - campus.area) < 1e-6
    return cells


if __name__ == "__main__":
    print(json.dumps(campus_cells(), separators=(",", ":")))
