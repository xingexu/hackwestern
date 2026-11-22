import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {folder,root} from './audit/io.mjs'

const cells=['x6z5','x-5z24','x6z0','x3z9','x11z1','x1z23','x5z23','x6z-6','x15z7','x1z3','x3z-8','x2z-9','x13z7','x0z-8','x6z2','x4z6','x-4z31','x-7z22','x7z7','x-7z14','x4z14','x-6z8','x3z5','x3z16','x8z-3','x0z-2','x3z-3','x2z-6','x4z-6','x3z13','x-1z35','x-1z36']
cells.push('x12z0','x8z14','x1z12','x4z36','x3z29','x5z35','x4z2','x4z5','x11z7','x-1z8','x-1z0','x11z9','x11z10','x-1z20','x-1z16','x-7z3','x10z13','x6z24','x-1z-3','x4z23')
cells.push('x8z0','x-1z22','x8z11','x7z-9','x-7z12','x-6z24','x-1z4','x5z19','x12z6','x7z22','x12z11','x13z-1','x7z20','x14z8','x0z12','x8z5','x9z3')
cells.push('x2z10','x1z-3','x-1z27','x6z-7','x15z8','x4z19','x-6z11','x0z34','x4z26','x-2z-5','x-2z24','x-3z-4','x-9z19','x2z22','x9z0','x-3z0','x-4z-5','x4z-7','x5z-6')
cells.push('x0z-1','x7z-7','x8z26')
const frontages=['x-2z-5','x-2z24','x-3z2','x-4z11','x-6z11','x-6z2','x-6z6','x0z-1','x12z0','x2z26','x2z27','x3z12','x4z-1','x4z-10','x4z1','x4z12','x4z16','x4z28','x5z-3','x5z1','x5z12','x5z22','x5z23','x5z27','x6z-11']
cells.push(...frontages.filter(id=>!cells.includes(id)))
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
      const fail=['ground-height','height-step','surface-class','off-road-paint','launch','stuck','fall-through','sinking','camera-clip','passed-solid','collision-parity','object-base'].includes(f.check)
      assert.ok(!fail,JSON.stringify(f))
    }
    for(const k of ['checked','collisionProbes','driveRuns'])count[k]=(count[k]??0)+m[k]
  }
  execFileSync(process.execPath,['web/dev/audit/run.mjs','--run',name,'--cells',[...new Set([...frontages,...'x6z21,x-3z10,x-2z10,x4z14,x6z19,x7z14,x10z-7,x6z14,x-7z11,x6z26,x6z2,x2z3,x-5z18,x-2z3,x11z8,x-4z1,x-2z1,x-4z26,x8z10,x0z34,x4z26,x-2z-5,x-2z24,x-3z-4,x-9z19,x2z22,x-3z0,x-4z-5,x4z-7,x5z-6,x-2z-3,x-2z-4,x0z3,x8z-3,x-5z-2,x-5z-4,x7z-7,x8z26'.split(',')])].join(','),'--stage','capture','--workers','1'],{cwd:root,stdio:'pipe'})
  execFileSync(join(root,'.venv/bin/python'),['build/check_lot_surface.py',directory],{cwd:root,stdio:'inherit'})
  execFileSync(join(root,'.venv/bin/python'),['build/check_occupied_rows.py',directory],{cwd:root,stdio:'inherit'})
  execFileSync(join(root,'.venv/bin/python'),['build/check_river_frontages.py',directory],{cwd:root,stdio:'inherit'})
  execFileSync(join(root,'.venv/bin/python'),['build/check_frontage_materials.py',directory],{cwd:root,stdio:'inherit'})
  console.log('Paved terraces, parking aprons, markings, vegetation, street furniture and bridge contacts',count)
}finally{await rm(directory,{recursive:true,force:true})}
