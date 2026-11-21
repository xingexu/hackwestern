import json
from pathlib import Path

import numpy as np
from scipy import ndimage

import geo


ROAD_SECTIONS = (
    (1442163219, "University Drive", slice(None, None, -1)),
    (142399224, "Middlesex Drive", slice(None)),
    (142399222, "Elgin Drive", slice(None)),
    (561637296, "Elgin Drive", slice(None)),
    (142399225, "Oxford Drive", slice(0, 5)),
    (35578876, "Kent Drive", slice(None, 2, -1)),
)


def street_centerline(elements):
    by_id = {way["id"]: way for way in elements if way["type"] == "way"}
    points = []
    for way_id, name, section in ROAD_SECTIONS:
        way = by_id[way_id]
        tags = way["tags"]
        if name not in (tags.get("name"), tags.get("ref")):
            raise ValueError(f"Way {way_id} no longer identifies {name}")
        street = geo.way_rings(way)[0][0][section]
        if points and points[-1] != street[0]:
            raise ValueError(f"Disconnected course at {name}, way {way_id}")
        points.extend(street[1:] if points else street)
    return np.array(points)


def resample(points, spacing):
    lengths = np.linalg.norm(np.diff(points, axis=0), axis=1)
    distances = np.r_[0, np.cumsum(lengths)]
    samples = np.linspace(0, distances[-1], int(np.ceil(distances[-1] / spacing)) + 1)
    return np.column_stack([np.interp(samples, distances, axis) for axis in points.T]), samples


def compile_route():
    from voxelize import GROUND_FLOOR, collect_layers, building_rasters

    elements = geo.load_osm()
    streets, _ = resample(street_centerline(elements), 0.25)
    streets = ndimage.gaussian_filter1d(streets, sigma=32, axis=0, mode="nearest")
    points, distances = resample(streets, 0.95)
    x, z = points.T
    tangent = np.gradient(points, axis=0)
    headings = np.arctan2(tangent[:, 0], tangent[:, 1])
    lidar = geo.lidar_surfaces()
    terrain = ndimage.gaussian_filter(lidar[0] if lidar is not None else geo.elevation(), 1.2 if lidar is not None else 4)
    top = terrain - terrain.min() + GROUND_FLOOR + 1
    y = ndimage.map_coordinates(top, [z - 0.5, x - 0.5], order=1)
    y = ndimage.gaussian_filter1d(y, sigma=2, mode="nearest")
    footprints = building_rasters(collect_layers(elements)[0])
    solid = np.logical_or.reduce([mask for _, mask in footprints])
    clearance = ndimage.map_coordinates(ndimage.distance_transform_edt(~solid), [z, x], order=1)
    if clearance.min() < 5 or min(x.min(), z.min(), geo.WIDTH - x.max(), geo.DEPTH - z.max()) < 15:
        raise ValueError(f"Course too close to a building or map edge, building clearance {clearance.min():.1f} m")
    if not 580 < distances[-1] < 700 or np.abs(np.diff(y) / np.diff(distances)).max() > 0.2:
        raise ValueError("Course length or grade falls outside the expected UC Hill profile")
    samples = [
        {"x": round(px, 3), "y": round(float(py), 3), "z": round(pz, 3), "heading": round(yaw, 6), "distance": round(s, 3)}
        for px, py, pz, yaw, s in zip(x, y, z, headings, distances)
    ]
    print(f"UC Hill: {distances[-1]:.1f} m, {len(samples)} samples, {y.max() - y.min():.1f} m relief, {clearance.min():.1f} m minimum building clearance")
    return samples


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "web" / "drive-route.json"
    output.write_text(json.dumps(compile_route(), separators=(",", ":")) + "\n")
