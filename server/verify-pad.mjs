import assert from 'node:assert/strict'
import {execFileSync,spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {createServer} from 'node:net'
import {fileURLToPath} from 'node:url'
import {setTimeout as sleep} from 'node:timers/promises'
import {chromium,webkit,devices} from 'playwright'
import './verify-wheel.mjs'

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
  await host.locator('#phone-pair').evaluate(async dialog=>{
    await Promise.all(dialog.getAnimations().map(animation=>animation.finished))
    await dialog.querySelector('#pad-qr').decode()
  })
  await host.screenshot({path:desktopShot})
  const scanned=execFileSync('.venv/bin/python',['-c','import cv2,sys; print(cv2.QRCodeDetector().detectAndDecode(cv2.imread(sys.argv[1]))[0])',desktopShot],{cwd:root,encoding:'utf8'}).trim()
  const qrURL=new URL(scanned)
  assert.equal(qrURL.origin,manual.origin)
  assert.equal(qrURL.pathname,'/pad')
  assert.equal(qrURL.searchParams.get('code'),code)
  for(const [engine,profile,shot] of [[webkit,'iPhone 15','iphone'],[chromium,'Pixel 7','pixel']]){
    phoneBrowser=await engine.launch()
    const context=await phoneBrowser.newContext({...devices[profile],deviceScaleFactor:1})
    await context.addInitScript(()=>{
      if(/iPhone/.test(navigator.userAgent)){
        for(const name of ['DeviceOrientationEvent','DeviceMotionEvent']){
          if(!window[name])window[name]=class extends Event{}
          Object.defineProperty(window[name],'requestPermission',{configurable:true,value:async()=>'denied'})
        }
      }
      const send=WebSocket.prototype.send
      WebSocket.prototype.send=function(data){
        if(JSON.parse(data).type==='pad'){
          window.padSamples?.push({at:performance.now(),...JSON.parse(data).input})
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
    await phone.getByRole('heading',{name:'Lock rotation first'}).waitFor()
    assert.ok(await phone.getByText(/Control Centre.*Portrait Orientation Lock/).isVisible())
    assert.ok(await phone.getByText(/Quick Settings.*Auto-rotate/).isVisible())
    assert.equal(await phone.locator('#controls').isVisible(),false)
    await phone.screenshot({path:fileURLToPath(new URL(shot+'-portrait-setup.png',shots))})
    await phone.getByRole('button',{name:'Start driving'}).tap()
    await phone.locator('#controls').waitFor()
    await host.waitForFunction(()=>document.querySelector('#pad-state').textContent==='Phone connected')
    await phone.waitForFunction(()=>window.controllerSocket?.readyState===1)
    assert.equal(new URL(await phone.evaluate(()=>window.controllerSocket.url)).origin,manual.origin.replace(/^http/,'ws'))
    assert.equal(await phone.locator('canvas,nav').count(),0)
    assert.equal(await phone.locator('#pair').isVisible(),false)
    assert.ok(await phone.getByRole('button',{name:'Steer right'}).isVisible())
    assert.deepEqual(await phone.locator('#pedals button').evaluateAll(bs=>bs.map(b=>b.id)),['brake','gas'])
    if(!await phone.evaluate(()=>isSecureContext))assert.ok(await phone.getByRole('button',{name:'Wheel needs HTTPS'}).isDisabled())
    else if(engine===webkit)await phone.getByText('Tilt unavailable · use the arrows').waitFor()
    const gasY=async page=>(await page.locator('#gas').boundingBox()).y
    const brakeY=async page=>(await page.locator('#brake').boundingBox()).y
    assert.ok(await gasY(phone)>await brakeY(phone))
    await phone.locator('#flip').tap()
    assert.ok(await gasY(phone)<await brakeY(phone))
    await phone.locator('#flip').tap()
    async function captureSideways(page,name,topEdge){
      const raw=fileURLToPath(new URL(shot+'-'+name+'-portrait.png',shots))
      const sideways=fileURLToPath(new URL(shot+'-'+name+'.png',shots))
      await page.screenshot({path:raw})
      execFileSync('.venv/bin/python',['-c','from PIL import Image; import sys; Image.open(sys.argv[1]).transpose(Image.Transpose.ROTATE_90 if sys.argv[3]=="left" else Image.Transpose.ROTATE_270).save(sys.argv[2])',raw,sideways,topEdge],{cwd:root})
    }
    await captureSideways(phone,'buttons','left')
    if(engine===chromium){
      const touch=await context.newCDPSession(phone)
      const [gas,brake]=await Promise.all(['gas','brake'].map(async (key,id)=>{
        const b=await phone.locator('#'+key).boundingBox()
        return {id,x:b.x+b.width/2,y:b.y+b.height/2}
      }))
      const send=(type,touchPoints)=>touch.send('Input.dispatchTouchEvent',{type,touchPoints})
      await phone.evaluate(()=>{window.padSamples=[]})
      await send('touchStart',[gas,brake])
      await sleep(300)
      await send('touchEnd',[brake])
      const single=await phone.evaluate(()=>window.padSamples)
      assert.ok(single.some(p=>p.throttle && p.brake) && single.every(p=>!p.handbrake))
      for(let i=0;i<2;i++){
        await send('touchStart',[gas,brake])
        await send('touchEnd',[brake])
      }
      await phone.waitForFunction(()=>window.padSamples.some(p=>p.handbrake))
      await phone.waitForFunction(()=>!document.querySelector('#brake').hasAttribute('data-pulse'))
      const packets=await phone.evaluate(()=>window.padSamples)
      const pulse=packets.filter(p=>p.handbrake)
      const released=packets.find(p=>p.at>pulse.at(-1).at && !p.handbrake)
      assert.ok(pulse.every(p=>p.throttle===1 && p.brake===0))
      assert.ok(released?.throttle && released.at-pulse[0].at>=350 && released.at-pulse[0].at<600)
      await send('touchEnd',[])
      await phone.locator('#restart').tap()
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
    await phone.setViewportSize(devices[profile+' landscape'].viewport)
    await phone.locator('#lock-hint').waitFor()
    assert.equal(await phone.locator('#controls').isVisible(),true)
    await host.waitForFunction(()=>window.driveMetrics.car.throttlePlate<.01)
    await phone.mouse.up()
    await hold(phone,'gas')
    await host.waitForFunction(()=>window.driveMetrics.car.throttlePlate>.3)
    await phone.close()
    await host.waitForFunction(()=>document.querySelector('#pad-state').textContent==='Waiting for phone' && window.driveMetrics.car.throttlePlate<.01)
    assert.ok(resources.every(path=>!path.startsWith('/assets/')),resources.join(', '))
    {
      await context.addInitScript(()=>{
        window.grants=[]
        const send=WebSocket.prototype.send
        WebSocket.prototype.send=function(data){
          const m=JSON.parse(data)
          if(m.type==='pad'){
            window.lastInput=m.input
            if(!this.observingStraight){
              this.observingStraight=true
              this.addEventListener('message',event=>{
                const feedback=JSON.parse(event.data)
                if(feedback.type==='pad-straight')window.carStraight=feedback.straight
              })
            }
          }
          return send.call(this,data)
        }
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
      await sensors.getByRole('button',{name:'Start driving'}).tap()
      await sensors.locator('#controls').waitFor()
      const orient=(beta,gamma)=>sensors.evaluate(({beta,gamma})=>window.dispatchEvent(Object.assign(new Event('deviceorientation'),{beta,gamma})),{beta,gamma})
      await sensors.waitForFunction(()=>{
        window.dispatchEvent(Object.assign(new Event('deviceorientation'),{beta:0,gamma:-85}))
        return document.querySelector('#tilt').getAttribute('aria-pressed')==='true'
      })
      const grants=await sensors.evaluate(()=>window.grants)
      assert.equal(grants.length,engine===webkit?2:0)
      assert.ok(grants.every(g=>g.gesture))
      const view=()=>sensors.evaluate(()=>({scale:visualViewport.scale,left:scrollX,top:scrollY,width:visualViewport.width}))
      assert.match(await sensors.locator('meta[name=viewport]').getAttribute('content'),/maximum-scale=1,user-scalable=no/)
      assert.equal(await sensors.locator('#controls').evaluate(el=>getComputedStyle(el).touchAction),'none')
      assert.equal(await sensors.locator('body').evaluate(el=>getComputedStyle(el).overscrollBehavior),'none')
      const original=await view()
      await sensors.waitForFunction(()=>window.carStraight===true)
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
      for(const side of [1,-1]){
        const gamma=-85*side
        await orient(0,gamma)
        await orient(1,gamma)
        await sensors.waitForFunction(()=>window.lastInput.steer===0)
        assert.equal(await sensors.evaluate(()=>window.lastInput.steer),0)
        assert.ok(await sensors.locator('#left').isHidden() && await sensors.locator('#right').isHidden())
        assert.ok(side*(await gasY(sensors)-await brakeY(sensors))>30)
        assert.ok(await sensors.locator('#lock-hint').isHidden())
        const latency=await sensors.evaluate(async side=>{
          const rad=Math.PI/180
          function tilt(roll,pitch){
            const x=side*Math.cos(roll*rad)*Math.cos(pitch*rad)
            const y=side*Math.sin(roll*rad)*Math.cos(pitch*rad)
            window.dispatchEvent(Object.assign(new Event('deviceorientation'),{beta:Math.asin(y)/rad,gamma:Math.atan2(-x,Math.sin(pitch*rad))/rad}))
          }
          const wait=()=>new Promise(resolve=>setTimeout(resolve,16))
          tilt(0,30)
          await wait()
          const start=performance.now()
          tilt(32,30)
          let tick=0
          while(window.lastInput.steer>-.5 && ++tick<10){await wait();tilt(32,30)}
          const response=performance.now()-start
          for(const pitch of [10,45,75]){
            for(let i=0;i<10;i++){tilt(32,pitch);await wait()}
            if(window.lastInput.steer>-.9)throw Error('Steering changed with pitch '+pitch)
          }
          return response
        },side)
        assert.ok(latency<85,profile+' sensor-to-packet latency '+latency+' ms')
        console.log(profile,'side',side,'sensor-to-packet 50% response',Math.round(latency),'ms')
        await sensors.waitForFunction(()=>window.carStraight===false)
        for(const direction of [-1,1]){
          await orient(-24*direction*side,gamma)
          await sensors.waitForFunction(sign=>sign*window.lastInput.steer>.5,direction)
          await host.waitForFunction(sign=>sign*window.driveMetrics.car.steer>.04 && window.driveMetrics.car.profile==='wheel',direction)
        }
        await orient(0,gamma)
        await sensors.waitForFunction(()=>window.lastInput.steer===0)
        assert.equal(await sensors.getByRole('button',{name:/cent(re|er) tilt/i}).count(),0)
        if(side===-1){
          await sensors.locator('#tilt').tap()
          assert.ok(await sensors.locator('#left').isVisible() && await sensors.locator('#right').isVisible())
          await sensors.locator('#tilt').tap()
          await orient(0,gamma)
          await sensors.locator('#wheel').waitFor()
          await captureSideways(sensors,'tilt','right')
        }
      }
      await sleep(520)
      const gravity=(x,y)=>sensors.evaluate(({x,y})=>window.dispatchEvent(Object.assign(new Event('devicemotion'),{accelerationIncludingGravity:{x,y,z:1}})),{x,y})
      await gravity(9.6,0)
      await gravity(9,3.5)
      await sensors.waitForFunction(()=>window.lastInput.steer<-.5)
      assert.ok(await gasY(sensors)>await brakeY(sensors))
      await sensors.setViewportSize(devices[profile+' landscape'].viewport)
      await sensors.locator('#lock-hint').waitFor()
      assert.ok(await sensors.locator('#gas').isVisible() && await sensors.locator('#wheel').isVisible())
      await sensors.locator('#restart').tap()
      await host.waitForFunction(()=>window.driveMetrics.car.phase==='ready' && window.driveMetrics.car.distance===0)
      const before=await host.evaluate(()=>window.driveMetrics.car.heading)
      await orient(0,-85)
      await sensors.waitForFunction(()=>window.lastInput.steer===0)
      await orient(24,-85)
      await sensors.waitForFunction(()=>window.lastInput.steer<-.5)
      await hold(sensors,'gas')
      try{
        await host.waitForFunction(h=>window.driveMetrics.car.speed>1 && Math.abs(window.driveMetrics.car.heading-h)>.06,before,{timeout:12000})
      }catch(error){
        console.error('Desktop steering',await sensors.evaluate(()=>window.lastInput),await host.evaluate(()=>window.driveMetrics.car))
        throw error
      }
      await sensors.mouse.up()
      await sensors.locator('#options summary').tap()
      const sensitivity=sensors.getByRole('slider',{name:/Steering sensitivity/})
      await sensitivity.press('Home')
      assert.equal(await sensors.locator('#degrees').textContent(),'±44°')
      await orient(26,-85)
      await sensors.waitForFunction(()=>window.lastInput.steer<-.4 && window.lastInput.steer>-.7)
      await sensitivity.press('End')
      assert.equal(await sensors.locator('#degrees').textContent(),'±20°')
      await orient(26,-85)
      await sensors.waitForFunction(()=>window.lastInput.steer===-1)
      await sensors.close()
      console.log(profile+' passed portrait setup, both sideways layouts and steering directions, gravity fallback, tilt/buttons switching, automatic centring, unlocked driving, dead zone, double-tap and pinch handling')
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
