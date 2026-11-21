import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {args,folder,json,root,save} from './io.mjs'

const {run}=args({run:null})
const dest=join(folder(run),'calibration')
const sample=await json(join(dest,'sample.json'))
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']})
let browser
try{
  const [banner]=await once(server.stdout,'data'),base=banner.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const page=await browser.newPage()
  for(const file of ['drive-sim.mjs','race/math.mjs']){
    await page.route('**/audit-replay/'+file,route=>route.fulfill({contentType:'application/javascript',path:join(root,'web',file)}))
  }
  await page.goto(base+'/?diagnostics&audit')
  await page.waitForFunction(()=>window.campusAudit && window.driveMetrics,null,{timeout:120000})
  const entries={}
  for(const row of sample.rows.filter(row=>row.finding.check==='stuck')){
    const trace=await page.evaluate(async f=>{
      const audit=window.campusAudit,network=window.driveMetrics.network
      const {createDriveSim}=await import('/audit-replay/drive-sim.mjs')
      const cell={x:Math.floor(f.x/50)*50,z:Math.floor(f.z/50)*50}
      await audit.focus(cell)
      await new Promise(resolve=>setTimeout(resolve,120))
      let first
      const observed={...network,blocked(x,z,y,r){
        const blocked=network.blocked(x,z,y,r)
        if(blocked && !first)first={x,y,z,r,reason:network.blockerKind(x,z,y,r)}
        return blocked
      }}
      const heading=Math.round(f.measured.heading/(Math.PI/2))*Math.PI/2
      const p=network.sample(f.x,f.z),sim=createDriveSim([{...p,heading,distance:0}],{mode:'roam',network:observed})
      sim.state.speed=12
      for(let i=0;i<36;i++)sim.step({throttle:1})
      const out={advance:Math.hypot(sim.state.x-p.x,sim.state.z-p.z),first}
      if(first){
        const {x,y,z}=first
        out.evidence=audit.inspect(cell,x,y,z)
        out.image=audit.render({eye:[x+3,y+1.65,z+3],at:[x,y+.45,z],fov:53,width:360,height:360})
      }
      return out
    },row.finding)
    if(trace.image){
      await writeFile(join(dest,row.id+'-impact.png'),Buffer.from(trace.image,'base64'))
      delete trace.image
    }
    entries[row.id]=trace
  }
  await save(join(dest,'stuck-replays.json'),entries)
}finally{await browser?.close();server.kill()}
