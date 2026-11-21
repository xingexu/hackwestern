import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'

function run(args,env=process.env) {
  const result=spawnSync(process.execPath,args,{env,stdio:'inherit'})
  if (result.status!==0) throw new Error('Failed to run '+args.join(' '))
}

await mkdir(resolve('web/dist'),{recursive:true})
const preview=await mkdtemp(resolve('web/dist/.trial-world-'))
const env={...process.env,CAMPUS_RACE_PREVIEW:preview}
const check=process.argv.includes('--check')
try {
  run(['node_modules/vite/bin/vite.js','build'],env)
  run(['web/dev/bake_race_courses.mjs',...(check?['--check']:[])],env)
  run(['web/dev/race_version.mjs',...(check?[]:['--write'])])
  if (!check) {
    run(['web/dev/race_fixtures.mjs'])
    run(['node_modules/vite/bin/vite.js','build'])
  }
} finally {await rm(preview,{recursive:true,force:true})}
