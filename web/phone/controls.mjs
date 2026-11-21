export function installPhoneControls(root) {
  const tilt=root.querySelector('#tilt')
  const settings=document.createElement('details')
  settings.id='phone-settings'
  settings.innerHTML='<summary>Controls</summary><section><button type="button" data-center>Center tilt</button><label>Sensitivity <input type="range" min="12" max="44" value="24" aria-label="Steering range in degrees"></label><label>Deadzone <input type="range" min="0" max="8" value="2" aria-label="Tilt deadzone in degrees"></label><label><input type="checkbox" data-wheel> Thumb wheel</label><button type="button" data-full>Fullscreen</button></section>'
  root.append(settings)
  const [range,deadzone]=settings.querySelectorAll('input[type=range]')
  const steering=root.querySelector('[data-key=ArrowLeft]').parentElement
  const wheel=document.createElement('button')
  wheel.id='thumb-wheel'
  wheel.textContent='◈'
  wheel.setAttribute('aria-label','Drag to steer')
  wheel.hidden=true
  steering.append(wheel)
  let wheelInput=0, active=false, enabled=false, neutral=null, target=0, filtered=0, reading=null, timeout, generation=0
  let lease=null, waiting=false
  async function wake() {
    if (waiting || lease || !active || document.hidden || !navigator.wakeLock) return
    waiting=true
    try {
      const lock=await navigator.wakeLock.request('screen')
      if (!active || document.hidden) await lock.release()
      else {lease=lock;lock.addEventListener('release',()=>{if (lease===lock) lease=null},{once:true})}
    } catch {} finally {waiting=false}
  }
  function driving(value) {
    if (active===value) return
    active=value
    if (value) void wake()
    else if (lease) void lease.release().catch(()=>{})
  }
  document.addEventListener('visibilitychange',()=>{if (!document.hidden) void wake()})
  root.addEventListener('pointerdown',wake)
  settings.querySelector('[data-full]').onclick=async()=>{
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.()
      await screen.orientation?.lock?.('landscape')
    } catch {}
    settings.open=false
  }
  function center() {
    neutral=reading
    target=filtered=0
  }
  settings.querySelector('[data-center]').onclick=center
  function clear() {
    reading=null
    wheelInput=0
    center()
  }
  function disable(text='Enable tilt steering') {
    clearTimeout(timeout)
    generation++
    enabled=false
    clear()
    tilt.textContent=text
    tilt.setAttribute('aria-pressed','false')
  }
  function orientation(event) {
    if (!enabled || !Number.isFinite(event.gamma) || !Number.isFinite(event.beta)) return
    const angle=((screen.orientation?.angle??window.orientation??0)%360+360)%360
    reading=angle===90 ? event.beta : angle===270 ? -event.beta : angle===180 ? -event.gamma : event.gamma
    neutral??=reading
    const delta=(reading-neutral+540)%360-180
    target=-Math.sign(delta)*Math.min(1,Math.max(0,Math.abs(delta)-Number(deadzone.value))/Number(range.value))
    clearTimeout(timeout)
  }
  window.addEventListener('deviceorientation',orientation)
  screen.orientation?.addEventListener('change',clear)
  window.addEventListener('orientationchange',clear)
  tilt.onclick=async()=>{
    if (enabled) {disable();return}
    const epoch=++generation
    try {
      if (!window.DeviceOrientationEvent) {disable('Tilt unavailable · use arrows');return}
      const permissions=[window.DeviceOrientationEvent,window.DeviceMotionEvent].filter(type=>typeof type?.requestPermission==='function')
      const grants=await Promise.all(permissions.map(type=>type.requestPermission()))
      if (epoch!==generation) return
      if (grants.includes('denied') || grants.some(g=>g!=='granted')) {disable('Enable tilt steering · retry');return}
      clear()
      enabled=true
      tilt.textContent='Tilt on'
      tilt.setAttribute('aria-pressed','true')
      timeout=setTimeout(()=>{if (enabled && reading===null) disable('No tilt signal · retry')},3500)
    } catch {disable('Enable tilt steering · retry')}
  }
  settings.querySelector('[data-wheel]').onchange=event=>{
    wheel.hidden=!event.target.checked
    for (const b of steering.querySelectorAll('[data-key]')) b.hidden=!wheel.hidden
    wheelInput=0
    settings.open=false
  }
  let originX=0
  wheel.onpointerdown=event=>{
    event.preventDefault()
    originX=event.clientX
    wheel.setPointerCapture(event.pointerId)
  }
  wheel.onpointermove=event=>{
    if (!wheel.hasPointerCapture(event.pointerId)) return
    wheelInput=Math.max(-1,Math.min(1,(originX-event.clientX)/46))
    wheel.style.setProperty('--angle',(-wheelInput*80)+'deg')
  }
  wheel.onlostpointercapture=()=>{wheelInput=0;wheel.style.removeProperty('--angle')}
  return {clear,driving,steer(dt){
    filtered+=(target-filtered)*(1-Math.exp(-Math.max(0,dt)*18))
    return wheelInput+(enabled?filtered:0)
  },vibrate(ms){if (matchMedia('(pointer:coarse)').matches) navigator.vibrate?.(ms)}}
}
