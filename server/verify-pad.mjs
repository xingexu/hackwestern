import assert from 'node:assert/strict'
import {execFileSync,spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {createServer} from 'node:net'
import {fileURLToPath} from 'node:url'
import {setTimeout as sleep} from 'node:timers/promises'
import {chromium,webkit,devices} from 'playwright'

const root=fileURLToPath(new URL('../',import.meta.url))
const shots=new URL('../web/dev/shots/controller/',import.meta.url)
const socket=createServer().listen(0,'127.0.0.1')
await once(socket,'listening')
const port=socket.address().port
await new Promise(resolve=>socket.close(resolve))
const base='http://127.0.0.1:'+port
await mkdir(new URL('../.wrangler/',import.meta.url),{recursive:true})
const storage=await mkdtemp(fileURLToPath(new URL('../.wrangler/pad-',import.meta.url)))
const local=spawn(process.execPath,['server/lan.mjs','--port',String(port),'--persist-to',storage],{cwd:root,detached:true,stdio:['ignore','pipe','pipe']})
let logs='',desktopBrowser,phoneBrowser
for(const stream of [local.stdout,local.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-4500)})
async function hold(page,id){
  const box=await page.locator('#'+id).boundingBox()
  assert.ok(box,id+' must be visible')
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  await page.mouse.down()
}
try{
  for(let i=0;i<150;i++){
    try{if((await fetch(base,{method:'HEAD'})).ok)break}catch{}
    if(local.exitCode!==null || i===149)throw Error(logs)
    await sleep(100)
  }
  await mkdir(shots,{recursive:true})
  desktopBrowser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const host=await desktopBrowser.newPage({viewport:{width:1160,height:720}})
  await host.addInitScript(()=>{
    const getEntries=performance.getEntriesByType.bind(performance)
    performance.getEntriesByType=type=>type==='navigation'?[{serverTiming:[]}]:getEntries(type)
  })
  await host.goto(base+'/?course=stadium&diagnostics')
  await host.getByRole('button',{name:'Phone controller',exact:true}).click({timeout:60000})
  await host.locator('#pad-info').waitFor()
  const code=await host.locator('#pad-code').innerText()
  const manual=new URL(await host.locator('#pad-url').getAttribute('href'))
  assert.match(code,/^[A-Z2-9]{6}$/)
  assert.match(await host.locator('#pad-qr').getAttribute('src'),/^data:image\//)
  assert.equal(manual.pathname,'/pad')
  const advertised=logs.match(/Phone: (\S+)/)?.[1]
  if(advertised)assert.equal(manual.href,advertised)
  const desktopShot=fileURLToPath(new URL('desktop-pairing.png',shots))
  await host.screenshot({path:desktopShot})
  const scanned=execFileSync('.venv/bin/python',['-c','import cv2,sys; print(cv2.QRCodeDetector().detectAndDecode(cv2.imread(sys.argv[1]))[0])',desktopShot],{cwd:root,encoding:'utf8'}).trim()
  const qrURL=new URL(scanned)
  assert.equal(qrURL.origin,manual.origin)
  assert.equal(qrURL.pathname,'/pad')
  assert.equal(qrURL.searchParams.get('code'),code)
  for(const [engine,profile,shot] of [[webkit,'iPhone 15','iphone'],[chromium,'Pixel 7','pixel']]){
    phoneBrowser=await engine.launch()
    const context=await phoneBrowser.newContext({...devices[profile+' landscape'],deviceScaleFactor:1})
    await context.addInitScript(()=>{
      const send=WebSocket.prototype.send
      WebSocket.prototype.send=function(data){
        if(JSON.parse(data).type==='pad'){
          window.controllerSocket=this
          if(window.dropNextGas && JSON.parse(data).input.throttle){window.dropNextGas=false;return}
        }
        return send.call(this,data)
      }
    })
    const phone=await context.newPage()
    const resources=[]
    phone.on('request',request=>resources.push(new URL(request.url()).pathname))
    await phone.goto(shot==='iphone'?manual.origin:qrURL.href)
    assert.equal(new URL(phone.url()).pathname,'/pad')
    if(shot==='iphone')await phone.getByLabel('Desktop join code').fill(code)
    else assert.equal(await phone.locator('#code').inputValue(),code)
    await phone.getByRole('button',{name:'Pair controller'}).tap()
    await phone.locator('#controls').waitFor()
    await host.waitForFunction(()=>document.querySelector('#pad-state').textContent==='Phone connected')
    assert.equal(await phone.locator('canvas,nav').count(),0)
    assert.equal(await phone.locator('#pair').isVisible(),false)
    await phone.screenshot({path:fileURLToPath(new URL(shot+'-landscape.png',shots))})
    if(engine===chromium){
      const touch=await context.newCDPSession(phone)
      const buttons=await Promise.all(['gas','right'].map(key=>phone.locator('#'+key).boundingBox()))
      const touchPoints=buttons.map((b,id)=>({x:b.x+b.width/2,y:b.y+b.height/2,id}))
      const heading=await host.evaluate(()=>window.driveMetrics.car.heading)
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints})
      await host.waitForFunction(h=>window.driveMetrics.car.speed>2 && Math.abs(window.driveMetrics.car.heading-h)>.04,heading)
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
      await phone.locator('#restart').tap()
      await host.waitForFunction(()=>window.driveMetrics.car.phase==='ready' && window.driveMetrics.car.distance===0)
    }
    await phone.evaluate(()=>{window.dropNextGas=true})
    await hold(phone,'gas')
    await host.waitForFunction(()=>window.driveMetrics.car.speed>3)
    assert.equal(await phone.evaluate(()=>window.dropNextGas),false)
    await phone.mouse.up()
    const heading=await host.evaluate(()=>window.driveMetrics.car.heading)
    await hold(phone,'left')
    await host.waitForFunction(h=>Math.abs(window.driveMetrics.car.heading-h)>.04,heading)
    await phone.mouse.up()
    await phone.locator('#recover').tap()
    await host.waitForFunction(()=>Math.abs(window.driveMetrics.car.speed)<.1)
    await hold(phone,'gas')
    await host.waitForFunction(()=>window.driveMetrics.car.speed>2)
    await phone.mouse.up()
    await phone.locator('#restart').tap()
    await host.waitForFunction(()=>window.driveMetrics.car.phase==='ready' && window.driveMetrics.car.distance===0)
    await hold(phone,'brake')
    await host.waitForFunction(()=>window.driveMetrics.car.speed<-.5)
    await phone.mouse.up()
    await phone.locator('#restart').tap()
    await hold(phone,'gas')
    await host.waitForFunction(()=>window.driveMetrics.car.throttlePlate>.3)
    await phone.evaluate(()=>window.controllerSocket.close(4000,'Test connection loss'))
    await host.waitForFunction(()=>window.driveMetrics.car.throttlePlate<.01)
    await phone.waitForFunction(()=>window.controllerSocket?.readyState===1)
    await phone.mouse.up()
    await hold(phone,'gas')
    await host.waitForFunction(()=>window.driveMetrics.car.throttlePlate>.3)
    await phone.evaluate(async()=>{
      if(document.fullscreenElement)await document.exitFullscreen()
      try{screen.orientation?.unlock?.()}catch{}
    })
    await phone.setViewportSize({width:390,height:844})
    await phone.getByRole('heading',{name:'Rotate your phone'}).waitFor()
    assert.equal(await phone.locator('#controls').isVisible(),false)
    await host.waitForFunction(()=>window.driveMetrics.car.throttlePlate<.01)
    if(shot==='iphone')await phone.screenshot({path:fileURLToPath(new URL('portrait.png',shots))})
    await phone.mouse.up()
    await phone.setViewportSize(devices[profile+' landscape'].viewport)
    await hold(phone,'gas')
    await host.waitForFunction(()=>window.driveMetrics.car.throttlePlate>.3)
    await phone.close()
    await host.waitForFunction(()=>document.querySelector('#pad-state').textContent==='Waiting for phone' && window.driveMetrics.car.throttlePlate<.01)
    assert.ok(resources.every(path=>!path.startsWith('/assets/')),resources.join(', '))
    if(engine===webkit){
      await context.addInitScript(()=>{
        window.grants=[]
        for(const name of ['DeviceOrientationEvent','DeviceMotionEvent']){
          if(!window[name])window[name]=class extends Event{}
          Object.defineProperty(window[name],'requestPermission',{configurable:true,value:async()=>{
            window.grants.push({name,gesture:navigator.userActivation.isActive})
            return 'granted'
          }})
        }
      })
      const sensors=await context.newPage()
      await sensors.goto(base+'/pad?code='+code)
      await sensors.getByRole('button',{name:'Pair controller'}).tap()
      await sensors.locator('#tilt').tap()
      const grants=await sensors.evaluate(()=>window.grants)
      assert.equal(grants.length,2)
      assert.ok(grants.every(g=>g.gesture))
      const before=await host.evaluate(()=>window.driveMetrics.car.heading)
      await sensors.evaluate(()=>{
        for(const degrees of [0,20])window.dispatchEvent(Object.assign(new Event('deviceorientation'),{gamma:degrees,beta:degrees}))
      })
      await hold(sensors,'gas')
      await host.waitForFunction(h=>Math.abs(window.driveMetrics.car.heading-h)>.06,before)
      await sensors.close()
      console.log('WebKit requested both sensor permissions during the tap and steered from orientation readings')
    }
    await phoneBrowser.close()
    phoneBrowser=null
    await host.getByRole('button',{name:'Restart',exact:false}).first().click()
    console.log(profile+' passed manual/QR entry, gas after a dropped packet, steering, reverse, recover, restart, reconnect, portrait and disconnect release')
  }
  await host.getByRole('button',{name:'Phone controller',exact:true}).click()
  await host.locator('#end-pad').click()
}finally{
  await phoneBrowser?.close()
  await desktopBrowser?.close()
  if(local.exitCode===null && !local.signalCode){
    const exited=once(local,'exit')
    process.kill(-local.pid,'SIGTERM')
    await Promise.race([exited,sleep(2500)])
  }
  await rm(storage,{recursive:true,force:true})
}
