// Pixel-art "3 · 2 · 1 · GO!" start sequence drawn above the track.
// The canvas is rendered at a tiny logical resolution and upscaled with
// `image-rendering: pixelated`, so every block on screen is a real pixel.
// Callers feed it the seconds left until the start (negative once racing);
// it runs its own animation frame loop so the motion stays smooth even
// though the HUD only refreshes every ~60 ms.

const W=72,H=48,CELL=4,GLYPH_TOP=17,MID=W/2

const GLYPHS={
  3:['111110','000011','000011','001110','000011','000011','111110'],
  2:['011110','110011','000011','000110','001100','011000','111111'],
  1:['001100','011100','111100','001100','001100','001100','111111'],
  G:['011110','110011','110000','110111','110011','110011','011111'],
  O:['011110','110011','110011','110011','110011','110011','011110'],
  '!':['11','11','11','11','11','00','11']
}
const DIGIT_COLORS={3:['#ff6a4d','#e8402f','#9c2318'],2:['#ffc070','#f9963a','#a9561a'],1:['#ffe9a8','#f9c35c','#a97a26']}
const GO_COLORS=['#a8ffb6','#4fd16a','#23803a'],FLASH_COLORS=['#ffffff','#f4fff2','#9fdcaa']
const INK='#172822',SHADOW='#0b1411'

function hash(i,j,seed=0) {
  const n=Math.sin(i*12.9898+j*78.233+seed*37.719)*43758.5453
  return n-Math.floor(n)
}
const clamp=v=>Math.max(0,Math.min(1,v))

// Lay a string out as a list of lit cells in canvas pixel coordinates.
function layout(text) {
  const glyphs=[...text].map(ch=>GLYPHS[ch])
  const width=glyphs.reduce((sum,g)=>sum+g[0].length,0)+glyphs.length-1
  let x=Math.round((W-width*CELL)/2)
  const cells=[]
  for (const glyph of glyphs) {
    glyph.forEach((row,j)=>[...row].forEach((bit,i)=>{
      if (bit==='1') cells.push({x:x+i*CELL,y:GLYPH_TOP+j*CELL,i:i+x,j,
        top:glyph[j-1]?.[i]!=='1',bottom:glyph[j+1]?.[i]!=='1',left:row[i-1]!=='1'})
    }))
    x+=(glyph[0].length+1)*CELL
  }
  return cells
}
const LAYOUTS={3:layout('3'),2:layout('2'),1:layout('1'),GO:layout('GO!')}

function createCountdown(parent) {
  const canvas=document.createElement('canvas')
  canvas.id='pixel-countdown'
  canvas.width=W
  canvas.height=H
  canvas.hidden=true
  canvas.setAttribute('aria-hidden','true')
  parent.append(canvas)
  const ctx=canvas.getContext('2d')
  const calm=matchMedia('(prefers-reduced-motion: reduce)')
  let base=null,syncedAt=0,frame=0

  function block(x,y,size,color) {
    ctx.fillStyle=color
    ctx.fillRect(Math.round(x),Math.round(y),size,size)
  }
  function drawCells(cells,colors,place) {
    const placed=[]
    for (const cell of cells) {
      const p=place(cell)
      if (p && p.alpha>0) placed.push({...p,cell})
    }
    // Outline, drop shadow, then bevelled face: three passes keep the
    // outlines from painting over neighbouring cells.
    for (const p of placed) {ctx.globalAlpha=p.alpha;block(p.x-1,p.y-1,CELL+2,INK)}
    for (const p of placed) {ctx.globalAlpha=p.alpha;block(p.x+1,p.y+1,CELL,SHADOW)}
    for (const p of placed) {
      // Cells that have drifted off the glyph get a full bevel; settled ones
      // only bevel their outer edges so strokes read as solid pixels.
      const x=Math.round(p.x),y=Math.round(p.y),loose=p.x!==p.cell.x || p.y!==p.cell.y
      ctx.globalAlpha=p.alpha
      block(x,y,CELL,colors[1])
      ctx.fillStyle=colors[0]
      if (loose || p.cell.top) ctx.fillRect(x,y,CELL,1)
      if (loose || p.cell.left) ctx.fillRect(x,y,1,CELL)
      ctx.fillStyle=colors[2]
      if (loose || p.cell.bottom) ctx.fillRect(x,y+CELL-1,CELL,1)
    }
    ctx.globalAlpha=1
  }
  // A small start gantry: three pixel lamps that light red one by one,
  // then all switch to green on GO.
  function drawGantry(lit,green,alpha) {
    ctx.globalAlpha=alpha
    ctx.fillStyle=INK
    ctx.fillRect(MID-17,1,34,11)
    ctx.fillRect(MID-16,0,32,13)
    ctx.fillStyle='#2f4a3e'
    ctx.fillRect(MID-16,1,32,1)
    for (let n=0;n<3;n++) {
      const x=MID-13+n*10,y=2,on=green||n<lit
      const [hi,mid,lo]=green?GO_COLORS:on?['#ff9a80','#e8402f','#8f1f14']:['#4a3a33','#33261f','#22201b']
      ctx.fillStyle=lo;ctx.fillRect(x+1,y,6,9);ctx.fillRect(x,y+1,8,7)
      ctx.fillStyle=mid;ctx.fillRect(x+1,y+1,6,7);ctx.fillRect(x+2,y,4,9)
      ctx.fillStyle=hi;ctx.fillRect(x+2,y+2,2,2)
    }
    ctx.globalAlpha=1
  }

  function paint(remaining) {
    ctx.clearRect(0,0,W,H)
    const still=calm.matches
    let scale=1
    if (remaining>0) {
      const digit=Math.min(3,Math.ceil(remaining)),t=digit-remaining
      drawGantry(4-digit,false,1)
      if (!still) scale=1+.55*(1-clamp(t/.18))**2
      drawCells(LAYOUTS[digit],DIGIT_COLORS[digit],cell=>{
        const h=hash(cell.i,cell.j,digit)
        if (still) return {x:cell.x,y:cell.y,alpha:1}
        if (h>t/.14) return null
        const fall=clamp((t-.76-h*.1)/.2)
        return {x:cell.x+(h-.5)*fall*6,y:cell.y+fall*fall*16,alpha:1-fall}
      })
    } else {
      const g=-remaining,fade=still?clamp((g-.7)/.3):clamp((g-.55)/.45)
      drawGantry(3,true,1-fade)
      if (!still) scale=1+.7*(1-clamp(g/.16))**2
      const flash=!still && g<.4 && Math.floor(g/.07)%2===0
      drawCells(LAYOUTS.GO,flash?FLASH_COLORS:GO_COLORS,cell=>{
        if (still) return {x:cell.x,y:cell.y,alpha:1-fade}
        const h=hash(cell.i,cell.j,7),k=clamp((g-.55-h*.12)/.38)
        const dx=cell.x+CELL/2-MID,dy=cell.y+CELL/2-(GLYPH_TOP+14)
        return {x:cell.x+dx*k*1.4+(h-.5)*k*18,y:cell.y+dy*k*1.4-k*10+k*k*22,alpha:1-k}
      })
    }
    canvas.style.setProperty('--pop',scale.toFixed(3))
  }

  function loop() {
    frame=0
    if (!base) return
    const remaining=base.remaining-Math.min(performance.now()-syncedAt,120)/1000
    if (remaining<=-1) {hide();return}
    paint(remaining)
    frame=requestAnimationFrame(loop)
  }
  function hide() {
    base=null
    canvas.hidden=true
    if (frame) cancelAnimationFrame(frame)
    frame=0
  }
  return {
    // Seconds until the start: 3 → 0 counts down, 0 → -1 plays the GO burst.
    sync(remaining) {
      if (!(remaining>-1)) {if (base) hide();return}
      if (base?.remaining!==remaining) {base={remaining};syncedAt=performance.now()}
      canvas.hidden=false
      if (!frame) frame=requestAnimationFrame(loop)
    },
    hide
  }
}

let shared=null
export function pixelCountdown() {
  if (!shared) shared=createCountdown(document.getElementById('drive-ui')??document.body)
  return shared
}
