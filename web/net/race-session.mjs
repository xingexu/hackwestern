import {PROTOCOL,RULES,Cadence,decode,encode,frameState} from './wire.mjs'
import {SIM_VERSION} from '../race/version.mjs'
import {Clock,Lag,StampMap} from './timing.mjs'
import {Track} from './motion.mjs'

export const versions={protocol:PROTOCOL,rules:RULES,sim:SIM_VERSION}
export async function post(path,body){
  const res=await fetch(path,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(4500)})
  const data=await res.json()
  if(!res.ok)throw Object.assign(new Error(data.reason||'Connection failed'),{status:res.status})
  return data
}
let identifying
async function identify(){
  const cached=JSON.parse(localStorage.getItem('western-account')||'null')
  if(cached)return cached
  identifying??=post('/api/identity',{}).then(id=>{localStorage.setItem('western-account',JSON.stringify(id));return id}).finally(()=>{identifying=null})
  return identifying
}
export async function seat(code,profile){
  const path='/api/rooms'+(code?'/'+encodeURIComponent(code.toUpperCase())+'/join':'')
  const reserve=async()=>post(path,{...profile,...await identify(),...versions})
  try{return await reserve()}catch(e){
    if(e.status!==401)throw e
    localStorage.removeItem('western-account')
    return reserve()
  }
}
function impaired(config,seed){
  const lag=new Lag({...config,seed})
  return (fn,reliable)=>{
    if(!lag.latency && !lag.loss && !lag.jitter)return fn()
    const now=performance.now(),due=lag.delivery(now,reliable)
    if(Number.isFinite(due))setTimeout(fn,Math.max(0,due-now))
  }
}
export class RaceSession{
  peers=new Map()
  tracks=new Map()
  clock=new Clock()
  cadence=new Cadence()
  seq=0
  epoch=1
  constructor(ticket,profile,receive,status){
    Object.assign(this,{ticket,profile,receive,status})
    const q=new URLSearchParams(location.search)
    this.config={latency:Math.max(0,Number(q.get('lag'))||0),loss:Math.min(1,Math.max(0,Number(q.get('loss'))||0)),jitter:Math.max(0,Number(q.get('jitter'))||0)}
    this.open()
  }
  open(){
    const url=new URL('/api/rooms/'+this.ticket.code+'/socket',location.href)
    url.protocol=url.protocol==='https:'?'wss:':'ws:'
    url.search=new URLSearchParams(versions)
    const ws=this.ws=new WebSocket(url,['western',this.ticket.token])
    ws.binaryType='arraybuffer'
    this.clock=new Clock()
    this.tx=impaired(this.config,31+this.ticket.slot)
    const rx=impaired(this.config,61+this.ticket.slot)
    ws.onopen=()=>{
      this.connected=true;this.lost=0;this.status('Connected')
      const ping=()=>{
        if(ws!==this.ws || !this.connected)return
        this.send({type:'ping',sent:performance.now(),rtt:this.clock.rtt})
        this.pingTimer=setTimeout(ping,this.clock.interval)
      }
      ping()
    }
    ws.onmessage=({data})=>rx(()=>{
      if(ws!==this.ws || !this.connected)return
      if(typeof data!=='string')return this.state(data,'relay')
      const m=JSON.parse(data)
      if(m.type==='pong')this.clock.observe(m.sent,performance.now(),m.now)
      else if(m.type==='room'){this.roster(m.players);this.receive(m)}
      else if(m.type==='signal')this.signal(m.from,m.data)
    },typeof data==='string')
    ws.onclose=e=>{
      this.connected=false;clearTimeout(this.pingTimer)
      for(const slot of this.peers.keys())this.drop(slot)
      this.direct=''
      if(this.closed)return
      if([1000,4001].includes(e.code)){this.closed=true;return this.status(e.code===4001?'Session replaced':'Session ended')}
      this.lost||=performance.now()
      this.status(e.code===1001 && e.reason==='Server updating'?'Server updating. Reconnecting…':'Connection lost. Reconnecting…')
      this.retry=setTimeout(()=>this.reconnect(),500)
    }
  }
  async reconnect(){
    if(this.closed)return
    if(performance.now()-this.lost>20000){this.closed=true;this.status('Seat expired');return}
    try{
      const next=await seat(this.ticket.code,{...this.profile,expectedSeat:this.ticket.id})
      if(next.id!==this.ticket.id)throw Object.assign(Error('Seat expired'),{status:410})
      this.ticket=next
      if(!this.closed)this.open()
    }catch(e){
      if([404,409,410,426].includes(e.status)){this.closed=true;this.status(e.message);return}
      this.retry=setTimeout(()=>this.reconnect(),900)
    }
  }
  send(m){
    const ws=this.ws
    if(ws?.readyState===1)this.tx(()=>{if(ws.readyState===1)ws.send(JSON.stringify(m))},true)
  }
  drop(slot){
    const p=this.peers.get(slot)
    this.peers.delete(slot)
    p?.pc?.close()
  }
  roster(players){
    this.generation=players.find(p=>p.id===this.ticket.id)?.generation
    for(const [slot,p] of this.peers){
      if(!players.some(q=>q.slot===slot && q.id===p.id && q.generation===p.generation && q.connected)){
        this.drop(slot);this.tracks.delete(slot)
      }
    }
    for(const q of players){
      if(!q.connected || q.slot===this.ticket.slot || this.peers.has(q.slot))continue
      this.tracks.set(q.slot,new Track())
      const p={...q,rtt:new Clock(),map:new StampMap(),last:-Infinity,tx:impaired(this.config,47+q.slot),attempt:0}
      this.peers.set(q.slot,p)
      if(this.ticket.slot<p.slot)this.dial(p)
    }
  }
  signalPeer(p,data){
    this.send({type:'signal',to:p.slot,generation:p.generation,source:this.generation,data:{...data,attempt:p.attempt}})
  }
  dial(p){
    if(typeof RTCPeerConnection==='undefined')return
    p.attempt++
    this.signalPeer(p,{dial:true})
    this.peerConnection(p,true)
  }
  peerConnection(p,initiator){
    const old=p.pc
    p.pc=null;p.ch=null;p.ice=[];p.last=-Infinity;p.dialed=performance.now()
    old?.close()
    let pc
    try{pc=p.pc=new RTCPeerConnection({iceServers:this.ticket.iceServers})}catch{return}
    pc.onicecandidate=e=>{if(e.candidate && p.pc===pc)this.signalPeer(p,{ice:e.candidate.toJSON()})}
    pc.ondatachannel=e=>{if(p.pc===pc)this.channel(p,e.channel)}
    if(initiator){
      this.channel(p,pc.createDataChannel('states',{ordered:false,maxRetransmits:0}))
      pc.onnegotiationneeded=async()=>{
        try{await pc.setLocalDescription();if(p.pc===pc)this.signalPeer(p,{sdp:pc.localDescription.toJSON()})}catch{}
      }
    }
  }
  async signal(slot,data){
    const p=this.peers.get(slot)
    if(!p || !data || !Number.isInteger(data.attempt))return
    if(data.dial && slot<this.ticket.slot && data.attempt>p.attempt){
      p.attempt=data.attempt
      this.peerConnection(p,false)
      return
    }
    const pc=p.pc
    if(!pc || p.attempt!==data.attempt)return
    try{
      if(data.sdp){
        await pc.setRemoteDescription(data.sdp)
        for(const ice of p.ice.splice(0))await pc.addIceCandidate(ice)
        if(data.sdp.type==='offer'){await pc.setLocalDescription();if(p.pc===pc)this.signalPeer(p,{sdp:pc.localDescription.toJSON()})}
      }else if(data.ice){
        if(pc.remoteDescription)await pc.addIceCandidate(data.ice)
        else p.ice.push(data.ice)
      }
    }catch{}
  }
  channel(p,ch){
    p.ch=ch;ch.binaryType='arraybuffer'
    ch.onclose=()=>{if(p.ch!==ch)return;p.last=-Infinity;p.dialed=performance.now();this.paths(performance.now())}
    ch.onmessage=({data})=>{
      if(this.peers.get(p.slot)!==p)return
      if(typeof data!=='string')return this.state(data,'direct',p)
      let m
      try{m=JSON.parse(data)}catch{return}
      if(!m || typeof m!=='object')return
      const now=performance.now()
      if(m.ping!==undefined)this.peerSend(p,JSON.stringify({pong:m.ping,at:now,ref:this.clock.synced?this.clock.offset:null}))
      if(m.pong!==undefined){p.rtt.observe(m.pong,now,m.at);p.ref=m.ref}
    }
    ch.onopen=()=>{p.nextPing=0}
  }
  peerSend(p,data){
    if(p.ch?.readyState==='open')p.tx(()=>{if(p.ch.readyState==='open' && p.ch.bufferedAmount<8192)p.ch.send(data)},false)
  }
  state(data,path,p){
    if(!this.clock.synced)return
    const s=decode(data),now=performance.now()
    if(!s || (p && (s.slot!==p.slot || !p.rtt.count)))return
    s.time=p?p.map.map(s.stamp,now,p.rtt.rtt,Number.isFinite(p.ref)?p.ref-this.clock.offset:undefined):this.clock.local(s.stamp)
    const track=this.tracks.get(s.slot)
    track?.push(s,path,now)
    if(p && track?.paths.direct.at(-1)===s && now-s.time<300)p.last=now
  }
  paths(now){
    const slots=[...this.peers.values()].filter(p=>now-p.last<180).map(p=>p.slot)
    if(slots.join(',')!==this.direct){this.direct=slots.join(',');this.send({type:'paths',slots})}
  }
  reset(){
    this.epoch=(this.epoch+1)&65535
    this.previous=null
    this.send({type:'recover'})
  }
  frame(car,input,stamp){
    if(!this.connected || !this.cadence.take(stamp))return
    const ws=this.ws,now=performance.now()
    const state=frameState(car,input,this.previous,stamp,this.ticket.slot,this.seq++,this.epoch)
    this.previous=state
    const bytes=encode(state)
    this.tx(()=>{if(ws.readyState===1 && ws.bufferedAmount<8192)ws.send(bytes)},false)
    for(const p of this.peers.values()){
      if(p.ch?.readyState!=='open'){
        if(this.ticket.slot<p.slot && now-p.dialed>10000)this.dial(p)
        continue
      }
      if(now>=(p.nextPing||0)){p.nextPing=now+p.rtt.interval;this.peerSend(p,JSON.stringify({ping:now}))}
      this.peerSend(p,bytes)
    }
    this.paths(now)
  }
  close(){
    this.closed=true;clearTimeout(this.retry);clearTimeout(this.pingTimer)
    if(this.ws?.readyState===1)this.ws.send(JSON.stringify({type:'leave'}))
    this.ws?.close()
  }
}
