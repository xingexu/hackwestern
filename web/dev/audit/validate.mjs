import {access} from 'node:fs/promises'
import {join} from 'node:path'
import {campusFootprint} from '../../campus-clip.js'
import {args,dir,folder,json,root} from './io.mjs'

const {run,issues}=args({run:null,issues:null})
const schema=await json(join(dir,'issue.schema.json'))
const boundary=campusFootprint(await json(join(root,'web/campus-boundary.json')))
const values=await json(issues)
const records=Array.isArray(values)?values:[values]
for(const [i,record] of records.entries()) {
  const fail=message=>{throw new Error('Issue '+(i+1)+' '+message)}
  if(!record || typeof record!=='object' || Array.isArray(record)) fail('must be an object')
  for(const k of Object.keys(record)) if(!Object.hasOwn(schema.properties,k)) fail('unexpected '+k)
  for(const k of schema.required) {
    const v=record[k],rule=schema.properties[k]
    if(rule.enum && !rule.enum.includes(v) || rule.type && typeof v!==rule.type || rule.type==='number' && !Number.isFinite(v) || rule.minLength && !v.trim() || rule.pattern && !new RegExp(rule.pattern).test(v)) fail('invalid '+k)
  }
  if(record.cell!=='x'+Math.floor(record.x/50)+'z'+Math.floor(record.z/50) || !boundary.contains(record.x,record.z)) fail('coordinates outside assigned campus cell')
  await access(join(folder(run),'cells',record.cell,record.view))
}
console.log(records.length+' review issues validated')
