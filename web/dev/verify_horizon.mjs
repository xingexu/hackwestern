import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import * as THREE from 'three';
import {createDrivingHorizon} from '../driving-horizon.js';
import {campusFootprint,campusCanopyFilter} from '../campus-clip.js';
import {createCarriageway,createLandscapeGrid} from '../campus-terrain.mjs';
import {streetSignPanels} from '../region-detail.js';

const read=name=>JSON.parse(readFileSync(new URL('../'+name+'.json',import.meta.url)));
function decode(text){
  const bytes=inflateSync(Buffer.from(text,'base64'));
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}
const footprint=campusFootprint(read('campus-boundary'));
const world=read('world'),region=read('campus-region'),surface=read('surface-tiles'),core=read('campus-ground');
const coreHeights=new Uint16Array(decode(core.heightMillimeters));
const coreAt=(x,z)=>coreHeights[Math.min(world.depth-1,Math.max(0,Math.floor(z)))*world.width+Math.min(world.width-1,Math.max(0,Math.floor(x)))]*.001;
const streets=createCarriageway(THREE,surface.carriageway,new Uint8Array(decode(surface.carriageway.samples)),region.bounds);
const grid=createLandscapeGrid(region,world,coreAt,surface.relief,new Int16Array(decode(surface.relief.samples)),streets.contains);
const data=read('driving-horizon'),park=createDrivingHorizon(THREE,data,grid);
const pos=park.geometry.attributes.position,joins=new Map();
let area=0;
for(let i=0;i<pos.count;i+=3){
  const a=new THREE.Vector3().fromBufferAttribute(pos,i),b=new THREE.Vector3().fromBufferAttribute(pos,i+1),c=new THREE.Vector3().fromBufferAttribute(pos,i+2);
  const cross=(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  assert.ok(cross<0);
  const x=(a.x+b.x+c.x)/3,z=(a.z+b.z+c.z)/3;
  assert.ok(footprint.contains(x,z),'Park triangle outside Western');
  assert.ok(Math.abs(grid.heightAt(x,z)-(a.y+b.y+c.y)/3)<.002,'Physics diverges from rendered campus ground');
  for(const p of [a,b,c])if(Math.abs(p.z-data.edge)<.001)joins.set(Math.round(p.x*1000),p);
  area-=cross*.5;
}
assert.ok(Math.abs(area-data.area)<.1);
for(const x of grid.xs.filter(x=>footprint.contains(x,data.edge+.001))){
  const at=joins.get(Math.round(Math.fround(x)*1000));
  assert.ok(at&&Math.abs(at.y-grid.heightAt(x,data.edge))<.0002,'Parkland must meet the last campus survey row at '+x);
}
let pixels=0;
const [l,t,r,b]=footprint.textureBounds;
for(let v=2;v<footprint.height-2;v+=5)for(let u=2;u<footprint.width-2;u+=5){
  const x=l+(u+.5)/footprint.width*(r-l),z=t+(v+.5)/footprint.height*(b-t);
  assert.equal(Boolean(footprint.pixels[v*footprint.width+u]),footprint.contains(x,z));
  pixels++;
}
assert.ok(!campusCanopyFilter(footprint,[])(732,15,391,1),'The bridge corridor cannot carry suspended canopy');
const garden=campusFootprint({bounds:[0,0,100,100],polygons:[[[0,0,100,0,100,100,0,100]]]});
const anchored=campusCanopyFilter(garden,[[9,3,40,12]]);
assert.ok(anchored(10,14,40,1));
assert.ok(!anchored(19,14,40,1)&&!anchored(.3,14,40,1)&&!anchored(10,32,40,1));
const signData=read('street-signs'),detail=read('region-detail');
const posts=Object.values(detail.tiles).flatMap(tile=>tile.p??[]).filter(p=>footprint.contains(p[2],p[4])&&['stop','bus_stop'].includes(p[0]));
const signs=streetSignPanels(THREE,posts,signData.records,new THREE.MeshLambertMaterial({vertexColors:true}));
assert.equal(signs.userData.posts.length,posts.length);
assert.ok(signs.geometry.attributes.position.count>posts.length*150);
assert.ok(!signs.material.map&&!signs.geometry.attributes.uv);
console.log(pixels+' campus mask pixels, '+joins.size+' parkland boundary vertices, '+Math.round(area)+' m² of campus-edge terrain and '+posts.length+' authored vector street panels passed.');
