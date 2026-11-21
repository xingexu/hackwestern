import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {setTimeout as delay} from 'node:timers/promises'
import {PROTOCOL,RULES} from '../web/net/wire.mjs'
import {SIM_VERSION} from '../web/race/version.mjs'
import {decodeReplay} from '../web/race/replay.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const controllerSource=(await readFile(new URL('../web/dev/circuit_driver.mjs',import.meta.url),'utf8')).replace('export function','function')
const processes=[]
let browser
const baseDir=join(root,'.wrangler')
await mkdir(baseDir,{recursive:true})
const temp=await mkdtemp(join(baseDir,'verify-'))
async function freePort(){
  const srv=createServer().listen(0,'127.0.0.1')
  await once(srv,'listening')
  const port=srv.address().port
  await new Promise(resolve=>srv.close(resolve))
  return port
}
async function launch(script,args){
  const port=await freePort()
  const p=spawn(process.execPath,[script,...args,'--port',String(port)],{cwd:root,detached:true,stdio:['ignore','pipe','pipe']})
  processes.push(p)
  let logs=''
  for(const stream of [p.stdout,p.stderr])stream.on('data',s=>{logs=(logs+s).slice(-8000)})
  const base='http://127.0.0.1:'+port
  for(let i=0;i<200;i++){
    if(p.exitCode!==null)throw Error(logs)
    try{if((await fetch(base,{method:'HEAD'})).ok)return base}catch{}
    await delay(100)
  }
  throw Error(logs)
}
try{
  const [worker,staticBase]=await Promise.all([launch('node_modules/wrangler/bin/wrangler.js',['dev','--local','--config','server/wrangler.jsonc','--var','MULTIPLAYER:1','--persist-to',temp,'--inspector-port','0']),launch('serve.mjs',[])])
  const html=await (await fetch(staticBase)).text()
  const manifest=JSON.parse(html.match(/id="campus-assets">(.*?)<\/script>/)[1])
  const world=await (await fetch(new URL(manifest['world.json'],staticBase))).json()
  for(const file of ['/',new URL(manifest['drive-network.json'],staticBase).pathname,new URL(world.coreMesh.url,staticBase).pathname]){
    for(const encoding of ['identity','br','br;q=0']){
      const headers={'accept-encoding':encoding}
      const [a,b]=await Promise.all([staticBase,worker].map(base=>fetch(base+file,{headers})))
      assert.equal(a.status,b.status)
      for(const header of ['cache-control','content-encoding','vary']) assert.equal(b.headers.get(header),a.headers.get(header),file+' '+encoding+' '+header)
      assert.deepEqual(new Uint8Array(await b.arrayBuffer()),new Uint8Array(await a.arrayBuffer()))
      assert.equal((await fetch(worker+file,{method:'HEAD',headers:{...headers,'if-none-match':b.headers.get('etag')}})).status,304)
    }
  }
  assert.equal((await fetch(worker+'/missing')).status,404)
  assert.equal((await fetch(worker+'/index.html.br')).status,404)
  console.log('Worker and static server returned equivalent identity/Brotli bodies, caching and conditional responses')
  const course='college',bytes=new Uint8Array(await readFile(new URL('../web/dev/fixtures/replays/college.bin',import.meta.url)))
  const replay=decodeReplay(bytes)
  const url=worker+'/api/laps/'+course+'?'+new URLSearchParams({playerId:crypto.randomUUID(),nickname:'Test Racer',timeMs:replay.timeMs})
  const submit=body=>fetch(url,{method:'POST',body})
  const response=await (await submit(bytes)).json()
  assert.equal(response.accepted,true,JSON.stringify(response))
  assert.equal(response.rank,1)
  const rows=await (await fetch(worker+'/api/laps/college?limit=1')).json()
  assert.equal(rows[0].verified,true)
  assert.equal(rows[0].entryId,response.entryId)
  assert.deepEqual(new Uint8Array(await (await fetch(worker+'/api/laps/college/'+response.entryId)).arrayBuffer()),bytes)
  const bad=bytes.slice()
  bad[20]^=1
  assert.equal((await submit(bad)).status,400)
  for(let i=0;i<4;i++)assert.equal((await submit(bad)).status,400)
  assert.equal((await submit(bad)).status,429)
  console.log('Leaderboard validated full physics, ranked and returned the replay, rejected altered hash and rate-limited retries')
  const queued=await launch('node_modules/wrangler/bin/wrangler.js',['dev','--local','--config','server/wrangler.jsonc','--var','VERIFY_MODE:queued','--persist-to',join(temp,'queued'),'--inspector-port','0'])
  for(const body of [bytes,bad]){
    const result=await (await fetch(url.replace(worker,queued),{method:'POST',body})).json()
    assert.equal(result.accepted,true,JSON.stringify(result))
    assert.equal(result.rank,null)
    const list=await (await fetch(queued+'/api/laps/college')).json()
    assert.equal(list.find(row=>row.entryId===result.entryId).verified,false)
  }
  let queuedRows
  for(let i=0;i<150;i++){
    queuedRows=await (await fetch(queued+'/api/laps/college')).json()
    if(queuedRows.length===1 && queuedRows[0].verified)break
    await delay(100)
  }
  assert.equal(queuedRows.length,1)
  assert.equal(queuedRows[0].verified,true)
  console.log('The verification alarm promoted the valid lap and removed the altered one')
  browser=await chromium.launch({args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',...(process.platform==='darwin'?['--use-angle=metal']:[])]})
  const errors=[]
  let releaseWorld
  async function desktop(nickname,invite=''){
    const ctx=await browser.newContext({viewport:{width:800,height:540}})
    await ctx.addInitScript({content:controllerSource+`
      const NativePeer=window.RTCPeerConnection
      window.testPeers=[]
      window.RTCPeerConnection=class extends NativePeer{constructor(...args){super(...args);window.testPeers.push(this)}}
      const original=navigator.getGamepads.bind(navigator)
      Object.defineProperty(navigator,'getGamepads',{value:()=>{
        const metrics=window.driveMetrics
        if(!window.racePilot || metrics?.mode!=='circuit')return original()
        const samples=metrics.network.circuits.find(c=>c.id===metrics.course).samples
        const {steer,throttle,brake}=driveInput(samples,metrics.car,7)
        return [{connected:true,mapping:'standard',axes:[-Math.sign(steer)*(.12+.88*Math.min(1,Math.abs(steer)))],buttons:Array.from({length:10},(_,i)=>({value:i===6?brake:i===7?throttle:0}))}]
      }})
    `})
    const page=await ctx.newPage()
    page.on('pageerror',e=>{errors.push(e.message);console.error(nickname,e.stack)})
    if(invite){
      const hold=new Promise(resolve=>{releaseWorld=resolve})
      await page.route(/\/assets\/world-[^/]+\.json$/,async r=>{await hold;await r.continue()},{times:1})
    }
    await page.goto(worker+'/?diagnostics&netdebug&lag=150&loss=.05&jitter=15'+(invite?'&room='+invite:''),{waitUntil:'domcontentloaded'})
    if(!invite)await page.getByRole('button',{name:'Online',exact:true}).click({timeout:60000})
    await page.locator('#race-name').fill(nickname)
    return page
  }
  const host=await desktop('Avery')
  await host.locator('#online-close').click()
  await host.locator('#drive-course').selectOption(course)
  await host.locator('#trial-open').click()
  await host.locator('#trial-opponent').selectOption(response.entryId)
  await host.locator('#trial-start').click()
  await host.waitForFunction(()=>!document.querySelector('#trial-setup').open && !document.querySelector('#trial-splits').hidden)
  await host.getByRole('button',{name:'Online',exact:true}).click()
  console.log('The time-trial menu loaded the verified leaderboard entry and started its downloaded ghost')
  await host.locator('#make-pad').click()
  await host.locator('#pad-qr[src]').waitFor()
  const padLink=await host.locator('#pad-url').getAttribute('href')
  assert.ok((await host.locator('#pad-qr').getAttribute('src')).startsWith('data:image/'))
  const mobile=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:844,height:390}})
  const phone=await mobile.newPage()
  await phone.goto(padLink)
  await phone.locator('#code').fill(await host.locator('#pad-code').innerText())
  await phone.getByRole('button',{name:'Pair controller'}).click()
  await phone.locator('#tilt').click()
  await host.waitForFunction(()=>document.getElementById('pad-state').textContent==='Phone connected')
  await host.locator('#drive-course').selectOption('stadium')
  const initial=await host.evaluate(()=>window.driveMetrics.car.heading)
  await phone.evaluate(()=>{
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{beta:0,gamma:0}))
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{beta:18,gamma:18}))
  })
  const gas=await phone.locator('#gas').boundingBox()
  await phone.mouse.move(gas.x+gas.width/2,gas.y+gas.height/2)
  await phone.mouse.down()
  await host.waitForFunction(h=>window.driveMetrics.car.speed>1 && Math.abs(window.driveMetrics.car.heading-h)>.04,initial,{timeout:10000})
  await phone.mouse.up()
  await host.getByRole('button',{name:'Phone controller',exact:true}).click()
  await host.locator('#phone-pair button[aria-label="Close"]').click()
  await phone.locator('#tilt').click()
  await host.getByRole('button',{name:'Online',exact:true}).click()
  console.log('Mobile tilt and gas moved and turned the desktop simulation through the paired relay')
  await host.locator('#make-room').click()
  await host.locator('#room-label').waitFor()
  const roomCode=(await host.locator('#room-label').innerText()).split(' ').at(-1)
  const guest=await desktop('Blake',roomCode)
  assert.equal(await guest.locator('#room-code').inputValue(),roomCode)
  await guest.locator('#room-code').fill(roomCode)
  await guest.locator('#race-color').fill('#4594db')
  await guest.locator('#join-room').click()
  await guest.locator('#room-label').waitFor()
  assert.equal(await guest.locator('#race-ready').textContent(),'Loading campus…')
  assert.ok(await guest.locator('#race-ready').isDisabled())
  releaseWorld()
  await guest.waitForFunction(()=>!document.querySelector('#race-ready').disabled)
  await guest.reload()
  await guest.getByRole('button',{name:'Online',exact:true}).click()
  await guest.waitForFunction(()=>document.querySelector('#room-roster').textContent.includes('Blake · Waiting'))
  const versions={protocol:PROTOCOL,rules:RULES,sim:SIM_VERSION}
  const reserveSeat=async name=>fetch(worker+'/api/rooms/'+roomCode+'/join',{method:'POST',body:JSON.stringify({...await (await fetch(worker+'/api/identity',{method:'POST'})).json(),...versions,nickname:name,color:'#eeeeee'})})
  const seats=[]
  for(const name of ['Casey','Dana','Eli','Fran','Gray','Harper']){
    const ticket=await (await reserveSeat(name)).json()
    const ws=new WebSocket(worker.replace('http:','ws:')+'/api/rooms/'+roomCode+'/socket?'+new URLSearchParams(versions),['western',ticket.token])
    await once(ws,'open')
    seats.push(ws)
  }
  assert.equal((await reserveSeat('Ninth')).status,409)
  await host.waitForFunction(()=>document.querySelectorAll('#room-roster li').length===8)
  for(const ws of seats){
    const left=once(ws,'close')
    ws.send(JSON.stringify({type:'leave'}))
    await left
  }
  await host.waitForFunction(()=>document.querySelectorAll('#room-roster li').length===2)
  console.log('A driver rejoined after reload, eight occupied slots excluded a ninth and leaving released six seats')
  await host.locator('#race-course').selectOption('stadium')
  await guest.waitForFunction(()=>document.querySelector('#race-course').value==='stadium')
  await host.locator('#race-contact').check()
  await guest.waitForFunction(()=>document.querySelector('#race-contact').checked)
  await host.locator('#race-contact').uncheck()
  await guest.waitForFunction(()=>!document.querySelector('#race-contact').checked)
  await Promise.all([host,guest].map(p=>p.locator('#race-ready').click()))
  await host.locator('#race-start').click()
  for(const p of [host,guest]) await p.waitForFunction(()=>window.driveMetrics.course==='stadium' && !document.querySelector('#race-banner').hidden)
  for(const p of [host,guest]) assert.ok(await p.locator('#trial-open').isDisabled())
  await phone.mouse.move(gas.x+gas.width/2,gas.y+gas.height/2)
  await phone.mouse.down()
  await host.waitForFunction(()=>window.driveMetrics.car.speed>1,null,{timeout:20000})
  await phone.mouse.up()
  await Promise.all([host,guest].map(p=>p.evaluate(()=>{window.racePilot=true})))
  await Promise.all([host,guest].map(p=>p.waitForFunction(()=>window.driveMetrics.opponents.length===1 && window.driveMetrics.car.distance>12,null,{timeout:45000})))
  for(const [page,peer] of [[host,guest],[guest,host]]){
    const remote=await page.evaluate(()=>window.driveMetrics.opponents[0])
    const paint=await page.evaluate(name=>window.driveMetrics.inspectLook().scene.getObjectByName(name).children[0].material.color.getHexString(),remote.name)
    assert.equal(paint,page===host?'4594db':'d94a28')
    const local=await peer.evaluate(()=>{const {x,z}=window.driveMetrics.car;return {x,z}})
    assert.ok(Math.hypot(remote.x-local.x,remote.z-local.z)<20)
  }
  try{
    await Promise.all([host,guest].map(p=>p.waitForFunction(()=>window.driveMetrics.net[0]?.path==='direct',null,{timeout:25000})))
  }catch(error){
    for(const p of [host,guest])console.error(await p.evaluate(async()=>({net:window.driveMetrics.net,peers:await Promise.all(window.testPeers.filter(pc=>pc.connectionState!=='closed').map(async pc=>({connection:pc.connectionState,ice:pc.iceConnectionState,signaling:pc.signalingState,local:pc.localDescription?.type,remote:pc.remoteDescription?.type,stats:[...await pc.getStats()].filter(([,v])=>v.type==='data-channel' || v.type==='candidate-pair').map(([,v])=>[v.type,v.state,v.messagesSent,v.messagesReceived])})))})))
    throw error
  }
  await host.evaluate(()=>window.testPeers.forEach(pc=>pc.close()))
  await Promise.all([host,guest].map(p=>p.waitForFunction(()=>window.driveMetrics.net[0]?.path==='relay' && window.driveMetrics.net[0].age<.6,null,{timeout:10000})))
  console.log('Paired phone drove the host during the race. Both clients drew direct WebRTC updates and switched to live Worker relay at 150 ms and 5% loss')
  for(let i=0;i<260;i++){
    const stats=await Promise.all([host,guest].map(p=>p.evaluate(()=>{const {distance,checkpointsPassed,phase,speed}=window.driveMetrics.car;return {distance,checkpointsPassed,phase,speed}})))
    if(i%10===0)console.log('Race progress',JSON.stringify(stats))
    if(stats.every(s=>s.phase==='finished'))break
    await delay(1000)
  }
  for(const page of [host,guest])await page.waitForFunction(()=>document.querySelector('#room-roster').textContent.includes('2. '),null,{timeout:3000})
  assert.equal(await host.locator('#room-roster').innerText(),await guest.locator('#room-roster').innerText())
  const saved=await (await fetch(worker+'/api/rooms/'+roomCode+'/results')).json()
  assert.equal(saved.at(-1).results.filter(r=>r.finish>0).length,2)
  await host.locator('#race-again').click()
  await guest.locator('#race-again').click()
  await host.waitForFunction(()=>!document.querySelector('#race-ready').hidden)
  await mobile.close()
  assert.deepEqual(errors,[])
  console.log('Both clients completed a circuit with gamepad inputs and displayed identical finish order and times')
} finally {
  await browser?.close()
  for(const p of processes)try{process.kill(-p.pid,'SIGTERM')}catch{}
  await Promise.all(processes.filter(p=>p.exitCode===null && !p.signalCode).map(p=>Promise.race([once(p,'exit'),delay(2500)])))
  await rm(temp,{recursive:true,force:true})
}
