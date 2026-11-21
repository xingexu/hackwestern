import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {engines,serve} from './race_browser.mjs'
import {decodeReplay,simulateReplay} from '../race/replay.mjs'
import {createRaceContext} from '../race/context.mjs'

const course='stadium'
const bytes=await readFile(new URL('./fixtures/replays/stadium.bin',import.meta.url))
const recorded=decodeReplay(bytes)
const server=await serve(true), browser=await engines.chromium.launch()
try {
  const page=await browser.newPage()
  await page.route('**/net/leaderboard.mjs',route=>route.fulfill({contentType:'text/javascript',body:`
    export const available=()=>true
    export const topLaps=async()=>[{entryId:'lap-7',nickname:'River',timeMs:${recorded.timeMs},verified:true}]
    export const fetchReplay=async()=>new Uint8Array(await (await fetch('/dev/fixtures/replays/stadium.bin')).arrayBuffer())
    export async function submitLap(data) {
      await window.verifySubmission({...data,replay:Array.from(data.replay)})
      return {accepted:true,rank:1,entryId:'lap-8'}
    }
  `}))
  let received=false
  await page.exposeFunction('verifySubmission',submission=>{
    assert.equal(submission.nickname,'Western Driver')
    assert.match(submission.playerId,/^[0-9a-f-]{36}$/)
    assert.equal(submission.course,course)
    const lap=decodeReplay(new Uint8Array(submission.replay))
    const verified=simulateReplay(lap,createRaceContext(course))
    assert.equal(verified.timeMs,submission.timeMs)
    assert.equal(verified.stateHash,recorded.stateHash)
    received=true
  })
  await page.goto(server.base+'/race/version.mjs')
  await page.evaluate(async ()=>{
    document.body.innerHTML='<button id="restart"></button><button id="recover"></button><div><canvas id="route-plan"></canvas></div><output id="result"></output><output id="time"></output><p id="drive-message"></p>'
    const {installTrial}=await import('/race/trial.mjs')
    const {createDriveSim}=await import('/drive-sim.mjs')
    const {decodeReplay}=await import('/race/replay.mjs')
    const trial=installTrial({scene:{add(){}},ghostModel:()=>({position:{set(){}},rotation:{set(){}}}),reset(){sim.reset();trial.begin()},visualHeight:p=>p.y,vibrate(){}})
    trial.course('stadium')
    const c=trial.context
    const sim=createDriveSim(c.samples,{mode:'circuit',network:c.network})
    const replay=decodeReplay(new Uint8Array(await (await fetch('/dev/fixtures/replays/stadium.bin')).arrayBuffer()))
    window.race=()=>{
      for (let i=0;i<360;i++) trial.step(sim,{})
      for (const run of replay.runs) for (let i=0;i<run.count;i++) trial.step(sim,run)
      trial.hud(sim.state)
    }
  })
  await page.locator('#trial-open').click()
  await page.locator('#trial-opponent').selectOption('lap-7')
  await page.locator('#trial-start').click()
  await page.waitForFunction(()=>!document.querySelector('#trial-setup').open)
  await page.evaluate(()=>window.race())
  await page.locator('#trial-nickname').fill('Western Driver')
  await page.locator('#trial-submit').click()
  await page.waitForFunction(()=>document.querySelector('#trial-rank').textContent==='Verified · rank 1')
  assert.ok(received)
  console.log('Leaderboard opponent, selected replay, nickname, player ID and verified submission passed')
} finally {await browser.close();server.close()}
