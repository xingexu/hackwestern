const by=id=>document.getElementById(id)

export function installMobileHud(){
  const root=by('drive-ui'),card=root.querySelector('.course-card'),map=root.querySelector('.route-card')
  const touch=by('touch-drive'),tilt=by('tilt'),settings=by('phone-settings')
  const coarse=matchMedia('(pointer:coarse)')
  const toggle=document.createElement('button')
  toggle.id='mobile-menu-toggle'
  toggle.type='button'
  toggle.ariaLabel='Driving menu'
  toggle.setAttribute('aria-haspopup','dialog')
  toggle.setAttribute('aria-controls','mobile-drive-menu')
  toggle.setAttribute('aria-expanded','false')
  const dialog=document.createElement('dialog')
  dialog.id='mobile-drive-menu'
  dialog.setAttribute('aria-label','Driving menu')
  const close=document.createElement('button')
  close.type='button'
  close.className='close-drive-menu'
  close.ariaLabel='Close driving menu'
  close.textContent='×'
  const options=document.createElement('div')
  options.className='mobile-steering'
  dialog.append(close)
  const mapToggle=document.createElement('button')
  mapToggle.type='button'
  mapToggle.id='mobile-map-toggle'
  mapToggle.setAttribute('aria-controls','route-plan')
  function expandMap(expanded){
    map.dataset.expanded=String(expanded)
    mapToggle.ariaLabel=expanded?'Shrink minimap':'Expand minimap'
    mapToggle.setAttribute('aria-expanded',String(expanded))
  }
  expandMap(false)
  mapToggle.onclick=()=>expandMap(map.dataset.expanded!=='true')
  map.append(mapToggle)
  const hint=document.createElement('output')
  hint.id='mobile-drive-hint'
  root.append(toggle,dialog,hint)
  toggle.onclick=()=>{
    dialog.showModal()
    toggle.setAttribute('aria-expanded','true')
    close.focus()
  }
  close.onclick=()=>dialog.close()
  dialog.addEventListener('close',()=>toggle.setAttribute('aria-expanded',String(dialog.open)))
  dialog.addEventListener('click',e=>{
    const r=dialog.getBoundingClientRect()
    if(e.target===dialog && (e.clientX<r.left || e.clientX>r.right || e.clientY<r.top || e.clientY>r.bottom))dialog.close()
    if(e.target.closest('nav button,nav a'))dialog.close()
  })
  const originalControls=tilt.nextElementSibling
  function layout(){
    if(coarse.matches){
      dialog.append(card)
      card.querySelector('nav').before(options)
      options.append(tilt,settings)
    }else{
      if(dialog.open)dialog.close()
      root.insertBefore(card,map)
      touch.insertBefore(tilt,originalControls)
      touch.append(settings)
      options.remove()
    }
  }
  coarse.addEventListener('change',layout)
  layout()
  let previousCar=null,phase='',hintUntil=0
  return (car,paired,pad,now)=>{
    if(!coarse.matches)return
    root.classList.toggle('phone-paired',Boolean(paired))
    const changed=previousCar!==car || phase!==car.phase
    if(changed && (car.phase==='ready' || car.phase==='driving')){
      if(dialog.open && car.phase==='driving')dialog.close()
      hintUntil=now+(car.phase==='ready'?3500:1800)
    }
    previousCar=car;phase=car.phase
    const message=paired?'Steer with your paired phone':pad?'Left stick to steer · RT for gas':tilt.getAttribute('aria-pressed')==='true'?'Tilt to steer · Gas to drive':'Arrows to steer · Gas to drive'
    if(hint.textContent!==message)hint.textContent=message
    hint.classList.toggle('visible',now<hintUntil && !dialog.open && car.phase!=='finished')
    root.classList.toggle('show-drive-warning',Boolean(car.offCourse || /Paused|Time limit|Roundabout|Wrong way|Restricted road|Keep right/.test(by('drive-message').textContent)))
  }
}
