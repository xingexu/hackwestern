import {newer} from './wire.mjs'

const angle=x=>Math.atan2(Math.sin(x),Math.cos(x))
export const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
export function predict(s,now){
  const age=Math.max(0,(now-s.time)/1000),dt=Math.min(1,age),acc=Math.min(.3,dt)
  const speed=Math.hypot(s.vx,s.vz),tangent=speed>.1?(s.vx*s.ax+s.vz*s.az)/speed:0
  const coast=speed*dt+tangent*acc*(dt-acc/2)
  const turn=s.turn*dt,mid=turn/2,sinc=Math.abs(mid)<.0001?1:Math.sin(mid)/mid
  const dx=speed>.1?s.vx/speed:Math.sin(s.heading),dz=speed>.1?s.vz/speed:Math.cos(s.heading)
  return {...s,x:s.x+coast*sinc*(dx*Math.cos(mid)+dz*Math.sin(mid)),z:s.z+coast*sinc*(dz*Math.cos(mid)-dx*Math.sin(mid)),y:s.y+s.vy*dt+s.ay*acc*(dt-acc/2),heading:s.heading+turn,age}
}
function sample(items,now){
  const i=items.findIndex(s=>s.time>=now)
  if(i<0)return predict(items.at(-1),now)
  if(!i)return {...items[0],age:0}
  const a=items[i-1],b=items[i],dt=(b.time-a.time)/1000,t=(now-a.time)/(1000*dt),h=t*t*(3-2*t)
  const out={...b,heading:a.heading+angle(b.heading-a.heading)*t,age:0}
  for(const k of ['x','y','z'])out[k]=a[k]*(1-h)+b[k]*h+dt*t*(1-t)*((1-t)*a['v'+k]-t*b['v'+k])
  return out
}
export class Track{
  paths={relay:[],direct:[]}
  path=null
  correction=0
  jitter=0
  until=0
  clearRequired=true
  last=-Infinity
  offset={x:0,y:0,z:0,h:0,at:0}
  raw(now){return this.path?sample(this.paths[this.path],now):null}
  draw(now){
    if(now-this.last>=2000)return null
    const s=this.raw(now)
    if(!s)return null
    const fade=Math.exp(-Math.max(0,now-this.offset.at)/150)
    return {...s,x:s.x+this.offset.x*fade,y:s.y+this.offset.y*fade,z:s.z+this.offset.z*fade,heading:s.heading+this.offset.h*fade,ghost:now-this.last>500 || now<this.until || this.clearRequired}
  }
  push(s,path,now){
    const items=this.paths[path],old=items.at(-1),active=this.path && this.paths[this.path].at(-1)
    if(old && (!newer(s.seq,old.seq) || s.time<=old.time))return false
    const before=this.draw(now)
    items.push(s)
    if(items.length>32)items.shift()
    if(active && path!==this.path && (!newer(s.seq,active.seq) || s.time<active.time+30))return false
    if(old)this.jitter+=.08*(Math.abs(now-(old.arrival??now)-(s.time-old.time))-this.jitter)
    s.arrival=now
    this.path=path;this.last=now
    const after=this.raw(now),reset=!before || active?.epoch!==s.epoch
    this.correction=before?distance(before,after):0
    if(reset || this.correction>1.9)this.until=now+400
    if(reset)this.clearRequired=true
    this.offset=reset || this.correction>8?{x:0,y:0,z:0,h:0,at:now}:{x:before.x-after.x,y:before.y-after.y,z:before.z-after.z,h:angle(before.heading-after.heading),at:now}
    return true
  }
  clearIfSeparated(pose,others){
    if(this.clearRequired && others.every(o=>Math.abs(o.y-pose.y)>1.5 || Math.hypot(o.x-pose.x,o.z-pose.z)>2.3))this.clearRequired=false
  }
}
export function contact(car,other,dt){
  const dx=car.x-other.x,dz=car.z-other.z,d=Math.hypot(dx,dz)
  if(other.ghost || d>=1.9 || d<.001 || Math.abs(car.y-other.y)>1.5)return false
  const push=Math.min(1.9-d,dt*5)
  car.x+=dx/d*push;car.z+=dz/d*push;car.speed*=Math.exp(-dt*2)
  return true
}
