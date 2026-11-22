import base64
import io
import json
import sys
import zlib

import numpy as np
from PIL import Image


def encode(pixels):
    height, width, channels = pixels.shape
    if channels == 1:
        image = pixels[:, :, 0]
    else:
        rows = pixels.transpose(2, 0, 1).reshape(-1, width)
        rows = np.pad(rows, ((0, -len(rows) % 3), (0, 0)), mode='edge')
        image = rows.reshape(-1, 3, width).transpose(0, 2, 1)
    stream = io.BytesIO()
    Image.fromarray(image).save(stream, 'WEBP', lossless=True, method=4)
    return stream.getvalue()


width, height, tile_size = map(int, sys.argv[1:])
pixels = np.frombuffer(zlib.decompress(sys.stdin.buffer.read()), dtype=np.uint8).reshape(height, width, -1)
if tile_size:
    overview_size = ((width + 7) // 8, (height + 7) // 8)
    overview = np.stack([np.asarray(Image.fromarray(channel).resize(overview_size, Image.Resampling.BOX))
                         for channel in pixels.transpose(2, 0, 1)], axis=2)
    tiles = [encode(pixels[y:y + tile_size, x:x + tile_size]) for y in range(0, height, tile_size)
             for x in range(0, width, tile_size)]
    json.dump([base64.b64encode(image).decode('ascii') for image in [encode(overview), *tiles]], sys.stdout)
else:
    sys.stdout.buffer.write(encode(pixels))
