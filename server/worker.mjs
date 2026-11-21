import {courses,json,readBytes} from './common.mjs'
import padPage from './pad.html'
import {SIM_VERSION} from '../web/race/version.mjs'
export {Room} from './room.mjs'
export {Leaderboard} from './leaderboard.mjs'

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), n => alphabet[n%32]).join('')
const types = {js:'text/javascript',css:'text/css',json:'application/json',html:'text/html; charset=utf-8',bin:'application/octet-stream'}

async function asset(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null,{status:405})
  if (url.pathname.endsWith('.br')) return new Response(null,{status:404})
  const path = url.pathname === '/' ? '/index.html' : url.pathname
  const ext = path.split('.').pop()
  const accepts = (request.headers.get('Accept-Encoding') || '').split(',').some(token => /^\s*br\s*(?:;\s*q=(?!0(?:\.0*)?\s*$)[\d.]+)?\s*$/i.test(token))
  const get = name => env.ASSETS.fetch(new Request(new URL(name,url.origin),{method:request.method,headers:{'accept-encoding':'identity'}}))
  let response = accepts && types[ext] ? await get(path+'.br') : null
  const compressed = response?.ok
  if (!compressed) response = await get(path)
  if (!response.ok) return response
  const headers = new Headers(response.headers)
  headers.set('Cache-Control',path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  headers.set('Vary','Accept-Encoding')
  if (path === '/index.html') headers.set('Server-Timing','western-online')
  if (types[ext]) headers.set('Content-Type',types[ext])
  if (compressed) headers.set('Content-Encoding','br')
  if (headers.has('etag') && request.headers.get('if-none-match') === headers.get('etag')) return new Response(null,{status:304,headers})
  return new Response(response.body,{headers,encodeBody:'manual'})
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/pad') return new Response(padPage,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}})
    if (!url.pathname.startsWith('/api/')) return asset(request,env,url)
    if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({reason:'Invalid origin'},403)
    const [, , kind, code, action, ...extra] = url.pathname.split('/')
    if (kind === 'laps' && courses.includes(code) && !extra.length) return env.LEADERS.getByName(code+':'+SIM_VERSION).fetch(request)
    if ((kind !== 'rooms' && kind !== 'pads') || extra.length) return json({reason:'Not found'},404)
    if (!code && request.method === 'POST') {
      let text
      try { text = new TextDecoder().decode(await readBytes(request,1024)) } catch { return json({reason:'Invalid profile size'},413) }
      for (let tries=0; tries<4; tries++) {
        const fresh = newCode()
        const internal = new Request(new URL('/api/'+kind+'/'+fresh+'/create',url),{method:'POST',body:text})
        const response = await env.ROOMS.getByName(kind+fresh).fetch(internal)
        if (response.status !== 409) return response
      }
      return json({reason:'Please retry'},503)
    }
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code) || !['join','socket'].includes(action)) return json({reason:'Code not found'},404)
    return env.ROOMS.getByName(kind+code).fetch(request)
  }
}
