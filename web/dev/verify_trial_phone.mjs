import {drivingMenu} from './mobile_menu.mjs'
import assert from 'node:assert/strict'
import {mkdir,readFile} from 'node:fs/promises'
import {engines,serve} from './race_browser.mjs'

const server=await serve()
const shots=new URL('./shots/',import.meta.url)
const driver=await readFile(new URL('./circuit_driver.mjs',import.meta.url),'utf8')
const driverURL='data:text/javascript;base64,'+Buffer.from(driver).toString('base64')
try {
  await mkdir(shots,{recursive:true})
  const manifestURL=new URL('app.webmanifest',server.base)
  const manifest=await (await fetch(manifestURL)).json()
  assert.equal(manifest.display,'fullscreen')
  assert.equal(manifest.orientation,'landscape')
  assert.equal(new URL(manifest.start_url,manifestURL).pathname,'/')
  for (const icon of manifest.icons) {
    const response=await fetch(new URL(icon.src,manifestURL))
    assert.equal(response.status,200)
    const png=Buffer.from(await response.arrayBuffer())
    assert.equal(png.readUInt32BE(16)+'x'+png.readUInt32BE(20),icon.sizes)
  }
  for (const [engine,profile] of [['chromium','Pixel 7'],['webkit','iPhone 13']]) {
    const browser=await engines[engine].launch({args:engine==='chromium' && process.platform==='darwin'?['--use-angle=metal']:[]})
    try {
      const page=await browser.newPage({...engines.devices[profile],viewport:{width:844,height:390},deviceScaleFactor:1})
      const errors=[]
      page.on('pageerror',e=>errors.push(e.message))
      await page.addInitScript(()=>{
        window.grant='denied'
        window.requests=[]
        for (const id of ['DeviceOrientationEvent','DeviceMotionEvent']) {
          if (!window[id]) window[id]=class extends Event {}
          Object.defineProperty(window[id],'requestPermission',{configurable:true,value:()=>{
            window.requests.push(id)
            return Promise.resolve(window.grant)
          }})
        }
        const frame=window.requestAnimationFrame
        window.requestAnimationFrame=fn=>frame.call(window,t=>{
          window.pilot?.()
          fn(t*4)
        })
      })
      await page.goto(server.base+'/?course=stadium&diagnostics')
      await page.waitForFunction(()=>window.driveMetrics?.frames>2,null,{timeout:60000})
      const tilt=page.locator('#tilt'),gas=page.locator('[data-key=ArrowUp]'),brake=page.locator('[data-key=ArrowDown]')
      assert.match(await page.locator('link[rel=manifest]').getAttribute('href'),/app.webmanifest$/)
      assert.equal(await page.locator('meta[name=apple-mobile-web-app-capable]').getAttribute('content'),'yes')
      await drivingMenu(page)
      await tilt.tap()
      assert.equal(await tilt.getAttribute('aria-pressed'),'false')
      await page.evaluate(()=>{window.grant='granted'})
      await tilt.tap()
      assert.equal(await tilt.getAttribute('aria-pressed'),'true')
      assert.equal(await page.evaluate(()=>requests.length),4)
      await page.evaluate(()=>{
        window.orient=value=>{
          const e=new Event('deviceorientation')
          Object.defineProperties(e,{gamma:{value},beta:{value}})
          dispatchEvent(e)
        }
        orient(0)
      })
      async function press(locator) {
        const b=await locator.boundingBox()
        assert.ok(b)
        await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
        await page.mouse.down()
      }
      await drivingMenu(page,false)
      await press(gas)
      await page.waitForFunction(()=>driveMetrics.car.speed>3 && driveMetrics.car.profile==='tilt')
      await page.mouse.up()
      await press(brake)
      await page.waitForFunction(()=>driveMetrics.car.speed<1)
      await page.mouse.up()
      await page.screenshot({path:new URL(engine+'-phone-steering.png',shots).pathname})
      await drivingMenu(page)
      await page.locator('#trial-open').tap()
      await page.locator('#trial-start').tap()
      await page.waitForFunction(()=>/^[123]$/.test(document.querySelector('#race-countdown').textContent))
      await page.evaluate(async url=>{
        const {driveInput}=await import(url)
        const samples=driveMetrics.network.circuits.find(c=>c.id==='stadium').samples
        const angle=((screen.orientation?.angle??window.orientation??0)%360+360)%360
        window.pilot=()=>{
          const car=driveMetrics.car,desired=driveInput(samples,car)
          const upcoming=samples.filter(p=>p.distance>=car.distance && p.distance<=car.distance+30)
          window.speedLimit=upcoming.some(p=>Math.abs(Math.atan2(Math.sin(p.heading-car.heading),Math.cos(p.heading-car.heading)))>.55)?4.5:8
          const steer=Math.max(-1,Math.min(1,desired.steer))
          orient(-(angle===270 || angle===180?-1:1)*Math.sign(steer)*(2+24*Math.abs(steer)))
        }
      },driverURL)
      let held=''
      const deadline=Date.now()+270000
      while (Date.now()<deadline) {
        const state=await page.evaluate(()=>({v:driveMetrics.car.speed,phase:driveMetrics.car.phase,limit:window.speedLimit??8}))
        if (state.phase==='finished') break
        const next=state.v<state.limit?'gas':state.v>state.limit+1?'brake':''
        if (next!==held) {
          if (held) await page.mouse.up()
          if (next) await press(next==='gas'?gas:brake)
          held=next
        }
        await page.waitForTimeout(90)
      }
      if (held) await page.mouse.up()
      assert.equal(await page.evaluate(()=>driveMetrics.car.phase),'finished',JSON.stringify(await page.evaluate(()=>driveMetrics.car)))
      await page.locator('#trial-pb').waitFor()
      assert.match(await page.locator('#trial-pb').textContent(),/New personal best/)
      const time=await page.locator('#result').textContent()
      assert.match(time,/^\d+:\d\d\.\d{3}$/)
      assert.match(await page.locator('#trial-sectors').textContent(),/S3 /)
      await page.screenshot({path:new URL(engine+'-trial-result.png',shots).pathname})
      await page.locator('#again').tap()
      await page.waitForFunction(()=>driveMetrics.ghostVisible===true && /^0:0[2-9]\./.test(document.querySelector('#time').textContent))
      await page.screenshot({path:new URL(engine+'-pb-ghost.png',shots).pathname})
      await drivingMenu(page)
      await page.getByRole('button',{name:'Ghost on',exact:true}).tap()
      await page.waitForFunction(()=>driveMetrics.ghostVisible===false)
      await page.reload()
      await drivingMenu(page)
      await page.locator('#trial-open').tap()
      assert.match(await page.locator('#trial-opponent').textContent(),/Personal best/)
      assert.deepEqual(errors,[])
      console.log(engine,profile,time,'tilt lap, three sectors, persisted PB and ghost toggle')
    } finally {await browser.close()}
  }
} finally {server.close()}
