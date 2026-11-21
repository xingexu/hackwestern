import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import requests
from PIL import Image

from grid import ROOT

sys.path.insert(0, str(ROOT / "build"))
from building_inventory import AERIAL_SERVICE, local_to_mercator


def tile_path(x, z):
    return ROOT / "data/audit/ortho-2025" / f"{x}_{z}.jpg"


def fetch_tile(origin):
    x, z = origin
    target = tile_path(x, z)
    if target.exists():
        with Image.open(target) as image:
            image.verify()
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    left, top = local_to_mercator(x, z)
    right, bottom = local_to_mercator(x + 150, z + 150)
    params = dict(bbox=f"{left},{bottom},{right},{top}", bboxSR=3857, imageSR=3857,
                  size="1500,1500", adjustAspectRatio="false", format="jpg", f="image")
    for attempt in range(4):
        try:
            response = requests.get(AERIAL_SERVICE, params=params, timeout=45)
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as image:
                image.load()
                if image.size != (1500, 1500):
                    raise ValueError(str(image.size))
            tmp = target.with_suffix(f".{uuid4().hex}.tmp")
            tmp.write_bytes(response.content)
            os.replace(tmp, target)
            return
        except (ValueError, OSError, requests.RequestException):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def reference(x, z):
    tx, tz = x // 150 * 150, z // 150 * 150
    with Image.open(tile_path(tx, tz)) as image:
        u, v = (x-tx)*10, (z-tz)*10
        return image.crop((u, v, u+500, v+500)).resize((1000, 1000), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    cells = json.load(sys.stdin)
    origins = {(c["x"]//150*150, c["z"]//150*150) for c in cells}
    with ThreadPoolExecutor(6) as pool:
        list(pool.map(fetch_tile, sorted(origins)))
