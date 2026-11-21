import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {folder,root} from './audit/io.mjs'

const cells=['x6z5','x-5z24','x6z0','x3z9','x11z1','x1z23','x5z23','x6z-6','x15z7','x1z3','x3z-8','x2z-9','x13z7','x0z-8','x6z2','x4z6','x-4z31','x-7z22','x7z7','x-7z14','x4z14','x-6z8','x3z5','x3z16','x8z-3','x0z-2','x3z-3','x2z-6','x4z-6','x3z13','x-1z35','x-1z36']
cells.push('x12z0','x8z14','x1z12','x4z36','x3z29','x5z35','x4z2','x4z5','x11z7','x-1z8','x-1z0','x11z9','x11z10','x-1z20','x-1z16','x-7z3','x10z13','x6z24','x-1z-3','x4z23')
const directory=await mkdtemp(folder('ground-parity-'))
const name=directory.split('/').at(-1)
const count={}
try{
  for(const stage of ['checks','drive']){
    execFileSync(process.execPath,['web/dev/audit/run.mjs','--run',name,'--cells',cells.join(','),'--stage',stage,'--workers','3'],{cwd:root,stdio:'pipe'})
  }
  for(const cell of cells){
    const m=JSON.parse(await readFile(join(directory,'cells',cell,'metrics.json')))
    assert.ok(m.checked>0 && m.collisionProbes>0 && m.driveRuns>0,cell)
    for(const f of m.findings){
      const fail=['ground-height','surface-class','off-road-paint','launch','stuck','fall-through','sinking','camera-clip','passed-solid','collision-parity','object-base'].includes(f.check)
      assert.ok(!fail,JSON.stringify(f))
    }
    for(const k of ['checked','collisionProbes','driveRuns'])count[k]=(count[k]??0)+m[k]
  }
  console.log('Paved terraces, parking aprons, markings, vegetation, street furniture and bridge contacts',count)
}finally{await rm(directory,{recursive:true,force:true})}
