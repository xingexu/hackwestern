import assert from 'node:assert/strict';
import {adaptiveResolution,createCameraRig,interpolatePose,snapshotPose} from '../frame-pacing.mjs';

const from={x:12,y:3,z:4,pitch:.1,roll:0,bodyPitch:0,heading:Math.PI-.05};
const to={...from,x:14,heading:-Math.PI+.05};
const pose=interpolatePose({},snapshotPose({},from),to,.5);
assert.equal(pose.x,13);
assert.ok(Math.abs(pose.heading-Math.PI)<.0001);
const quality=adaptiveResolution();
for(let i=0;i<80;i++) assert.equal(quality.sample(1/60),1);
assert.equal(quality.sample(.8),1);
let scale;
for(let i=0;i<500;i++) scale=quality.sample(1/34);
assert.equal(scale,.65);
for(let i=0;i<3000;i++) scale=quality.sample(1/62);
assert.equal(scale,1);
const slowDevice=adaptiveResolution();
for(let i=0;i<100;i++) scale=slowDevice.sample(.20);
assert.equal(scale,.65);
console.log('Interpolated position and heading across wraparound, stable resolution, bounded slowdown and recovery verified.');

function roughRoad(hz){
  const camera=createCameraRig();
  const car={y:0,pitch:0,bodyPitch:0,roll:0,heading:Math.PI-.01};
  camera.reset(car);
  let maxHeight=0,maxPitch=0;
  for(let i=1;i<=hz*2;i++){
    const t=i/hz, ripple=Math.sin(2*Math.PI*6*t);
    car.y=.08*ripple;
    car.pitch=.07*ripple;
    car.heading=-Math.PI+.01;
    const view=camera.update(car,1/hz);
    if(t>.4){
      maxHeight=Math.max(maxHeight,Math.abs(view.height));
      maxPitch=Math.max(maxPitch,Math.abs(view.pitch));
    }
    assert.ok(Math.abs(Math.sin(view.eyeYaw))<=.011 && Math.cos(view.chaseYaw)<-.99);
  }
  car.y=1.5; car.pitch=.14;
  for(let i=0;i<hz;i++) camera.update(car,1/hz);
  const crest=camera.update(car,1/hz);
  assert.ok(Math.abs(crest.height-car.y)<.001 && Math.abs(crest.pitch-car.pitch)<.001);
  return {maxHeight,maxPitch};
}

for(const hz of [30,60,120]){
  const {maxHeight,maxPitch}=roughRoad(hz);
  assert.ok(maxHeight<.013 && maxPitch<.005,'Suppress the six-Hz height and horizon ripple at '+hz+' Hz');
}
const constrained=createCameraRig();
constrained.reset({y:0,pitch:0,heading:0});
assert.equal(constrained.limitArm(2,1/60),2);
const emerging=constrained.limitArm(6.45,1/60);
assert.ok(emerging>2 && emerging<2.3,'Ease the chase camera back out of an obstacle');
assert.equal(constrained.limitArm(1,1/60),1);
for(let frame=0;frame<150;frame++) constrained.limitArm(6.45,1/60);
assert.ok(constrained.limitArm(6.45,1/60)>6.449);
console.log('Camera isolated pavement ripple at 30/60/120 Hz, settled on a crest and cleared a wall without a pullback snap.');
