import {drivingMenu} from './mobile_menu.mjs'
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {engines,serve} from './race_browser.mjs'

const server=await serve()
const shots=new URL('./shots/',import.meta.url)
await mkdir(shots,{recursive:true})
const browser=await engines.chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
try{
  for(const [name,profile] of [['desktop',{viewport:{width:1280,height:720}}],['phone',{...engines.devices['Pixel 7'],viewport:{width:844,height:390},deviceScaleFactor:1}]]){
    const page=await browser.newPage(profile)
    await page.addInitScript(()=>{
      window.stick=0
      Object.defineProperty(navigator,'getGamepads',{value:()=>[{connected:true,mapping:'standard',axes:[window.stick],buttons:[]}]})
      window.cues=[]
      window.tones=[]
      const start=OscillatorNode.prototype.start
      OscillatorNode.prototype.start=function(...args){if(this.type==='sine')window.tones.push(this.frequency.value);return start.apply(this,args)}
      new MutationObserver(records=>{
        for(const record of records)if(record.target.id==='race-countdown')window.cues.push(record.target.textContent)
      }).observe(document,{subtree:true,childList:true})
    })
    await page.goto(server.base+'/?course=stadium&diagnostics')
    await page.waitForFunction(()=>window.driveMetrics?.frames>2,null,{timeout:60000})
    const settings=page.locator('#driving-settings summary'),toggle=page.locator('#driving-assists')
    await drivingMenu(page)
    await settings.click()
    assert.equal(await toggle.isChecked(),true)
    await toggle.uncheck()
    assert.equal(await page.evaluate(()=>window.driveMetrics.car.assists),false)
    await page.reload()
    await page.waitForFunction(()=>window.driveMetrics?.frames>2,null,{timeout:60000})
    assert.equal(await page.evaluate(()=>window.driveMetrics.car.assists),false)
    await drivingMenu(page)
    await settings.click()
    await toggle.check()
    await settings.click()
    await page.locator('#trial-open').click()
    await page.locator('#trial-start').click()
    const cue=page.locator('#race-countdown')
    await page.waitForFunction(()=>document.querySelector('#race-countdown').textContent==='2')
    await cue.evaluate(e=>Promise.all(e.getAnimations().map(animation=>animation.finished)))
    await page.waitForFunction(()=>{
      const canvas=document.querySelector('#pixel-countdown')
      return canvas && !canvas.hidden && canvas.getContext('2d').getImageData(0,14,72,34).data.some((n,i)=>i%4===3 && n>128)
    })
    const bounds=await cue.boundingBox(),viewport=page.viewportSize()
    assert.ok(bounds.height>=78 && Math.abs(bounds.x+bounds.width/2-viewport.width/2)<2 && Math.abs(bounds.y+bounds.height/2-viewport.height/2)<2)
    await page.screenshot({path:fileURLToPath(new URL('countdown-'+name+'.png',shots))})
    await page.waitForFunction(()=>document.querySelector('#race-countdown').textContent==='GO')
    await cue.waitFor({state:'hidden'})
    assert.deepEqual(await page.evaluate(()=>window.cues),['3','2','1','GO'])
    assert.deepEqual(await page.evaluate(()=>window.tones),[659.25,659.25,659.25,1046.5])
    assert.match(await page.locator('#checkpoint-direction').innerText(),/\d+ m/)
    const markers=await page.evaluate(()=>{
      const {scene,camera,THREE}=window.driveMetrics.inspectLook()
      const arch=scene.getObjectByName('Next checkpoint arch')
      const mid=arch.localToWorld(new THREE.Vector3(0,2.5,0)).project(camera)
      return {visible:arch.parent.visible && Math.abs(mid.x)<1 && Math.abs(mid.y)<1 && Math.abs(mid.z)<1,span:arch.children[1].position.x-arch.children[0].position.x}
    })
    assert.ok(markers.visible && markers.span>=10)
    await page.screenshot({path:fileURLToPath(new URL('checkpoint-'+name+'.png',shots))})
    await page.evaluate(()=>{window.stick=.25})
    await page.waitForFunction(()=>driveMetrics.car.profile==='gamepad')
    await page.keyboard.down('w')
    await page.waitForFunction(()=>driveMetrics.car.profile==='keyboard' && driveMetrics.car.speed>3)
    await page.keyboard.up('w')
    const reading=await page.evaluate(()=>({hud:Number(document.querySelector('#speed').textContent),car:Math.hypot(driveMetrics.car.speed,driveMetrics.car.lateralSpeed)*3.6}))
    assert.ok(Math.abs(reading.hud-reading.car)<2)
    if(name==='phone'){
      await page.locator('[data-key=ArrowRight]').tap()
      await page.waitForFunction(()=>driveMetrics.car.profile==='buttons')
    }
    console.log(name+' showed 3–2–1–GO with four audio ticks, centred '+bounds.height.toFixed(0)+' px cue and '+markers.span.toFixed(1)+' m checkpoint arch.')
    await page.close()
  }
}finally{await browser.close();server.close()}
