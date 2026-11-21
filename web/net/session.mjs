export async function reserve(kind, code, profile) {
  const response = await fetch('/api/'+kind+(code ? '/'+encodeURIComponent(code.toUpperCase())+'/join' : ''), {method:'POST',body:JSON.stringify(profile)})
  const data = await response.json()
  if (!response.ok) throw new Error(data.reason)
  return data
}

export class Session {
  constructor(ticket, receive, status) {
    this.ticket = ticket
    this.receive = receive
    this.status = status
    this.offset = 0
    this.delay = Infinity
    this.open()
  }
  open() {
    const {kind,code,token} = this.ticket
    const url = new URL('/api/'+kind+'/'+code+'/socket',location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = this.ws = new WebSocket(url,['western',token])
    ws.onopen = () => {
      this.status('Connected')
      this.ping()
      this.timer = setInterval(()=>this.ping(),5000)
      this.lost = 0
    }
    ws.onmessage = ({data}) => {
      const m = JSON.parse(data)
      if (m.type !== 'pong') return this.receive(m)
      const now = Date.now(), rtt = now-m.sent
      if (rtt <= this.delay+10) {
        this.offset = m.now-(now+m.sent)/2
        this.delay = rtt
      }
    }
    ws.onclose = e => {
      clearInterval(this.timer)
      if (this.closed) return
      this.lost ||= Date.now()
      if ([1000,4001].includes(e.code) || Date.now()-this.lost > 85000) {
        this.closed = true
        this.status('Session ended')
      } else {
        this.status('Reconnecting…')
        this.retry = setTimeout(()=>this.open(),1250)
      }
    }
  }
  ping() { this.send({type:'ping',sent:Date.now()}) }
  now() { return Date.now()+this.offset }
  send(data) {
    if (this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 8192) this.ws.send(JSON.stringify(data))
  }
  close() {
    this.closed = true
    clearTimeout(this.retry)
    clearInterval(this.timer)
    this.send({type:'leave'})
    this.ws.close()
  }
}

export class Snapshots {
  items = []
  push(state) {
    if (this.items.at(-1)?.now >= state.now) return
    this.items.push(state)
    if (this.items.length > 12) this.items.shift()
  }
  at(now) {
    const time = now-100, last = this.items.at(-1)
    if (!last || time-last.now > 1500) return null
    const upper = this.items.findIndex(p => p.now >= time)
    if (upper === 0) return this.items[0]
    if (upper < 0) {
      const distance = last.speed*Math.min(150,time-last.now)/1000
      return {...last,x:last.x+Math.sin(last.heading)*distance,z:last.z+Math.cos(last.heading)*distance}
    }
    const a = this.items[upper-1], b = this.items[upper], t = (time-a.now)/(b.now-a.now)
    const turn = b.heading-a.heading
    return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,heading:a.heading+Math.atan2(Math.sin(turn),Math.cos(turn))*t}
  }
}
