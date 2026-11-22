import {decode,encode,newer,HZ} from '../web/net/wire.mjs'
import {StampMap} from '../web/net/timing.mjs'
import {distance} from '../web/net/motion.mjs'

import {ROAD_HALF_WIDTH} from '../web/drive-sim.mjs'
import circuits from '../web/race/courses.mjs'
import sprint from '../web/drive-route.json' with {type:'json'}
import {advanceZones,circuitGates,zoneProgress} from '../web/race/zones.mjs'

const courses={...circuits,sprint:{samples:sprint}}
const gates=Object.fromEntries(Object.entries(courses).map(([id,course])=>[id,circuitGates(course.samples)]))
function atSprintFinish(point){
  const end=sprint.at(-1),previous=sprint.at(-2)
  const tx=end.x-previous.x,tz=end.z-previous.z,length=Math.hypot(tx,tz)
  const dx=point.x-end.x,dz=point.z-end.z
  return dx*tx+dz*tz>=0 && Math.abs(dx*tz-dz*tx)<=ROAD_HALF_WIDTH*length && Math.abs(point.y-end.y)<=2.2
}

export function observeRacePose(r,p,pose) {
  if (r.phase!=='playing' || p.dnf || p.finish) return false
  const samples=courses[r.settings.course].samples,indices=gates[r.settings.course]
  const track=p.track??={...zoneProgress(),point:null}
  const {x,y,z,epoch}=pose,point={x,y,z,epoch}
  const prev=track.point
  if (!prev || epoch!==prev.epoch || Math.hypot(x-prev.x,z-prev.z)>12) {
    const recovery=r.settings.course==='sprint' && prev && epoch!==prev.epoch && Math.hypot(x-prev.x,z-prev.z)<8
    const anchor=recovery?prev:samples[indices[track.passed-1]??0]
    if (Math.hypot(x-anchor.x,z-anchor.z)>(track.passed?10:17) || Math.abs(y-anchor.y)>2.5) return false
    track.point=point
    track.near=true
    track.missed=false
    return true
  }
  const near=track.near,missed=track.missed
  const credited=advanceZones(samples,indices,track,prev,point)
  track.point=point
  return Boolean(credited || near!==track.near || missed!==track.missed)
}

export class Relay{
  constructor(){this.sources=new Map()}
  forget(slot){this.sources.delete(slot)}
  receive(slot,buffer,now,rtt,allowReset=false){
    const s=decode(buffer)
    if(!s || s.slot!==slot || Math.max(Math.abs(s.x),Math.abs(s.y),Math.abs(s.z))>20000 || Math.hypot(s.vx,s.vy,s.vz)>115 || Math.hypot(s.ax,s.ay,s.az)>120 || Math.abs(s.turn)>15)return null
    let src=this.sources.get(slot)
    if(!src){src={map:new StampMap(),tokens:12,at:now};this.sources.set(slot,src)}
    const gap=Math.max(0,now-src.at)
    src.tokens=Math.min(12,src.tokens+gap*HZ*1.5/1000);src.at=now
    if(src.tokens<1)return null
    src.tokens--
    const last=src.state
    if(last && (!newer(s.seq,last.seq) || s.stamp<=last.stamp))return null
    if(last && distance(s,last)>4+2*85*(now-src.arrival)/1000 && !allowReset)return null
    src.state=s;src.arrival=now
    const stamp=src.map.map(s.stamp,now,Math.max(0,Math.min(2000,rtt)))
    src.serverStamp=stamp
    return encode({...s,stamp})
  }
}
export const seatGrace=20000
export const drainGrace=600000
export const roomDefaults={course:'sprint',laps:1,collisions:true,limit:300}
export function newRoundRoom(code){return {code,kind:'rooms',players:[],host:null,settings:{...roomDefaults},race:null,phase:'lobby',start:0,deadline:0,results:[],drain:0}}
export function transition(r,now){
  const connected=r.players.filter(p=>p.connected)
  if(r.race && connected.length && connected.every(p=>p.vote)){lobby(r);return}
  if(r.phase==='positioning' && ((connected.length && connected.every(p=>p.placed)) || now>=r.deadline)){
    for(const p of r.players)if(!p.placed)p.dnf=true
    r.phase='countdown';r.start=now+3000;r.deadline=r.start
  }
  if(r.phase==='countdown' && now>=r.start){r.phase='playing';r.deadline=r.start+r.settings.limit*1000}
  if(r.phase==='playing' && (now>=r.deadline || (connected.length && connected.every(p=>p.finish || p.dnf)) || !r.players.length)){
    for(const p of r.players)if(!p.finish)p.dnf=true
    r.results=[...r.results,...r.players.map(p=>({id:p.id,nickname:p.nickname,finish:p.finish,dnf:!p.finish}))].sort((a,b)=>(a.finish||Infinity)-(b.finish||Infinity))
    r.phase='results';r.deadline=0
  }
}
export function lobby(r){
  Object.assign(r,{phase:'lobby',race:null,start:0,deadline:0})
  for(const p of r.players)Object.assign(p,{ready:false,placed:false,vote:false,lap:0,finish:0,dnf:false})
}
export function removePlayer(r,id,now){
  const p=r.players.find(p=>p.id===id)
  if(!p)return
  if(r.race && r.phase!=='results')r.results.push({id,nickname:p.nickname,finish:p.finish,dnf:!p.finish})
  r.players=r.players.filter(p=>p.id!==id)
  r.host=r.players[0]?.id??null
  transition(r,now)
}
export function command(r,p,m,now,raceId){
  const connected=r.players.filter(p=>p.connected)
  if(m.type==='loaded' && !p.loaded){p.loaded=true}
  else if(m.type==='settings' && p.id===r.host && r.phase==='lobby' && (typeof m.course==='string' && Object.hasOwn(courses,m.course) || m.course==='roam') && Number.isInteger(m.laps) && m.laps>=1 && m.laps<=5 && Number.isInteger(m.limit) && m.limit>=30 && m.limit<=900 && typeof m.collisions==='boolean'){
    r.settings={course:m.course,laps:m.course==='sprint'?1:m.laps,collisions:m.collisions,limit:m.limit}
    for(const player of r.players)player.ready=false
  }else if(m.type==='ready' && p.loaded && r.phase==='lobby' && typeof m.ready==='boolean' && m.ready!==p.ready)p.ready=m.ready
  else if(m.type==='start' && p.id===r.host && !r.drain && r.phase==='lobby' && r.settings.course!=='roam' && connected.length>=2 && connected.length===r.players.length && connected.every(p=>p.loaded && p.ready)){
    Object.assign(r,{race:raceId(),phase:'positioning',deadline:now+10000,results:[]})
    for(const player of r.players)Object.assign(player,{placed:false,lap:0,finish:0,dnf:false,vote:false,track:null})
  }else if(m.type==='placed' && !p.placed && r.phase==='positioning' && m.race===r.race)p.placed=true
  else if(m.type==='lap' && r.phase==='playing' && m.race===r.race && !p.dnf && !p.finish && m.lap===p.lap+1 && p.track?.passed===gates[r.settings.course].length && (r.settings.course!=='sprint' || atSprintFinish(p.track.point))){
    p.track=null
    p.lap++
    if(p.lap===r.settings.laps)p.finish=Math.max(1,now-r.start)
  }else if(m.type==='vote' && !p.vote && r.race && m.race===r.race){
    p.vote=true
  }else return false
  transition(r,now)
  return true
}
