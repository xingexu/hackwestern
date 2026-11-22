const degrees=180/Math.PI
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n))
const blend=(dt,hz)=>1/(1+1/(2*Math.PI*hz*dt))

export function createBrakeTap(){
  let first,press
  function reset(){first=press=null}
  return {
    reset,
    down(id,x,y,time){
      if(press){reset();return}
      press={id,x,y,time}
    },
    move(id,x,y){
      if(press?.id===id && Math.hypot(x-press.x,y-press.y)>24)reset()
    },
    up(id,x,y,time){
      if(press?.id!==id || time-press.time>220 || Math.hypot(x-press.x,y-press.y)>24){reset();return false}
      const twice=Boolean(first && press.time-first.time<=320 && Math.hypot(x-first.x,y-first.y)<=40)
      press=null
      first=twice?null:{x,y,time}
      return twice
    }
  }
}

// Track only the brake finger: the other thumb can keep holding Gas.
export function bindDriftBrake(button,{enabled=()=>true,change=()=>{},feedback=()=>{}}={}){
  const taps=createBrakeTap(), down=new Set()
  let until=0,timer
  function release(){
    clearTimeout(timer)
    until=0
    button.removeAttribute('data-pulse')
  }
  function reset(){release();down.clear();taps.reset()}
  button.addEventListener('pointerdown',e=>{
    if(!enabled())return
    release()
    down.add(e.pointerId)
    if(down.size===1)taps.down(e.pointerId,e.clientX,e.clientY,performance.now())
    else taps.reset()
  })
  button.addEventListener('pointermove',e=>taps.move(e.pointerId,e.clientX,e.clientY))
  button.addEventListener('pointerup',e=>{
    if(!down.delete(e.pointerId) || !enabled() || !taps.up(e.pointerId,e.clientX,e.clientY,performance.now()))return
    until=performance.now()+410
    button.setAttribute('data-pulse','')
    feedback()
    change()
    timer=setTimeout(()=>{release();change()},410)
  })
  for(const type of ['pointercancel','lostpointercapture'])button.addEventListener(type,e=>{
    if(down.delete(e.pointerId))taps.reset()
  })
  return {reset,get active(){return performance.now()<until}}
}

export function createWheel(){
  let side=0,neutral=0,angle=0,previous=0,velocity=0,last=-Infinity
  let started=0,samples=0,learning=true
  return {
    get side(){return side},
    get turnDegrees(){return angle-neutral},
    get neutral(){return neutral},
    sample(x,y,now,straight,range=32){
      if(Math.hypot(x,y)<.10)return null
      const next=Math.sign(x)
      if(!side && Math.abs(y)>Math.abs(x))return null
      const flipped=next!==side && Math.abs(y)<Math.abs(x)*.45
      if(!side || flipped){
        side=next;neutral=0;started=now;samples=0;learning=true;last=-Infinity
      }
      const raw=Math.atan2(y*side,x*side)*degrees
      const dt=clamp((now-last)/1000,.001,.1)
      if(now-last>200){
        angle=previous=raw;velocity=0
      }else{
        velocity+=blend(dt,2.5)*((raw-previous)/dt-velocity)
        angle+=blend(dt,5+.19*Math.abs(velocity))*(raw-angle)
      }
      previous=raw;last=now
      const error=angle-neutral
      if(samples && Math.abs(raw-neutral)>2)learning=false
      if(learning && now-started<1000 && Math.abs(raw)<=6 && Math.abs(velocity)<6){
        neutral+=(raw-neutral)/++samples
      }else if(straight && Math.abs(error)<=2 && Math.abs(raw-neutral)<=2 && Math.abs(velocity)<2){
        neutral=clamp(neutral+clamp(error*(1-Math.exp(-dt/7)),-.23*dt,.23*dt),-6,6)
      }
      const delta=angle-neutral
      const u=clamp((Math.abs(delta)-2)/(range-2),0,1)
      return -Math.sign(delta)*u*(.72+.28*u*u)
    }
  }
}
