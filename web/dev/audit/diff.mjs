import {join} from 'node:path'
import {args,folder,json} from './io.mjs'

const {before,after}=args({before:null,after:null})
const previous=folder(before),next=folder(after)
const a=await json(join(previous,'summary.json')),b=await json(join(next,'summary.json'))
const cells=new Map(a.cells.map(c=>[c.id,c]))
const result={before,after,compared:[],uncompared:[],new:[],fixed:[]}
const key=f=>[f.check,f.x,f.z,f.measured.heading??'',f.measured.instance??'',f.measured.dx??'',f.measured.dz??''].join('|')
for(const c of b.cells) {
  const old=cells.get(c.id)
  if(!old || old.stages.toSorted().join()!==c.stages.toSorted().join()) {result.uncompared.push(c.id);continue}
  result.compared.push(c.id)
  const [left,right]=await Promise.all([previous,next].map(dir=>json(join(dir,'cells',c.id,'metrics.json'))))
  const unmatched=new Map()
  for(const f of left.findings) {
    const k=key(f)
    if(!unmatched.has(k)) unmatched.set(k,[])
    unmatched.get(k).push(f)
  }
  for(const f of right.findings) {
    if(!unmatched.get(key(f))?.pop()) result.new.push(f)
  }
  for(const group of unmatched.values()) result.fixed.push(...group)
}
const nextIds=new Set(b.cells.map(c=>c.id))
result.uncompared.push(...a.cells.filter(c=>!nextIds.has(c.id)).map(c=>c.id))
console.log(JSON.stringify(result))
