import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../mesh-worker.js', import.meta.url), 'utf8');
const palette = [[0, 0, 0], [140, 160, 170], [160, 160, 170]];

function mesh(width, height, depth, occupied) {
  const volume = new Uint8Array(width * height * depth);
  for (const [x, y, z, color = 1] of occupied) volume[(y * depth + z) * width + x] = color;
  const messages = [];
  const self = { postMessage: message => messages.push(message) };
  runInNewContext(source, { self });
  self.onmessage({ data: { world: { width, height, depth, palette }, buffer: volume.buffer } });
  const stats = messages.pop();
  assert.equal(stats.type, 'done', stats.message);
  return { stats, chunks: messages };
}

function quads(chunk, axis, plane, direction) {
  const matching = [];
  for (let i = 0; i < chunk.positions.length; i += 12) {
    if (chunk.normals[i + axis] !== direction || chunk.positions[i + axis] !== plane) continue;
    const first = i / 3;
    const winding = [];
    for (let j = 0; j < chunk.indices.length; j += 3) {
      const triangle = chunk.indices.slice(j, j + 3);
      if (triangle.every(vertex => vertex >= first && vertex < first + 4)) {
        winding.push(...Array.from(triangle, vertex => vertex - first));
      }
    }
    matching.push({
      positions: Array.from(chunk.positions.slice(i, i + 12)),
      colors: Array.from(chunk.colors.slice(i, i + 12)),
      winding
    });
  }
  return matching;
}

const uniform = mesh(4, 3, 3, [[1, 1, 1], [2, 1, 1]]);
assert.equal(uniform.stats.triangles, 12);
assert.equal(mesh(4, 3, 3, [[1, 1, 1], [2, 1, 1, 2]]).stats.triangles, 20);

const boundary = mesh(34, 3, 3, [[31, 1, 1], [32, 1, 1]]);
assert.equal(boundary.stats.chunks, 2);
assert.equal(boundary.stats.triangles, 20);
assert.equal(quads(boundary.chunks[0], 0, 32, 127).length, 0);
assert.equal(quads(boundary.chunks[1], 0, 32, -127).length, 0);

const occlusion = mesh(4, 4, 4, [[1, 1, 1], [1, 1, 2], [2, 2, 0]]);
const top = quads(occlusion.chunks[0], 0, 2, 127);
assert.equal(top.length, 2);
const occluded = top.find(quad => quad.positions[2] === 1);
assert.ok(occluded.colors[3] < occluded.colors[0]);
assert.deepEqual(occluded.winding, [1, 2, 3, 1, 3, 0]);

const junction = mesh(34, 3, 4, [
  [31, 1, 1], [31, 1, 2], [32, 1, 1], [32, 1, 2, 2]
]);
const split = junction.chunks[0];
const vertices = [...split.indices].filter(vertex => {
  const i = vertex * 3;
  return split.positions[i] === 32 && split.positions[i + 1] === 2 &&
    split.positions[i + 2] === 2 && split.normals[i + 1] === 127;
});
assert.ok(vertices.length > 0, 'The larger surface must reach the neighboring chunk’s mid-edge vertex.');

const air = mesh(1, 1, 1, []);
assert.equal(air.stats.triangles, 0);
assert.equal(air.stats.chunks, 0);

console.log('Verified same-color merging, color boundaries, cross-chunk culling and aligned edges, AO and diagonal flipping, and empty worlds.');
