import {join} from 'node:path'
import {args,folder,json,save} from './io.mjs'

const {run,reviewers}=args({run:null,reviewers:'16'})
const n=Number(reviewers),out=folder(run)
if(!Number.isInteger(n)||n<1) throw new Error('Expected a positive reviewer count')
const {cells}=await json(join(out,'summary.json'))
const groups=Array.from({length:n},(_,i)=>({reviewer:i+1,load:0,area:0,cells:[]}))
for(const c of cells) c.weight=c.area+Math.min(c.detail,10000)*.8+500
for(const c of cells.sort((a,b)=>b.weight-a.weight||a.id.localeCompare(b.id))) {
  const group=groups.reduce((a,b)=>a.load<=b.load?a:b)
  group.cells.push(c.id)
  group.area+=c.area
  group.load+=c.weight
}
await save(join(out,'batches.json'),groups)
console.log(cells.length+' cells in '+n+' batches')
