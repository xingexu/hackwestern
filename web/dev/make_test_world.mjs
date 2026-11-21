import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const output = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./test-world/', import.meta.url));
const width = 635;
const depth = 557;
const height = 96;
const layer = width * depth;
const voxels = new Uint8Array(layer * height);
const ground = new Uint8Array(layer);
const palette = [
  [0, 0, 0], [99, 117, 82], [123, 140, 91], [134, 150, 100],
  [105, 125, 85], [115, 135, 89], [113, 97, 76], [140, 121, 94],
  [80, 131, 133], [107, 119, 113], [167, 159, 136], [199, 191, 156],
  [170, 164, 143], [96, 109, 106], [76, 89, 89], [187, 171, 142],
  [153, 118, 93], [63, 78, 74], [220, 209, 172], [125, 103, 77],
  [70, 104, 68], [87, 122, 72], [105, 131, 76], [112, 139, 85],
  [90, 111, 77], [104, 123, 83], [149, 156, 99], [146, 154, 121],
  [170, 153, 128], [107, 128, 119], [204, 190, 158], [91, 90, 74]
];
const labels = [];
let seed = 7823721;

function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}

function riverCenter(z) {
  return 511 + Math.sin(z / 60) * 31 + Math.sin(0.7 + z / 136) * 25;
}

function riverHalfWidth(z) {
  return 15 + 4 * Math.sin(z / 64);
}

function set(x, y, z, material) {
  if (x >= 0 && x < width && y >= 0 && y < height && z >= 0 && z < depth) {
    voxels[y * layer + z * width + x] = material;
  }
}

function box(x, y, z, w, h, d, material) {
  for (let row = z; row < z + d; row++) {
    for (let floor = y; floor < y + h; floor++) {
      voxels.fill(material, floor * layer + row * width + x, floor * layer + row * width + x + w);
    }
  }
}

function hill(x, z, cx, cz, radius, elevation) {
  return elevation * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / radius ** 2);
}

function terrain(x, z) {
  const riverDistance = Math.abs(x - riverCenter(z)) - riverHalfWidth(z);
  const elevation = 15 + hill(x, z, 150, 125, 143, 9) + hill(x, z, 330, 300, 160, 6) +
    hill(x, z, 580, 360, 84, 8) + 0.9 * Math.sin(x / 31 + z / 71) + Math.sin(z / 46);
  const bank = Math.max(0, Math.min(1, riverDistance / 21));
  return Math.floor(10 + (elevation - 10) * bank);
}

function segmentDistance(x, z, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const along = Math.max(0, Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - start[0] - along * dx, z - start[1] - along * dz);
}

const roads = [
  [65, [6, 307], [128, 287], [164, 274], [244, 267], [353, 258], [437, 258], [635, 271]],
  [58, [227, 0], [215, 129], [203, 180], [159, 233], [164, 274], [174, 340], [206, 403], [229, 557]],
  [49, [353, 258], [357, 324], [375, 410], [429, 500], [445, 557]],
  [48, [159, 233], [96, 198], [26, 182], [0, 185]],
  [28, [203, 180], [284, 192], [327, 212], [353, 258]],
  [27, [174, 340], [243, 353], [308, 348], [357, 324]],
  [19, [203, 180], [242, 125], [320, 128], [367, 170], [397, 223], [437, 258]],
  [22, [206, 403], [283, 408], [375, 410]]
];

const paths = roads.flatMap(([size, ...points]) => points.slice(1).map((end, i) => [size / 10, points[i], end]));

for (let z = 0; z < depth; z++) {
  for (let x = 0; x < width; x++) {
    const index = z * width + x;
    const riverDistance = Math.abs(x - riverCenter(z)) - riverHalfWidth(z);
    const elevation = terrain(x, z);
    ground[index] = elevation;
    let surface = 2;
    const foliage = Math.sin(x / 58 + z / 71) + 0.55 * Math.cos(z / 36 - x / 63) + 0.30 * Math.sin((x + z) / 18);
    if (foliage < -0.53) surface = 4;
    else if (foliage < -0.12) surface = 5;
    else if (foliage > 0.68) surface = 3;
    if (riverDistance < 0) surface = 8;
    else if (riverDistance < 3.5) surface = 7;
    if (riverDistance >= 0 && paths.some(([size, start, end]) => segmentDistance(x, z, start, end) < size)) {
      surface = 10;
      if (paths.some(([size, start, end]) => size >= 4.8 && segmentDistance(x, z, start, end) < size - 1.5)) surface = 9;
    }

    for (let y = 0; y < elevation; y++) voxels[y * layer + index] = y > elevation - 4 ? 7 : 6;
    voxels[elevation * layer + index] = surface;
  }
}

function building(name, x, z, w, d, stories, wall, roof, hip = true) {
  const centerX = x + Math.floor(w / 2);
  const centerZ = z + Math.floor(d / 2);
  const y = ground[centerZ * width + centerX];
  const top = y + stories;
  const rise = hip ? Math.round(Math.min(w, d) * 0.27) : 3;
  box(x, y - 4, z, w, stories + 4, d, wall);
  box(x, y, z, w, 2, d, wall === 16 ? 28 : 12);
  box(x - 1, top - 1, z - 1, w + 2, 2, d + 2, wall === 16 ? 28 : 18);
  for (let level = 0; level < rise; level++) {
    const inset = hip ? Math.floor(level * 1.46) : 0;
    box(x + inset, top + level, z + inset, w - inset * 2, 1, d - inset * 2, roof);
  }
  for (let floor = y + 4; floor <= top - 4; floor += 6) {
    for (let along = 4; along < w - 3; along += 6) {
      for (let windowY = 0; windowY < 3; windowY++) {
        set(x + along, floor + windowY, z, 17);
        set(x + along + 1, floor + windowY, z, 17);
        set(x + along, floor + windowY, z + d - 1, 17);
        set(x + along + 1, floor + windowY, z + d - 1, 17);
      }
    }
    for (let along = 4; along < d - 3; along += 6) {
      for (let windowY = 0; windowY < 3; windowY++) {
        set(x, floor + windowY, z + along, 17);
        set(x, floor + windowY, z + along + 1, 17);
        set(x + w - 1, floor + windowY, z + along, 17);
        set(x + w - 1, floor + windowY, z + along + 1, 17);
      }
    }
  }
  if (name) labels.push({ name, x: centerX, y: top + rise, z: centerZ });
  return { y, top, rise };
}

building('University College', 254, 222, 69, 25, 27, 11, 13);
building(null, 254, 195, 22, 29, 24, 11, 13);
building(null, 301, 198, 22, 26, 24, 11, 13);
const tower = building(null, 280, 213, 17, 19, 56, 15, 14, false);
box(279, tower.top - 6, 212, 19, 2, 21, 18);
box(279, tower.top + 1, 212, 19, 2, 21, 18);
for (let x = 279; x <= 296; x += 4) {
  box(x, tower.top + 3, 212, 2, 3, 2, 11);
  box(x, tower.top + 3, 231, 2, 3, 2, 11);
}
for (let z = 215; z <= 229; z += 4) {
  box(279, tower.top + 3, z, 2, 3, 2, 11);
  box(296, tower.top + 3, z, 2, 3, 2, 11);
}
labels[0].y = tower.top + 6;
building('Middlesex College', 328, 146, 34, 44, 22, 11, 14);
building(null, 347, 147, 13, 15, 38, 11, 14);
building('Talbot College', 245, 153, 35, 28, 19, 15, 13);
building('Lawson Hall', 283, 140, 34, 26, 16, 11, 14);
building('Alumni Hall', 250, 286, 59, 38, 17, 12, 29, false);
building('McIntosh Gallery', 303, 327, 34, 17, 13, 16, 14);
building('Weldon Library', 190, 284, 53, 47, 25, 12, 29, false);
building('Social Science Centre', 110, 296, 47, 39, 30, 28, 13, false);
building('Somerville House', 342, 270, 38, 26, 14, 11, 14);
building('Stevenson Hall', 373, 197, 32, 27, 16, 15, 13);
building('Physics and Astronomy', 195, 218, 43, 34, 18, 11, 13);
building('Medical Sciences', 87, 216, 47, 44, 24, 16, 29, false);
building('Taylor Library', 34, 223, 40, 31, 18, 28, 13, false);
building('Biological and Geological Sciences', 75, 143, 78, 36, 20, 11, 29, false);
building('Kresge Building', 103, 95, 39, 35, 16, 16, 14);
building('International and Graduate Affairs', 169, 112, 34, 27, 19, 15, 13);
building('Thames Hall', 237, 368, 46, 25, 17, 15, 13);
building('Spencer Engineering', 306, 370, 43, 26, 21, 16, 14);
building('Brescia Hall', 80, 376, 54, 29, 24, 11, 13);
building(null, 102, 401, 20, 17, 18, 11, 13);
building('Althouse Faculty of Education', 265, 450, 59, 35, 22, 16, 13, false);
building('Health Sciences', 389, 320, 35, 50, 20, 15, 14);
building('Huron University', 127, 437, 46, 38, 18, 11, 14);

box(451, 22, 257, 146, 3, 12, 12);
box(451, 25, 258, 146, 1, 10, 9);
box(451, 25, 257, 146, 1, 1, 18);
box(451, 25, 268, 146, 1, 1, 18);
for (const x of [465, 494, 525, 556, 585]) box(x, 10, 259, 5, 12, 8, 12);

function tree(x, z, radius, trunk, foliage) {
  const y = ground[z * width + x];
  for (let h = 1; h <= trunk; h++) set(x, y + h, z, 19);
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const distance = dx * dx + dz * dz + dy * dy * 0.72;
        if (distance > radius * radius * (0.78 + random() * 0.34)) continue;
        set(x + dx, y + trunk + dy, z + dz, dy > radius * 0.65 ? foliage + 1 : foliage);
      }
    }
  }
}

for (let i = 0; i < 2500; i++) {
  const x = 5 + Math.floor(random() * (width - 10));
  const z = 5 + Math.floor(random() * (depth - 10));
  const y = ground[z * width + x];
  const riverDistance = Math.abs(x - riverCenter(z));
  const central = x > 98 && x < 434 && z > 118 && z < 403;
  const openField = (x > 205 && x < 427 && z > 14 && z < 116) || (x > 362 && x < 435 && z > 445);
  const density = central || openField ? 0.09 : riverDistance < 84 ? 0.74 : 0.44;
  if (random() > density || riverDistance < 21 || paths.some(([size, start, end]) => segmentDistance(x, z, start, end) < size + 4)) continue;
  const radius = 2 + Math.floor(random() * 4);
  let clear = true;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const index = (z + dz) * width + x + dx;
      if (voxels[(ground[index] + 2) * layer + index]) clear = false;
    }
  }
  if (clear) tree(x, z, radius, radius + 4 + Math.floor(random() * 5), 20 + 2 * Math.floor(random() * 3));
}

await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, 'world.json'), JSON.stringify({ width, height, depth, voxelMeters: 1, palette, labels })),
  writeFile(resolve(output, 'world.bin'), deflateSync(voxels))
]);
console.log(`Generated ${width} × ${height} × ${depth} test world in ${output}`);
