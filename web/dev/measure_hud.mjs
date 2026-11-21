export function hudArea(){
  const selectors=['.course-card','.route-card','.instruments','.drive-help','#drive-message','#checkpoint-direction','#race-countdown','#race-banner','#touch-drive button','#phone-settings summary','#map-sources','#mobile-menu-toggle','#mobile-drive-hint']
  const rects=[]
  for(const element of document.querySelectorAll(selectors.join(','))){
    if(!element.textContent.trim() && !element.ariaLabel)continue
    let visible=true
    for(let el=element;el && visible;el=el.parentElement){
      const style=getComputedStyle(el)
      visible=style.visibility!=='hidden' && style.display!=='none' && Number(style.opacity)>.02
    }
    if(!visible)continue
    const r=element.getBoundingClientRect(),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom)
    if(left<right && top<bottom)rects.push({left,right,top,bottom})
  }
  const xs=[...new Set(rects.flatMap(r=>[r.left,r.right]))].sort((a,b)=>a-b)
  let area=0
  for(let i=1;i<xs.length;i++){
    const spans=rects.filter(r=>r.left<xs[i] && r.right>xs[i-1]).sort((a,b)=>a.top-b.top)
    let end=0,height=0
    for(const r of spans){
      height+=Math.max(0,r.bottom-Math.max(r.top,end))
      end=Math.max(end,r.bottom)
    }
    area+=height*(xs[i]-xs[i-1])
  }
  return {px:Math.round(area),share:100*area/(innerWidth*innerHeight)}
}
