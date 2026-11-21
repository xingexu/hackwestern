import {decodeReplay, milliseconds, simulateReplay} from '../web/race/replay.mjs'
import {createRaceContext} from '../web/race/context.mjs'
import {nicknameOK, json, readBytes} from './common.mjs'

const reject = (reason,status=400) => json({accepted:false,rank:null,entryId:null,reason},status)
const cap = 100
function inspect(bytes,course,timeMs) {
  const replay = decodeReplay(bytes)
  const gates = replay.checkpointsMs
  if (course !== replay.course || timeMs !== replay.timeMs || timeMs !== milliseconds(replay.steps) ||
      timeMs < 10000 || !gates.length || gates.at(-1) !== timeMs ||
      gates.some((ms,i)=> ms < 1 || ms < gates[i-1])) throw Error('Invalid course, time or checkpoint splits')
  return replay
}
function verify(replay) {
  const result = simulateReplay(replay,createRaceContext(replay.course))
  if (result.timeMs !== replay.timeMs || result.stateHash !== replay.stateHash ||
      result.checkpointsMs.length !== replay.checkpointsMs.length ||
      result.checkpointsMs.some((ms,i)=>ms!==replay.checkpointsMs[i])) throw Error('Replay does not match finish')
}

export class Leaderboard {
  constructor(ctx,env) {
    this.ctx = ctx
    this.env = env
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS laps (entryId TEXT PRIMARY KEY, player TEXT, nickname TEXT, timeMs INTEGER, date TEXT, verified INTEGER, replay BLOB)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS ranking ON laps (verified DESC,timeMs,date,entryId)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, until INTEGER, count INTEGER)')
  }
  rate(key,max) {
    const now = Date.now()
    this.sql.exec('DELETE FROM limits WHERE until <= ?',now)
    const {count} = this.sql.exec('INSERT INTO limits VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',key,now+60000).one()
    return count <= max
  }
  trim() {
    this.sql.exec('DELETE FROM laps WHERE entryId IN (SELECT entryId FROM laps WHERE verified=1 ORDER BY timeMs,date,entryId LIMIT -1 OFFSET ?)',cap)
  }
  async fetch(request) {
    const url = new URL(request.url)
    const [,,,course,id] = url.pathname.split('/')
    if (request.method === 'GET') {
      if (id) {
        const row = this.sql.exec('SELECT replay FROM laps WHERE entryId=?',id).toArray()[0]
        return row ? new Response(row.replay,{headers:{'content-type':'application/octet-stream'}}) : reject('Entry not found',404)
      }
      const limit = Math.max(1,Math.min(cap,parseInt(url.searchParams.get('limit') ?? '10',10) || 10))
      return json(this.sql.exec('SELECT entryId,nickname,timeMs,date,verified FROM laps ORDER BY verified DESC,timeMs,date,entryId LIMIT ?',limit).toArray().map(r=>({...r,verified:Boolean(r.verified)})))
    }
    if (id || request.method !== 'POST') return reject('Not supported',405)
    const nickname=url.searchParams.get('nickname'), player=url.searchParams.get('playerId'), timeMs=Number(url.searchParams.get('timeMs'))
    if (!nicknameOK(nickname) || !/^[A-Za-z0-9_-]{8,80}$/.test(player || '')) return reject('Invalid nickname or player id')
    if (!this.rate('ip:'+(request.headers.get('cf-connecting-ip') || 'local'),24) || !this.rate('player:'+player,6)) return reject('Try again in a minute',429)
    let bytes, verified
    try {
      bytes = await readBytes(request,505040)
      const replay = inspect(bytes,course,timeMs)
      verified = this.env.VERIFY_MODE !== 'queued' && replay.steps <= 36000
      if (verified) verify(replay)
    } catch(error) { return reject(error.message) }
    if (!verified && this.sql.exec('SELECT count(*) AS n FROM laps WHERE verified=0').one().n >= 8) return reject('Verification queue full',429)
    const entryId=crypto.randomUUID(), date=new Date().toISOString()
    this.sql.exec('INSERT INTO laps VALUES(?,?,?,?,?,?,?)',entryId,player,nickname,timeMs,date,Number(verified),bytes.buffer)
    this.trim()
    if (!verified) {
      await this.ctx.storage.setAlarm(Date.now()+1000)
      return json({accepted:true,rank:null,entryId,reason:'Pending server verification'})
    }
    const rank=this.sql.exec('SELECT pos FROM (SELECT entryId,ROW_NUMBER() OVER (ORDER BY timeMs,date,entryId) AS pos FROM laps WHERE verified=1) WHERE entryId=?',entryId).toArray()[0]?.pos
    return rank ? json({accepted:true,rank,entryId,reason:null}) : reject('Outside the top 100',422)
  }
  async alarm() {
    const pending=this.sql.exec('SELECT entryId,replay FROM laps WHERE verified=0 ORDER BY date LIMIT 1').toArray()[0]
    if (!pending) return
    try {
      verify(decodeReplay(new Uint8Array(pending.replay)))
    } catch {
      this.sql.exec('DELETE FROM laps WHERE entryId=?',pending.entryId)
      await this.ctx.storage.setAlarm(Date.now()+100)
      return
    }
    this.sql.exec('UPDATE laps SET verified=1 WHERE entryId=?',pending.entryId)
    this.trim()
    if (this.sql.exec('SELECT entryId FROM laps WHERE verified=0 LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now()+100)
  }
}
