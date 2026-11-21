import {json,nicknameOK,readBytes} from './common.mjs'
import {observeRacePose,Relay,newRoundRoom,command,transition,removePlayer,seatGrace,drainGrace} from './referee.mjs'
import {CAPACITY,PROTOCOL,RULES} from '../web/net/wire.mjs'
import {iceServers} from './ice.mjs'
import {SIM_VERSION} from '../web/race/version.mjs'

const uid=()=>crypto.randomUUID()
const versions={protocol:PROTOCOL,sim:SIM_VERSION,rules:RULES}
const compatible=m=>Object.entries(versions).every(([k,v])=>m?.[k]===v)
const internal=(path,body)=>new Request('https://internal/'+path,{method:'POST',body:JSON.stringify(body)})
const failure=(reason,status=400)=>json({reason},status)
const latestResults=32
export class Arena{
  constructor(ctx,env){
    this.ctx=ctx;this.env=env;this.relay=new Relay();this.connections=new Map()
    ctx.blockConcurrencyWhile(async()=>{this.r=await ctx.storage.get('room')})
  }
  directory(path,body){return this.env.RACES.getByName('directory').fetch(internal(path,body))}
  async registry(path,m){
    const storage=this.ctx.storage
    if(path==='identity' || path==='verify'){
      this.key ??= (async()=>{
        const stored=await storage.get('hmac')
        if(stored)return crypto.subtle.importKey('raw',stored,{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])
        const key=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},true,['sign','verify'])
        await storage.put('hmac',await crypto.subtle.exportKey('raw',key))
        return key
      })()
      const key=await this.key
      const bytes=s=>new TextEncoder().encode(s)
      if(path==='identity'){
        const account=uid(),signature=await crypto.subtle.sign('HMAC',key,bytes(account))
        return json({account,proof:btoa(String.fromCharCode(...new Uint8Array(signature)))})
      }
      try{if(await crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(m.proof),c=>c.charCodeAt(0)),bytes(m.account)))return json({ok:true})}catch{}
      return failure('Identity expired',401)
    }
    const drain=await storage.get('drain') || 0
    if(path==='health')return json({draining:!!drain,deadline:drain,graceMs:drainGrace,...versions})
    if(path==='register'){
      if(drain)return failure('Server updating',503)
      await storage.put('code:'+m.code,true);return json({ok:true})
    }
    if(path==='unregister'){await storage.delete('code:'+m.code);return json({ok:true})}
    if(path==='drain' || path==='resume'){
      const until=path==='drain'?(drain||Date.now()+drainGrace):0
      await storage.put('drain',until)
      for(const key of (await storage.list({prefix:'code:'})).keys()){
        await this.env.RACES.getByName(key).fetch(internal('maintenance',{until}))
      }
      return json({deadline:until,graceMs:drainGrace})
    }
    return failure('Not found',404)
  }
  sockets(id){return this.ctx.getWebSockets(id).filter(ws=>ws.readyState===1)}
  send(ws,m){if(ws.readyState===1)ws.send(JSON.stringify(m))}
  view(){
    const r=this.r
    return {...r,type:'room',players:r.players.map(({token,account,until,arrival,track,...p})=>p)}
  }
  event(p,name){
    console.log(JSON.stringify({event:name,room:this.r.code,mode:this.r.settings.course,arrival:p.arrival,player:p.id,playerCount:this.r.players.length,phase:this.r.phase}))
  }
  async save(before){
    const r=this.r,now=Date.now()
    if(before && before!==r.phase){
      const step={countdown:'start handshake done',playing:'round started',lobby:'back in room'}[r.phase]
      if(step)for(const p of r.players)this.event(p,step)
    }
    if(r.phase==='results' && r.saved!==r.race){
      await this.ctx.storage.put('result:'+r.race,{race:r.race,course:r.settings.course,at:now,results:r.results})
      const past=await this.ctx.storage.list({prefix:'result:'})
      if(past.size>latestResults){
        const oldest=[...past].sort((a,b)=>a[1].at-b[1].at)[0][0]
        await this.ctx.storage.delete(oldest)
      }
      r.saved=r.race
      for(const p of r.players)this.event(p,'round finished')
    }
    r.revision=(r.revision??0)+1
    await this.ctx.storage.put('room',r)
    const timers=[r.deadline,...r.players.map(p=>p.until),r.drain>now && r.drain,!r.players.length && now+3600000].filter(Boolean)
    if(timers.length)await this.ctx.storage.setAlarm(Math.min(...timers))
    else await this.ctx.storage.deleteAlarm()
    const view=this.view()
    for(const ws of this.sockets())this.send(ws,view)
    if(r.drain && (r.phase==='lobby' || r.phase==='results' || now>=r.drain)){
      for(const ws of this.sockets())ws.close(1001,'Server updating')
    }
  }
  async fetch(req){
    const url=new URL(req.url)
    if(url.hostname==='internal'){
      const path=url.pathname.slice(1),m=await req.json()
      if(path!=='maintenance')return this.registry(path,m)
      if(this.r){this.r.drain=m.until;await this.save()}
      return json({ok:true})
    }
    const [,,,code,action]=url.pathname.split('/')
    if(action==='results')return req.method==='GET'?json([...await this.ctx.storage.list({prefix:'result:'})].map(([,v])=>v)):failure('GET required',405)
    if(this.r && !compatible(this.r.versions))return failure('Update required',426)
    if(action==='socket'){
      if(req.headers.get('upgrade')?.toLowerCase()!=='websocket')return failure('WebSocket required',426)
      if(!compatible(Object.fromEntries([...url.searchParams].map(([k,v])=>[k,Number(v)]))))return failure('Update required',426)
      const token=req.headers.get('Sec-WebSocket-Protocol')?.split(',')[1]?.trim()
      const p=this.r?.players.find(p=>p.token===token)
      if(!p || (p.until && p.until<=Date.now()))return failure('Seat expired',403)
      if(this.r.drain && ['lobby','results'].includes(this.r.phase))return failure('Server updating',503)
      const [client,ws]=Object.values(new WebSocketPair())
      for(const old of this.sockets(p.id))old.close(4001,'Replaced')
      this.ctx.acceptWebSocket(ws,[p.id]);ws.serializeAttachment({id:p.id})
      this.relay.forget(p.slot);this.connections.delete(p.id)
      for(const connection of this.connections.values())connection.direct.delete(p.slot)
      if(p.joined)this.event(p,'reconnected')
      p.generation=(p.generation||0)+1;p.connected=true;p.joined=true;p.until=0;p.loaded=false
      await this.save()
      return new Response(null,{status:101,webSocket:client,headers:{'Sec-WebSocket-Protocol':'western'}})
    }
    if(req.method!=='POST')return failure('POST required',405)
    let m
    try{m=JSON.parse(new TextDecoder().decode(await readBytes(req,2048)))}catch{return failure('Invalid profile')}
    if(!compatible(m))return failure('Update required',426)
    if(!nicknameOK(m.nickname) || !/^#[0-9a-f]{6}$/i.test(m.color))return failure('Invalid name or colour')
    if(!(await this.directory('verify',{account:m.account,proof:m.proof})).ok)return failure('Identity expired',401)
    if(action==='create'){
      if(this.r || (await this.ctx.storage.list({prefix:'result:',limit:1})).size)return failure('Code in use',409)
      if(!(await this.directory('register',{code})).ok)return failure('Server updating',503)
      this.r={...newRoundRoom(code),versions}
    }
    const r=this.r
    if(!r)return failure('Room not found',404)
    let p=r.players.find(p=>p.account===m.account)
    if(m.expectedSeat && (!p || p.id!==m.expectedSeat || (p.until && p.until<=Date.now())))return failure('Seat expired',410)
    if(!p){
      if(r.drain)return failure('Server updating',503)
      if(r.phase!=='lobby' || r.players.length>=CAPACITY)return failure('Room is full or racing',409)
      let slot=0
      while(r.players.some(p=>p.slot===slot))slot++
      p={account:m.account,id:uid(),slot,token:uid(),nickname:m.nickname,color:m.color,ready:false,connected:false,loaded:false,joined:false,until:Date.now()+seatGrace,lap:0,finish:0,arrival:action==='create'?'created':m.arrival==='invite'?'invite':'code'}
      r.players.push(p);r.host??=p.id;this.event(p,'room joined')
    }
    await this.save()
    return json({id:p.id,slot:p.slot,token:p.token,kind:'rooms',code,iceServers:await iceServers(this.env,p.account,Date.now()),...versions})
  }
  async webSocketMessage(ws,msg){
    const attachment=ws.deserializeAttachment(),r=this.r,p=r?.players.find(p=>p.id===attachment.id)
    if(!p || ws.readyState!==1)return
    let c=this.connections.get(p.id)
    if(!c){
      c={direct:new Set(),rtt:0,resetAt:0};this.connections.set(p.id,c)
      if (attachment.track && attachment.race===r.race && attachment.lap===p.lap) p.track=attachment.track
    }
    const now=Date.now()
    if(typeof msg!=='string'){
      if(!p.loaded || r.phase==='results')return
      const packet=this.relay.receive(p.slot,msg,now,c.rtt,!!c.allowReset)
      if(!packet)return
      const advanced=observeRacePose(r,p,this.relay.sources.get(p.slot).state)
      if(advanced || (r.phase==='playing' && p.track?.point && now>=(c.snapshotAt??0))){
        c.snapshotAt=now+300
        ws.serializeAttachment({id:p.id,race:r.race,lap:p.lap,track:p.track})
      }
      c.allowReset=false
      for(const peer of r.players)if(peer!==p && !this.connections.get(peer.id)?.direct.has(p.slot)){
        for(const other of this.sockets(peer.id))other.send(packet)
      }
      return
    }
    if(msg.length>24000)return ws.close(1008,'Message too large')
    let m
    try{m=JSON.parse(msg)}catch{return ws.close(1007,'Invalid message')}
    if(!m || typeof m.type!=='string')return
    if(m.type==='ping'){
      if(Number.isFinite(m.rtt))c.rtt=Math.max(0,Math.min(2000,m.rtt))
      return this.send(ws,{type:'pong',sent:m.sent,now})
    }
    if(m.type==='paths'){c.direct=new Set(Array.isArray(m.slots)?m.slots.filter(Number.isInteger).slice(0,CAPACITY):[]);return}
    if(m.type==='signal'){
      const target=r.players.find(q=>q.slot===m.to && q!==p && q.generation===m.generation && p.generation===m.source)
      if(target)for(const peer of this.sockets(target.id))this.send(peer,{type:'signal',from:p.slot,data:m.data})
      return
    }
    if(m.type==='recover'){
      if(now-c.resetAt>750){c.allowReset=true;c.resetAt=now}
      return
    }
    if(m.type==='share'){this.event(p,'invite shared');return}
    if(m.type==='rename' && nicknameOK(m.nickname)){p.nickname=m.nickname;return this.save()}
    if(m.type==='leave'){
      const before=r.phase
      this.event(p,'left');removePlayer(r,p.id,now);ws.close(1000,'Left');this.relay.forget(p.slot);return this.save(before)
    }
    const before=r.phase,firstLoad=!p.loaded,firstVote=!p.vote
    if(command(r,p,m,now,uid)){
      const event={loaded:firstLoad && 'game loaded',ready:m.ready && 'ready',start:'start clicked',vote:firstVote && 'restart vote'}[m.type]
      if(event)this.event(p,event)
      if(m.type==='placed')c.allowReset=true
      if(m.type==='lap')c.allowReset=true
      await this.save(before)
    }else if(m.type==='lap' && r.phase==='playing' && !p.finish && c.denied!==r.race){
      c.denied=r.race
      console.log(JSON.stringify({event:'pending checkpoints',room:r.code,slot:p.slot,passed:p.track?.passed??0}))
    }
  }
  async webSocketClose(ws){
    const id=ws.deserializeAttachment()?.id,p=this.r?.players.find(p=>p.id===id)
    if(p?.connected && !this.sockets(id).some(s=>s!==ws)){
      const before=this.r.phase
      p.connected=false;p.until=Date.now()+seatGrace;p.ready=false
      this.connections.delete(id);this.event(p,'connection failed')
      transition(this.r,Date.now());await this.save(before)
    }
    if(ws.readyState===2)ws.close(1000,'Closed')
  }
  webSocketError(ws){return this.webSocketClose(ws)}
  async alarm(){
    const r=this.r,now=Date.now()
    if(!r)return
    if(!r.players.length){
      await this.directory('unregister',{code:r.code})
      await this.ctx.storage.delete('room');this.r=null;return
    }
    const before=r.phase
    for(const p of r.players.slice())if(p.until && p.until<=now){this.event(p,'left');removePlayer(r,p.id,now);this.relay.forget(p.slot)}
    if(r.drain && r.drain<=now && r.race && r.phase!=='results'){r.phase='playing';r.deadline=now}
    transition(r,now)
    await this.save(before)
  }
}
