import assert from 'node:assert/strict'
import {createDriveSim} from '../drive-sim.mjs'
import {profiles,speedKph} from '../race/input.mjs'

const hz=120
const origin={x:0,z:0,y:0,distance:0,heading:0}
const flat={sample:(x,z)=>({x,z,y:0,grade:0,tangentX:0,tangentZ:1,lateral:0,surface:'road'}),blocked:()=>false}

function approachSpeed(sim,speed,profile){
  for(let tick=0;tick<180*hz && speedKph(sim.state)<speed;tick++)sim.step({profile,throttle:1})
  assert.ok(speedKph(sim.state)>=speed)
}

function flick(profile){
  const radius=38
  let entry=Infinity
  const bend={
    ...flat,
    sample(x,z){
      const offset=z<entry && x<radius?x:Math.hypot(x-radius,z-entry)-radius
      return {...flat.sample(x,z),surface:Math.abs(offset)<=4.3?'road':'grass'}
    }
  }
  const sim=createDriveSim([origin],{mode:'roam',network:bend})
  approachSpeed(sim,80,profile)
  entry=sim.state.z
  let onRoad=0,peakSlip=0,integral=0
  for(let tick=0;tick<6*hz;tick++){
    const error=(80-speedKph(sim.state))/3.6
    integral=Math.max(-1,Math.min(1,integral+error*.38/hz))
    const pedal=.55*error+integral
    const steer=tick%180>=120 && tick%180<132?-1:1
    sim.step({profile,steer,throttle:Math.max(0,pedal),brake:Math.max(0,-pedal)})
    const {x,z,lateralSpeed,speed}=sim.state
    const offset=Math.abs(Math.hypot(x-radius,z-entry)-radius)
    if(offset<=4.3)onRoad++
    peakSlip=Math.max(peakSlip,Math.abs(Math.atan2(lateralSpeed,speed)))
  }
  return {onRoad,peakSlip}
}

function wall(angle,side,normalKnown){
  const heading=angle*Math.PI/180
  let barrier=Infinity
  const network={...flat,blocked:(x,z,y,r)=>side*x+r>=barrier}
  if(normalKnown)network.solidNormal=()=>[-side,0]
  const sim=createDriveSim([{...origin,heading:heading*side}],{mode:'roam',network})
  approachSpeed(sim,80,'keyboard')
  barrier=side*sim.state.x+4
  let entered=false,entryZ,entrySpeed,elapsed=0
  for(let t=0;t<8*hz && elapsed<hz;t++){
    const z=sim.state.z,speed=speedKph(sim.state)
    sim.step({profile:'keyboard'})
    if(!entered && sim.state.contact){
      entered=true
      entryZ=z
      entrySpeed=speed
    }
    if(entered)elapsed++
    assert.ok(side*sim.state.x+.9+1.34*Math.abs(Math.sin(sim.state.heading))<=barrier+1e-7)
  }
  assert.ok(entered)
  return {retained:speedKph(sim.state)/entrySpeed,advance:sim.state.z-entryZ}
}

for(const profile of profiles){
  const {onRoad,peakSlip}=flick(profile)
  assert.ok(onRoad>=684 && peakSlip<.10,JSON.stringify({profile,onRoad,peakSlip}))
  console.log(profile,'80 km/h bend with four opposite-lock flicks',onRoad+'/720 ticks in lane, peak sideslip',(peakSlip*180/Math.PI).toFixed(2)+'°')
}
for(const known of [false,true]){
  for(const side of [-1,1]){
    const result=wall(25,side,known)
    assert.ok(result.retained>.78 && result.advance>18)
    console.log('25° wall',side,known,result)
  }
}

for(const profile of profiles){
  const sim=createDriveSim([origin],{mode:'roam',network:flat})
  approachSpeed(sim,190,profile)
  const car=sim.state
  let maxSlip=0,maxYaw=0
  for(let t=0;t<4*hz;t++){
    const steer=t<hz?1:t<2*hz?-1:0
    sim.step({profile,steer})
    maxSlip=Math.max(maxSlip,Math.abs(Math.atan2(car.lateralSpeed,car.speed)))
    maxYaw=Math.max(maxYaw,Math.abs(car.yawRate))
  }
  console.log(profile,'190 km/h reversal',maxSlip*180/Math.PI,maxYaw,car.yawRate)
  assert.ok(maxSlip<.13 && maxYaw<.7 && Math.abs(car.yawRate)<.01)
}
