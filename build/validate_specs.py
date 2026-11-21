import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SPECS = ROOT / "build" / "specs" / "buildings"
SCHEMA = ROOT / "build" / "specs" / "building-spec-v1.schema.json"
COMPASS = {"all", "street", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"}


def material_refs(node, found):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("material", "surroundMaterial", "surround") and isinstance(value, str) and key != "surround":
                found.add(value)
            elif key == "surround" and isinstance(value, str) and value not in ("none", "stone", "brick-soldier", "precast", "metal"):
                found.add(value)
            else:
                material_refs(value, found)
    elif isinstance(node, list):
        for value in node:
            material_refs(value, found)
    return found


def selector_indices(selector, wall_count):
    if isinstance(selector, int):
        return [selector]
    if isinstance(selector, list):
        return [i for item in selector for i in selector_indices(item, wall_count)]
    text = str(selector).strip()
    if text in COMPASS:
        return []
    match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", text)
    if match:
        return list(range(int(match[1]), int(match[2]) + 1))
    if text.isdigit():
        return [int(text)]
    raise ValueError(f"unreadable wall selector {selector!r}")


def check(spec, building, validator):
    problems = [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in validator.iter_errors(spec)]
    if spec.get("id") != building["id"]:
        problems.append(f"id {spec.get('id')!r} does not match file name {building['id']!r}")
    materials = spec.get("materials", {})
    for required in ("wall", "roof"):
        if required not in materials:
            problems.append(f"materials.{required} is missing")
    for ref in sorted(material_refs({k: v for k, v in spec.items() if k != "materials"}, set())):
        if ref not in materials:
            problems.append(f"material reference {ref!r} is not defined in materials")
    walls = len(building["walls"])
    selectors = list(spec.get("walls", {}).get("byWall", {}).keys())
    selectors += [e.get("wall") for e in spec.get("entrances", []) if "wall" in e]
    selectors += [a.get("walls") for a in spec.get("attachments", []) if a.get("walls") is not None]
    selectors += [f.get("walls") for f in spec.get("roof", {}).get("features", []) if f.get("walls") is not None]
    for selector in selectors:
        try:
            for index in selector_indices(selector, walls):
                if not 0 <= index < walls:
                    problems.append(f"wall {index} does not exist (building has walls 0-{walls - 1})")
        except ValueError as error:
            problems.append(str(error))
    if spec.get("present") is False:
        if not spec.get("evidence"):
            problems.append("present:false needs evidence entries showing the building is gone")
        return problems
    if spec.get("lidarTrusted") is False:
        if not spec.get("lidarNote"):
            problems.append("lidarTrusted:false needs a lidarNote explaining the measured heights")
        return problems
    height = building.get("heightP90") or 0
    tallest = max([p.get("height", 0) for p in spec.get("massing", {}).get("parts", [])] + [0])
    if tallest and height > 3 and not 0.45 * height <= tallest <= 2.2 * max(height, building.get("heightMax", 0)):
        problems.append(f"tallest part {tallest} m is far from lidar height p90 {height} m / max {building.get('heightMax')} m; if lidar is wrong here (trees over the roof, demolition, new construction) set lidarTrusted:false with a lidarNote")
    return problems


def main():
    inventory = {b["id"]: b for b in json.loads((ROOT / "data" / "buildings" / "inventory.json").read_text())["buildingsList"]}
    validator = Draft202012Validator(json.loads(SCHEMA.read_text()))
    wanted = sys.argv[1:]
    files = [SPECS / f"{i}.json" for i in wanted] if wanted else sorted(SPECS.glob("*.json"))
    failures = 0
    for path in files:
        building_id = path.stem
        if building_id not in inventory:
            print(f"FAIL {building_id}: not in data/buildings/inventory.json")
            failures += 1
            continue
        if not path.exists():
            print(f"FAIL {building_id}: {path} does not exist")
            failures += 1
            continue
        try:
            spec = json.loads(path.read_text())
        except json.JSONDecodeError as error:
            print(f"FAIL {building_id}: invalid JSON: {error}")
            failures += 1
            continue
        problems = check(spec, inventory[building_id], validator)
        if problems:
            failures += 1
            print(f"FAIL {building_id}:")
            for problem in problems[:25]:
                print(f"  - {problem}")
        else:
            print(f"ok   {building_id} {spec.get('name', '')}")
    print(f"{len(files) - failures}/{len(files)} specs valid")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
