import assert from 'node:assert/strict'
import {createWheel} from '../web/phone/pad-wheel.js'
import {createDriveSim} from '../web/drive-sim.mjs'
import {createRaceContext} from '../web/race/context.mjs'
import {driveInput} from '../web/dev/circuit_driver.mjs'

function vector(turn,pitch,side=1){
  const rad=Math.PI/180
  return [Math.cos(turn*rad)*Math.cos(pitch*rad)*side,Math.sin(turn*rad)*Math.cos(pitch*rad)*side]
}

for(const side of [1,-1]){
  const wheel=createWheel()
  let t=0,steer
  function sample(turn,pitch,straight=true){
    steer=wheel.sample(...vector(turn,pitch,side),t,straight)
    t+=1000/60
  }
  for(let i=0;i<90;i++)sample(3,50)
  assert.ok(Math.abs(wheel.neutral-3)<.01)
  for(let i=0;i<1800;i++)sample(3+2*i/1800,50)
  assert.ok(Math.abs(wheel.neutral-5)<.55 && steer===0)
  const neutral=wheel.neutral
  const start=t
  do{sample(neutral+32,65)}while(-steer<.5 && t-start<150)
  assert.ok(t-start<=50)
  console.log('Wheel 50% step response at 60 Hz:',Math.round(t-start),'ms')
  for(const pitch of [0,30,60,78,40]){
    for(let i=0;i<180;i++)sample(neutral+17,pitch)
    assert.ok(Math.abs(steer+.395)<.002 && wheel.neutral===neutral)
  }
  for(let i=0;i<120;i++)sample(neutral,30,false)
  for(let i=0;i<600;i++)sample(neutral+1.5,30,false)
  assert.equal(wheel.neutral,neutral)
}

const context=createRaceContext('stadium')
for(const legacy of [true,false]){
  const sim=createDriveSim(context.samples,{mode:'circuit',network:context.network})
  const wheel=createWheel()
  for(let i=0;i<60;i++)wheel.sample(...vector(0,35),-1000+i*1000/60,true)
  let command=0,target=0,steer=0,ticks=0,nextPacket=0,previousPacket=0
  for(;ticks<120*240 && sim.state.phase!=='finished';ticks++){
    const input=driveInput(context.samples,sim.state)
    const t=ticks/120
    if(ticks%2===0){
      command=Math.max(-1,Math.min(1,input.steer))
      const turn=-command*32+1.5*Math.sin(t*.17)+.55*Math.sin(t*43)
      const [x,y]=vector(turn,35+24*Math.sin(t*.28))
      if(legacy){
        const raw=Math.atan2(y,x)*180/Math.PI
        target=-Math.sign(raw)*Math.min(1,Math.max(0,Math.abs(raw)-2)/25)
      }else steer=wheel.sample(x,y,t*1000,Math.abs(sim.state.yawRate)<.06 && Math.abs(sim.state.steer)<.035)
    }
    if(legacy && t>=nextPacket){
      steer+=(target-steer)*(1-Math.exp(-(t-previousPacket)/.022))
      previousPacket=t;nextPacket+=.04
    }
    sim.step({...input,steer,profile:legacy?'tilt':'wheel'})
  }
  console.log('Stadium scripted tilt lap',legacy?'previous':'wheel',sim.state.phase,(ticks/120).toFixed(3)+' s',sim.state.checkpointsPassed+' checkpoints')
  assert.equal(sim.state.phase,'finished')
}
