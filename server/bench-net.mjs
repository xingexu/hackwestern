import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {createDriveSim} from '../web/drive-sim.mjs'
import {createRaceContext} from '../web/race/context.mjs'
import {driveInput} from '../web/dev/circuit_driver.mjs'
import {Snapshots} from '../web/net/session.mjs'
import {decode,encode,frameState,Cadence,BYTES,CAPACITY,HZ} from '../web/net/wire.mjs'
import {Clock,StampMap,Lag} from '../web/net/timing.mjs'
import {Track,contact} from '../web/net/motion.mjs'
import {Relay,newRoundRoom,command,transition} from './referee.mjs'

const scenarios={
  direct20:{latency:20},direct50:{latency:50},direct100:{latency:100},loss:{loss:.01},wifi:{stall:1},tail:{tail:1},drift:{drift:50},
  school:{school:1,relay:1,asym:1,latency:90,loss:.075,jitter:15},outage:{outage:1},relay:{relay:1},asymmetric:{asym:1},hitches:{hitch:1},slow30:{slow:1},grid:{grid:1},contact:{contact:1}
}
const quick=process.argv.includes('--quick'),ablate=process.argv.includes('--ablate'),trace=process.argv.indexOf('--trace')
const csv=process.argv.indexOf('--csv'),duration=quick?12000:45000
const traces=[],rows=[]
function pct(values,p){const sorted=values.slice().sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]||0}
function run(name,settings,mode){
  const cfg={latency:50,jitter:5,loss:0,...settings}
  const context=createRaceContext('stadium'),ref=new Relay(),round=newRoundRoom('BENCH2')
  const rng=new Lag({seed:421}),queue=[]
  const client=[0,1].map((i)=>{
    const sim=createDriveSim(context.samples,{mode:'circuit',network:context.network})
    if(cfg.contact)sim.state.x+=i*2.4
    else {const side=i?1.4:-1.4;sim.state.x+=Math.cos(sim.state.heading)*side;sim.state.z-=Math.sin(sim.state.heading)*side}
    const scale=1+(i?1:-1)*(cfg.drift??12)/1e6,offset=i?1276:433
    return {sim,time:t=>t*scale+offset,inverse:t=>(t-offset)/scale,clock:new Clock(),map:new StampMap(),peerClock:new Clock(),track:new Track(),old:new Snapshots(),pace:new Cadence(),seq:0,prev:null,next:0,nextPing:-4000,serverRtt:0,lastDirect:-Infinity,arrivals:new Map()}
  })
  round.players=client.map((_,id)=>({id,loaded:true,ready:true,connected:true}));round.host=0
  command(round,round.players[0],{type:'start'},-4000,()=>1)
  for(const p of round.players)command(round,p,{type:'placed',race:1},cfg.grid?50:-3100)
  function enqueue(at,fn){let i=queue.length;while(i && queue[i-1].at>at)i--;queue.splice(i,0,{at,fn})}
  function delay(t,direct,reverse=false){
    let d=(direct?cfg.latency:cfg.latency*.7)+(rng.random()-.5)*2*cfg.jitter
    if(cfg.asym)d*=reverse?1.7:.45
    if(cfg.tail && rng.random()<.13)d+=5/(.015+rng.random())
    if(cfg.stall && t%4900>4480)d+=465
    if(cfg.hitch && t%2700>2570)d+=140
    return Math.max(1,d)
  }
  const ordered=new Map()
  function socketArrival(key,t,reverse){
    let due=t+delay(t,false,reverse)
    if(!cfg.school)return due
    if(rng.random()<cfg.loss)due+=120+180*rng.random()
    if(t%7300>6950)due+=300
    if(t%1700>1300)due+=80*rng.random()
    due=Math.max(due,(ordered.get(key)??-Infinity)+.02)
    ordered.set(key,due)
    return due
  }
  const along=[],lat=[],bias=[],wobble=[],ages=[],timing=[],predictor=[],stale=[],smoothing=[],slide=[],gap=[]
  let jumps=0,reversals=0,frames=0,contacts=0,ghosts=0,hidden=0,firstDraw=0
  const idealRtt=oneWay=>Math.max(1,oneWay-cfg.jitter)*(cfg.asym?2.15:2)
  const tick=1000/120
  for(let k=-480;k*tick<duration;k++){
    const t=k*tick
    while(queue.length && queue[0].at<=t+.001){const e=queue.shift();e.fn(e.at)}
    transition(round,t)
    for(let i=0;i<2;i++){
      const c=client[i],other=client[1-i],car=c.sim.state
      if(t>=c.nextPing){
        for(const direct of [false,true]){
          const hit=direct?t+delay(t,true):socketArrival(i+'up',t,false),sent=c.time(t)
          enqueue(hit,at=>enqueue(direct?at+delay(at,true,true):socketArrival(i+'down',at,true),end=>{
            const clock=direct?c.peerClock:c.clock
            clock.observe(sent,c.time(end),direct?other.time(at):at)
            c.serverRtt=c.clock.rtt
            if(direct && other.clock.synced)c.peerRef=other.clock.offset
          }))
        }
        c.nextPing=t+c.clock.interval
      }
      if(t<0)continue
      const input=driveInput(context.samples,car)
      if(round.phase==='playing')c.sim.step(input)
      if(t+.001<c.next)continue
      c.next=t+(cfg.slow && i?2:1)*1000/60+(cfg.hitch && rng.random()<.05?70:0)
      if(mode==='legacy'?t-(c.lastSend??-100)>=40:c.pace.take(c.time(t))){
        c.lastSend=t
        const state=frameState(car,input,c.prev,c.time(t),i,++c.seq,0);c.prev=state
        const late=cfg.slow && i?4+7*rng.random():cfg.hitch && k%127<7?35:0
        const sent=t+late,bytes=encode(state)
        function deliver(packet,path,arrival){
          const s=decode(packet),now=other.time(arrival)
          const local=mode==='sender'?other.time(t):path==='direct'?other.map.map(s.stamp,now,mode==='rtt'?idealRtt(cfg.latency):other.peerClock.rtt,mode!=='midpoint' && Number.isFinite(other.peerRef)?other.peerRef-other.clock.offset:undefined):mode==='receiver'?other.time(s.stamp):other.clock.local(s.stamp)
          if(!other.clock.synced)return
          const known=other.arrivals.get(s.seq)
          if(known && known.path!==path)gap.push(Math.abs(local-known.local))
          other.arrivals.set(s.seq,{path,local})
          if(path==='direct')other.lastDirect=arrival
          other.track.push({...s,time:local,trueTime:t},path,now)
        }
        const down=cfg.outage && t%9000>4900 && t%9000<7600
        if(!cfg.relay && mode!=='legacy' && !down && rng.random()>=cfg.loss){
          enqueue(sent+delay(sent,true,i===1),arrival=>deliver(bytes,'direct',arrival))
        }
        const serverAt=socketArrival(i+'up',sent,false)
        enqueue(serverAt,arr=>{
          const accepted=ref.receive(i,bytes,arr,mode==='rtt'?idealRtt(cfg.latency*.7):c.serverRtt)
          if(!accepted)return
          const stamp=decode(accepted).stamp
          if(mode==='legacy'){
            enqueue(socketArrival((1-i)+'down',arr,true),()=>other.old.push({...state,heading:decode(bytes).heading,now:arr,speed:Math.hypot(state.vx,state.vz)}))
          }else if(cfg.relay || arr-other.lastDirect>130 || c.seq%30===0){
            if(rng.random()>=cfg.loss)enqueue(arr+delay(arr,false,true),arrival=>deliver(accepted,'relay',arrival))
          }
          if(mode!=='legacy' && c.lastMap && arr>c.lastMap.at)slide.push(Math.abs((stamp-state.stamp)-c.lastMap.offset)/(arr-c.lastMap.at)*1000)
          c.lastMap={at:arr,offset:stamp-state.stamp}
        })
      }
    }
    if(t<0)continue
    for(let i=0;i<2;i++){
      const c=client[i],other=client[1-i],truth=other.sim.state,now=c.time(t)
      if(c.lastDraw!==undefined && t-c.lastDraw<1000/(cfg.slow && i?30:60)-.001)continue
      const drawn=mode==='legacy'?c.old.at(t):c.track.draw(now)
      if(!drawn){if(c.lastDraw!==undefined)hidden++;continue}
      if(!firstDraw)firstDraw=t
      if(drawn.ghost)ghosts++
      c.track.clearIfSeparated(drawn,[c.sim.state])
      if(cfg.contact && mode!=='legacy' && contact(c.sim.state,drawn,1/60))contacts++
      const dx=drawn.x-truth.x,dz=drawn.z-truth.z,s=Math.sin(truth.heading),co=Math.cos(truth.heading)
      const forward=dx*s+dz*co,side=dx*co-dz*s,dt=(t-(c.lastDraw??t))/1000
      along.push(Math.abs(forward));lat.push(Math.abs(side));bias.push(forward);frames++
      if(c.lastPose && dt>0){
        const step=(drawn.x-c.lastPose.x)*s+(drawn.z-c.lastPose.z)*co
        if(Math.hypot(drawn.x-c.lastPose.x,drawn.z-c.lastPose.z)>Math.max(2,85*dt))jumps++
        const back=step<-.015 && truth.speed>1
        if(back && !c.back)reversals++
        c.back=back
      }
      c.low=(c.low??forward)+(forward-(c.low??forward))*(1-Math.exp(-2*Math.PI*2*dt))
      wobble.push((forward-c.low)**2)
      if(mode!=='legacy'){
        const track=c.track,latest=track.paths[track.path].at(-1),raw=track.raw(now)
        const exactAge=t-latest.trueTime
        const perfect=track.raw(latest.time+exactAge)
        const project=p=>(p.x-truth.x)*s+(p.z-truth.z)*co
        timing.push(Math.abs(project(raw)-project(perfect)));smoothing.push(Math.abs(forward-project(raw)))
        predictor.push(exactAge<=300?Math.abs(project(perfect)):0);stale.push(exactAge>300?Math.abs(project(perfect)):0)
        ages.push(Number(drawn.age>.3))
        if(trace>=0 && i===0)traces.push([name,mode,t,forward,side,latest.time-c.time(latest.trueTime),drawn.age,track.path,track.correction].join(','))
      }
      c.lastPose=drawn;c.lastDraw=t
    }
  }
  const mean=a=>a.reduce((a,b)=>a+b,0)/(a.length||1),rate=n=>n*60000/(2*duration)
  if(cfg.contact && mode!=='legacy')assert.ok(contacts>0,'Contact scenario must exercise collisions')
  assert.ok(frames>duration/100,'No remote frames')
  return [name,mode,...[along,lat].flatMap(v=>[pct(v,.5),pct(v,.95),Math.max(...v)]),mean(bias),Math.sqrt(mean(wobble)),rate(reversals),rate(jumps),100*mean(ages),pct(slide,.95),pct(gap,.95),...[timing,predictor,stale,smoothing].map(v=>pct(v,.95)),100*ghosts/frames,100*hidden/(frames+hidden),firstDraw]
}
const header='scenario,mode,along50_m,along95_m,alongMax_m,side50_m,side95_m,sideMax_m,bias_m,wobble_m,reversals_min,jumps_min,overCap_pct,slew95_ms_s,pathGap95_ms,timing95_m,predictor95_m,stale95_m,smoothing95_m,ghost_pct,hidden_pct,first_draw_ms'
console.log(header)
for(const [name,cfg] of Object.entries(scenarios)){
  if(quick && !['direct50','outage','slow30','school','asymmetric'].includes(name))continue
  for(const mode of (ablate?['legacy','live','midpoint','rtt','sender','receiver']:['legacy','live'])){
    const row=run(name,cfg,mode)
    rows.push(row.map(v=>typeof v==='number'?v.toFixed(3):v).join(','))
    console.log(rows.at(-1))
    if(name==='asymmetric' && mode==='live')assert.ok(row[3]<.12 && row[14]<12)
    if(name==='school' && mode==='live'){assert.ok(row[3]<1.25 && row[6]<.75);assert.equal(row[11],0);assert.ok(row[12]>0)}
    if(name==='direct50' && mode==='live'){assert.ok(row[3]<.75 && row[6]<.5);assert.equal(row[11],0)}
  }
}
if(csv>=0)writeFileSync(process.argv[csv+1],[header,...rows].join('\n')+'\n')
if(trace>=0)writeFileSync(process.argv[trace+1],['scenario,mode,true_ms,along_m,side_m,stamp_error_ms,age_s,path,correction_m',...traces].join('\n')+'\n')
console.log('Eight slots, bytes/s per client at 60Hz:',BYTES*HZ*(CAPACITY-1),'all relay inbound;',BYTES*HZ*CAPACITY,'upload including server + seven direct peers')
