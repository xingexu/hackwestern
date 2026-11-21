import assert from 'node:assert/strict'
import {once} from 'node:events'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {chromium,devices} from 'playwright'

const listener=createServer().listen(0,'127.0.0.1')
await once(listener,'listening')
const port=listener.address().port
await new Promise(resolve=>listener.close(resolve))
const base='https://127.0.0.1:'+port
const temp=await mkdtemp(join(tmpdir(),'western-school-'))
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--local','--local-protocol','https','--ip','127.0.0.1','--config','server/wrangler.jsonc','--var','MULTIPLAYER:1','--inspector-port','0','--port',String(port),'--persist-to',temp],{detached:true,stdio:['ignore','pipe','pipe']})
let browser,logs=''
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+b).slice(-4000)})
try{
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1024,height:700}})
  for(let i=0;i<160;i++){
    try{if((await context.request.get(base+'/api/health',{timeout:700})).ok())break}catch{}
    if(i===159 || child.exitCode!==null)throw Error(logs)
    await sleep(100)
  }
  const page=await context.newPage(),cdp=await context.newCDPSession(page),requests=new Map()
  await page.addInitScript(()=>{window.RTCPeerConnection=undefined;performance.setResourceTimingBufferSize(2500)})
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:true})
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:625000,uploadThroughput:625000})
  cdp.on('Network.responseReceived',({requestId,response})=>{
    if(response.url.startsWith(base))requests.set(requestId,{url:new URL(response.url).pathname,bytes:0,headers:Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k.toLowerCase(),v]))})
  })
  cdp.on('Network.dataReceived',({requestId,encodedDataLength})=>{const r=requests.get(requestId);if(r)r.bytes+=encodedDataLength})
  cdp.on('Network.loadingFinished',({requestId,encodedDataLength})=>{const r=requests.get(requestId);if(r)r.bytes=encodedDataLength})
  await page.goto(base+'/?diagnostics',{waitUntil:'commit'})
  await page.waitForFunction(()=>window.driveMetrics?.frames>=1,null,{timeout:300000})
  await page.keyboard.down('ArrowUp')
  await page.waitForFunction(()=>window.driveMetrics.car.speed>.2,null,{polling:'raf'})
  const elapsed=await page.evaluate(()=>performance.now())
  const loaded=[...requests.values()],bytes=loaded.reduce((n,r)=>n+r.bytes,0),assets=loaded.filter(r=>r.url.startsWith('/assets/'))
  console.log(JSON.stringify({coldFirstDriveSeconds:+(elapsed/1000).toFixed(2),transferredBytes:bytes,requests:loaded.length,brotliRequests:loaded.filter(r=>r.headers['content-encoding']==='br').length,largest:assets.sort((a,b)=>b.bytes-a.bytes).slice(0,6).map(r=>[r.url,r.bytes])}))
  assert.ok(assets.length>10 && bytes>1000000 && assets.every(r=>r.headers['cache-control']?.includes('immutable')))
  const packable=assets.filter(r=>/\.(js|css|json|bin)$/.test(r.url))
  for(const r of packable)assert.ok(['br','gzip'].includes(r.headers['content-encoding']),r.url)
  for(const {url} of packable){
    const head=await context.request.head(base+url,{headers:{'accept-encoding':'br'}})
    assert.equal(head.headers()['content-encoding'],'br',url)
  }
  await page.keyboard.up('ArrowUp')
  await page.getByRole('button',{name:'Phone controller',exact:true}).click()
  await page.locator('#pad-qr[src]').waitFor()
  const code=await page.locator('#pad-code').innerText()
  const padOrigin=new URL(await page.locator('#pad-url').getAttribute('href')).origin
  assert.equal(padOrigin,base)
  const phone=await browser.newContext({...devices['iPhone 15 landscape'],ignoreHTTPSErrors:true})
  const pad=await phone.newPage(),sockets=[]
  pad.on('websocket',ws=>sockets.push(ws.url()))
  await pad.addInitScript(()=>{window.RTCPeerConnection=undefined})
  await pad.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort())
  await pad.goto(base+'/pad')
  await pad.locator('#code').fill(code)
  await pad.getByRole('button',{name:'Pair controller'}).tap()
  await pad.getByRole('button',{name:'Start driving'}).tap()
  await page.waitForFunction(()=>document.querySelector('#pad-state').textContent==='Phone connected')
  await pad.waitForFunction(()=>{
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{beta:0,gamma:-85}))
    return document.querySelector('#tilt').getAttribute('aria-pressed')==='true'
  })
  await pad.locator('#restart').tap()
  await page.waitForFunction(()=>window.driveMetrics.car.distance===0 && window.driveMetrics.car.phase==='ready')
  const at=await page.evaluate(()=>window.driveMetrics.car.heading),gas=await pad.locator('#gas').boundingBox()
  await pad.mouse.move(gas.x+gas.width/2,gas.y+gas.height/2);await pad.mouse.down()
  await page.waitForFunction(()=>window.driveMetrics.car.speed>1)
  await pad.evaluate(()=>{
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{beta:0,gamma:-85}))
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{beta:20,gamma:-85}))
  })
  await page.waitForFunction(h=>window.driveMetrics.car.speed>1 && Math.abs(window.driveMetrics.car.heading-h)>.04,at,{timeout:12000})
  assert.ok(sockets.length && sockets.every(s=>s.startsWith(base.replace('https:','wss:')+'/api/pads/')))
  await pad.close()
  await page.waitForFunction(()=>window.driveMetrics.car.throttlePlate<.01)
  console.log('Isolated mobile context steered and accelerated over same-origin HTTPS/WSS, then released the pedals on disconnect')
}finally{
  await browser?.close();try{process.kill(-child.pid,'SIGTERM')}catch{}
  await Promise.race([once(child,'exit'),sleep(1500)]);await rm(temp,{recursive:true,force:true})
}
