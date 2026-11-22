import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {chromium} from 'playwright'
import {verifyStadiumVerge} from './verify_ground_materials.mjs'

const server=spawn(process.execPath,['serve.mjs','--port','0'],{stdio:['ignore','pipe','inherit']})
let browser
try{
  const [ready]=await once(server.stdout,'data')
  const base=ready.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const page=await browser.newPage({viewport:{width:1100,height:680}})
  page.setDefaultTimeout(120000)
  await page.goto(base+'/?diagnostics')
  await page.waitForFunction(()=>window.driveMetrics?.frames>=5)
  await page.selectOption('#spawn','Western Alumni Stadium')
  await page.waitForFunction(()=>window.driveMetrics?.frames>=5 && document.querySelector('#status').hidden)
  await page.waitForLoadState('networkidle')
  await verifyStadiumVerge(page)
}finally{
  await browser?.close()
  server.kill()
}
