import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from orthos import reference
from grid import ROOT

POLYGONS = json.loads((ROOT / "web/campus-boundary.json").read_text())["polygons"]


def font(size):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", size)
    except OSError:
        return ImageFont.load_default(size=size)


def sheet(folder):
    metrics = json.loads((folder / "metrics.json").read_text())
    cell = metrics["cell"]
    x, z = cell["x"], cell["z"]
    views = folder / "views"
    available = {p["name"] for p in metrics["views"]}
    for kind in ("eye", "chase"):
        for direction in "NESW":
            name = f"{kind}-{direction}"
            if name not in available:
                (views / (name + ".png")).unlink(missing_ok=True)
    reference(x, z).save(views / "city-2025.png")
    canvas = Image.new("RGB", (2000, 3170), "#172021")
    draw = ImageDraw.Draw(canvas)
    draw.text((15, 8), f'{cell["id"]}   East {x} to {x+50} m   South {z} to {z+50} m   Campus area {cell["area"]:.2f} m²', font=font(27))
    slots = [("top", 0, 50), ("city-2025", 1000, 50), ("oblique-nw", 0, 1090), ("oblique-se", 500, 1090)]
    for j, height in enumerate(("eye", "chase")):
        for i, direction in enumerate("NESW"):
            slots.append((f"{height}-{direction}", i*500, 1480+j*320))
    slots.extend([("ground", 0, 2140), ("top", 1000, 2140)])
    campus = Image.new("L", (1000,1000))
    mask = ImageDraw.Draw(campus)
    for rings in POLYGONS:
        for i, ring in enumerate(rings):
            points = [((px-x)*20,(pz-z)*20) for px,pz in zip(ring[::2],ring[1::2])]
            mask.polygon(points, fill=255 if i==0 else 0)
    for name, left, top in slots:
        path = views / (name + ".png")
        if path.exists():
            with Image.open(path) as view:
                if name == "city-2025":
                    canvas.paste(view, (left, top), campus)
                else:
                    canvas.paste(view, (left, top))
            title = {"top":"GAME   North ↑   20 px/m", "city-2025":"CITY OF LONDON   2025   North ↑   10 px/m source"}.get(name, name)
            if top==2140:
                title = "Campus parcel ground only · outside parcel omitted" if left==0 else "Automated findings · see original top.png for an unobstructed view"
            draw.rectangle((left, top, left+draw.textlength(title, font=font(16))+14, top+22), fill="#172021")
            draw.text((left+6,top+2), title, font=font(16))
    colors = {"critical":"#ff2170", "high":"#ff7300", "medium":"#00b7ff", "low":"#b7ff70"}
    marker = Image.new("RGBA", (1000,1000))
    pen = ImageDraw.Draw(marker)
    for finding in metrics["findings"]:
        u = (finding["x"]-x)*20
        v = (finding["z"]-z)*20
        pen.ellipse((u-2,v-2,u+2,v+2), fill=colors[finding["severity"]])
    canvas.paste(marker,(1000,2140),marker)
    draw.line((16,1066,216,1066), fill="white", width=4)
    draw.text((225,1055),"10 m",font=font(18))
    draw.text((1030,1090), "Automated findings", font=font(26))
    for i,(name,count) in enumerate(sorted(metrics["counts"].items())):
        draw.text((1030+(i//9)*470,1130+(i%9)*31),f"{name}    {count:,}",font=font(20))
    for i,(name,color) in enumerate(colors.items()):
        draw.text((1030+i*195,1432), name, fill=color,font=font(20))
    if not metrics.get("anchor"):
        draw.text((16,1500),"No accessible street-view anchor sampled in this cell",font=font(24))
    canvas.save(folder / "composite.jpg", quality=91, subsampling=0)


if __name__ == "__main__":
    for line in sys.stdin:
        sheet(Path(json.loads(line)))
        print("ok", flush=True)
