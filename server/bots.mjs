import assert from 'node:assert/strict'
import {once} from 'node:events'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {parseArgs} from 'node:util'
import {createRaceContext} from '../web/race/context.mjs'
import {SIM_VERSION} from '../web/race/version.mjs'
import {createDriveSim} from '../web/drive-sim.mjs'
import {driveInput} from '../web/dev/circuit_driver.mjs'
import {PROTOCOL,RULES,CAPACITY,Cadence,decode,encode,frameState} from '../web/net/wire.mjs'

const {values}=parseArgs({options:{base:{type:'string'},count:{type:'string',default:'8'},seconds:{type:'string',default:'8'}}})
const count=Number(values.count),seconds=Number(values.seconds)
assert.ok(Number.isInteger(count) && count>=2 && count<=CAPACITY && seconds>0)
const poll=async(test,ms=12000)=>{const until=Date.now()+ms;while(!await test()){assert.ok(Date.now()<until,'Timed out waiting for room');await sleep(25)}}
let base=values.base,child,temp
const bots=[],versions={protocol:PROTOCOL,rules:RULES,sim:SIM_VERSION},ctx=createRaceContext('stadium')
const post=(path,body)=>fetch(base+path,{method:'POST',body:JSON.stringify(body)})
try{
  if(!base){
    const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening')
    const port=socket.address().port;await new Promise(r=>socket.close(r))
    base='http://127.0.0.1:'+port;temp=await mkdtemp(join(tmpdir(),'western-bots-'))
    child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--local','--config','server/wrangler.jsonc','--var','MULTIPLAYER:1','--var','DRAIN_TOKEN:local-bot-test','--inspector-port','0','--port',String(port),'--persist-to',temp],{detached:true,stdio:'ignore',env:{...process.env,X_LOCAL_OBSERVABILITY:'false'}})
    await poll(()=>fetch(base+'/api/health').then(r=>r.ok).catch(()=>false),25000)
  }
  const health=await (await fetch(base+'/api/health')).json()
  assert.ok(health.multiplayer && health.graceMs>=20000)
  const profile=async i=>({...await (await post('/api/identity',{})).json(),...versions,nickname:'Driver '+i,color:'#428cbe'})
  const first=await profile(1)
  assert.equal((await post('/api/rooms',{...first,protocol:PROTOCOL-1})).status,426)
  let code
  for(let i=0;i<count;i++){
    const res=await post('/api/rooms'+(code?'/'+code+'/join':''),i?await profile(i+1):first)
    assert.equal(res.status,200,await res.clone().text())
    const ticket=await res.json();code=ticket.code
    const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/rooms/'+code+'/socket?'+new URLSearchParams(versions),['western',ticket.token])
    ws.binaryType='arraybuffer'
    const sim=createDriveSim(ctx.samples,{mode:'circuit',network:ctx.network})
    const bot={ws,ticket,sim,seq:0,received:new Set(),bytes:0,send:m=>ws.send(JSON.stringify(m)),cadence:new Cadence()}
    bots.push(bot)
    ws.addEventListener('close',e=>{bot.closed={code:e.code,reason:e.reason}})
    ws.onmessage=({data})=>{
      if(typeof data!=='string'){
        const state=decode(data);if(state){bot.received.add(state.slot);bot.bytes+=data.byteLength}
        return
      }
      const m=JSON.parse(data)
      if(m.type==='room'){
        bot.room=m
        if(m.phase==='positioning' && !bot.placed){bot.placed=true;bot.send({type:'placed',race:m.race})}
      }
    }
    await once(ws,'open');bot.send({type:'loaded'})
  }
  const host=bots[0]
  if(count===CAPACITY)assert.equal((await post('/api/rooms/'+code+'/join',await profile(9))).status,409)
  await poll(()=>host.room?.players.length===count && host.room.players.every(p=>p.loaded))
  host.send({type:'settings',course:'roam',laps:1,limit:180,collisions:true})
  await poll(()=>bots.every(b=>b.room.settings.course==='roam'))
  host.send({type:'start'});host.send({type:'settings',course:'stadium',laps:1,limit:180,collisions:true})
  await poll(()=>bots.every(b=>b.room.settings.course==='stadium'))
  for(const b of bots)b.send({type:'ready',ready:true})
  await poll(()=>host.room.players.every(p=>p.ready))
  host.send({type:'start'});await poll(()=>bots.every(b=>b.room.phase==='playing'))
  const start=performance.now();let steps=0
  async function driveFrame(){
    const stamp=performance.now(),due=Math.floor((stamp-start)*.12)
    for(const b of bots){
      for(let k=steps;k<due;k++){
        b.input=driveInput(ctx.samples,b.sim.state)
        b.sim.step(b.input)
      }
      if(!b.cadence.take(stamp))continue
      const state=frameState(b.sim.state,b.input??{},b.previous,stamp,b.ticket.slot,++b.seq,0)
      b.ws.send(encode(state));b.previous=state
      if(b.sim.state.phase==='finished' && !b.room.players.find(p=>p.id===b.ticket.id)?.finish && stamp>=(b.reportAt??0)){
        b.send({type:'lap',race:b.room.race,lap:1});b.reportAt=stamp+350
      }
    }
    steps=due;await sleep(3)
  }
  while(performance.now()-start<seconds*1000 && host.room.phase==='playing')await driveFrame()
  const elapsed=(performance.now()-start)/1000
  const rates=bots.map(b=>Math.round(b.bytes/elapsed))
  console.log(count+' bots, '+elapsed.toFixed(1)+' s, '+(bots[0].seq/elapsed).toFixed(1)+' Hz, received '+Math.min(...rates)+'–'+Math.max(...rates)+' bytes/s per driver, '+bots.filter(b=>b.sim.state.phase==='finished').length+' crossed the finish line')
  for(const b of bots){
    assert.equal(b.received.size,count-1);assert.ok(b.sim.state.distance>1)
    assert.ok(b.bytes/elapsed>(count-1)*64*35,JSON.stringify({reason:'Relay delivery below 35 Hz',phase:b.room.phase,car:b.sim.state.phase,closed:b.closed,sent:b.seq,bytes:b.bytes,elapsed}))
  }
  if(child){
    assert.equal((await post('/api/drain',{})).status,403)
    const closed=Promise.all(bots.map(b=>once(b.ws,'close')))
    const drain=await fetch(base+'/api/drain',{method:'POST',headers:{Authorization:'Bearer local-bot-test'}})
    assert.ok(drain.ok);assert.equal((await post('/api/rooms',await profile(10))).status,503)
    await poll(()=>host.room.drain)
    while(host.room.phase==='playing' && Date.now()<host.room.deadline)await driveFrame()
    for(const [event] of await closed)assert.equal(event.code,1001)
    const results=await (await fetch(base+'/api/rooms/'+code+'/results')).json()
    assert.equal(results.at(-1).results.length,count)
    assert.ok(results.at(-1).results.every(p=>p.finish>0),JSON.stringify(bots.map(b=>({slot:b.ticket.slot,phase:b.sim.state.phase,at:b.sim.state.distance,checkpoints:b.sim.state.checkpointsPassed,finish:b.room.players.find(p=>p.id===b.ticket.id)?.finish}))))
    console.log('Draining refused new rooms, saved the running round and closed every socket with 1001')
  }
}finally{
  for(const b of bots)if(b.ws.readyState===1){b.send({type:'leave'});b.ws.close()}
  if(child){try{process.kill(-child.pid,'SIGTERM')}catch{};await Promise.race([once(child,'exit'),sleep(1500)]);await rm(temp,{recursive:true,force:true})}
}
