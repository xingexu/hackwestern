import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

folder = Path(sys.argv[1])
rows = json.loads((folder / "sample.json").read_text())["rows"]
for start in range(0, len(rows), 12):
    entries = rows[start:start + 12]
    image = Image.new("RGB", (3 * 336, ((len(entries)+2)//3)*184))
    draw = ImageDraw.Draw(image)
    for i, record in enumerate(entries):
        x, y = i%3*336, i//3*184
        for j, view in enumerate((0, int(sys.argv[2]) if len(sys.argv) > 2 else 1)):
            with Image.open(folder / f'{record["id"]}-{view}.png') as src:
                image.paste(src.resize((166,166)), (x+j*168,y))
            cx, cy = x+j*168+83, y+83
            draw.ellipse((cx-3,cy-3,cx+3,cy+3),outline="#ff365b")
        draw.text((x+2,y+166), record["id"],fill="white")
    image.save(folder / f"sheet-{start//12+1}{'-low' if len(sys.argv) > 2 else ''}.jpg",quality=93)
