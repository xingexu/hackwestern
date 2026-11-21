// Briefly flashes a landmark's name above the car as you drive past it.
// Each landmark gets its own trigger radius based on how close the nearest
// road passes, so set-back buildings (the stadium, Huron) still register
// while tightly packed central buildings don't all fire at once.

const COOLDOWN=60000,GAP=2500

function segmentDistance(px,pz,ax,az,bx,bz) {
  const dx=bx-ax,dz=bz-az,sq=dx*dx+dz*dz||1
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(pz-az)*dz)/sq))
  return Math.hypot(px-ax-t*dx,pz-az-t*dz)
}

export function installLandmarkFlash({parent,labels,ways}) {
  const roads=ways.filter(way=>way.kind==='road')
  const landmarks=labels.map(({name,x,z})=>{
    let nearest=Infinity
    for (const way of roads) for (let i=0;i<way.points.length-1;i++) {
      const a=way.points[i],b=way.points[i+1]
      if (Math.abs(a[0]-x)>200 && Math.abs(b[0]-x)>200) continue
      nearest=Math.min(nearest,segmentDistance(x,z,a[0],a[2],b[0],b[2]))
    }
    return {name,x,z,radius:Math.max(40,Math.min(130,nearest+18))}
  })
  const flash=document.createElement('div')
  flash.id='landmark-flash'
  flash.setAttribute('role','status')
  flash.setAttribute('aria-live','polite')
  flash.hidden=true
  parent.append(flash)
  flash.addEventListener('animationend',()=>{flash.hidden=true})
  const shown=new Map()
  let current=null,lastFlash=-Infinity

  function show(name,now) {
    shown.set(name,now)
    lastFlash=now
    flash.textContent=name
    flash.hidden=false
    flash.classList.remove('play')
    void flash.offsetWidth // restart the CSS animation
    flash.classList.add('play') // the animationend handler hides it again
  }
  return {
    update(car,{quiet=false}={}) {
      const now=performance.now()
      // Leave the current landmark only once clearly outside it (hysteresis).
      if (current && Math.hypot(car.x-current.x,car.z-current.z)>current.radius*1.25) current=null
      let best=null,score=1
      for (const landmark of landmarks) {
        const ratio=Math.hypot(car.x-landmark.x,car.z-landmark.z)/landmark.radius
        if (ratio<score) {score=ratio;best=landmark}
      }
      if (!best || best===current || quiet || now-lastFlash<GAP) return
      current=best
      if (now-(shown.get(best.name)??-Infinity)>COOLDOWN) show(best.name,now)
    },
    hide() {flash.hidden=true;flash.classList.remove('play')}
  }
}
