import assert from 'node:assert/strict'
import * as THREE from 'three'
import {createFleet} from '../web/lobby/remote.mjs'
import {readFile} from 'node:fs/promises'
import {decode,encode,Cadence,BYTES} from '../web/net/wire.mjs'
import {Clock,StampMap,Lag} from '../web/net/timing.mjs'
import {Track,contact} from '../web/net/motion.mjs'
import {createHmac} from 'node:crypto'
import {iceServers} from './ice.mjs'
import sprint from '../web/drive-route.json' with {type:'json'}
import {createDriveSim} from '../web/drive-sim.mjs'
import circuits from '../web/race/courses.mjs'
import {carsOverlap,finishDuration,finishPose,gridPosition} from '../web/race/online-race.mjs'
import {driveInput} from '../web/dev/circuit_driver.mjs'
import {observeRacePose,standings,Relay,newRoundRoom,command,transition,removePlayer} from './referee.mjs'
for(const name of ['wire','timing','motion']){
  const source=await readFile(new URL('../web/net/'+name+'.mjs',import.meta.url),'utf8')
  assert.doesNotMatch(source,/\b(window|document|navigator|Date|performance|fetch|WebSocket|RTCPeerConnection|setTimeout|setInterval|process|crypto|THREE)\b|Math\.random/)
  for(const match of source.matchAll(/from ['"]([^'"]+)/g))assert.ok(['./wire.mjs','./timing.mjs','./motion.mjs'].includes(match[1]))
}
const turn='turns:relay.example:443?transport=tcp'
const servers=await iceServers({TURN_URL:turn,TURN_SECRET:'test-key'},'driver',1000)
assert.deepEqual(servers[1].urls,[turn])
assert.equal(servers[1].credential,createHmac('sha1','test-key').update(servers[1].username).digest('base64'))
assert.equal((await iceServers({},'driver',1)).length,1)
const s={q:[.5,-.5,.5,.5],slot:1,seq:7,epoch:2,stamp:99,x:100.123456789,y:8,z:15,vx:3.125,vy:0,vz:0,ax:0,ay:0,az:0,turn:0,gas:1,brake:0,steer:-1,flags:1,rpm:1100}
const b=encode(s),d=decode(b)
assert.equal(b.byteLength,BYTES)
for(const key of ['x','z','slot','seq','stamp','vx','rpm','steer','gas'])assert.equal(d[key],s[key])
assert.ok(Math.abs(d.q.reduce((a,x,i)=>a+x*s.q[i],0))>.999)
const relay=new Relay()
assert.ok(relay.receive(1,b,5099,20))
assert.equal(relay.receive(1,b,5100,20),null)
assert.equal(relay.receive(1,encode({...s,seq:8,stamp:115,x:900}),5115,20),null)
const t=new Track()
t.push({...d,time:90},'direct',100)
assert.ok(t.draw(110).ghost)
t.clearIfSeparated(t.draw(110),[])
assert.ok(!t.draw(505).ghost)
assert.ok(t.draw(605).ghost)
assert.equal(t.draw(2200),null)
assert.ok(t.draw(400).x>d.x)
const clock=new Clock()
for(let i=0;i<16;i++)clock.observe(i*250,i*250+20,i*250+2010)
assert.ok(clock.synced);assert.equal(clock.server(500),2500)
const map=new StampMap();assert.equal(map.map(200,330,60),300)
const pace=new Cadence()
let count=0
for(let now=0;now<1000;now+=2)count+=Number(pace.take(now))
assert.equal(count,60)
const lag=new Lag({latency:150,jitter:70,loss:1})
assert.equal(lag.delivery(1),Infinity)
assert.ok(lag.delivery(2,true)<lag.delivery(3,true))
const room=newRoundRoom('ABC234')
room.players=[1,2].map(id=>({id,connected:true,loaded:true,ready:true}));room.host=1
assert.ok(command(room,room.players[0],{type:'start'},0,()=>1))
for(const p of room.players)command(room,p,{type:'placed',race:1},100)
assert.equal(room.start,3100);transition(room,3100);assert.equal(room.phase,'playing')
transition(room,room.deadline);assert.equal(room.results.length,2);assert.ok(room.results.every(p=>p.dnf))
const fallback=new Track()
fallback.push({...d,seq:1,time:500},'direct',520)
assert.equal(fallback.push({...d,seq:2,time:515},'relay',530),false)
assert.equal(fallback.path,'direct')
assert.equal(fallback.push({...d,seq:3,time:540},'relay',560),true)
const visible=fallback.draw(560)
assert.equal(contact({...visible,speed:2,x:visible.x+.5},visible,.017),false)
fallback.clearIfSeparated(visible,[{...visible,x:visible.x+1}])
assert.ok(fallback.clearRequired)
fallback.clearIfSeparated(visible,[{...visible,x:visible.x+3}])
const trusted=fallback.draw(950)
assert.equal(contact({...trusted,x:trusted.x+.5,speed:2},trusted,.017),true)
fallback.push({...d,seq:4,epoch:3,x:400,time:955},'relay',960)
assert.ok(fallback.draw(960).ghost)
assert.ok(fallback.draw(960).x>=400)
assert.equal(relay.receive(1,encode({...s,seq:8,stamp:120,vx:200}),5123,20),null)
const bucket=new Relay()
assert.equal(Array.from({length:20},(_,seq)=>bucket.receive(1,encode({...s,stamp:seq,seq}),100,10)).filter(Boolean).length,12)
assert.ok(command(room,room.players[0],{type:'vote',race:1},9200,()=>2))
assert.equal(room.phase,'results')
assert.ok(command(room,room.players[1],{type:'vote',race:1},9201,()=>2))
assert.equal(room.phase,'lobby')
for(const p of room.players)p.ready=true
room.drain=999999
assert.equal(command(room,room.players[0],{type:'start'},0,()=>2),false)
room.drain=0
assert.ok(command(room,room.players[0],{type:'start'},0,()=>2))
command(room,room.players[0],{type:'placed',race:2},200)
transition(room,10000);assert.equal(room.phase,'countdown');assert.ok(room.players[1].dnf)
removePlayer(room,1,10100);assert.equal(room.host,2);assert.equal(room.results[0].dnf,true)
const voteRoom=newRoundRoom('VTE234')
voteRoom.players=[1,2,3].map(id=>({id,connected:true,vote:id!==3}))
Object.assign(voteRoom,{race:'voted',phase:'playing',deadline:1000})
removePlayer(voteRoom,3,300)
assert.equal(voteRoom.phase,'lobby')
console.log('Binary codec, pure-module boundary, clock, referee sanity checks, prediction, ghost lifetime and round timeout passed')

const hill=newRoundRoom('HILL23')
hill.host=0
hill.players=Array.from({length:8},(_,slot)=>({id:slot,slot,connected:true,loaded:true}))
assert.equal(hill.settings.course,'sprint')
assert.ok(command(hill,hill.players[0],{...hill.settings,type:'settings',laps:5},0))
assert.equal(hill.settings.laps,1)
for(const driver of hill.players)command(hill,driver,{type:'ready',ready:true},1)
assert.ok(command(hill,hill.players[0],{type:'start'},2,()=>1))
for(const driver of hill.players)command(hill,driver,{type:'placed',race:1},3)
transition(hill,hill.start)
const cars=hill.players.map(({slot})=>{
  const sim=createDriveSim(sprint)
  sim.placeOnGrid(slot)
  return sim
})
for(const [slot,sim] of cars.entries()){
  const {x,z,heading}=sim.state
  for(const other of cars.slice(0,slot)){
    const dx=other.state.x-x,dz=other.state.z-z
    assert.ok(Math.abs(dx*Math.sin(heading)+dz*Math.cos(heading))>4.5 || Math.abs(dx*Math.cos(heading)-dz*Math.sin(heading))>2.3)
  }
  const driver=hill.players[slot],lap={type:'lap',race:1,lap:1}
  assert.equal(observeRacePose(hill,driver,{...sprint.at(-1),epoch:0}),false)
  assert.equal(command(hill,driver,lap,hill.start+1),false)
  let tick=0,epoch=1,recovered=false
  while(sim.state.phase!=='finished' && tick<120*90){
    if(tick%6===0)observeRacePose(hill,driver,{...sim.state,epoch})
    if(!recovered && sim.state.distance>250){
      sim.recover()
      epoch++
      recovered=true
    }
    sim.step(driveInput(sprint,sim.state,false))
    tick++
  }
  assert.equal(sim.state.phase,'finished')
  assert.equal(command(hill,driver,lap,hill.start+tick*1000/120),false)
  observeRacePose(hill,driver,{...sim.state,epoch})
  assert.ok(command(hill,driver,lap,hill.start+tick*1000/120))
}
assert.equal(hill.phase,'results')
assert.ok(hill.results.every(row=>row.finish>0 && !row.dnf))
console.log('All eight sprint grid slots drove to a validated finish, including mid-course recovery and rejection of early finish reports')

for(const [id,{samples}] of Object.entries({...circuits,sprint:{samples:sprint}})){
  const grid=Array.from({length:8},(_,spot)=>gridPosition(samples,spot,id==='sprint'))
  for(const [i,pose] of grid.entries())for(const other of grid.slice(0,i))assert.ok(!carsOverlap(pose,other),id+' grid slot '+i)
}
const start={x:0,y:0,z:0,heading:0}
const sampleGround=()=>({y:0,grade:0,tangentX:0,tangentZ:1})
const middle=finishPose(start,finishDuration/2,0,false,sampleGround)
const stopped=finishPose(start,finishDuration,0,false,sampleGround)
assert.ok(middle.z>0 && middle.z<stopped.z && middle.heading<-.4 && middle.x<0)
assert.equal(stopped.heading,0)
assert.deepEqual(stopped,finishPose(start,finishDuration+1000,0,false,sampleGround))
assert.ok(carsOverlap(middle,{...middle,heading:middle.heading-.5}))
assert.ok(!carsOverlap(middle,{...middle,x:middle.x+7}))

const full=newRoundRoom('GRID23')
full.host=0
full.players=Array.from({length:8},(_,slot)=>({id:slot,slot,connected:true,loaded:true,ready:true}))
const pole=[]
for(let heat=0;heat<8;heat++){
  assert.ok(command(full,full.players[0],{type:'start'},heat,()=>heat+1))
  assert.equal(new Set(full.players.map(p=>p.grid)).size,8)
  pole.push(full.players.find(p=>p.grid===0).id)
  for(const p of full.players)command(full,p,{type:'vote',race:heat+1},heat)
  for(const p of full.players)p.ready=true
}
assert.equal(new Set(pole).size,8)
Object.assign(full,{phase:'playing',results:[]})
Object.assign(full.players[0],{lap:1,track:{distance:500}})
Object.assign(full.players[1],{lap:2,track:{distance:5}})
Object.assign(full.players[2],{lap:2,track:{distance:10}})
Object.assign(full.players[3],{finish:3000})
Object.assign(full.players[4],{finish:2999})
Object.assign(full.players[5],{dnf:true})
assert.deepEqual(standings(full).slice(0,5).map(p=>p.id),[4,3,2,1,0])
assert.equal(standings(full).at(-1).id,5)
console.log('Eight-car grids, rotating pole, live priority and settle-to-stop finish poses passed')

// Render both finishers from identical crossing locations, then let them separate.
const scene=new THREE.Scene(),coupe=new THREE.Group()
coupe.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()))
const fleet=createFleet(THREE,scene,coupe,{},sampleGround)
const arrival=10000
const finishers=[1,2].map(slot=>({slot,id:slot,nickname:'Racer '+slot,connected:true,color:'#ffffff',finish:1000,
  finishStart:{...start,at:arrival+slot}}))
const observer={...start,x:30}
const session={tracks:new Map(),clock:{synced:true}}
globalThis.document={createElement:()=>({getContext:()=>({fillRect(){},fillText(){}})})}
try{
  fleet.roster(finishers,0)
  fleet.update(session,observer,false,1/60,arrival+25,false)
  fleet.separate(observer,false)
  assert.equal(scene.children.filter(model=>model.visible).length,1)
  fleet.separate(start,true)
  assert.equal(scene.children.filter(model=>model.visible).length,0)
  finishers[1].finishStart={...finishers[1].finishStart,x:8}
  fleet.roster(finishers,0)
  fleet.update(session,observer,false,1/60,arrival+25,false)
  fleet.separate(observer,false)
  assert.equal(scene.children.filter(model=>model.visible).length,2)
}finally{
  fleet.roster([],0)
  delete globalThis.document
}
console.log('Simultaneous finish models were separated from each other and the local car')
