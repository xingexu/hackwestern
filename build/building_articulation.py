import re

from shapely.geometry import LineString, Point, Polygon


def articulate(spec):
    evidence = " ".join([spec.get("notes", ""), spec.get("summary",""), *(row.get("note", "") for row in spec.get("evidence", []))]).lower()
    parts = spec.get("massing", {}).get("parts", [])
    facades = [spec["walls"]["default"], *spec["walls"].get("byWall", {}).values()]
    materials = spec["materials"]
    for name, material in materials.items():
        if material["kind"] == "precast-panel" and re.search(r"brutalist|bush.hammered|ribbed concrete", evidence):
            material.setdefault("surface", "ribbed-concrete" if name == "wall" else "bush-hammered")
    for part in parts:
        name = part.get("name", "").lower()
        facade = part.setdefault("facade", {})
        if "canopy" in name and "square-ended concrete canopy" in evidence:
            facade.setdefault("fasciaBeam", {"spacing": 2.5, "projection": .36})
        if re.search(r"stair (shaft|core)", name) and facade.get("windows", {}).get("type") == "slot":
            facade["windows"].setdefault("spanFloors", part.get("floors", spec["floors"]["count"]))
        facades.append(facade)
    if "glazed courtyard elevations" in evidence:
        spec["walls"].setdefault("courtyard", {"material": "glass", "blank": False, "windows": {"type": "curtain-wall"}})
    profiles=list(facades)
    for facade in facades:
        profiles.extend(p for p in (facade.get("groundFloor"),facade.get("topFloor"),*facade.get("floorOverrides",{}).values()) if p)
    for profile in profiles:
        windows = profile.get("windows", {})
        piers = profile.get("piers")
        if windows.get("type") == "curtain-wall" and re.search(r"slop(?:ed|ing),? (?:mullioned )?glaz|sloped, mullioned glass", evidence):
            windows.setdefault("rake", -.65)
        parapet=profile.get("parapet")
        if parapet and "pierced parapet" in evidence and parapet.get("type") == "plain":
            parapet["type"]="pierced"
        if piers and "projecting blades" in evidence and piers.get("depth", 0) >= .25:
            piers.setdefault("aboveRoof", 1.35)
        if windows.get("type") in ("curtain-wall", "ribbon") and "alternating projected glass bays" in evidence:
            windows.setdefault("projectEvery", 2)
            windows.setdefault("projection", .52)
        if "rectangular dark frames project from the curtain wall" in evidence and windows.get("type") == "curtain-wall":
            windows.setdefault("projectEvery", 3)
            windows.setdefault("projection", .48)
        if windows.get("type")=="punched" and re.search(r"alternating buff and brick upper",evidence) and "red" in materials:
            profile.setdefault("bayMaterials",["wall","red"])
        if profile.get("material")=="spandrel" and "alternate glazing and opaque spandrel" in evidence:
            profile.setdefault("spandrelMaterial","spandrel")
        if parapet and "stepped parapet" in evidence and parapet.get("type") in ("coped","plain") and not profile.get("blank"):
            parapet["type"]="stepped"
        balcony = profile.get("balconies")
        if balcony:
            if "alternate opaque" in evidence:
                balcony.setdefault("infill","alternating")
            if "dark panel fills the lower part" in evidence:
                balcony.setdefault("infill","lower-panel")
                balcony.setdefault("panelMaterial","accent")
            if "divider splits the slab" in evidence:
                balcony.setdefault("divider",True)
            if re.search(r"opaque (front|infill)|solid (front|parapet)|precast balcony", evidence):
                balcony.setdefault("infill", "solid")
            if re.search(r"end panels?|side panels?|end walls?|side cheeks", evidence):
                balcony.setdefault("endPanels", True)
    for tower in spec.get("towers", []):
        if "entrance" in tower.get("name","").lower() and "three pierced openings" in evidence:
            tower.setdefault("piercedParapet",{"openings":3,"height":.9})
            if "oriel" in evidence and spec.get("entrances"):
                tower.setdefault("oriel",{"wall":spec["entrances"][0]["wall"],"projection":.62})
    for row in spec.get("attachments", []):
        if row["type"] == "covered-walkway" and re.search(r"shallow sloped porch|shallow pitched (hood|canop)|shared.{0,30}pitched (hood|canop)", evidence):
            row.setdefault("roofRise", min(.48, row.get("width", 1.6)*.27))
        if row["type"] in ("exterior-stair", "fire-escape") and row.get("height", 0) > 2.5:
            row.setdefault("landing", True)


def bind_grade(parts, spec):
    entries = spec.get("entrances", [])
    grades = [(i, Point(e["gradePoint"])) for i, e in enumerate(entries) if "gradePoint" in e]
    if not grades:
        return
    for part in parts:
        if not 0 < part["low"] < 4.5 or not re.search(r"\bporch\b", part["name"], re.I):
            continue
        outline = Polygon(part["rings"][0], part["rings"][1:]).buffer(0)
        distance, i = min((outline.distance(point), i) for i, point in grades)
        if distance <= 5:
            part["porchEntry"] = i
    for row in spec.get("attachments", []):
        if row["type"] not in ("terrace", "covered-walkway") or not row.get("path"):
            continue
        line = LineString(row["path"])
        distance, i = min((line.distance(point), i) for i, point in grades)
        if distance < max(2.2, row.get("width", 0)):
            row["gradeEntry"] = i
