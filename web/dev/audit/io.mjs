import {mkdir,readFile,rename,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {parseArgs} from 'node:util'

export const root=fileURLToPath(new URL('../../../',import.meta.url))
export const dir=fileURLToPath(new URL('./',import.meta.url))
export const python=join(root,'.venv','bin','python')
export const json=async path=>JSON.parse(await readFile(path,'utf8'))
export function args(options) {
  return parseArgs({options:Object.fromEntries(Object.entries(options).map(([name,value])=>[name,{type:'string',...(value?{default:value}:{})}]))}).values
}
export function folder(run) {
  if(!run || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(run) || run==='ortho-2025') throw new Error('Expected a run name')
  return resolve(root,'data/audit',run)
}
export function grid(filter) {
  const cells=JSON.parse(execFileSync(python,['-B',join(dir,'grid.py')],{maxBuffer:20e6}))
  if(!filter) return cells
  const ids=new Set(filter.split(','))
  const chosen=cells.filter(c=>ids.delete(c.id))
  if(ids.size) throw new Error('Unknown cells '+[...ids])
  return chosen
}
export async function save(path,data) {
  await writeFile(path+'.tmp',JSON.stringify(data))
  await rename(path+'.tmp',path)
}
export async function summary(out,cells,wallMs) {
  const counts={},severity={},byCheckSeverity={},stages={checks:0,drive:0,capture:0}
  let checked=0,areaChecked=0,driveRuns=0,collisionProbes=0,reviewImages=0,edgeObservations=0
  const completed=[]
  for(const {id} of cells) {
    let m
    try {m=await json(join(out,'cells',id,'metrics.json'))}
    catch(e){if(e.code==='ENOENT') continue;throw e}
    checked+=m.checked; areaChecked+=m.areaChecked; driveRuns+=m.driveRuns; collisionProbes+=m.collisionProbes
    edgeObservations+=m.edgeObservations?.length??0
    for(const f of m.findings){
      severity[f.severity]=(severity[f.severity]??0)+1
      const row=byCheckSeverity[f.check]??={}
      row[f.severity]=(row[f.severity]??0)+1
    }
    for(const [k,n] of Object.entries(m.counts)) counts[k]=(counts[k]??0)+n
    for(const stage of Object.keys(stages)) stages[stage]+=m[stage+'Ms']??0
    if(m.views) reviewImages++
    completed.push({id,area:m.cell.area,detail:m.findings.length+(m.driveRuns??0),stages:m.stages})
  }
  const campusArea=cells.reduce((sum,c)=>sum+c.area,0)
  const fullCoverage=completed.length===cells.length && Math.abs(areaChecked-campusArea)<1e-5
  const result={campusArea,expectedCells:cells.length,fullCoverage,cells:completed,checked,areaChecked,driveRuns,collisionProbes,reviewImages,counts,severity,byCheckSeverity,edgeObservations,stageWorkerMs:stages,lastInvocationWallMs:wallMs}
  await mkdir(out,{recursive:true})
  await save(join(out,'summary.json'),result)
  return result
}
