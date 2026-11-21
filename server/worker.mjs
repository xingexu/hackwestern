import {courses,json,readBytes} from './common.mjs'
import padPage from './pad.html'
import {SIM_VERSION} from '../web/race/version.mjs'
export {Arena} from './arena.mjs'
export {Room} from './room.mjs'
export {Leaderboard} from './leaderboard.mjs'

const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), n => alphabet[n%alphabet.length]).join('')
const types = {webmanifest:'application/manifest+json',js:'text/javascript',css:'text/css',json:'application/json',html:'text/html; charset=utf-8',bin:'application/octet-stream'}

async function asset(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null,{status:405})
  if (url.pathname.endsWith('.br')) return new Response(null,{status:404})
  const path = url.pathname === '/' ? '/index.html' : url.pathname
  const ext = path.split('.').pop()
  const accepts = (request.cf?.clientAcceptEncoding ?? request.headers.get('Accept-Encoding') ?? '').split(',').some(token => /^\s*br\s*(?:;\s*q=(?!0(?:\.0*)?\s*$)[\d.]+)?\s*$/i.test(token))
  const get = name => env.ASSETS.fetch(new Request(new URL(name,url.origin),{method:request.method,headers:{'accept-encoding':'identity'}}))
  let response = accepts && types[ext] ? await get(path+'.br') : null
  const compressed = response?.ok
  if (!compressed) response = await get(path)
  if (!response.ok) return response
  const headers = new Headers(response.headers)
  headers.set('Cache-Control',path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  headers.set('Vary','Accept-Encoding')
  if (path === '/index.html') {
    headers.set('Server-Timing','western-online')
    headers.set('X-Western-Online','1')
  }
  if (types[ext]) headers.set('Content-Type',types[ext])
  if (compressed) headers.set('Content-Encoding','br')
  if (headers.has('etag') && request.headers.get('if-none-match') === headers.get('etag')) return new Response(null,{status:304,headers})
  return new Response(response.body,{headers,encodeBody:'manual'})
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname==='/' && request.method==='GET' && (!url.search || url.searchParams.has('code')) && /iPhone|iPod|Android.+Mobile/i.test(request.headers.get('User-Agent') || '')) {
      return new Response(null,{status:302,headers:{location:'/pad'+url.search,'cache-control':'no-store',vary:'User-Agent'}})
    }
    if (url.pathname === '/pad') return new Response(padPage,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}})
    if (!url.pathname.startsWith('/api/')) return asset(request,env,url)
    if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({reason:'Invalid origin'},403)
    const [, , kind, code, action, ...extra] = url.pathname.split('/')
    const enabled=env.MULTIPLAYER==='1'
    if(['identity','health','drain','resume'].includes(kind) && !code){
      if(kind==='health' && (!enabled || request.method!=='GET'))return json({multiplayer:false})
      if(!enabled)return json({reason:'Multiplayer unavailable'},503)
      if(kind!=='health' && request.method!=='POST')return json({reason:'POST required'},405)
      if(['drain','resume'].includes(kind) && (!env.DRAIN_TOKEN || request.headers.get('Authorization')!=='Bearer '+env.DRAIN_TOKEN))return json({reason:'Unauthorized'},403)
      const response=await env.RACES.getByName('directory').fetch(new Request('https://internal/'+kind,{method:'POST',body:'{}'}))
      return kind==='health'?json({multiplayer:true,inviteOrigin:(['localhost','127.0.0.1','[::1]'].includes(url.hostname) && env.PAD_LAN_ORIGIN)||url.origin,...await response.json()}):response
    }
    if(kind==='rooms' && !enabled)return json({reason:'Multiplayer unavailable'},503)
    const instance=id=>kind==='rooms'?env.RACES.getByName('code:'+id):env.ROOMS.getByName(kind+id)
    if (kind === 'laps' && courses.includes(code) && !extra.length) return env.LEADERS.getByName(code+':'+SIM_VERSION).fetch(request)
    if ((kind !== 'rooms' && kind !== 'pads') || extra.length) return json({reason:'Not found'},404)
    if (!code && request.method === 'POST') {
      let text
      try { text = new TextDecoder().decode(await readBytes(request,1024)) } catch { return json({reason:'Invalid profile size'},413) }
      for (let tries=0; tries<4; tries++) {
        const fresh = newCode()
        const internal = new Request(new URL('/api/'+kind+'/'+fresh+'/create',url),{method:'POST',body:text})
        const response = await instance(fresh).fetch(internal)
        if (response.ok && kind==='pads') {
          const ticket=await response.json()
          const local=/^(localhost|127\.[\d.]+|\[::1\]|0\.0\.0\.0)$/.test(url.hostname)
          return json({...ticket,padOrigin:(local && env.PAD_LAN_ORIGIN) || url.origin})
        }
        if (response.status !== 409) return response
      }
      return json({reason:'Please retry'},503)
    }
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code) || !['join','socket',...(kind==='rooms'?['results']:[])].includes(action)) return json({reason:'Code not found'},404)
    return instance(code).fetch(request)
  }
}
