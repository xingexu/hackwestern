import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {recordCircuit} from './verify_replay.mjs'

const root=new URL('./fixtures/replays/',import.meta.url)
await mkdir(root,{recursive:true})
async function update(name,bytes) {
  const file=new URL(name,root)
  const previous=await readFile(file).catch(()=>null)
  if (!previous?.equals(bytes)) await writeFile(file,bytes)
}
const expected={}
for (const course of ['college','stadium','campus']) {
  const {bytes,result}=recordCircuit(course)
  expected[course]=result
  await update(course+'.bin',Buffer.from(bytes))
}
await update('expected.json',Buffer.from(JSON.stringify(expected,null,2)+'\n'))
