import assert from 'node:assert/strict'
import {once} from 'node:events'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {chromium,devices} from 'playwright'
import {hudArea} from './measure_hud.mjs'
import {drivingMenu} from './mobile_menu.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url)),shots=new URL('./shots/mobile-hud/',import.meta.url)
const listener=createServer().listen(0,'127.0.0.1')
await once(listener,'listening')
const port=listener.address().port
await new Promise(resolve=>listener.close(resolve))
await mkdir(shots,{recursive:true})
await mkdir(root+'.wrangler',{recursive:true})
const storage=await mkdtemp(root+'.wrangler/hud-'),hosted=process.env.HUD_BASE
const base=hosted || 'http://127.0.0.1:'+port
const local=hosted?null:spawn(process.execPath,['server/lan.mjs','--host','127.0.0.1','--port',String(port),'--persist-to',storage],{cwd:root,stdio:'ignore',detached:true})
let browser
try{
  for(let i=0;i<200;i++){
    try{if((await fetch(base+'/api/health')).ok)break}catch{}
    if(local?.exitCode!=null || i===199)throw Error('Could not start HUD test server')
    await delay(100)
  }
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  for(const [kind,viewport] of [['landscape',{width:844,height:390}],['portrait',{width:390,height:844}],['desktop',{width:1280,height:720}]]){
    const phone=kind!=='desktop'
    const page=await browser.newPage({...phone?devices['Pixel 7']:{},viewport,deviceScaleFactor:1})
    await page.goto(base+'/?diagnostics&course=stadium')
    await page.waitForFunction(()=>window.driveMetrics?.frames>2 && document.querySelector('#make-pad'),null,{timeout:90000})
    const menu=page.locator('#mobile-menu-toggle'),map=page.locator('#mobile-map-toggle'),card=page.locator('.course-card')
    assert.equal(await menu.isVisible(),phone)
    assert.equal(await card.isVisible(),!phone)
    if(phone){
      await drivingMenu(page)
      assert.ok(await page.locator('#tilt').isVisible() && await page.locator('#phone-settings summary').isVisible())
      assert.ok(await page.locator('#driving-settings').isVisible() && await page.getByRole('button',{name:'Phone controller',exact:true}).isVisible())
      await page.locator('#driving-settings summary').click()
      assert.ok(await page.locator('#audio-master').isVisible() && await page.locator('#driving-assists').isVisible())
      await page.locator('#driving-settings summary').click()
      await drivingMenu(page,false)
      assert.equal(await page.locator('#tilt').isVisible(),false)
      const compact=await map.boundingBox()
      await map.click()
      assert.ok((await map.boundingBox()).width>compact.width*2)
      await map.click()
    }
    await page.keyboard.down('w')
    if(phone)await page.locator('#mobile-drive-hint.visible').waitFor()
    await page.waitForFunction(()=>driveMetrics.car.elapsed>=.9)
    await page.keyboard.up('w')
    await page.waitForFunction(()=>driveMetrics.car.distance>5 && driveMetrics.car.elapsed>=4.5)
    assert.equal(await page.evaluate(()=>driveMetrics.car.offCourse),false)
    const area=await page.evaluate(hudArea)
    if(phone){
      assert.ok(area.share<=15,kind+' HUD covered '+area.share+'%')
      assert.ok(!await card.isVisible() && !await page.locator('#mobile-drive-hint').isVisible())
      assert.ok((await page.locator('.instruments').boundingBox()).height<30)
      for(const b of await page.locator('#touch-drive [data-key]').all()){
        const r=await b.boundingBox()
        assert.ok(r && r.width>=44 && r.height>=44 && r.x>=0 && r.y>=0 && r.x+r.width<=viewport.width+1 && r.y+r.height<=viewport.height+1)
      }
      assert.ok(await page.locator('#checkpoint-direction').isVisible())
    }else{
      assert.ok(Math.abs(area.share-15.075)<.15,'Desktop HUD moved from its measured 1280 × 720 footprint: '+area.share+'%')
      assert.ok(await page.locator('#route-plan').isVisible() && await page.locator('#powertrain').isVisible() && await page.locator('#surface').isVisible())
      assert.equal(await map.isVisible(),false)
      assert.ok(await page.locator('.drive-help').isVisible())
    }
    await page.screenshot({path:fileURLToPath(new URL('after-'+kind+'.png',shots))})
    console.log(kind,area.px+' px²',area.share.toFixed(2)+'%')
    if(kind==='portrait'){
      await drivingMenu(page)
      await page.getByRole('button',{name:'Phone controller',exact:true}).click()
      await page.locator('#pad-info').waitFor()
      const controller=await browser.newPage({...devices['Pixel 7']})
      await controller.goto(base+'/pad')
      await controller.locator('#code').fill(await page.locator('#pad-code').innerText())
      await controller.getByRole('button',{name:'Pair controller'}).click()
      await page.waitForFunction(()=>document.querySelector('#pad-state').textContent==='Phone connected')
      await page.locator('#touch-drive').waitFor({state:'hidden'})
      await controller.close()
      await page.locator('#touch-drive').waitFor({state:'visible'})
    }
    await page.close()
  }
}finally{
  await browser?.close()
  if(local){try{process.kill(-local.pid,'SIGTERM')}catch{}}
  await rm(storage,{recursive:true,force:true,maxRetries:3})
}
