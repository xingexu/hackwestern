import assert from 'node:assert/strict'
import {mkdir,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {engines,serve} from './race_browser.mjs'
import {recordCircuit} from './verify_replay.mjs'

const server=await serve(true)
try {
  const fixtures=new URL('./fixtures/replays/',import.meta.url)
  const expected=JSON.parse(await readFile(new URL('expected.json',fixtures)))
  const circuits=[]
  for (const course of Object.keys(expected)) {
    const bytes=await readFile(new URL(course+'.bin',fixtures))
    const recorded=recordCircuit(course)
    assert.deepEqual(recorded.result,expected[course])
    assert.deepEqual(Buffer.from(recorded.bytes),bytes)
    circuits.push({course,hashes:recorded.hashes,result:recorded.result})
  }
  for (const engine of ['chromium','webkit','firefox']) {
    const options={}
    if (engine==='firefox' && process.platform==='darwin') {
      const profileRoot=new URL('../../.agent/state/firefox/',import.meta.url)
      await mkdir(new URL('Library/Application Support/Firefox/',profileRoot),{recursive:true})
      options.env={...process.env,HOME:fileURLToPath(profileRoot),CFFIXED_USER_HOME:fileURLToPath(profileRoot)}
    }
    const browser=await engines[engine].launch(options)
    try {
      const page=await browser.newPage()
      await page.goto(server.base+'/race/version.mjs')
      for (const {course,hashes,result} of circuits) {
        const actual=await page.evaluate(async course=>{
          const {createPlayback,decodeReplay,stateHash,simulateReplay}=await import('/race/replay.mjs')
          const {createRaceContext}=await import('/race/context.mjs')
          const bytes=await (await fetch('/dev/fixtures/replays/'+course+'.bin')).arrayBuffer()
          const replay=decodeReplay(new Uint8Array(bytes)),context=createRaceContext(course)
          const ghost=createPlayback(replay,context),hashes=[]
          while (ghost.step()) if (ghost.tick%120===0) hashes.push(stateHash(ghost.sim))
          return {hashes,result:simulateReplay(replay,context)}
        },course)
        assert.deepEqual(actual.hashes,hashes,engine+' '+course)
        assert.deepEqual(actual.result,result)
        console.log(engine,course,hashes.length+' one-second samples',actual.result.stateHash)
      }
    } finally {await browser.close()}
  }
} finally {server.close()}
