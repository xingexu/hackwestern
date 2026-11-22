import json
from pathlib import Path

import numpy as np
import requests
from scipy import ndimage
from scipy.spatial import cKDTree

import geo
from buildings import style_for
from fetch import DATA
from voxelize import GROUND_FLOOR, WEB


OSM_URL = "https://api.openstreetmap.org/api/0.6/map.json?bbox=-81.2768,43.0062,-81.2690,43.0112"
STREET_FRAMES = [
    (533489, 164, 102315609), (933231, 306, 138018887), (491777, 151, 66668411),
    (393142, 422, 39253064), (895417, 441, 131662887), (519133, 422, 89741133),
    (393142, 435, 39253104), (895167, 759, 131414025), (393142, 448, 39253176)
]
LANDMARKS = {
    "University College": ("UC", 300.6, 309.5, 10),
    "Middlesex College": ("MC", 530.1, 199.4, -35),
    "Physics Building": ("PAB", 349, 184.8, -21),
    "Natural Sciences Building": ("NSC", 322, 87, -21),
    "McIntosh Art Gallery": ("MG", 276.4, 197, 10)
}


def map_snapshot():
    cache = DATA / "street" / "full.json"
    if not cache.exists():
        response = requests.get(OSM_URL, headers={"User-Agent": "Western campus scene model"}, timeout=50)
        response.raise_for_status()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(response.content)
    return json.loads(cache.read_text())["elements"]


def compile_detail():
    dtm = geo.lidar_surfaces()
    terrain = ndimage.gaussian_filter(dtm[0] if dtm else geo.elevation(), 1.2 if dtm else 4)
    ground = terrain - terrain.min() + GROUND_FLOOR + 1
    route = json.loads((DATA / "street" / "core-survey-axis.json").read_text())
    coords = np.array([(s["x"], s["z"]) for s in route])
    tree = cKDTree(coords)
    items = []
    for node in map_snapshot():
        if node["type"] != "node":
            continue
        t = node.get("tags", {})
        highway, amenity = t.get("highway"), t.get("amenity")
        x, z = geo.to_grid(node["lat"], node["lon"])
        if not (2 < x < geo.WIDTH - 2 and 2 < z < geo.DEPTH - 2):
            continue
        d, index = tree.query([x, z])
        s = route[index]
        yaw = s["heading"]
        lateral = (x - s["x"]) * np.cos(yaw) - (z - s["z"]) * np.sin(yaw)
        y = np.rint(ground[int(z), int(x)])
        name = t.get("name")
        if highway == "crossing" and d < 2 and (t.get("crossing:markings") in ("yes", "ladder", "lines") or t.get("crossing") == "traffic_signals"):
            kind = "crossing"
            x, z, y = s["x"], s["z"], s["y"]
        elif highway == "traffic_signals" and d < 2:
            kind = "signals"
            x, z, y = s["x"], s["z"], s["y"]
        elif highway == "bus_stop" and t.get("public_transport") != "stop_position":
            kind = "shelter" if t.get("shelter") == "yes" else "transit"
            if d < 12:
                offset = np.sign(lateral) * max(7.8, min(abs(lateral), 12))
                x, z = s["x"] + offset * np.cos(yaw), s["z"] - offset * np.sin(yaw)
                y = s["y"] + 0.09
            if lateral < 0:
                yaw += np.pi
        elif amenity == "bicycle_parking":
            kind = "rack"
            name = min(12, max(2, int(t.get("capacity", "8").split(";")[0]) // 2)) if t.get("capacity", "8").split(";")[0].isdigit() else 4
            if d < 8.5:
                continue
        elif amenity == "bench":
            kind = "bench"
            if d < 8:
                continue
        else:
            continue
        if d < 8 and kind not in ("signals", "crossing", "shelter", "transit"):
            raise ValueError("Street furniture interferes with the driving envelope")
        items.append(dict(kind=kind, id=node["id"], x=round(x, 2), y=round(float(y), 3),
                          z=round(z, 2), yaw=round(float(yaw), 6), label=name,
                          distance=round(s["distance"], 1), grade=round(float((route[min(index + 1, len(route) - 1)]["y"] - route[max(index - 1, 0)]["y"]) / 1.9), 5)))
    stops = [f for f in items if f["kind"] == "shelter"]
    items = [f for f in items if f["kind"] != "transit" or all(np.hypot(f["x"] - p["x"], f["z"] - p["z"]) > 4 for p in stops)]
    for d, kind, lateral in [(150, "speed", -7.3), (196, "pedestrian", -7.4), *[(d, "busbay", -3.38) for d in range(405, 432, 3)]]:
        s = min(route, key=lambda s: abs(s["distance"] - d))
        yaw = s["heading"]
        items.append(dict(kind=kind, id=None, x=round(s["x"] + lateral * np.cos(yaw), 2), y=round(s["y"] + (0.09 if kind != "busbay" else 0), 3),
                          z=round(s["z"] - lateral * np.sin(yaw), 2), yaw=yaw, label=None, distance=s["distance"], grade=0))
    labels = json.loads((WEB / "world.json").read_text())["labels"]
    anchors = []
    for name, (code, x, z, angle) in LANDMARKS.items():
        label = next(item for item in labels if item["name"] == name)
        anchors.append([code, x + .5, label["y"] - round(style_for({"name": name}).height) - 2, z + .5, round(float(np.deg2rad(-angle)), 7)])
    sources = {"streetPhotos": [f"https://kartaview.org/details/{s}/{i}" for s, i, _ in STREET_FRAMES],
               "imageIds": [p for _, _, p in STREET_FRAMES], "map": OSM_URL, "exteriors": [f"https://www.uwo.ca/fm/img/what_we_do/bldg/{a[0]}.jpg" for a in anchors]}
    kinds = {f["kind"] for f in items}
    if not {"crossing", "signals", "shelter", "transit", "rack", "bench", "speed", "busbay"} <= kinds:
        raise ValueError(f"Missing street detail: {kinds}")
    return {"sources": sources, "landmarks": anchors, "features": items}


if __name__ == "__main__":
    data = compile_detail()
    (WEB / "street-detail.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"{len(data['features'])} street features, {len(data['landmarks'])} landmark facades, {len(data['sources']['streetPhotos'])} street references")
