import {createRaceContext} from './context.mjs'
import {quantizeInput,createPlayback,createRecorder,encodeReplay,decodeReplay,simulateReplay,MAX_STEPS,milliseconds,stateHash} from './replay.mjs'
import {personalBest,player,saveBest,saveNickname} from './storage.mjs'
import * as leaderboard from '../net/leaderboard.mjs'
import {snapshotPose,interpolatePose} from '../frame-pacing.mjs'
import {pixelCountdown} from './pixel-countdown.mjs'

function lap(ms) {
  const n=Math.abs(ms)
  return Math.floor(n/60000)+':'+String(Math.floor(n/1000)%60).padStart(2,'0')+'.'+String(n%1000).padStart(3,'0')
}
function delta(ms) {return (ms<0?'−':'+')+(Math.abs(ms)/1000).toFixed(3)}

export function installTrial({scene,ghostModel,reset,sound,visualHeight,vibrate}) {
  const byId=id=>document.getElementById(id)
  const start=document.createElement('button')
  start.id='trial-open'
  start.textContent='Time trial'
  byId('restart').before(start)
  const panel=document.createElement('dialog')
  panel.id='trial-setup'
  panel.innerHTML='<form method="dialog"><h2>Time trial</h2><label>Race against <select id="trial-opponent"></select></label><label><input id="show-ghost" type="checkbox" checked> Show ghost</label><p id="trial-notice" role="status"></p><div><button value="cancel">Cancel</button><button type="button" id="trial-start">Start trial</button></div></form>'
  document.body.append(panel)
  const splits=document.createElement('output')
  splits.id='trial-splits'
  byId('route-plan').parentElement.append(splits)
  const results=document.createElement('section')
  results.id='trial-results'
  results.innerHTML='<output id="trial-pb"></output><p id="trial-sectors"></p><label>Nickname <input id="trial-nickname" maxlength="24" autocomplete="nickname"></label><button id="trial-submit">Submit lap</button><p id="trial-rank" role="status"></p>'
  byId('result').after(results)
  const ghostToggle=document.createElement('button')
  ghostToggle.textContent='Ghost on'
  ghostToggle.setAttribute('aria-pressed','true')
  start.before(ghostToggle)
  const check=byId('show-ghost'), opponent=byId('trial-opponent'),notice=byId('trial-notice')
  const previous={},rendered={}
  let context=null,countdown=0,recorder=null,tick=0,times=[],best=null,source=null,ghost=null,model=null,finishedReplay=null,epoch=0
  let active=false, loading=false, expired=false, lastGateDistance=0
  function showGhost(value) {
    check.checked=value
    ghostToggle.textContent=value?'Ghost on':'Ghost off'
    ghostToggle.setAttribute('aria-pressed',String(value))
  }
  ghostToggle.onclick=()=>showGhost(!check.checked)
  check.onchange=()=>showGhost(check.checked)
  function clear() {
    epoch++
    active=false
    loading=false
    recorder=ghost=source=finishedReplay=null
    splits.hidden=results.hidden=ghostToggle.hidden=true
    if (model) model.visible=false
    pixelCountdown().hide()
    byId('recover').hidden=!context
    if (panel.open) panel.close()
  }
  function course(id) {
    context=['college','campus','stadium'].includes(id)?createRaceContext(id):null
    clear()
    start.hidden=!context
  }
  async function choose() {
    if (!context) return
    const request=++epoch
    best=personalBest(context.id)
    opponent.replaceChildren(new Option(best?'Personal best · '+lap(best.timeMs):'Solo · set a personal best','pb'))
    notice.textContent=leaderboard.available()?'Loading leaderboard…':'Local time trial'
    byId('trial-start').disabled=false
    loading=false
    panel.showModal()
    if (!leaderboard.available()) return
    try {
      const entries=await leaderboard.topLaps(context.id,{limit:10})
      if (request!==epoch || !panel.open) return
      for (const entry of entries.filter(e=>e.verified)) opponent.add(new Option(entry.nickname+' · '+lap(entry.timeMs),entry.entryId))
      notice.textContent=entries.length?'':'No leaderboard times yet'
    } catch {if (epoch===request) notice.textContent='Leaderboard unavailable · race locally'}
  }
  start.onclick=choose
  function begin(assists=true) {
    if (!active) return
    lastGateDistance=0
    tick=0
    times=[]
    finishedReplay=null
    expired=false
    countdown=360
    recorder=createRecorder({course:context.id,setup:assists?'stock':'expert'})
    ghost=source?createPlayback(source,context):null
    if (ghost) {
      if (!model) {model=ghostModel();scene.add(model)}
      snapshotPose(previous,ghost.sim.state)
    }
    ghostToggle.hidden=!ghost
    splits.hidden=false
    splits.textContent='Sector 1 / 3'
    results.hidden=true
    byId('recover').hidden=true
  }
  byId('trial-start').onclick=async()=>{
    if (loading) return
    loading=true
    const request=++epoch
    byId('trial-start').disabled=true
    try {
      const replay=opponent.value==='pb'?best:decodeReplay(await leaderboard.fetchReplay(context.id,opponent.value))
      if (request!==epoch || !panel.open) return
      if (replay && (replay.course!==context.id || simulateReplay(replay,context).timeMs!==replay.timeMs)) throw new Error('Invalid ghost')
      source=replay
      active=true
      panel.close()
      reset()
    } catch {
      if (request===epoch) notice.textContent='Could not load this ghost. Choose your personal best to race locally.'
    } finally {
      if (request===epoch) {loading=false;byId('trial-start').disabled=false}
    }
  }
  function sectors(count) {return [Math.ceil(count/3),Math.ceil(count*2/3),count]}
  function finish(sim) {
    finishedReplay=recorder.finish({timeMs:milliseconds(tick),checkpointsMs:times,stateHash:stateHash(sim)})
    const before=personalBest(context.id)
    const improved=!before || finishedReplay.timeMs<before.timeMs
    if (improved) {saveBest(finishedReplay);sound?.('best')}
    const pb=improved?finishedReplay:before
    best=pb
    if (opponent.value==='pb') source=pb
    byId('trial-pb').textContent=(improved?'New personal best · ':'Personal best · ')+lap(pb.timeMs)+(before?' ('+delta(finishedReplay.timeMs-before.timeMs)+')':'')
    let last=0
    byId('trial-sectors').textContent=sectors(times.length).map((gate,i)=>{
      const ms=times[gate-1]-last
      last=times[gate-1]
      return 'S'+(i+1)+' '+lap(ms)
    }).join(' · ')
    byId('trial-nickname').value=player().nickname
    byId('trial-submit').hidden=!leaderboard.available()
    byId('trial-submit').disabled=false
    byId('trial-rank').textContent=leaderboard.available()?'':'Saved on this device'
    results.hidden=false
    vibrate(70)
  }
  byId('trial-nickname').onchange=event=>saveNickname(event.target.value.trim())
  byId('trial-submit').onclick=async()=>{
    const replay=finishedReplay,button=byId('trial-submit'),input=byId('trial-nickname')
    if (!replay || button.disabled) return
    const nickname=input.value.trim()
    if (!nickname) {input.focus();byId('trial-rank').textContent='Enter a nickname to submit';return}
    saveNickname(nickname)
    button.disabled=true
    try {
      const response=await leaderboard.submitLap({...player(),nickname,course:replay.course,timeMs:replay.timeMs,replay:encodeReplay(replay)})
      if (finishedReplay!==replay) return
      byId('trial-rank').textContent=response.accepted && response.rank!==null?'Verified · rank '+response.rank:(response.reason||'Lap declined')
      button.disabled=response.accepted
    } catch {
      if (finishedReplay===replay) {button.disabled=false;byId('trial-rank').textContent='Submission failed · try again'}
    }
  }
  function step(sim,input) {
    if (!active) {sim.step(context?quantizeInput(input):input);return}
    if (panel.open || expired || finishedReplay) return
    if (countdown>0) {countdown--;if (!countdown) vibrate(30);return}
    if (tick===MAX_STEPS) {expired=true;return}
    sim.step(recorder.record(input))
    tick++
    if (ghost) {
      snapshotPose(previous,ghost.sim.state)
      if (ghost.tick<source.steps) ghost.step()
    }
    while (times.length<sim.state.checkpointsPassed) times.push(milliseconds(tick))
    lastGateDistance=sim.state.lastGateDistance
    if (sim.state.phase==='finished') finish(sim)
  }
  function hud(car) {
    if (!active) return
    byId('time').textContent=lap(milliseconds(tick))
    if (countdown) pixelCountdown().sync(countdown/120)
    else if (!expired && tick<120) pixelCountdown().sync(-tick/120)
    else pixelCountdown().hide()
    if (countdown || tick<96) byId('drive-message').textContent=''
    else if (expired) byId('drive-message').textContent='Time limit · restart to try again'
    if (finishedReplay) {byId('result').textContent=lap(finishedReplay.timeMs);return}
    const ends=sectors(car.checkpointCount)
    const sector=ends.findIndex(end=>end>times.length)
    const start=sector>0?ends[sector-1]:0
    let label='Sector '+(sector+1)+' / 3'
    if (start) label+=' · '+lap(times[start-1]-(sector>1?times[ends[sector-2]-1]:0))
    if (source && car.nextGate) {
      const gate=car.checkpointsPassed
      const last=gate?source.checkpointsMs[gate-1]:0
      const refStart=lastGateDistance
      const progress=Math.max(0,Math.min(1,(car.distance-refStart)/(car.nextGate.distance-refStart)))
      const estimate=last+(source.checkpointsMs[gate]-last)*progress
      label+=' · Δ '+delta(milliseconds(tick)-estimate)
    }
    splits.textContent=label
  }
  function render(alpha) {
    if (!model) return
    model.visible=Boolean(active && ghost && check.checked && !finishedReplay)
    if (!model.visible) return
    const pose=interpolatePose(rendered,previous,ghost.sim.state,alpha)
    model.position.set(pose.x,visualHeight(pose)+pose.lift+.035,pose.z)
    model.rotation.set(-pose.pitch-pose.bodyPitch,pose.heading,pose.roll,'YXZ')
  }
  return {course,begin,step,hud,render,get cue(){return active && !expired && !finishedReplay ? countdown?String(Math.ceil(countdown/120)):tick<96?'GO':null : null},get active(){return active},get context(){return context}}
}
