import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {args,dir} from './io.mjs'

const {run,cells,workers}=args({run:null,cells:null,workers:'3'})
if(!run || !cells) throw new Error('Specify --run and --cells')
const child=spawnSync(process.execPath,[join(dir,'run.mjs'),'--run',run,'--cells',cells,'--stage','all','--poses','saved','--workers',workers],{stdio:'inherit'})
if(child.error) throw child.error
process.exitCode=child.status??1
