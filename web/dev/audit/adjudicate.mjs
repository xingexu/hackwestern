import {join} from 'node:path'
import {args,folder,json,save} from './io.mjs'

const {run,labels}=args({run:null,labels:null})
const dest=join(folder(run),'calibration')
const [sample,verdicts]=await Promise.all([json(join(dest,'sample.json')),json(labels)])
const checks=['missing-ground','ground-height','surface-class','height-step','building-height','stray-building','coincident-surfaces','object-base','off-road-paint','collision-parity','fall-through','launch','sinking','stuck','passed-solid','camera-clip']
const perCheck=Object.fromEntries(checks.map(check=>[check,{flagged:sample.counts[check]??0,sampled:0,confirmed:0,falsePositive:0,inconclusive:0}]))
const allowed=['confirmed','falsePositive','inconclusive']
for(const row of sample.rows){
  const entry=verdicts[row.id]
  if(!allowed.includes(entry?.verdict)||!entry.basis)throw new Error('Missing review of '+row.id)
  const record=perCheck[row.finding.check]
  record[entry.verdict]++
  record.sampled++
}
if(Object.keys(verdicts).length!==sample.rows.length)throw new Error('Review and sample row counts differ')
for(const row of Object.values(perCheck)){
  const resolved=row.confirmed+row.falsePositive
  row.precisionResolved=resolved?row.confirmed/resolved:null
  row.confirmedFraction=row.sampled?row.confirmed/row.sampled:null
}
await save(join(dest,'review.json'),{seed:sample.seed,sample:'sample.json',perCheck,verdicts})
console.log(JSON.stringify(perCheck))
