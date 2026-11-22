import assert from 'node:assert/strict'
import {createDriveSim} from '../drive-sim.mjs'
import {profiles,speedKph} from '../race/input.mjs'
import noviceRecording from './fixtures/novice-keyboard.json' with {type:'json'}
import {recordCircuit} from './verify_replay.mjs'

const origin={x:0,y:0,z:0,heading:0,distance:0}
const network={
  sample(x,z){return {x,z,y:0,grade:0,tangentX:0,tangentZ:1,lateral:x,surface:Math.abs(x)<=4.3?'road':'grass'}},
  blocked(){return false}
}
const responses={}
for(const profile of profiles){
  const sim=createDriveSim([origin],{mode:'roam',network})
  sim.step({profile,steer:.2})
  const first=sim.state.filteredSteer
  for(let i=0;i<15;i++)sim.step({profile,steer:.2})
  responses[profile]={first,settled:sim.state.filteredSteer}
  assert.equal(sim.state.profile,profile)
  for(let i=0;i<60;i++)sim.step({profile,steer:1})
  assert.ok(sim.state.filteredSteer>.999)
}
assert.equal(responses.keyboard.first,.2)
assert.equal(responses.buttons.first,.2)
assert.equal(responses.wheel.first,.2)
assert.equal(responses.wheel.settled,.2)
assert.ok(responses.gamepad.first>.15 && responses.gamepad.first<.2)
assert.ok(responses.tilt.first<responses.tilt.settled/2 && responses.tilt.settled>.14 && responses.tilt.settled<responses.gamepad.settled)
const reference=createDriveSim([origin],{mode:'roam',network})
let steer=0
const trace=Array.from({length:1680},(_,step)=>{
  const turn=step-480
  if(turn>=0 && turn%24===0){
    const target=[2,-2,2,0][Math.floor(turn/300)]
    const car=reference.state
    const predicted=car.x+Math.sin(car.heading)*car.speed*.55
    steer=Math.abs(target-predicted)>.8?Math.sign(target-predicted):0
  }
  const input={throttle:1,steer,profile:'keyboard'}
  reference.step(input)
  return input
})
function novice(profile,assists,inputs){
  const sim=createDriveSim([origin],{mode:'roam',network,assists})
  let road=0,peak=0
  inputs.forEach((input,i)=>{
    sim.step({...input,profile})
    if(i<480)return
    if(sim.state.surface==='road')road++
    peak=Math.max(peak,Math.abs(sim.state.x))
  })
  return {road,peak,forward:sim.state.z}
}
console.log('Ten seconds of lane changes on an 8.6 m road, recorded with the default keyboard setup. Full-lock decisions every 200 ms. Identical commands replayed in each mode.')
for(const profile of profiles){
  const on=novice(profile,true,trace),off=novice(profile,false,trace)
  console.log(profile, 'on/off asphalt ticks',on.road,off.road,'of 1200, peak offset',on.peak.toFixed(2),off.peak.toFixed(2),'m')
  assert.ok(on.road>off.road && on.peak<off.peak)
  if(profile==='keyboard')assert.ok(on.road>off.road+240 && on.forward>off.forward && on.peak<4.3)
}
const {straightTicks,ticksPerCommand,steering}=noviceRecording
const recorded=Array.from({length:straightTicks+steering.length*ticksPerCommand},(_,tick)=>({
  throttle:1,
  steer:tick<straightTicks?0:steering[Math.floor((tick-straightTicks)/ticksPerCommand)]
}))
for(const profile of profiles){
  const result=novice(profile,true,recorded)
  assert.ok(result.road>=1080,profile+' stayed on asphalt for '+result.road+' of 1200 frames')
  console.log('Recorded novice trace:',profile,result.road+'/1200 ticks on asphalt, peak offset '+result.peak.toFixed(2)+' m')
}
const alternating=trace.map((_,i)=>{
  const t=i-480
  return {throttle:1,steer:t>=0 && t%60<30?[1,-1,-1,1][Math.floor(t/60)%4]:0}
})
const alternateOn=novice('keyboard',true,alternating),alternateOff=novice('keyboard',false,alternating)
console.log('Independent quarter-second alternating presses, asphalt ticks on/off:',alternateOn.road,alternateOff.road)
assert.ok(alternateOn.forward>alternateOff.forward && alternateOn.peak<4.3)
const speeds=[]
for(const assists of [true,false]){
  const sim=createDriveSim([origin],{mode:'roam',network,assists})
  assert.equal(sim.state.rpm,850)
  sim.step({throttle:1})
  assert.equal(sim.state.gasPedal<1,assists)
  let lastGear=sim.state.gear,shifts=0
  for(let i=0;i<180*120;i++){
    const {x,z,rpm}=sim.state
    sim.step({throttle:1})
    assert.ok(sim.state.rpm>=850 && sim.state.rpm<=6750)
    if(sim.state.gear>lastGear){
      assert.ok(rpm>=6200 && sim.state.gear===lastGear+1)
      shifts++
    }
    lastGear=sim.state.gear
    assert.ok(Math.abs(speedKph(sim.state)-Math.hypot(sim.state.x-x,sim.state.z-z)*120*3.6)<.00001)
  }
  assert.ok(shifts>=4)
  speeds.push(sim.state.speed*3.6)
  sim.step({brake:1})
  assert.equal(sim.state.brakePedal<1,assists)
}
console.log('Full-throttle straight at 180 s, assists on/off: '+speeds.map(s=>s.toFixed(1)).join(' / ')+' km/h')
assert.ok(speeds[0]>=180 && speeds[0]<=200 && Math.abs(speeds[0]-speeds[1])<1)
const descent={...network,sample(x,z){
  return {...network.sample(x,z),y:-Math.max(0,z-15)*.14-(z>70 ? .16 : 0),grade:z>15?-.14:0}
}}
for(const assists of [true,false]){
  const sim=createDriveSim([origin],{mode:'roam',network:descent,assists})
  let peak=0
  for(let i=0;i<1000;i++){
    sim.step({throttle:1})
    peak=Math.max(peak,sim.state.lift)
  }
  assert.ok(peak>=.10 && peak<.4)
  assert.ok(sim.state.lift<.01 && sim.state.z>100)
}
recordCircuit('stadium','expert')
