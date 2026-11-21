import assert from 'node:assert/strict';
import {encodeChunks,decodeChunks} from '../scene-pack.mjs';

const chunks=[Uint16Array,Uint32Array].map(Index=>({
  positions:new Int16Array([-1156,25,636,1530,36,-1090,45,70,995,45,69,995]),
  normals:new Int8Array([127,0,0,-127,0,0,0,127,0,0,0,-127]),
  colors:new Uint8Array([255,3,120,0,233,205,199,142,7,199,142,8]),
  indices:new Index([0,1,2,2,1,3])
}));
const original=structuredClone(chunks);
const wire=encodeChunks(chunks);
assert.deepEqual(chunks,original);
assert.deepEqual(decodeChunks(wire.buffer.slice(0)),original);
assert.throws(()=>decodeChunks(wire.buffer.slice(0,-3)));
console.log('Both index widths and every position, normal and colour survived compact mesh encoding unchanged.');

const {recessVoxelWalls}=await import('../core-volume.mjs');
const wallGrid={width:11,height:12,depth:11},raw=new Uint8Array(11*12*11).fill(7);
const cell=(x,y,z)=>raw[x+z*11+y*121];
recessVoxelWalls(raw.buffer,wallGrid,[['concrete',2,[[2,4.4,8,4.4,9,0,1]],'courtyard']]);
assert.equal(cell(4,5,4),0);
assert.equal(cell(4,5,3),7);
assert.equal(cell(4,9,4),7);
assert.equal(cell(0,5,4),7);
console.log('Voxel wall faces yield to surveyed frontages up to the eave, preserving roof, interior and uncovered edges.');
const {readFileSync}=await import('node:fs');
const {inflateSync}=await import('node:zlib');
const read=name=>readFileSync(new URL('../'+name,import.meta.url));
const surveyed=JSON.parse(read('region-detail.json')).architecture.core;
const dimensions=JSON.parse(read('world.json')),originalVolume=Uint8Array.from(inflateSync(read('world.bin')));
const uc=surveyed.find(([, , ,name])=>name==='University College');
const shots=[];
for(const [ax,az,bx,bz,top,nx,nz] of uc[2]) for(const fraction of [.25,.5,.75]) for(const vertical of [.25,.5,.75]){
  const x=Math.floor(ax+(bx-ax)*fraction+nx*.055),z=Math.floor(az+(bz-az)*fraction+nz*.055);
  const y=Math.floor(uc[1]+(top-uc[1])*vertical);
  shots.push(x+z*dimensions.width+y*dimensions.width*dimensions.depth);
}
const before=shots.filter(idx=>originalVolume[idx]).length;
recessVoxelWalls(originalVolume.buffer,dimensions,surveyed);
const after=shots.filter(idx=>originalVolume[idx]).length;
assert.ok(before>10 && after<before*.12,'Actual University College frontage samples must clear the legacy voxel shell');
console.log(`University College plaster in front of surveyed facade at ${before} of ${shots.length} sample rays before, ${after} after.`);
