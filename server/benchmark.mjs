import {readFileSync} from 'node:fs'
import {performance} from 'node:perf_hooks'
import {createRaceContext} from '../web/race/context.mjs'
import {decodeReplay,simulateReplay} from '../web/race/replay.mjs'

for(const course of ['college','stadium','campus']){
  const bytes=readFileSync(new URL('../web/dev/fixtures/replays/'+course+'.bin',import.meta.url))
  const context=createRaceContext(course)
  const replay=decodeReplay(bytes)
  const measurements=[]
  for(let i=0;i<6;i++){
    const cpu=process.cpuUsage(),start=performance.now()
    const result=simulateReplay(replay,context)
    if(result.stateHash!==replay.stateHash || result.timeMs!==replay.timeMs) throw Error('Replay differs')
    const used=process.cpuUsage(cpu)
    if(i)measurements.push({wall:performance.now()-start,cpu:(used.user+used.system)/1000})
  }
  const median=k=>measurements.map(m=>m[k]).sort((a,b)=>a-b)[2].toFixed(1)
  console.log(course,replay.steps+' ticks',replay.timeMs+' ms lap',median('wall')+' ms wall',median('cpu')+' ms process CPU')
}
