import {courses, json, nicknameOK, readBytes} from './common.mjs'

const grace = 90000
const lifetime = 2 * 60 * 60 * 1000
const settings = {course:'college', laps:1, collisions:false}
const secret = () => crypto.randomUUID()
const validProfile = p => nicknameOK(p.nickname) && /^#[0-9a-f]{6}$/i.test(p.color)
const poseOK = p => ['x','y','z','heading','speed'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) < 10000)
const controlOK = p => p && ['steer','throttle','brake'].every(k => Number.isFinite(p[k]) && p[k] <= 1 && p[k] >= (k === 'steer' ? -1 : 0))

export class Room {
  constructor(ctx) {
    this.ctx = ctx
    this.lastPacket = new Map()
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get('room') })
  }
  sockets(id) {
    return this.ctx.getWebSockets(id).filter(s => s.readyState === 1)
  }
  view() {
    const {players, host, race, start, settings, kind} = this.room
    return {type:'room', host, race, start, settings, kind, players:players.map(({token, until, ...p}) => ({...p, connected:this.sockets(p.id).length > 0}))}
  }
  broadcast(data, except) {
    const wire = JSON.stringify(data)
    for (const ws of this.sockets()) if (ws !== except) ws.send(wire)
  }
  async save() {
    await this.ctx.storage.put('room', this.room)
    await this.ctx.storage.setAlarm(Math.min(this.room.expires, ...this.room.players.map(p => p.until || Infinity)))
    this.broadcast(this.view())
  }
  async fetch(request) {
    const url = new URL(request.url)
    const [, , kind, code, action] = url.pathname.split('/')
    if (action === 'socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const token = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(t=>t.trim())[1]
      const player = this.room?.players.find(p => p.token === token)
      if (!player || this.room.expires <= Date.now()) return json({reason:'Session expired'}, 403)
      for (const old of this.sockets(player.id)) old.close(4001, 'Reconnected')
      const [client, ws] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(ws, [player.id])
      ws.serializeAttachment(player.id)
      player.until = null
      await this.save()
      return new Response(null, {status:101, webSocket:client, headers:{'Sec-WebSocket-Protocol':'western'}})
    }
    if (request.method !== 'POST') return json({reason:'POST required'}, 405)
    let body
    try { body = JSON.parse(new TextDecoder().decode(await readBytes(request, 1024))) }
    catch { return json({reason:'Invalid profile'}, 400) }
    if (!body || (kind === 'rooms' && !validProfile(body))) return json({reason:'Use a nickname of 1–18 letters or numbers and a car colour'}, 400)
    if (action === 'create') {
      if (this.room) return json({reason:'Code in use'}, 409)
      this.room = {kind, host:null, players:[], settings:{...settings}, race:null, start:0, expires:Date.now()+lifetime}
    } else if (action !== 'join' || !this.room || this.room.expires <= Date.now()) return json({reason:'Code not found'}, 404)
    if (this.room.race || this.room.players.length >= (kind === 'rooms' ? 4 : 2)) return json({reason:'Room is full or racing'}, 409)
    const id = secret(), token = secret()
    this.room.players.push({id, token, nickname:kind === 'pads' ? 'Controller' : body.nickname, color:kind === 'pads' ? '#ffffff' : body.color, ready:false, lap:0, finish:0, until:Date.now()+grace})
    this.room.host ??= id
    await this.save()
    return json({id, token, code, kind})
  }
  async webSocketMessage(ws, message) {
    const id = ws.deserializeAttachment()
    const r = this.room
    const p = r?.players.find(p => p.id === id)
    if (!p || !this.sockets(id).includes(ws) || typeof message !== 'string' || message.length > 1024) return ws.close(1008,'Invalid session or message')
    let m
    try { m = JSON.parse(message) } catch { return ws.close(1007, 'Invalid JSON') }
    if (!m || typeof m !== 'object') return
    const now = Date.now()
    if (m.type === 'ping') return ws.send(JSON.stringify({type:'pong', sent:m.sent, now}))
    if (m.type === 'leave') {
      this.remove(id)
      ws.close(1000,'Left room')
      return this.persistRemaining()
    }
    if (m.type === 'state' || m.type === 'pad') {
      if (now - (this.lastPacket.get(id) || 0) < 25) return
      this.lastPacket.set(id, now)
      if (m.type === 'pad' && r.kind === 'pads' && id !== r.host && controlOK(m.input)) {
        this.broadcast({type:'pad',input:m.input}, ws)
      } else if (m.type === 'state' && r.kind === 'rooms' && r.race && m.race === r.race && poseOK(m)) {
        const {x,y,z,heading,speed} = m
        this.broadcast({type:'state',id,x,y,z,heading,speed,now}, ws)
      }
      return
    }
    if (r.kind !== 'rooms') return
    if (m.type === 'settings' && p.id === r.host && !r.race && courses.includes(m.course) && Number.isInteger(m.laps) && m.laps >= 1 && m.laps <= 5 && typeof m.collisions === 'boolean') {
      r.settings = {course:m.course,laps:m.laps,collisions:m.collisions}
      for (const player of r.players) player.ready = false
    } else if (m.type === 'ready' && !r.race && typeof m.ready === 'boolean') p.ready = m.ready
    else if (m.type === 'start' && !r.race && id === r.host && r.players.length >= 2 && r.players.every(p => p.ready && this.sockets(p.id).length)) {
      r.race = secret()
      r.start = now + 4000
    } else if (m.type === 'lap' && r.race && m.race === r.race && now > r.start && m.lap === p.lap + 1 && !p.finish) {
      p.lap++
      if (p.lap === r.settings.laps) p.finish = now - r.start
    } else if (m.type === 'again' && r.race && id === r.host && r.players.every(p => p.finish)) {
      r.race = null
      r.start = 0
      for (const player of r.players) Object.assign(player, {ready:false,lap:0,finish:0})
    } else return
    await this.save()
  }
  remove(id) {
    const r = this.room
    r.players = r.players.filter(p => p.id !== id)
    this.lastPacket.delete(id)
    if (r.kind === 'pads' && id === r.host) r.players = []
    r.host = r.players.some(p => p.id === r.host) ? r.host : r.players[0]?.id
  }
  async persistRemaining() {
    if (this.room.players.length) return this.save()
    for (const ws of this.sockets()) ws.close(1000,'Session ended')
    this.room = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }
  async webSocketClose(ws, code) {
    const id = ws.deserializeAttachment()
    const p = this.room?.players.find(p => p.id === id)
    if (p && !this.sockets(id).some(other => other !== ws)) {
      p.until = Date.now()+grace
      if (!this.room.race) p.ready = false
      await this.save()
    }
    if (ws.readyState !== 3) ws.close(code === 1006 ? 1000 : code)
  }
  webSocketError(ws) { return this.webSocketClose(ws, 1011) }
  async alarm() {
    if (!this.room) return
    const now = Date.now()
    for (const p of this.room.players.slice()) if (this.room.expires <= now || p.until && p.until <= now) this.remove(p.id)
    await this.persistRemaining()
  }
}
