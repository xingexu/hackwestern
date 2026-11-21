import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {compileFunction} from 'node:vm';
import {inflateSync,deflateSync} from 'node:zlib';
import {removeGround,removeFoliage,recessVoxelWalls} from '../web/core-volume.mjs';
import {encodeChunks} from '../web/scene-pack.mjs';

export async function bakeMesh(web,world,ground,trees){
  if(world.driveCourse)return {source:deflateSync(encodeChunks([])),triangles:0,chunks:0};
  const [packed,worker,detail]=await Promise.all([readFile(join(web,'world.bin')),readFile(join(web,'mesh-worker.js'),'utf8'),readFile(join(web,'region-detail.json'),'utf8')]);
  const voxels=Uint8Array.from(inflateSync(packed));
  removeGround(voxels.buffer,inflateSync(Buffer.from(ground.cut,'base64')));
  removeFoliage(voxels.buffer,inflateSync(Buffer.from(trees.cells,'base64')));
  recessVoxelWalls(voxels.buffer,world,JSON.parse(detail).architecture.core);
  const chunks=[];
  let triangles=0;
  const self={postMessage(msg){
    if(msg.type==='chunk') chunks.push(msg);
    else if(msg.type==='done') triangles=msg.triangles;
    else throw new Error(msg.message);
  }};
  compileFunction(worker,['self'])(self);
  self.onmessage({data:{world,buffer:voxels.buffer}});
  if(!triangles||!chunks.length) throw new Error('Empty core building model.');
  return {source:deflateSync(encodeChunks(chunks),{level:7}),triangles,chunks:chunks.length};
}
