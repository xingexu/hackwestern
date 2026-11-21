import assert from 'node:assert/strict';
import {BoxGeometry,BufferGeometry,Float32BufferAttribute,Group,Mesh,MeshBasicMaterial} from 'three';
import {createBuildingContacts} from '../building-contacts.mjs';
import {spatialIndex} from './audit/spatial.mjs';

const contacts=createBuildingContacts(),root=new Group(),material=new MeshBasicMaterial();
for(const [x,y,z,w,h,d,angle] of [[7,3,8,8,6,4,.63],[15,1,9,.25,2,.36,-.47],[3,5,14,7,.19,6,0]]){
  const mesh=new Mesh(new BoxGeometry(w,h,d),material);
  mesh.position.set(x,y,z);mesh.rotation.y=-angle;root.add(mesh);
  contacts.sink.box(x,y,z,w,h,d,angle);
}
const corners=[[9,0,3],[11,2,6],[12,4,2]];
const geometry=new BufferGeometry();
geometry.setAttribute('position',new Float32BufferAttribute(corners.flat(),3));
root.add(new Mesh(geometry,material));
contacts.sink.face(corners);
contacts.finish();root.updateMatrixWorld(true);
const model=spatialIndex([root],{x:0,z:0},()=>'building');
let hits=0,misses=0;
for(let x=.27;x<18;x+=.51)for(let z=.23;z<18;z+=.57)for(let y=-.33;y<6;y+=.55){
  const r=.13+(x+z)%1.07,h=1.29;
  const expected=Boolean(model.solid(x,y,z,r,h));
  assert.equal(contacts.touches(x,z,y,y+h,r),expected,'Rendered boundary mismatch at '+[x,y,z,r]);
  if(expected)hits++;else misses++;
}
assert.ok(hits>600 && misses>6500);
console.log(hits+' contacts and '+misses+' clear volumes agree with the rendered rotated boxes and sloped triangle');
