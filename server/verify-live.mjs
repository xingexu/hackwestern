import {chromium} from 'playwright'

const origin=process.argv[2]||'https://fwestern.ca'
const browser=await chromium.launch()
async function attempt(){
  const page=await browser.newPage()
  const errors=[]
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
  await page.goto(origin+'/?mode=drive&diagnostics&course=sprint&fresh='+Date.now(),{waitUntil:'domcontentloaded'})
  const outcome=await page.waitForFunction(()=>{
    const status=document.querySelector('#status')
    if(window.driveMetrics?.frames>=2)return 'drivable'
    if(status?.getAttribute('role')==='alert')return 'failed: '+status.textContent
    return false
  },null,{timeout:120000,polling:500}).then(handle=>handle.jsonValue(),error=>'failed: '+error.message.split('\n')[0])
  const course=outcome==='drivable'?await page.evaluate(()=>window.driveMetrics.course):null
  await page.close()
  return {outcome,course,errors:errors.slice(0,5)}
}
let result
for(let tries=1;tries<=3;tries++){
  result=await attempt()
  console.log(JSON.stringify({origin,tries,...result}))
  if(result.outcome==='drivable')break
  await new Promise(resolve=>setTimeout(resolve,20000))
}
await browser.close()
if(result.outcome!=='drivable' || result.course!=='sprint')process.exit(1)
