class WindowMin{
  constructor(span){this.span=span;this.samples=[]}
  add(now,value,detail=value){
    while(this.samples.length && this.samples.at(-1).value>=value)this.samples.pop()
    this.samples.push({now,value,detail})
    while(this.samples[0].now<now-this.span)this.samples.shift()
    return this.samples[0]
  }
}
function slew(current,target,elapsed){
  if(current===null || Math.abs(target-current)>120)return target
  const limit=Math.max(0,elapsed)*.003
  return current+Math.max(-limit,Math.min(limit,target-current))
}
export class Clock{
  offset=null
  best=new WindowMin(60000)
  count=0
  last=0
  rtt=0
  observe(sent,received,remote){
    const trip=received-sent
    if(trip<0 || trip>10000 || !Number.isFinite(remote))return
    const best=this.best.add(received,trip,remote-(received+sent)/2)
    this.rtt=best.value
    this.offset=this.count<3?best.detail:slew(this.offset,best.detail,received-this.last)
    this.count++;this.last=received
  }
  get synced(){return this.count>=3}
  get interval(){return this.count<16?250:2000}
  server(now){return now+(this.offset??0)}
  local(stamp){return stamp-(this.offset??0)}
}
export class StampMap{
  gaps=new WindowMin(15000)
  offset=null
  last=0
  map(stamp,arrival,rtt,anchor){
    const floor=this.gaps.add(arrival,arrival-stamp).value
    const midpoint=floor-rtt/2
    const target=Number.isFinite(anchor)?Math.max(floor-rtt,Math.min(floor,anchor)):midpoint
    this.offset=slew(this.offset,target,arrival-this.last)
    this.last=arrival
    return Math.min(arrival,stamp+this.offset)
  }
}
export class Lag{
  constructor({latency=0,jitter=0,loss=0,seed=1}={}){
    Object.assign(this,{latency,jitter,loss,seed})
    this.ordered=-Infinity
  }
  random(){this.seed=(Math.imul(1664525,this.seed)+1013904223)>>>0;return this.seed/4294967296}
  delivery(now,reliable=false){
    if(!reliable && this.random()<this.loss)return Infinity
    const at=now+Math.max(0,this.latency+(2*this.random()-1)*this.jitter)
    if(!reliable)return at
    return this.ordered=Math.max(at,this.ordered+.001)
  }
}
