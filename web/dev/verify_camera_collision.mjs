import {groundObstacles} from '../ground-obstacles.mjs';
import assert from 'node:assert/strict';
import {BoxGeometry,BufferAttribute,InstancedBufferAttribute,InstancedBufferGeometry,Sphere,Group,InstancedMesh,Matrix4,Mesh,MeshStandardMaterial,PerspectiveCamera,Vector3} from 'three';
import {createCameraRig} from '../frame-pacing.mjs';
import {cameraGeometry} from '../look/camera-collision.mjs';
import {createCameraPlacement,nearPlaneClearance} from '../look/drive-camera.mjs';

const world=new Group(),solid=new MeshStandardMaterial(),collision=cameraGeometry([world]);
const pose={x:0,y:0,z:0,pitch:0,heading:0,bodyPitch:0,roll:0};
const network={groundAt:()=>0,solidAt:()=>false,chaseDistance:()=>6.45};
const camera=new PerspectiveCamera(55,16/10,.12,870),radius=nearPlaneClearance(camera);
assert.ok(radius>camera.near && nearPlaneClearance(new PerspectiveCamera(55,3,.12,870))>radius);
const eye=new Vector3(),origin=new Vector3(0,1.8,0),end=new Vector3(0,2.85,-6.45);
const pole=new InstancedMesh(new BoxGeometry(.04,4,.04),solid,1);
pole.setMatrixAt(0,new Matrix4().makeTranslation(radius+.009,2,-2.43));
assert.equal(collision.sweep(origin,end,radius),1);
world.add(pole);
assert.ok(collision.sweep(origin,end,radius)<.38);
assert.equal(collision.sweep(origin,end,0),1);
world.remove(pole);
assert.equal(collision.sweep(origin,end,radius),1);

const wall=new Mesh(new BoxGeometry(8,6,.037),solid);
wall.position.set(5,2,-3);
world.add(wall);
for(const hz of [30,60,120]){
  const rig=createCameraRig(),placement=createCameraPlacement(collision,network,rig);
  pose.x=-5;
  rig.reset(pose);
  let previous=6.45,maxPull=0,early=false;
  for(let i=0;i<=4*hz;i++){
    pose.x=-5+4*i/hz;
    const view=rig.update(pose,1/hz);
    placement.chase(eye,pose,view,1/hz,radius);
    const arm=-eye.z;
    assert.equal(collision.sweep(eye,eye,radius),1);
    if(pose.x>.99-radius && pose.x<9) assert.ok(arm<3);
    if(pose.x<1-radius && arm<6.35) early=true;
    maxPull=Math.max(maxPull,previous-arm);
    previous=arm;
  }
  assert.ok(early && maxPull<19/hz,'Predict a lateral obstacle and retract continuously at '+hz+' Hz: '+maxPull);
  for(let i=0;i<2*hz;i++) placement.chase(eye,pose,rig.update(pose,1/hz),1/hz,radius);
  assert.ok(-eye.z>6.449);
}
world.remove(wall);

const jamb=new Mesh(new BoxGeometry(.05,2,.8),solid);
jamb.position.set(.31,1.15,-.15);
world.add(jamb);
pose.x=0;
const rig=createCameraRig(),placement=createCameraPlacement(collision,network,rig);
rig.reset(pose);
const driverPose=Object.freeze({...pose});
for(let i=0;i<90;i++){
  eye.set(.34,1.182,-.19);
  placement.driver(eye,driverPose,rig.update(driverPose,1/60),radius);
  assert.ok(eye.x>=0 && eye.x<.31-radius);
  assert.equal(collision.sweep(eye,eye,radius),1);
}
world.remove(jamb);

const slope=new Mesh(new BoxGeometry(12,.08,10),solid);
slope.rotation.x=.5;
slope.position.set(0,2.3,-4.5);
world.add(slope);
assert.ok(collision.sweep(origin,end,radius)<1);
world.remove(slope);

const shell=new Mesh(new BoxGeometry(24,20,24),solid);
shell.position.y=10;
world.add(shell);
const enclosed={...network,solidAt:(x,z,y,r,h)=>Math.abs(x)<12+r && Math.abs(z)<12+r && y<20 && y+h>0};
const respawn=createCameraPlacement(collision,enclosed,rig);
respawn.chase(eye,driverPose,rig.update(driverPose,0),0,radius);
assert.ok(eye.y-radius>20);
console.log('Verified continuous sweeps through an off-axis instanced post, a sloped surface and a cockpit jamb, plus anticipatory retraction and steady recovery at 30/60/120 Hz.');

const crown=new InstancedBufferGeometry();
crown.setAttribute('position',new BufferAttribute(new Float32Array(9),3));
crown.setAttribute('crownCenter',new InstancedBufferAttribute(new Float32Array([0,2,-3]),3));
crown.setAttribute('crownRadius',new InstancedBufferAttribute(new Float32Array([1]),1));
crown.instanceCount=1;
crown.boundingSphere=new Sphere(new Vector3(0,2,-3),2);
const grove=new Group();
grove.add(new Mesh(crown,new MeshStandardMaterial({alphaTest:.38})));
const inLeaves=cameraGeometry([grove]);
assert.ok(inLeaves.sweep(origin,end,radius)<.4);
const inside=new Vector3(0,2,-3);
assert.equal(inLeaves.sweep(inside,inside,radius),0);
assert.equal(inLeaves.sweep(new Vector3(2,2,0),new Vector3(2,2,-6),radius),1);

const municipalProps=groundObstacles();
const mast=new Matrix4().makeRotationZ(.07).scale(new Vector3(.19,6.1,.19)).setPosition(13,3.05,-7);
municipalProps.addBox(mast.elements,'signal mast');
assert.equal(municipalProps.contact(13,-7,3.01,.01,.08)?.owner,'signal mast');
assert.equal(municipalProps.contact(13.24,-7,3.01,.01,.08),undefined);
