import assert from 'node:assert/strict'
import {once} from 'node:events'
import {lanAddresses} from './lan-address.mjs'

const nic=address=>[{family:'IPv4',internal:false,address}]
assert.deepEqual(lanAddresses({docker0:nic('172.17.0.1'),eth0:nic('10.0.0.2'),wlan1:nic('192.168.1.8'),
  utun1:nic('10.9.0.1'),en1:nic('169.254.1.1')}),['192.168.1.8','10.0.0.2'])
for(const base of process.argv.slice(2)){
  const url=new URL(base)
  const health=await (await fetch(new URL('/api/health',url))).json()
  assert.equal(health.multiplayer,true)
  const mobile=await fetch(url,{redirect:'manual',headers:{'user-agent':'iPhone'}})
  assert.equal(mobile.headers.get('location'),'/pad')
  const post=async(path,origin)=>{
    const r=await fetch(new URL(path,origin),{method:'POST',headers:{origin},body:'{}'})
    assert.equal(r.status,200)
    return r.json()
  }
  const host=await post('/api/pads',url.origin)
  assert.equal(host.padOrigin,health.inviteOrigin)
  const phone=await post('/api/pads/'+host.code+'/join',host.padOrigin)
  const connect=async(ticket,origin)=>{
    const socket=new WebSocket(origin.replace(/^http/,'ws')+'/api/pads/'+ticket.code+'/socket',['western',ticket.token])
    await once(socket,'open',{signal:AbortSignal.timeout(5000)})
    return socket
  }
  const desktop=await connect(host,url.origin)
  try{
    const pad=await connect(phone,host.padOrigin)
    try{
      const received=new Promise(resolve=>desktop.addEventListener('message',e=>{
        const m=JSON.parse(e.data)
        if(m.type==='pad')resolve(m.input)
      }))
      const input={steer:-.6,profile:'wheel',throttle:1,brake:0,handbrake:1}
      pad.send(JSON.stringify({type:'pad',input}))
      const timeout=AbortSignal.timeout(5000)
      assert.deepEqual(await Promise.race([received,once(timeout,'abort').then(()=>null)]),input)
      console.log(url.protocol,'phone join, advertised origin and handbrake relay passed')
    }finally{pad.close()}
  }finally{desktop.close()}
}
