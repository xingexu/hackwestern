import {decodeReplay,encodeReplay,SIM_VERSION} from './replay.mjs'
const memory=new Map()
function read(key) {
  try {return localStorage.getItem(key)??memory.get(key)} catch {return memory.get(key)}
}
function save(key,value) {
  memory.set(key,value)
  try {localStorage.setItem(key,value)} catch {}
}
function bestKey(course) {return 'western.trial.'+SIM_VERSION+'.'+course}
export function personalBest(course) {
  try {
    const raw=read(bestKey(course))
    if (raw) return decodeReplay(Uint8Array.from(atob(raw),c=>c.charCodeAt(0)))
  } catch {}
  return null
}
export function saveBest(replay) {
  const data=encodeReplay(replay),parts=[]
  for (let i=0;i<data.length;i+=8192) parts.push(String.fromCharCode(...data.subarray(i,i+8192)))
  save(bestKey(replay.course),btoa(parts.join('')))
}
export function player() {
  let id=read('western.trial.player')
  if (!id) {
    const bytes=crypto.getRandomValues(new Uint8Array(16))
    bytes[6]=(bytes[6]&15)|64
    bytes[8]=(bytes[8]&63)|128
    const hex=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('')
    id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
    save('western.trial.player',id)
  }
  return {playerId:id,nickname:read('western.trial.nickname')||''}
}
export const saveNickname = name => save('western.trial.nickname',name)
