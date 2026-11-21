import assert from 'node:assert/strict';
import * as THREE from 'three';
import {followShadows} from '../look/daylight.mjs';
import {presets,selectQuality} from '../look/quality.mjs';

for(const [preference,mobile,threads,expected] of [
  ['auto',true,12,'low'],['auto',false,4,'medium'],['auto',false,10,'high'],
  ['ultra',true,2,'ultra'],['invalid',false,8,'high']
]) assert.equal(selectQuality(preference,mobile,threads),expected);

const sun=new THREE.DirectionalLight();
const renderer={capabilities:{maxTextureSize:8192},shadowMap:{needsUpdate:false}};
const quality={current:presets.high,onChange(){}};
const update=followShadows(renderer,sun,quality);
function projected(x,z){
  update({x,y:18.8,z},false);
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  sun.shadow.updateMatrices(sun);
  return new THREE.Vector3(14,2,-7).applyMatrix4(sun.shadow.matrix).multiplyScalar(sun.shadow.mapSize.x);
}
const start=projected(122.12,87.34);
for(let frame=0;frame<15;frame++) assert.deepEqual(projected(122.12+frame*.01,87.34),start);
for(let i=1;i<100;i++){
  const delta=projected(122+i*9.7,87+i*2.35).sub(start);
  assert.ok(Math.abs(delta.x-Math.round(delta.x))<1e-8 && Math.abs(delta.y-Math.round(delta.y))<1e-8);
}
console.log('Verified preset overrides, touch defaults and sub-texel shadow stability along 99 camera positions.');
