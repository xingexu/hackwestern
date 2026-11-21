import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {args,folder,json,root,save} from './io.mjs'

const {run,samples,seed}=args({run:null,samples:'4',seed:'34129'})
const out=folder(run),dest=join(out,'calibration'),picked=new Map(),n=Number(samples)
const counts=new Map()
let state=Number(seed)
function random(){state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296}
for(const cell of (await json(join(out,'summary.json'))).cells) {
  const m=await json(join(out,'cells',cell.id,'metrics.json'))
  for(const f of m.findings) {
    const k=f.check,seen=(counts.get(k)??0)+1
    counts.set(k,seen)
    if(!picked.has(k)) picked.set(k,[])
    const records=picked.get(k)
    if(records.length<n) records.push(f)
    else {const i=Math.floor(random()*seen);if(i<n) records[i]=f}
  }
}
await mkdir(dest,{recursive:true})
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']})
let browser
try {
  const [banner]=await once(server.stdout,'data'),base=banner.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const page=await browser.newPage()
  await page.goto(base+'/?audit')
  await page.waitForFunction(()=>window.campusAudit,{},{timeout:120000})
  const rows=[]
  for(const [category,records] of picked) for(const [i,f] of records.entries()) {
    const probe=f.measured.probe
    const [x,y,z]=f.measured.camera??(typeof probe==='object'?[probe.x,probe.y,probe.z]:f.measured.at)??[f.x,f.y,f.z]
    const cell={x:Math.floor(x/50)*50,z:Math.floor(z/50)*50}
    const id=category+'-'+(i+1)
    const target=await page.evaluate(async({cell,x,y,z})=>{
      const audit=window.campusAudit
      await audit.focus(cell)
      await new Promise(resolve=>setTimeout(resolve,110))
      return audit.inspect?.(cell,x,y,z)??null
    },{cell,x,y,z})
    const poses=[{eye:[x,y+65,z],at:[x,y,z],span:12,up:[0,0,-1]},{eye:[x+7,y+5,z+8],at:[x,y,z],fov:50}]
    const nearViews=await page.evaluate(({cell,x,y,z})=>{
      const audit=window.campusAudit
      const ranked=[]
      for(const [dx,dz] of [[1,0],[0,-1],[-1,0],[0,1]]){
        const eye=[x+4*dx,y+1.45,z+4*dz]
        let occluders=0
        for(const distance of [1,2.5,4]){
          const probe=audit.inspect(cell,x+distance*dx,y+distance*.36,z+distance*dz)
          if(probe.eye || probe.physics.y>y+distance*.36)occluders+=2
          if(probe.hits.some(h=>h.kind==='building' && h.y>y+distance*.36))occluders++
        }
        ranked.push({eye,score:occluders})
      }
      return ranked.sort((a,b)=>a.score-b.score)
    },{cell,x,y,z})
    poses.push({eye:nearViews[0].eye,at:[x,y,z],fov:57})
    if(f.measured.camera && f.measured.at){
      const [cx,cy,cz]=f.measured.camera
      const [bx,,bz]=f.measured.at
      const length=Math.hypot(bx-cx,bz-cz)
      const dx=length>.01?(bx-cx)/length:Math.sin(f.measured.heading)
      const dz=length>.01?(bz-cz)/length:Math.cos(f.measured.heading)
      poses.push({eye:[cx,cy,cz],at:[cx+14*dx,cy-1.83,cz+14*dz],fov:62})
    }
    for(const [j,p] of poses.entries()){
      const bytes=await page.evaluate(p=>window.campusAudit.render({...p,width:320,height:320}),p)
      await writeFile(join(dest,id+'-'+j+'.png'),Buffer.from(bytes,'base64'))
    }
    rows.push({id,point:[x,y,z],finding:f,evidence:target,poses})
  }
  await save(join(dest,'sample.json'),{seed,counts:Object.fromEntries(counts),rows})
} finally {await browser?.close();server.kill()}
