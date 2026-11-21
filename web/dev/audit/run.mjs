import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createInterface} from 'node:readline'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {args,dir,folder,grid,json,python,root,save,summary} from './io.mjs'

const options=args({run:null,cells:null,workers:'3',stage:'all',poses:'current'})
const stages=options.stage==='all'?['checks','drive','capture']:[options.stage]
if(stages.some(s=>!['checks','capture','drive'].includes(s))) throw new Error('Unknown audit stage')
const workers=Number(options.workers)
if(!Number.isInteger(workers)||workers<1) throw new Error('Invalid worker count')
const out=folder(options.run), all=grid(), cells=options.cells?grid(options.cells):all
const inventory=(await json(join(root,'data/buildings/inventory.json'))).buildingsList.map(({id,footprint,holes,ground,heightMax})=>{
  const xs=footprint.map(p=>p[0]),zs=footprint.map(p=>p[1])
  return {id,footprint,holes,ground,heightMax,bounds:[Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)]}
})
const buildings=await Promise.all(inventory.map(async b=>{
  const spec=await json(join(root,'build/specs/buildings',b.id+'.json'))
  return {...b,present:spec.present!==false,lidarTrusted:spec.lidarTrusted!==false}
}))
const start=performance.now(),server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']})
const [banner]=await once(server.stdout,'data')
const base=banner.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0]
let browser,completed=0
try {
  if(stages.includes('capture')) {
    const loader=spawn(python,['-B',join(dir,'orthos.py')],{stdio:['pipe','inherit','inherit']})
    const exit=once(loader,'exit')
    loader.stdin.end(JSON.stringify(cells.map(({x,z})=>({x,z}))))
    if((await exit)[0]!==0) throw new Error('2025 ortho download failed')
  }
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const n=Math.min(workers,cells.length)
  await Promise.all(Array.from({length:n},async(_,i)=>{
    const page=await browser.newPage({viewport:{width:500,height:300}})
    const pending=new Set()
    page.on('request',r=>pending.add(r))
    page.on('requestfinished',r=>pending.delete(r))
    page.on('requestfailed',r=>pending.delete(r))
    const errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    page.on('response',r=>{if(r.status()>=400) errors.push(r.status()+' '+r.url())})
    await page.goto(base+'/?audit')
    await page.waitForFunction(()=>window.campusAudit||document.querySelector('#status[role=alert]'),null,{timeout:120000})
    if(!await page.evaluate(()=>!!window.campusAudit)) throw new Error(await page.locator('#status').textContent())
    const sheets=spawn(python,['-B',join(dir,'composite.py')],{stdio:['pipe','pipe','inherit']})
    const replies=sheets?createInterface({input:sheets.stdout})[Symbol.asyncIterator]():null
    try {
      for(let j=Math.floor(i*cells.length/n);j<Math.floor((i+1)*cells.length/n);j++) {
        const cell=cells[j],directory=join(out,'cells',cell.id)
        await mkdir(directory,{recursive:true})
        await page.evaluate(c=>window.campusAudit.focus(c),cell)
        const since=Date.now()
        do {
          await page.waitForTimeout(60)
          if(Date.now()-since>45000) throw new Error('Scene tiles timed out '+cell.id)
        } while(pending.size)
        if(errors.length) throw new Error(errors.join('\n'))
        const nearby=buildings.filter(({bounds:[l,t,r,b]})=>l<=cell.x+50 && r>=cell.x && t<=cell.z+50 && b>=cell.z)
        const m=await page.evaluate(([c,b,s])=>window.campusAudit.measure(c,b,s),[cell,nearby,stages])
        delete m.totalMs
        if(!stages.includes('checks')) m.checksMs=0
        if(!stages.includes('drive')) m.driveMs=0
        m.cell={id:cell.id,x:cell.x,z:cell.z,area:cell.area}
        m.stages=stages
        const path=join(directory,'metrics.json')
        let previous
        try {previous=await json(path)} catch(e){if(e.code!=='ENOENT') throw e}
        if(previous && options.stage!=='all') {
          const drive=new Set(['fall-through','launch','sinking','passed-solid','camera-clip','stuck'])
          const keep=name=>!stages.includes(drive.has(name)?'drive':'checks')
          m.findings.push(...previous.findings.filter(f=>keep(f.check)))
          for(const [name,count] of Object.entries(previous.counts)) if(keep(name)) {m.counts[name]=count;m.worst[name]=previous.worst[name]}
          if(!stages.includes('checks')) for(const key of ['areaChecked','checked','collisionProbes','checksMs','edgeObservations']) m[key]=previous[key]
          if(!stages.includes('drive')) for(const key of ['driveRuns','driveMs']) m[key]=previous[key]
          if(!stages.includes('capture')) for(const key of ['views','captureMs']) m[key]=previous[key]
          m.stages=[...new Set([...previous.stages,...stages])]
        }
        if(stages.includes('capture')) {
          const before=performance.now()
          if(options.poses==='saved' && !previous?.views) throw new Error('Missing saved poses for '+cell.id)
          m.views=options.poses==='saved'?previous.views:await page.evaluate(([c,a])=>window.campusAudit.poses(c,a),[cell,m.anchor])
          const views=join(directory,'views')
          await mkdir(views,{recursive:true})
          for(const pose of m.views) {
            const data=await page.evaluate(p=>window.campusAudit.render(p),pose)
            await writeFile(join(views,pose.name+'.png'),Buffer.from(data,'base64'))
          }
          m.captureMs=performance.now()-before
        }
        if(m.views) {
          const before=performance.now()
          await save(path,m)
          sheets.stdin.write(JSON.stringify(directory)+'\n')
          if((await replies.next()).value!=='ok') throw new Error('Composite generation failed')
          if(stages.includes('capture')) m.captureMs+=performance.now()-before
        }
        if(errors.length) throw new Error(errors.join('\n'))
        await save(path,m)
        if(++completed%20===0 || cells.length<10) console.log(completed+'/'+cells.length,cell.id,Math.round(performance.now()-start)+' ms')
      }
    } finally {sheets?.stdin.end();await page.close()}
  }))
  const {cells:finished,...report}=await summary(out,all,performance.now()-start)
  console.log(JSON.stringify(report))
} finally {await browser?.close();server.kill()}
