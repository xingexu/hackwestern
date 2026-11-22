import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {decode,encode,Cadence,BYTES} from '../web/net/wire.mjs'
import {Clock,StampMap,Lag} from '../web/net/timing.mjs'
import {Track,contact} from '../web/net/motion.mjs'
import {createHmac} from 'node:crypto'
import {iceServers} from './ice.mjs'
import {Relay,newRoundRoom,command,transition,removePlayer,observeRacePose} from './referee.mjs'
import sprint from '../web/drive-route.json' with {type:'json'}
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
const sprintRoom=newRoundRoom('SPR234')
sprintRoom.players=[1,2].map(id=>({id,connected:true,loaded:true,ready:true}))
sprintRoom.host=1
const sprintHost=sprintRoom.players[0]
assert.ok(command(sprintRoom,sprintHost,{type:'settings',course:'sprint',laps:1,limit:300,collisions:true},0))
for(const player of sprintRoom.players) assert.ok(command(sprintRoom,player,{type:'ready',ready:true},0))
assert.ok(command(sprintRoom,sprintHost,{type:'start'},0,()=>3))
for(const player of sprintRoom.players) assert.ok(command(sprintRoom,player,{type:'placed',race:3},100))
transition(sprintRoom,3100)
for(const player of sprintRoom.players){
  assert.equal(observeRacePose(sprintRoom,player,{...sprint.at(-1),epoch:1}),false)
  assert.equal(command(sprintRoom,player,{type:'lap',race:3,lap:1},4000),false)
  for(const sample of sprint) observeRacePose(sprintRoom,player,{...sample,epoch:1})
  assert.ok(command(sprintRoom,player,{type:'lap',race:3,lap:1},50000+player.id))
}
assert.equal(sprintRoom.phase,'results')
assert.deepEqual(sprintRoom.results.map(({id,dnf})=>({id,dnf})),[{id:1,dnf:false},{id:2,dnf:false}])
console.log('UC Hill Sprint room start, checkpoints and finish order passed')
console.log('Binary codec, pure-module boundary, clock, referee sanity checks, prediction, ghost lifetime and round timeout passed')
