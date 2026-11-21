export function installCountdown(element, sound) {
  let last=null
  return cue=>{
    if (last===cue) return
    last=cue
    element.hidden=!cue
    if (!cue) return
    element.textContent=cue
    element.dataset.go=String(cue==='GO')
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.getAnimations().forEach(a=>a.cancel())
      element.animate([{scale:'1.16',opacity:.6},{scale:'1',opacity:1}],{duration:190,easing:'ease-out'})
    }
    sound(cue==='GO'?'go':'tick')
  }
}
