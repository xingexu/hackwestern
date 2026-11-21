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
const hosted=process.env.PAD_BASE
const base=hosted || 'http://127.0.0.1:'+port
await mkdir(new URL('../.wrangler/',import.meta.url),{recursive:true})
const storage=await mkdtemp(fileURLToPath(new URL('../.wrangler/pad-',import.meta.url)))
const local=hosted?null:spawn(process.execPath,['server/lan.mjs','--port',String(port),'--persist-to',storage],{cwd:root,detached:true,stdio:['ignore','pipe','pipe']})
let logs='',desktopBrowser,phoneBrowser
for(const stream of local?[local.stdout,local.stderr]:[])stream.on('data',chunk=>{logs=(logs+chunk).slice(-4500)})
async function hold(page,id){
  const box=await page.locator('#'+id).boundingBox()
  assert.ok(box,id+' must be visible')
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  await page.mouse.down()
}
try{
  for(let i=0;i<150;i++){
    try{if((await fetch(base,{method:'HEAD'})).ok)break}catch{}
    if(local?.exitCode!=null || i===149)throw Error(logs)
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
  await host.waitForFunction(()=>window.driveMetrics?.frames>0,null,{timeout:60000})
  const code=await host.locator('#pad-code').innerText()
  const manual=new URL(await host.locator('#pad-url').getAttribute('href'))
  assert.match(code,/^[A-Z2-9]{6}$/)
  assert.match(await host.locator('#pad-qr').getAttribute('src'),/^data:image\//)
  assert.equal(manual.pathname,'/pad')
  const advertised=logs.match(/Phone: (\S+)/)?.[1]
  if(hosted)assert.equal(manual.origin,new URL(hosted).origin)
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
    await phone.waitForFunction(()=>window.controllerSocket?.readyState===1)
    assert.equal(new URL(await phone.evaluate(()=>window.controllerSocket.url)).origin,manual.origin.replace(/^http/,'ws'))
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
    {
      await context.addInitScript(()=>{
        window.grants=[]
        window.padAngle=90
        if(screen.orientation)Object.defineProperty(screen.orientation,'angle',{configurable:true,get:()=>window.padAngle})
        Object.defineProperty(window,'orientation',{configurable:true,get:()=>window.padAngle})
        const send=WebSocket.prototype.send
        WebSocket.prototype.send=function(data){const m=JSON.parse(data);if(m.type==='pad')window.lastInput=m.input;return send.call(this,data)}
        for(const name of ['DeviceOrientationEvent','DeviceMotionEvent']){
          if(!window[name])window[name]=class extends Event{}
          if(!/iPhone/.test(navigator.userAgent))continue
          Object.defineProperty(window[name],'requestPermission',{configurable:true,value:async()=>{
            window.grants.push({name,gesture:navigator.userActivation.isActive})
            return 'granted'
          }})
        }
      })
      const sensors=await context.newPage()
      await sensors.goto(base+'/pad?code='+code)
      await sensors.getByRole('button',{name:'Pair controller'}).tap()
      await sensors.locator('#controls').waitFor()
      assert.equal(await sensors.locator('#tilt').getAttribute('aria-pressed'),'true')
      const grants=await sensors.evaluate(()=>window.grants)
      assert.equal(grants.length,engine===webkit?2:0)
      assert.ok(grants.every(g=>g.gesture))
      const view=()=>sensors.evaluate(()=>({scale:visualViewport.scale,left:scrollX,top:scrollY,width:visualViewport.width}))
      assert.match(await sensors.locator('meta[name=viewport]').getAttribute('content'),/maximum-scale=1,user-scalable=no/)
      assert.equal(await sensors.locator('#controls').evaluate(el=>getComputedStyle(el).touchAction),'none')
      assert.equal(await sensors.locator('body').evaluate(el=>getComputedStyle(el).overscrollBehavior),'none')
      const original=await view()
      const cancelled=await sensors.evaluate(()=>['gesturestart','gesturechange','gestureend'].map((type,i)=>{
        const event=new Event(type,{bubbles:true,cancelable:true})
        Object.defineProperty(event,'scale',{value:i?1.8:1})
        return !document.querySelector('#deck').dispatchEvent(event)
      }))
      assert.ok(cancelled.every(Boolean))
      const pinchCancelled=await sensors.evaluate(()=>{
        const deck=document.querySelector('#deck')
        function touch(type,x){
          const fingers=[{identifier:1,clientX:300-x,clientY:120},{identifier:2,clientX:300+x,clientY:120}]
          const event=Object.assign(new Event(type,{bubbles:true,cancelable:true}),{touches:type==='touchend'?[]:fingers,changedTouches:fingers})
          return !deck.dispatchEvent(event)
        }
        touch('touchstart',20)
        const prevented=touch('touchmove',85)
        touch('touchend',85)
        return prevented
      })
      assert.ok(pinchCancelled)
      if(engine===chromium){
        const session=await context.newCDPSession(sensors)
        await session.send('Input.synthesizePinchGesture',{x:250,y:160,scaleFactor:1.8,gestureSourceType:'touch'})
      }
      await sensors.touchscreen.tap(240,140)
      await sensors.touchscreen.tap(240,140)
      await sleep(375)
      assert.deepEqual(await view(),original)
      const orient=(beta,gamma=0)=>sensors.evaluate(({beta,gamma})=>window.dispatchEvent(Object.assign(new Event('deviceorientation'),{beta,gamma})),{beta,gamma})
      for(const direction of [90,270]){
        await sensors.evaluate(a=>{window.padAngle=a;window.dispatchEvent(new Event('orientationchange'))},direction)
        await orient(10)
        await orient(11,35)
        await sleep(150)
        assert.equal(await sensors.evaluate(()=>window.lastInput.steer),0)
        await orient(30)
        await sensors.waitForFunction(sign=>sign*window.lastInput.steer>.5,direction===90?-1:1)
        await sensors.locator('#center').tap()
        await sensors.waitForFunction(()=>document.querySelector('#notice').value==='Tilt centred',null,{timeout:3500})
        await orient(31,-45)
        await sensors.waitForFunction(()=>window.lastInput.steer===0)
      }
      const before=await host.evaluate(()=>window.driveMetrics.car.heading)
      await sensors.evaluate(()=>{
        for(const degrees of [0,20])window.dispatchEvent(Object.assign(new Event('deviceorientation'),{gamma:degrees,beta:degrees}))
      })
      await hold(sensors,'gas')
      await host.waitForFunction(h=>Math.abs(window.driveMetrics.car.heading-h)>.06,before)
      await sensors.close()
      console.log(profile+' passed default tilt, both landscape directions, recalibration, dead zone, viewport scale, double-tap and pinch handling')
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
  if(local && local.exitCode===null && !local.signalCode){
    const exited=once(local,'exit')
    process.kill(-local.pid,'SIGTERM')
    await Promise.race([exited,sleep(2500)])
  }
  await rm(storage,{recursive:true,force:true})
}
