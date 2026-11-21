import {createDriveSim} from '../drive-sim.mjs'
import {profiles,inputProfile} from './input.mjs'
import {SIM_VERSION} from './version.mjs'

export {SIM_VERSION}
export const SIM_HZ = 120
export const MAX_STEPS = 10*60*SIM_HZ
const courses = ['college','stadium','campus']
const validSetup = setup => setup==='stock' || setup==='expert'
const magic = 0x44575231
const headerSize = 24

function axis(value,limit,low=0) {
  return Math.round(Math.max(low,Math.min(1,Number.isFinite(value)?value:0))*limit) || 0
}

export function quantizeInput(input) {
  return {
    steer:axis(input.steer,127,-1)/127,
    throttle:axis(input.throttle,255)/255,
    brake:axis(input.brake,255)/255,
    handbrake:axis(input.handbrake,255)/255,
    digitalSteer:Boolean(input.digitalSteer),profile:inputProfile(input)
  }
}

export const milliseconds = steps => Math.round(steps*1000/SIM_HZ)

export function createRecorder({course,simHz=SIM_HZ,setup='stock'}) {
  if (!courses.includes(course) || simHz!==SIM_HZ || !validSetup(setup)) throw new Error('Unsupported race setup')
  const runs=[]
  let steps=0
  return {
    record(input) {
      if (steps>=MAX_STEPS) throw new Error('Time trial exceeds ten minutes')
      const q=quantizeInput(input)
      const last=runs.at(-1)
      if (last && last.count<65535 && last.steer===q.steer && last.brake===q.brake && last.throttle===q.throttle && last.handbrake===q.handbrake && last.digitalSteer===q.digitalSteer && last.profile===q.profile) last.count++
      else runs.push({...q,count:1})
      steps++
      return q
    },
    finish({timeMs,checkpointsMs,stateHash=null}) {
      return {version:1,simVersion:SIM_VERSION,course,simHz,setup,steps,runs:runs.map(run=>({...run})),timeMs,stateHash,checkpointsMs:[...checkpointsMs]}
    }
  }
}

export function encodeReplay(replay) {
  const {course,steps,timeMs,checkpointsMs,runs}=replay
  if (replay.simVersion!==SIM_VERSION || replay.version!==1 || !validSetup(replay.setup) || replay.simHz!==SIM_HZ || !courses.includes(course) || checkpointsMs.length>255 || steps>MAX_STEPS) throw new Error('Unsupported replay')
  const bytes=new Uint8Array(headerSize+4*checkpointsMs.length+7*runs.length)
  const d=new DataView(bytes.buffer)
  d.setUint32(0,magic)
  d.setUint32(4,SIM_VERSION)
  d.setUint8(8,courses.indexOf(course) | (replay.setup==='expert'?128:0))
  d.setUint8(9,checkpointsMs.length)
  d.setUint16(10,SIM_HZ)
  d.setUint32(12,steps)
  d.setUint32(16,timeMs)
  d.setUint32(20,parseInt(replay.stateHash??'0',16))
  let at=headerSize
  for (const ms of checkpointsMs) {d.setUint32(at,ms);at+=4}
  for (const run of runs) {
    d.setUint16(at,run.count)
    d.setInt8(at+2,axis(run.steer,127,-1))
    d.setUint8(at+3,axis(run.throttle,255))
    d.setUint8(at+4,axis(run.brake,255))
    d.setUint8(at+5,axis(run.handbrake,255))
    d.setUint8(at+6,profiles.indexOf(inputProfile(run))*2+Number(run.digitalSteer))
    at+=7
  }
  return bytes
}

export function decodeReplay(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length<headerSize || bytes.length>headerSize+1020+MAX_STEPS*7) throw new Error('Invalid replay size')
  const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  if (d.getUint32(0)!==magic || d.getUint32(4)!==SIM_VERSION || d.getUint16(10)!==SIM_HZ) throw new Error('Incompatible replay')
  const setup=d.getUint8(8)&128?'expert':'stock'
  const course=courses[d.getUint8(8)&127], steps=d.getUint32(12), timeMs=d.getUint32(16)
  const checkpointsMs=[], runs=[]
  let at=headerSize,total=0
  const end=at+4*d.getUint8(9)
  if (!course || steps<1 || steps>MAX_STEPS || end>bytes.length || (bytes.length-end)%7) throw new Error('Invalid replay header')
  for (;at<end;at+=4) checkpointsMs.push(d.getUint32(at))
  for (;at<bytes.length;at+=7) {
    const count=d.getUint16(at), steer=d.getInt8(at+2),flags=d.getUint8(at+6),profile=profiles[flags>>1]
    total+=count
    if (!count || total>steps || steer===-128 || !profile) throw new Error('Invalid replay input')
    runs.push({count,steer:steer/127,throttle:d.getUint8(at+3)/255,brake:d.getUint8(at+4)/255,handbrake:d.getUint8(at+5)/255,digitalSteer:Boolean(flags&1),profile})
  }
  if (total!==steps) throw new Error('Truncated replay')
  return {version:1,simVersion:SIM_VERSION,course,simHz:SIM_HZ,setup,steps,timeMs,stateHash:d.getUint32(20).toString(16).padStart(8,'0'),checkpointsMs,runs}
}

export function stateHash(sim) {
  let hash=2166136261
  const view=new DataView(new ArrayBuffer(8))
  for (const value of [...Object.values(sim.state).filter(x=>typeof x==='number'),...sim.wheels]) {
    view.setFloat64(0,value)
    for (let i=0;i<8;i++) hash=Math.imul(hash^view.getUint8(i),16777619)
  }
  for (const flag of [sim.state.phase,sim.state.surface,String(sim.state.contact),String(sim.state.offCourse)]) {
    for (const c of flag) hash=Math.imul(hash^c.charCodeAt(0),16777619)
  }
  return (hash>>>0).toString(16).padStart(8,'0')
}

export function createPlayback(replay,context) {
  if (replay.simVersion!==SIM_VERSION || replay.course!==context.id || !validSetup(replay.setup) || replay.simHz!==SIM_HZ || replay.steps>MAX_STEPS) throw new Error('Wrong course or simulation version')
  const sim=createDriveSim(context.samples,{mode:'circuit',network:context.network,assists:replay.setup==='stock'})
  let index=0,used=0,tick=0
  const checkpointsMs=[]
  return {sim,checkpointsMs,get tick(){return tick},step(){
    const input=replay.runs[index]
    if (!input || tick>=replay.steps) return false
    if (sim.state.phase==='finished') throw new Error('Replay continues after finish')
    sim.step(input)
    tick++
    if (++used===input.count) {index++;used=0}
    while (sim.state.checkpointsPassed>checkpointsMs.length) checkpointsMs.push(milliseconds(tick))
    return true
  }}
}

export function simulateReplay(replay,courseContext) {
  const playback=createPlayback(replay,courseContext)
  while (playback.step()) {}
  if (playback.sim.state.phase!=='finished' || playback.tick!==replay.steps) throw new Error('Replay did not finish the course')
  return {timeMs:milliseconds(playback.tick),checkpointsMs:playback.checkpointsMs,stateHash:stateHash(playback.sim)}
}
