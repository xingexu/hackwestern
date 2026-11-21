import './controls.mjs'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {BoxGeometry,Float32BufferAttribute,Group,Mesh,MeshBasicMaterial} from 'three'
import {spatialIndex} from './spatial.mjs'
import {dir,folder,json,python} from './io.mjs'

await mkdir(join(folder('smoke-'),'..'),{recursive:true})
const out=await mkdtemp(folder('smoke-'))
const run=out.split('/').at(-1)
const cli=(name,...args)=>execFileSync(process.execPath,[join(dir,name+'.mjs'),...args],{encoding:'utf8',stdio:'pipe'})
try {
  const root=new Group(),wall=new Mesh(new BoxGeometry(.1,4,12),new MeshBasicMaterial())
  wall.position.set(20,2,20)
  root.add(wall)
  root.updateMatrixWorld(true)
  const index=spatialIndex([root],{x:0,z:0},()=> 'building')
  assert.ok(index.solid(20.8,.1,20))
  assert.equal(index.solid(21.1,.1,20),undefined)
  assert.equal(index.column(20,20)[0].y,4)
  assert.deepEqual(index.column(18,20),[])
  assert.equal(index.base(20,20,0,'building',.4),0)
  const wide=new Mesh(new BoxGeometry(4,2,4),wall.material)
  wide.position.set(5,2,5)
  wide.updateMatrixWorld()
  const broad=spatialIndex([wide],{x:0,z:0},()=> 'prop')
  assert.equal(broad.base(5,5,0,'prop',.1),1)
  const leaf=new Float32BufferAttribute(new Float32Array(wide.geometry.attributes.position.count).fill(1),1)
  wide.geometry.setAttribute('leaf',leaf)
  const tree=spatialIndex([wide],{x:0,z:0},()=> 'tree')
  assert.equal(tree.solid(6.95,1.2,5,.2,.5),undefined)
  leaf.array.fill(0)
  assert.ok(tree.solid(6.95,1.2,5,.2,.5))
  const rootIndex=spatialIndex([wall],{x:0,z:0},()=> 'limb')
  assert.equal(rootIndex.trunkBase(20,20,'limb'),1.5)
  assert.equal(rootIndex.trunkBase(20.2,20,'limb'),Infinity)
  cli('run','--run',run,'--cells','x0z0,x4z5,x-11z8','--workers','2')
  const summary=await json(join(out,'summary.json'))
  assert.equal(summary.checked,5883)
  assert.ok(Math.abs(summary.areaChecked-5849.920526)<.000001)
  assert.equal(summary.reviewImages,3)
  assert.ok(summary.collisionProbes>100 && summary.driveRuns>=8)
  let views=0
  for(const cell of summary.cells) {
    const base=join(out,'cells',cell.id),m=await json(join(base,'metrics.json'))
    assert.equal(m.views.length,m.anchor?12:4)
    views+=m.views.length
    for(const v of m.views) {
      const png=await readFile(join(base,'views',v.name+'.png'))
      assert.equal(png.readUInt32BE(16),v.width)
      assert.equal(png.readUInt32BE(20),v.height)
      assert.ok(png.length>4000)
    }
    const jpeg=await readFile(join(base,'composite.jpg'))
    assert.equal(jpeg.readUInt16BE(0),0xffd8)
    assert.ok(jpeg.length>70000)
  }
  const exterior=join(out,'cells','x-11z8','views','top.png')
  const paletteCheck=[
    'import sys',
    'from PIL import Image',
    'with Image.open(sys.argv[1]) as photo:',
    '    crop=photo.convert("RGB").resize((250,250))',
    'print(max(count for count,color in crop.getcolors(62500))/62500)',
  ].join('\n')
  const uniformFraction=Number(execFileSync(python,['-c',paletteCheck,exterior],{encoding:'utf8'}))
  assert.ok(uniformFraction<.20,'Aerial camera lost the landscape outside the playable parcel')
  cli('batches','--run',run,'--reviewers','2')
  assert.equal(new Set((await json(join(out,'batches.json'))).flatMap(b=>b.cells)).size,3)
  const issue={cell:'x0z0',x:1,z:1,category:'surface',severity:'medium',description:'Ground material differs from the photograph.',view:'views/top.png',suggestedOwner:'terrain'}
  const path=join(out,'issue.json')
  await writeFile(path,JSON.stringify(issue))
  cli('validate','--run',run,'--issues',path)
  await writeFile(path,JSON.stringify({...issue,x:-1}))
  assert.throws(()=>cli('validate','--run',run,'--issues',path))
  const diff=JSON.parse(cli('diff','--before',run,'--after',run))
  assert.equal(diff.fixed.length+diff.new.length+diff.uncompared.length,0)
  const sample=join(out,'cells','x0z0'),metrics=await json(join(sample,'metrics.json'))
  metrics.views=metrics.views.filter(v=>!v.name.startsWith('eye-') && !v.name.startsWith('chase-'))
  metrics.anchor=null
  await writeFile(join(sample,'metrics.json'),JSON.stringify(metrics))
  execFileSync(python,['-B',join(dir,'composite.py')],{input:JSON.stringify(sample)+'\n'})
  await assert.rejects(readFile(join(sample,'views','eye-N.png')),{code:'ENOENT'})
  console.log('Three cells, including a clipped boundary cell, covered '+summary.checked+' samples, '+summary.driveRuns+' driving trials and '+views+' rendered views')
} finally {await rm(out,{recursive:true,force:true})}
