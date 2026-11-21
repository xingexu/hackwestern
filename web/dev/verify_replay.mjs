import assert from 'node:assert/strict'
import {createDriveSim} from '../drive-sim.mjs'
import {createRaceContext} from '../race/context.mjs'
import {createRecorder,createPlayback,encodeReplay,decodeReplay,simulateReplay,milliseconds,stateHash,MAX_STEPS} from '../race/replay.mjs'
import {driveInput} from './circuit_driver.mjs'
import {pathToFileURL} from 'node:url'

export function recordCircuit(course,setup='stock') {
  const context=createRaceContext(course)
  const sim=createDriveSim(context.samples,{mode:'circuit',network:context.network,assists:setup==='stock'})
  const recorder=createRecorder({course,setup})
  const hashes=[],checkpointsMs=[]
  let steps=0
  while (sim.state.phase!=='finished' && steps<MAX_STEPS) {
    const input=driveInput(context.samples,sim.state)
    const digital=Math.abs(input.steer)>=1 || input.steer===0
    input.profile=digital?(Math.floor(steps/600)%2?'keyboard':'buttons'):(Math.floor(steps/480)%2?'tilt':'gamepad')
    input.digitalSteer=digital
    sim.step(recorder.record(input))
    assert.equal(sim.state.contact,false,course+' fixture made contact at '+sim.state.distance.toFixed(2)+' m')
    steps++
    if (steps%120===0) hashes.push(stateHash(sim))
    while (sim.state.checkpointsPassed>checkpointsMs.length) checkpointsMs.push(milliseconds(steps))
  }
  assert.equal(sim.state.phase,'finished',course+' at '+sim.state.distance)
  const timeMs=milliseconds(steps)
  const replay=recorder.finish({timeMs,checkpointsMs,stateHash:stateHash(sim)})
  const bytes=encodeReplay(replay)
  const decoded=decodeReplay(bytes)
  assert.equal(decoded.setup,setup)
  assert.deepEqual([...new Set(decoded.runs.map(r=>r.profile))].sort(),['buttons','gamepad','keyboard','tilt'])
  assert.deepEqual(encodeReplay(decoded),bytes)
  assert.throws(()=>decodeReplay(bytes.subarray(0,-1)))
  const result={timeMs,checkpointsMs,stateHash:stateHash(sim)}
  assert.deepEqual(simulateReplay({...decoded,timeMs:1,checkpointsMs:[]},context),result)
  const playback=createPlayback(decoded,context)
  while (playback.step()) if (playback.tick%120===0) assert.equal(stateHash(playback.sim),hashes[playback.tick/120-1])
  console.log(course,steps+' ticks',timeMs+' ms',bytes.length+' bytes',result.stateHash)
  return {bytes,hashes,result}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const recorder=createRecorder({course:'college'})
  const command={steer:-2,throttle:.37,brake:.14,handbrake:.55,digitalSteer:true}
  const quantized=recorder.record(command)
  recorder.record(command)
  recorder.record({steer:1,profile:'wheel'})
  const bytes=encodeReplay(recorder.finish({timeMs:25,checkpointsMs:[]}))
  const decoded=decodeReplay(bytes)
  assert.deepEqual(decoded.runs[0],{count:2,...quantized})
  assert.equal(decoded.runs[0].handbrake,140/255)
  assert.equal(decoded.runs[0].steer,-1)
  assert.equal(decoded.runs[1].steer,1)
  assert.equal(decoded.runs[1].profile,'wheel')
  assert.equal(decoded.runs.length,2)
  assert.throws(()=>simulateReplay(decoded,createRaceContext('stadium')),/Wrong course/)
  assert.throws(()=>simulateReplay(decoded,createRaceContext('college')),/did not finish/)
  const wrongVersion=bytes.slice()
  wrongVersion[4]^=1
  assert.throws(()=>decodeReplay(wrongVersion),/Incompatible/)
  for (const course of ['college','stadium','campus']) recordCircuit(course)
}
