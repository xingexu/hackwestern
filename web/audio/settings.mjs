import {createMixer, defaults} from './mixer.mjs'
import {drivingSounds} from './world.mjs'

const storageKey='western.audio.v1'

export function installAudio(panel, campus) {
  let saved
  try {saved=JSON.parse(localStorage.getItem(storageKey))} catch {}
  const values={...defaults}
  for (const [key,fallback] of Object.entries(defaults)) {
    const value=saved?.[key]
    if (typeof fallback==='boolean' ? typeof value==='boolean' : Number.isFinite(value) && value>=0 && value<=1) values[key]=value
  }
  let ctx, mix, drive
  const apply=()=>mix?.settings(values,document.hidden)
  function unlock() {
    const Context=window.AudioContext??window.webkitAudioContext
    if (!Context) return
    if (!ctx) {
      ctx=new Context({latencyHint:'interactive'})
      mix=createMixer(ctx)
      drive=drivingSounds(mix,campus)
      apply()
    }
    if (ctx.state!=='running') void ctx.resume().catch(()=>{})
  }
  for (const event of ['pointerdown','pointerup','keydown']) document.addEventListener(event,unlock,{capture:true,passive:true})
  document.addEventListener('visibilitychange',apply)
  const group=document.createElement('fieldset')
  group.id='audio-settings'
  const legend=document.createElement('legend')
  legend.textContent='Audio'
  group.append(legend)
  for (const [key,caption] of Object.entries({master:'Master',engine:'Engine',effects:'Effects',ambient:'Ambient',interface:'Interface',mute:'Mute',muteHidden:'Mute when tab hidden'})) {
    const toggle=typeof defaults[key]==='boolean'
    const label=document.createElement('label'), input=document.createElement('input')
    const title=document.createElement('span'), amount=document.createElement('output')
    title.textContent=caption
    input.id='audio-'+key
    input.setAttribute('aria-label',caption)
    input.type=toggle?'checkbox':'range'
    if (toggle) {
      input.checked=values[key]
      label.append(input,title)
    } else {
      input.min=0
      input.max=100
      input.value=Math.round(values[key]*100)
      amount.htmlFor=input.id
      amount.textContent=input.value+'%'
      label.append(title,input,amount)
    }
    input.addEventListener('input',()=>{
      values[key]=toggle?input.checked:input.valueAsNumber/100
      amount.textContent=input.value+'%'
      apply()
      try {localStorage.setItem(storageKey,JSON.stringify(values))} catch {}
    })
    group.append(label)
  }
  panel.append(group)
  document.addEventListener('click',event=>{
    if (event.target.closest?.('summary,button:not([data-key]),select,input[type=checkbox]')) mix?.cue('click')
  },true)
  return {
    get drive(){return drive},
    get mix(){return mix},
    cue(name){mix?.cue(name)}
  }
}
