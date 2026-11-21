const chunkSize = 32;

function cornerLight(first, second, diagonal) {
  return first && second ? 0 : 3 - first - second - diagonal;
}

function appendTriangle(indices, a, b, c, forward) {
  if (forward) indices.push(a, b, c);
  else indices.push(a, c, b);
}

function triangulateSplit(a, b, c, firstEdge, secondEdge, indices, forward) {
  let joint = a;
  for (const vertex of firstEdge) {
    appendTriangle(indices, joint, vertex, c, forward);
    joint = vertex;
  }
  let previous = b;
  for (const vertex of secondEdge) {
    appendTriangle(indices, joint, previous, vertex, forward);
    previous = vertex;
  }
  appendTriangle(indices, joint, previous, c, forward);
}

function joinAttributes(original, extra) {
  const joined = new original.constructor(original.length + extra.length);
  joined.set(original);
  joined.set(extra, original.length);
  return joined;
}

function splitTJunctions(mesh, corners, cornerRow, cornerLayer) {
  const { positions, normals, colors, indices } = mesh;
  const originalCount = positions.length / 3;
  const extraPositions = [];
  const extraNormals = [];
  const extraColors = [];
  const patchedIndices = [];
  const splits = [[], [], [], []];
  const cornerSteps = [1, cornerLayer, cornerRow];

  function splitEdge(first, second, edge) {
    const a = first * 3;
    const b = second * 3;
    const axis = positions[a] !== positions[b] ? 0 : positions[a + 1] !== positions[b + 1] ? 1 : 2;
    const span = positions[b + axis] - positions[a + axis];
    if (Math.abs(span) <= 1) return;
    const sign = Math.sign(span);
    const stride = sign * cornerSteps[axis];
    const start = positions[a] + positions[a + 1] * cornerLayer + positions[a + 2] * cornerRow;
    for (let step = 1; step < Math.abs(span); step++) {
      const corner = start + step * stride;
      if ((corners[corner >> 3] & (1 << (corner & 7))) === 0) continue;
      const offset = step * sign;
      edge.push(originalCount + extraPositions.length / 3);
      extraPositions.push(
        positions[a] + (axis === 0 ? offset : 0),
        positions[a + 1] + (axis === 1 ? offset : 0),
        positions[a + 2] + (axis === 2 ? offset : 0)
      );
      extraNormals.push(normals[a], normals[a + 1], normals[a + 2]);
      extraColors.push(colors[a], colors[a + 1], colors[a + 2]);
    }
  }

  for (let i = 0; i < indices.length; i += 6) {
    const base = i / 6 * 4;
    splitEdge(base, base + 1, splits[0]);
    splitEdge(base + 1, base + 2, splits[1]);
    splitEdge(base + 2, base + 3, splits[2]);
    splitEdge(base + 3, base, splits[3]);
    if (!splits[0].length && !splits[1].length && !splits[2].length && !splits[3].length) {
      patchedIndices.push(indices[i], indices[i + 1], indices[i + 2], indices[i + 3], indices[i + 4], indices[i + 5]);
      continue;
    }

    const diagonal = indices[i] - base;
    const forward = normals[base * 3] > 0 || normals[base * 3 + 1] > 0 || normals[base * 3 + 2] > 0;
    const a = base + diagonal;
    const b = base + ((diagonal + 1) & 3);
    const c = base + ((diagonal + 2) & 3);
    const d = base + ((diagonal + 3) & 3);
    triangulateSplit(a, b, c, splits[diagonal], splits[(diagonal + 1) & 3], patchedIndices, forward);
    triangulateSplit(c, d, a, splits[(diagonal + 2) & 3], splits[(diagonal + 3) & 3], patchedIndices, forward);
    for (const edge of splits) edge.length = 0;
  }

  if (!extraPositions.length) return mesh;
  return {
    type: 'chunk',
    positions: joinAttributes(positions, extraPositions),
    normals: joinAttributes(normals, extraNormals),
    colors: joinAttributes(colors, extraColors),
    indices: (originalCount + extraPositions.length / 3 <= 65536 ? Uint16Array : Uint32Array).from(patchedIndices)
  };
}

function meshWorld(world, voxels) {
  const dimensions = [world.width, world.height, world.depth];
  const strides = [1, world.width * world.depth, world.width];
  const limit = [0, world.height, 0];
  const origin = [0, 0, 0];
  const position = [0, 0, 0];
  const end = dimensions.map(size => size - 1);
  const linearPalette = world.palette.map((color, index) => (index === 0 ? [0, 0, 0] : color).map(channel => {
    const srgb = channel / 255;
    return 255 * (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4);
  }));
  const cornerRow = world.width + 1;
  const cornerLayer = cornerRow * (world.depth + 1);
  const corners = new Uint8Array(Math.ceil(cornerLayer * (world.height + 1) / 8));
  const chunkMeshes = [];

  const solid = (index, u, v, a, b) =>
    a >= 0 && a < dimensions[u] && b >= 0 && b < dimensions[v] && voxels[index] !== 0 ? 1 : 0;

  for (let z = 0; z < world.depth; z += chunkSize) {
    for (let x = 0; x < world.width; x += chunkSize) {
      origin[0] = x;
      origin[2] = z;
      limit[0] = Math.min(x + chunkSize, world.width);
      limit[2] = Math.min(z + chunkSize, world.depth);
      const positions = [];
      const normals = [];
      const colors = [];
      const indices = [];

      for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const width = limit[u] - origin[u];
        const height = limit[v] - origin[v];
        const step = strides[axis];
        const stepU = strides[u];
        const stepV = strides[v];
        const mask = new Int32Array(width * height);

        for (let plane = origin[axis]; plane <= limit[axis]; plane++) {
          let hasFaces = false;
          const hasBefore = plane > origin[axis];
          const hasAfter = plane < limit[axis];
          for (let row = 0; row < height; row++) {
            const b = row + origin[v];
            let index = plane * step + b * stepV + origin[u] * stepU;
            for (let column = 0; column < width; column++, index += stepU) {
              const offset = row * width + column;
              const before = plane > 0 ? voxels[index - step] : 0;
              const after = plane <= end[axis] ? voxels[index] : 0;
              if ((Boolean(before) === Boolean(after)) || (before ? !hasBefore : !hasAfter)) {
                mask[offset] = 0;
                continue;
              }

              const a = column + origin[u];
              const sign = before ? 1 : -1;
              let lighting = 255;
              if (plane > 0 && plane <= end[axis]) {
                const air = before ? index : index - step;
                const left = solid(air - stepU, u, v, a - 1, b);
                const right = solid(air + stepU, u, v, a + 1, b);
                const bottom = solid(air - stepV, u, v, a, b - 1);
                const top = solid(air + stepV, u, v, a, b + 1);
                lighting =
                  cornerLight(left, bottom, solid(air - stepU - stepV, u, v, a - 1, b - 1)) |
                  (cornerLight(right, bottom, solid(air + stepU - stepV, u, v, a + 1, b - 1)) << 2) |
                  (cornerLight(right, top, solid(air + stepU + stepV, u, v, a + 1, b + 1)) << 4) |
                  (cornerLight(left, top, solid(air - stepU + stepV, u, v, a - 1, b + 1)) << 6);
              }
              mask[offset] = sign * (((before || after) << 8) | lighting);
              hasFaces = true;
            }
          }

          if (!hasFaces) continue;
          for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
              const offset = row * width + column;
              const face = mask[offset];
              if (!face) continue;

              const key = Math.abs(face);
              const shades = [key & 3, (key >> 2) & 3, (key >> 4) & 3, (key >> 6) & 3];
              let run = 1;
              let rows = 1;
              if (shades[0] === shades[1] && shades[3] === shades[2]) {
                while (column + run < width && mask[offset + run] === face) run++;
              }
              if (shades[0] === shades[3] && shades[1] === shades[2]) {
                extend: while (row + rows < height) {
                  for (let i = 0; i < run; i++) {
                    if (mask[offset + rows * width + i] !== face) break extend;
                  }
                  rows++;
                }
              }
              for (let i = 0; i < rows; i++) {
                mask.fill(0, offset + i * width, offset + i * width + run);
              }

              const first = positions.length / 3;
              const normal = face > 0 ? 127 : -127;
              const color = linearPalette[key >> 8];
              position[axis] = plane;
              for (let corner = 0; corner < 4; corner++) {
                position[u] = origin[u] + column + (corner === 1 || corner === 2 ? run : 0);
                position[v] = origin[v] + row + (corner >= 2 ? rows : 0);
                positions.push(...position);
                const vertex = position[0] + position[1] * cornerLayer + position[2] * cornerRow;
                corners[vertex >> 3] |= 1 << (vertex & 7);
                normals.push(axis === 0 ? normal : 0, axis === 1 ? normal : 0, axis === 2 ? normal : 0);
                const light = 0.70 + shades[corner] * 0.10;
                colors.push(Math.round(color[0] * light), Math.round(color[1] * light), Math.round(color[2] * light));
              }

              const flip = shades[0] + shades[2] > shades[1] + shades[3];
              const a = first + (flip ? 1 : 0);
              const b = first + (flip ? 2 : 1);
              const c = first + (flip ? 3 : 2);
              const d = first + (flip ? 0 : 3);
              appendTriangle(indices, a, b, c, face > 0);
              appendTriangle(indices, a, c, d, face > 0);
            }
          }
        }
      }

      if (!indices.length) continue;
      chunkMeshes.push({
        type: 'chunk',
        positions: Int16Array.from(positions),
        normals: Int8Array.from(normals),
        colors: Uint8Array.from(colors),
        indices: (positions.length / 3 <= 65536 ? Uint16Array : Uint32Array).from(indices)
      });
    }
  }

  let triangles = 0;
  for (const chunk of chunkMeshes) {
    const mesh = splitTJunctions(chunk, corners, cornerRow, cornerLayer);
    triangles += mesh.indices.length / 3;
    self.postMessage(mesh, [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer]);
  }
  self.postMessage({ type: 'done', chunks: chunkMeshes.length, triangles });
}

self.onmessage = ({ data }) => {
  try {
    if(data.world.unifiedBuildings){self.postMessage({type:"done",chunks:0,triangles:0});return;}
    meshWorld(data.world, new Uint8Array(data.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
