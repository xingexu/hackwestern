import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'

const base=new URL(process.argv[2]).origin
const health=await (await fetch(base+'/api/health')).json()
assert.equal(health.multiplayer,true)
const driver=(await readFile(new URL('../web/dev/circuit_driver.mjs',import.meta.url),'utf8')).replace('export function','function')
const browser=await chromium.launch({args:['--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',...(process.platform==='darwin'?['--use-angle=metal']:[])]})
const pages=[]
async function desktop(name){
  const page=await browser.newPage({viewport:{width:900,height:600}})
  pages.push(page)
  await page.addInitScript({content:driver+`
    Object.defineProperty(navigator,'getGamepads',{value:()=>{
      const metrics=window.driveMetrics
      if(!window.pilot || metrics?.course!=='stadium')return []
      const route=metrics.network.circuits.find(c=>c.id==='stadium').samples
      const {steer,throttle,brake}=driveInput(route,metrics.car)
      return [{connected:true,mapping:'standard',axes:[-Math.sign(steer)*(.12+.88*Math.min(1,Math.abs(steer)))],buttons:Array.from({length:10},(_,i)=>({value:i===6?brake:i===7?throttle:0}))}]
    }})
  `})
  await page.goto(base+'/?diagnostics')
  await page.getByRole('button',{name:'Online',exact:true}).click({timeout:60000})
  await page.locator('#race-name').fill(name)
  return page
}
try{
  const [host,guest]=await Promise.all([desktop('Test West'),desktop('Test East')])
  await host.locator('#make-room').click()
  await host.locator('#room-label').waitFor()
  const code=(await host.locator('#room-label').innerText()).split(' ').at(-1)
  await guest.locator('#room-code').fill(code)
  await guest.locator('#join-room').click()
  await guest.locator('#room-label').waitFor()
  await host.waitForFunction(()=>document.querySelector('#room-roster').textContent.includes('Test East · Waiting') && !document.querySelector('#race-ready').disabled)
  await host.locator('#race-course').selectOption('stadium')
  await guest.waitForFunction(()=>document.querySelector('#race-course').value==='stadium')
  await host.locator('#race-contact').uncheck()
  await guest.waitForFunction(()=>document.querySelector('#race-course').value==='stadium' && !document.querySelector('#race-contact').checked)
  for(const page of pages)await page.locator('#race-ready').click()
  await host.locator('#race-start').click()
  await Promise.all(pages.map(async page=>{
    await page.waitForFunction(()=>window.driveMetrics?.course==='stadium' && !document.querySelector('#race-banner').hidden)
    await page.evaluate(()=>{window.pilot=true})
    await page.waitForFunction(()=>window.driveMetrics.car.distance>15 && window.driveMetrics.opponents.length===1,null,{timeout:30000})
  }))
  await Promise.all(pages.map(page=>page.waitForFunction(()=>document.querySelector('#room-roster').textContent.includes('2. '),null,{timeout:230000})))
  const results=await (await fetch(base+'/api/rooms/'+code+'/results')).json()
  assert.equal(results.at(-1).results.filter(p=>p.finish>0).length,2)
  assert.equal(await host.locator('#room-roster').innerText(),await guest.locator('#room-roster').innerText())
  console.log(base,code,JSON.stringify(results.at(-1).results))
}finally{
  for(const p of pages)if(await p.locator('#race-leave').isVisible())await p.locator('#race-leave').click().catch(()=>{})
  await browser.close()
}
