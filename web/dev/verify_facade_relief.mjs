import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import {modelFacadeTile} from '../streetview-facades.js';

const dataset=JSON.parse(fs.readFileSync(new URL('../streetview-facades.json',import.meta.url)));
const architecture=JSON.parse(fs.readFileSync(new URL('../region-detail.json',import.meta.url))).architecture;
assert.ok(!('image' in architecture.atlas) && architecture.atlas.forms.every(f=>Number.isInteger(f.wall)&&Number.isInteger(f.glass)));
const details={};
let observedWindows=0,observedRecesses=0;
for(const tile of dataset.tiles){
  assert.ok(!('image' in tile));
  const mesh=modelFacadeTile(tile);
  assert.equal(mesh.material.map,null);
  assert.equal(mesh.material.emissiveMap,null);
  assert.equal(mesh.geometry.getAttribute('uv'),undefined);
  assert.ok(mesh.geometry.index.count>0 && Number.isFinite(mesh.geometry.boundingSphere.radius));
  for(const [kind,count] of Object.entries(mesh.userData.details)) details[kind]=(details[kind]??0)+count;
  for(const panel of tile.panels){
    const feature=panel[10].find(f=>f.kind==='window' && f.w>.045 && f.h>.09);
    if(!feature) continue;
    const [ax,az,bx,bz,base,top,nx,nz]=panel,u=feature.u-feature.w*.16,v=feature.v-feature.h*.06;
    const origin=new THREE.Vector3(ax+(bx-ax)*u+nx,base+(top-base)*v,az+(bz-az)*u+nz);
    const sight=new THREE.Raycaster(origin,new THREE.Vector3(-nx,0,-nz).normalize(),.05,1.1);
    const hit=sight.intersectObject(mesh)[0];
    observedWindows++;
    if(hit && hit.distance>.90 && hit.distance<.98) observedRecesses++;
    if(observedWindows%3===0) break;
  }
  mesh.geometry.dispose();mesh.material.dispose();
}
assert.ok(details.window>50 && details.door>4 && details.band>8);
assert.ok(observedWindows>=20 && observedRecesses>observedWindows*.45,'Actual reconstructed window panes should sit visibly behind the walls');
const wall={kind:'wall',u:.5,v:.5,w:1,h:1,color:0x927056};
const window={kind:'window',u:.5,v:.5,w:.5,h:.5,color:0x537489};
const door={kind:'door',u:.12,v:.2,w:.15,h:.4,color:0x705948};
const mesh=modelFacadeTile({x:0,z:0,panels:[[0,0,8,0,2,7,0,1,1,'a',[wall,window,door]]]});
const ray=new THREE.Raycaster();
function depth(x,y){
  ray.set(new THREE.Vector3(x,y,2),new THREE.Vector3(0,0,-1));
  const hit=ray.intersectObject(mesh)[0];
  assert.ok(hit);return hit.point.z;
}
assert.ok(depth(.96,3.35)<.08 && depth(3.42,4.1)<.08);
assert.ok(depth(6.7,5)>.19);
assert.ok(depth(3.42,3.24)>.28);
ray.set(new THREE.Vector3(1.4,4.20,1.4),new THREE.Vector3(.5,0,-1).normalize());
const oblique=ray.intersectObject(mesh);
assert.ok(oblique.some(hit=>Math.abs(hit.face.normal.x)>.7),'Window jamb must have a side face from an oblique viewpoint');
console.log('No wall image maps in published materials, recessed glazing and doors, raised sills and oblique jamb parallax',details,{observedWindows,observedRecesses});

const fragment={...window,u:.5,v:.496,w:.052,h:.13},strong={...window,w:.082,h:.30}
const partial=modelFacadeTile({x:0,z:0,panels:[[0,0,12,0,0,6,0,1,1,'a',[
  wall,{...strong,u:.21,v:.53},{...strong,u:.77,v:.53},fragment
]]]});
ray.set(new THREE.Vector3(6.15,3.77,2),new THREE.Vector3(0,0,-1));
assert.ok(ray.intersectObject(partial)[0].point.z<.09,'Two neighboring complete windows establish the height of a partially observed opening');
