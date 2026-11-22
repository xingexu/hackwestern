import assert from 'node:assert/strict'
import {createDriveSim} from '../drive-sim.mjs'
import {speedKph} from '../race/input.mjs'

const origin={x:0,y:0,z:0,heading:0,distance:0}
const network={sample:(x,z)=>({x,z,y:0,grade:0,tangentX:0,tangentZ:1,lateral:0,surface:'road'}),blocked:()=>false}

const hz=120,settlingSeconds=21,measurementSeconds=3

function skidpad(speed,steer,assists=true){
  const sim=createDriveSim([origin],{mode:'roam',network,assists}),car=sim.state
  for(let t=0;t<60*hz && speedKph(car)<speed;t++)sim.step({throttle:1,profile:'gamepad'})
  assert.ok(speedKph(car)>=speed,'Skidpad approach did not reach '+speed+' km/h')
  let integral=0,length=0,rotation=0,maxSlip=0,maxError=0,lastDirection=0
  for(let t=0;t<(settlingSeconds+measurementSeconds)*hz;t++){
    const error=(speed-speedKph(car))/3.6
    integral=Math.max(-1,Math.min(1,integral+error*.38/hz))
    const pedal=error*.55+integral
    const x=car.x,z=car.z
    sim.step({steer:steer*Math.min(1,t/hz),throttle:Math.max(0,pedal),brake:Math.max(0,-pedal),profile:'gamepad'})
    const dx=car.x-x,dz=car.z-z,direction=Math.atan2(dx,dz)
    if(t>=settlingSeconds*hz){
      length+=Math.hypot(dx,dz)
      rotation+=Math.atan2(Math.sin(direction-lastDirection),Math.cos(direction-lastDirection))
      maxSlip=Math.max(maxSlip,Math.abs(Math.atan2(car.lateralSpeed,car.speed))*180/Math.PI)
      maxError=Math.max(maxError,Math.abs(speed-speedKph(car)))
    }
    lastDirection=direction
  }
  return {radius:length/Math.abs(rotation),g:Math.abs(length*rotation)/(measurementSeconds**2*9.81),maxSlip,maxError}
}

const radiusLimit=new Map([[30,5.15],[60,19.5],[100,56]])
const parkingTurn=skidpad(30,1)
assert.ok(parkingTurn.radius<5.35 && parkingTurn.maxError<.6)
let maximumG=0
for(const speed of [20,30,40,50,60,70,80,90,100,110,120]){
  let best
  for(let percent=30;percent<=100;percent+=5){
    const measured=skidpad(speed,percent/100)
    if(measured.maxError<.6 && (!best || measured.radius<best.radius))best=measured
  }
  assert.ok(best,'No settled constant-speed turn at '+speed+' km/h')
  if(radiusLimit.has(speed))assert.ok(best.radius<=radiusLimit.get(speed),JSON.stringify({speed,...best}))
  if(speed>=60)assert.ok(best.maxSlip<5,JSON.stringify({speed,...best}))
  maximumG=Math.max(maximumG,best.g)
  console.log(speed+' km/h: '+best.radius.toFixed(2)+' m, '+best.g.toFixed(3)+' g, '+best.maxSlip.toFixed(2)+'° sideslip, speed within '+best.maxError.toFixed(2)+' km/h')
}
assert.ok(maximumG>=1.45 && maximumG<=1.60,maximumG+' g on flat dry asphalt')
console.log('Largest sustained lateral acceleration '+maximumG.toFixed(3)+' g')

for(const profile of ['keyboard','buttons','gamepad','tilt','wheel']){
  for(const sign of [-1,1]){
    const sim=createDriveSim([origin],{mode:'roam',network}),car=sim.state
    for(let t=0;t<40*hz && speedKph(car)<100;t++)sim.step({profile,throttle:1})
    assert.ok(speedKph(car)>=100)
    let sideslip=0,releaseYaw=0,followThrough=0
    for(let t=0;t<3*hz;t++){
      sim.step({profile,steer:t<hz?sign:0})
      sideslip=Math.max(sideslip,Math.abs(Math.atan2(car.lateralSpeed,car.speed)))
      if(t===hz-1)releaseYaw=car.heading
      if(t>=hz)followThrough=Math.max(followThrough,Math.abs(car.heading-releaseYaw))
    }
    assert.ok(releaseYaw*sign>.25)
    assert.ok(sideslip<.10 && followThrough<.11 && Math.abs(car.yawRate)<.02,JSON.stringify({profile,sign,sideslip,followThrough,yaw:car.yawRate}))
  }
}

let expertPeak=0
for(let percent=30;percent<=100;percent+=5){
  const {g,maxError}=skidpad(70,percent/100,false)
  if(maxError<.6)expertPeak=Math.max(g,expertPeak)
}
assert.ok(expertPeak>1.205 && expertPeak<1.28,expertPeak+' g in expert mode')
console.log('Expert cornering at 70 km/h',expertPeak.toFixed(3)+' g')
