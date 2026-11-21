// Formula Western UI components: loading screen, screen transitions and pixel effects.
// Loaded as a classic module before main.js so the loader paints and animates immediately.
// Game code keeps owning #status (text, hidden, role=alert); this module only observes it.

const root=document.documentElement
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches
// Automated runs (Playwright sets navigator.webdriver) compare screenshots, so skip motion there.
const instant=reduced || navigator.webdriver
if(instant) root.dataset.uiInstant=''

const TIPS=[
  'Tilt your phone to steer once the controller is paired.',
  'Press R to restart the run from the grid.',
  'Driver view puts you behind the wheel.',
  'Time trial saves a ghost of your best lap.',
  'Up to 8 friends can race in one Online room.',
  'Free roam lets you start near any campus landmark.',
]

function mountLoader() {
  const loader=document.getElementById('loader')
  const status=document.getElementById('status')
  if(!loader || !status) return
  const fill=loader.querySelector('.loader-fill')
  const percent=loader.querySelector('.loader-percent')
  const tip=loader.querySelector('.loader-tip')
  if(tip) tip.textContent='TIP · '+TIPS[Math.floor(Math.random()*TIPS.length)]

  // Real progress: preloaded assets finishing (from <link rel=preload> in the built page),
  // then the scene-building phase, then the first rendered frame.
  const expected=new Set([...document.querySelectorAll('link[rel=preload],link[rel=modulepreload]')].map(link=>link.href))
  const total=Math.max(expected.size,24)
  let fetched=0,shown=0,target=0,phase=0,done=false
  const seen=new Set()
  const count=entries=>{
    for(const entry of entries){
      if(seen.has(entry.name) || !/\/assets\/|\.json|\.bin/.test(entry.name)) continue
      seen.add(entry.name); fetched++
    }
  }
  try {
    count(performance.getEntriesByType('resource'))
    new PerformanceObserver(list=>count(list.getEntries())).observe({type:'resource',buffered:true})
  } catch {}

  function tick() {
    if(done) return
    if(phase===0) target=Math.min(.7,.06+.64*fetched/total)
    else target=Math.max(target,.72)+(.95-Math.max(target,.72))*.04
    shown+=(target-shown)*.18
    render(shown)
    requestAnimationFrame(tick)
  }
  function render(value) {
    // Quantize to 20 blocks so the bar fills in chunky pixel steps.
    const blocks=Math.round(Math.min(1,value)*20)
    fill.style.setProperty('--blocks',blocks)
    if(percent) percent.textContent=String(blocks*5).padStart(3,' ')+'%'
  }
  function finish() {
    if(done) return
    done=true
    render(1)
    loader.classList.add('is-done')
    const leave=()=>{
      loader.classList.add('is-leaving')
      root.classList.add('ui-ready')
      // Hide rather than remove: game code and tests keep reading #status, which lives inside the loader.
      setTimeout(()=>{loader.hidden=true},instant?0:700)
    }
    if(instant) leave(); else setTimeout(leave,260)
  }
  function fail() {
    done=true
    loader.classList.add('is-error')
    if(!loader.querySelector('.loader-retry')){
      const retry=document.createElement('button')
      retry.type='button'; retry.className='px-button loader-retry'; retry.textContent='Retry'
      retry.addEventListener('click',()=>location.reload())
      loader.querySelector('.loader-panel')?.append(retry)
    }
  }
  function sync() {
    if(status.getAttribute('role')==='alert') return fail()
    if(status.hidden) return finish()
    if(/preparing/i.test(status.textContent)) phase=1
  }
  new MutationObserver(sync).observe(status,{attributes:true,childList:true,characterData:true,subtree:true})
  sync()
  requestAnimationFrame(tick)
}

// Pixel wipe between pages: links that reload the game play a short block wipe first.
function mountWipe() {
  const wipe=document.createElement('div')
  wipe.className='px-wipe'; wipe.setAttribute('aria-hidden','true')
  document.body.append(wipe)
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a[href]')
    if(!link || instant || event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || link.target) return
    const url=new URL(link.href,location.href)
    if(url.origin!==location.origin || url.pathname!==location.pathname || url.search===location.search) return
    event.preventDefault()
    wipe.classList.add('is-covering')
    setTimeout(()=>location.assign(url),360)
  })
  addEventListener('pageshow',()=>wipe.classList.remove('is-covering'))
  return wipe
}

// Short pixel flash when the course or spawn point changes without a page load.
function mountFlash(wipe) {
  const flash=()=>{
    if(instant) return
    wipe.classList.remove('is-flashing'); void wipe.offsetWidth; wipe.classList.add('is-flashing')
  }
  document.addEventListener('change',event=>{ if(event.target.matches?.('#drive-course,#spawn')) flash() })
  document.addEventListener('click',event=>{ if(event.target.closest?.('#restart,#again')) flash() })
}

// Buttons get a short pixel "press" class so taps register visually on touch screens too.
function mountPress() {
  document.addEventListener('pointerdown',event=>{
    const button=event.target.closest?.('button,summary,.px-button')
    if(!button) return
    button.classList.add('is-pressed')
    const release=()=>{button.classList.remove('is-pressed'); removeEventListener('pointerup',release); removeEventListener('pointercancel',release)}
    addEventListener('pointerup',release); addEventListener('pointercancel',release)
  },{passive:true})
}

mountLoader()
const wipe=mountWipe()
mountFlash(wipe)
mountPress()
