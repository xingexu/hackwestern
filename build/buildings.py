from dataclasses import dataclass

STONE = "stone"
CONCRETE = "concrete"
BRICK = "brick"
GLASS = "glass"

HIP = "hip"
FLAT = "flat"


@dataclass(frozen=True)
class Style:
    height: float
    wall: str
    roof: str
    pitch: float = 0.8


KNOWN = {
    "University College": Style(15, STONE, HIP, 0.4),
    "Middlesex College": Style(16, STONE, FLAT),
    "Physics Building": Style(17, STONE, FLAT),
    "Natural Sciences Building": Style(10, STONE, FLAT),
    "Lawson Hall": Style(15, STONE, FLAT),
    "Stevenson Hall": Style(12, CONCRETE, FLAT),
    "Somerville House": Style(11, STONE, FLAT),
    "Thames Hall": Style(12, STONE, FLAT),
    "Talbot College": Style(20, STONE, FLAT),
    "Arts & Humanities": Style(14, STONE, FLAT),
    "International & Graduate Affairs": Style(13, STONE, FLAT),
    "McIntosh Art Gallery": Style(7, STONE, HIP, 0.72),
    "Music Building": Style(20, GLASS, FLAT),
    "Social Science Center": Style(42, CONCRETE, FLAT),
    "Weldon Library": Style(22, CONCRETE, FLAT),
    "University Community Center": Style(14, CONCRETE, FLAT),
    "Western Student Services Building": Style(18, GLASS, FLAT),
    "Ronald D. Schmeichel Building for Entrepreneurship and Innovation": Style(17, GLASS, FLAT),
    "Medical Sciences Building": Style(21, STONE, FLAT),
    "Health Sciences Building": Style(30, BRICK, FLAT),
    "Western Science Centre": Style(16, STONE, FLAT),
    "Biological & Geological Sciences": Style(20, STONE, FLAT),
    "Chemistry Building": Style(20, STONE, FLAT),
    "North Campus Building": Style(18, GLASS, FLAT),
    "Collip Medical Research Building": Style(10, STONE, FLAT),
    "Kresge Building": Style(15, STONE, FLAT),
    "Dental Sciences Building": Style(29, CONCRETE, FLAT),
    "Siebens Centre": Style(12, BRICK, FLAT),
    "Taylor Library": Style(12, STONE, FLAT),
    "Greenhouses": Style(4, GLASS, HIP, 0.45),
    "3M Centre": Style(12, BRICK, FLAT),
    "Alumni Hall": Style(14, STONE, FLAT),
    "Biotron Experimental Climate Change Research Centre": Style(24, GLASS, FLAT),
    "Law School": Style(14, STONE, FLAT),
    "West Valley Building": Style(8, BRICK, FLAT),
    "Delaware Hall (Residence)": Style(18, STONE, FLAT),
    "Staging Building": Style(9, BRICK, FLAT),
    "Power Plant": Style(9, BRICK, FLAT),
    "Material Sciences Addition": Style(19, CONCRETE, FLAT),
    "FIMS & Nursing Building": Style(18, GLASS, FLAT),
    "Dr. Don Rix Clinical Skills Learning Building": Style(13, STONE, FLAT),
    "Health Sciences Addition": Style(25, CONCRETE, FLAT),
}

DEFAULT_LEVEL_METERS = 3.8
DEFAULT_HEIGHT = 12


def style_for(tags):
    name = tags.get("name", "")
    if name in KNOWN:
        return KNOWN[name]
    for key, scale in (("height", 1), ("building:levels", DEFAULT_LEVEL_METERS)):
        try:
            return Style(float(tags[key].split()[0]) * scale, BRICK, FLAT)
        except (KeyError, ValueError, IndexError):
            pass
    if tags.get("building") in ("shelter", "roof", "garage", "shed"):
        return Style(4, CONCRETE, FLAT)
    return Style(DEFAULT_HEIGHT, BRICK, FLAT)


CAMPUS_NAME_CORRECTIONS = {
    (118764109, "Stevenson Hall"): "Lawson Hall",
    (237302165, "Lawson Hall"): "Stevenson Hall",
}


def campus_tags(element):
    tags = element.get("tags", {})
    name = CAMPUS_NAME_CORRECTIONS.get((element["id"], tags.get("name")))
    if name is not None and element["type"] == "way":
        return {**tags, "name": name}
    return tags
