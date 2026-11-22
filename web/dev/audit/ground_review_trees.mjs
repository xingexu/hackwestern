import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {folder,json,root,save} from './io.mjs'

const out=folder(process.argv[2])
const {issues}=await json(join(out,'ground-review.json'))
const ground=await readFile(join(root,'web/ground-materials.json'))
const trees=JSON.parse(ground).landcover.observations.trees
const cells=new Map(),nearby=issues.map(issue=>{
  if(issue.category!=='vegetation')return []
  const candidates=trees.map(([x,z,height])=>({x,z,height,d:Math.hypot(x-issue.x,z-issue.z)})).filter(p=>p.d<14).sort((a,b)=>a.d-b.d).slice(0,3)
  for(const p of candidates){
    const col=Math.floor(p.x/50),row=Math.floor(p.z/50),id='x'+col+'z'+row
    if(!cells.has(id))cells.set(id,{cell:{id,x:col*50,z:row*50},points:new Map()})
    cells.get(id).points.set([p.x,p.z].join(','),p)
  }
  return candidates
})
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']})
let browser
try{
  const [banner]=await once(server.stdout,'data')
  const base=banner.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const page=await browser.newPage({viewport:{width:500,height:300}})
  await page.goto(base+'/?audit&diagnostics')
  await page.waitForFunction(()=>window.campusAudit&&window.driveMetrics?.network,undefined,{timeout:120000})
  const measured=new Map()
  for(const {cell,points} of cells.values()){
    const hits=await page.evaluate(async({cell,points})=>{
      await campusAudit.focus(cell)
      const network=driveMetrics.network
      return points.map(({x,z,height})=>{
        const y=network.groundAt(x,z),data=campusAudit.inspect(cell,x,y,z)
        const source=network.solidSource(x,z,y,.09)
        const body=data.body?.kind
        const crown=data.hits.filter(p=>p.kind==='municipal'||p.kind==='leaves').map(p=>p.y-y)
        const above=Math.max(0,...crown)
        return {x,z,height,body,blocker:source?.owner??null,base:source?.low??null,ground:y,above,
          grounded:source?.owner==='municipal tree'&&Math.abs(source.low-y)<.65&&body==='municipal'&&above>height*.22}
      })
    },{cell,points:[...points.values()]})
    for(const hit of hits)measured.set([hit.x,hit.z].join(','),hit)
  }
  const cases=nearby.map(candidates=>candidates.map(p=>({...measured.get([p.x,p.z].join(',')),distance:Math.round(p.d*100)/100})))
  const keys=issues.map(issue=>issue.cell+'|'+issue.description)
  await save(join(out,'review-trees.json'),{groundHash:createHash('sha256').update(ground).digest('hex'),keys,cases})
  console.log(issues.length+' review cases, '+measured.size+' surveyed tree positions tested, '+[...measured.values()].filter(p=>p.grounded).length+' with a visible colliding trunk at ground level.')
}finally{
  await browser?.close()
  server.kill()
}
