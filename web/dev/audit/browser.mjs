import {adapter} from './adapter.mjs'

import {support,driveBody,contactEvidence,coincident,visibleLimit} from './contacts.mjs'

const tolerance={bank:.35,road:.12,path:.22,grass:.35,field:.30,water:1,kerb:.16,gutter:.08}
const round=n=>Math.round(n*1000)/1000

function* samples(cell) {
  for(const v of cell.samples??Array.from({length:2500},(_,i)=>i)) {
    if(Array.isArray(v)) yield v
    else yield [cell.x+v%50+.5,cell.z+Math.floor(v/50)+.5,1]
  }
}

function insideRing(ring,x,z) {
  let inside=false
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [a,b]=ring[i],[c,d]=ring[j]
    if((b>z)!==(d>z) && x<(c-a)*(z-b)/(d-b)+a) inside=!inside
  }
  return inside
}

export function measure(game,index,cell,buildings,stages) {
  const findings=[],counts={},worst={},anchors=[],edgeObservations=[]
  let checked=0,areaChecked=0,driveRuns=0,collisionProbes=0
  const started=performance.now(), points=new Map()
  function report(check,severity,x,y,z,measured,score=1) {
    const entry={cell:cell.id,x:round(x),y:round(y),z:round(z),check,severity,measured}
    findings.push(entry)
    counts[check]=(counts[check]??0)+1
    if(!(check in worst) || worst[check].score<score) worst[check]={score,entry}
  }
  const sampleAt=(x,z,y)=>{
    const hits=game.column(index,x,z)
    const ground=support(hits,y)
    return {hits,ground}
  }
  const startChecks=performance.now()
  for(const [x,z,area] of samples(cell)) {
    const contact=game.sample(x,z)
    if(!contact.blocked && (Math.floor(x)%5===0 && Math.floor(z)%5===0 || !anchors.length)) anchors.push(contact)
    if(!stages.includes('checks')) continue
    checked++
    areaChecked+=area
    const {hits,ground}=sampleAt(x,z,contact.y)
    const y=contact.y
    if(!ground) report('missing-ground','critical',x,y,z,{intersections:hits.length})
    else {
      const delta=ground.y-y
      if(Math.abs(delta)>tolerance[ground.kind]) report('ground-height','high',x,ground.y,z,{physics:round(y),drawn:round(ground.y),delta:round(delta),surface:ground.kind},Math.abs(delta))
      const agrees=ground.kind==='bank' && ['path','grass'].includes(contact.surface) || ground.kind==='gutter' && contact.surface==='road' || ground.kind==='kerb' && (contact.curb>0 || contact.surface==='path') || ground.kind===contact.surface || ground.kind==='field' && contact.surface==='grass' || ground.kind==='water' && contact.blocked
      if(!agrees){
        const measured={drawn:ground.kind,physics:contact.surface,blocked:contact.blocked}
        const stable=[[.2,0],[-.2,0],[0,.2],[0,-.2]].every(([dx,dz])=>
          sampleAt(x+dx,z+dz,y).ground?.kind===ground.kind && game.sample(x+dx,z+dz,y).surface===contact.surface)
        if(stable)report('surface-class','medium',x,y,z,measured)
        else edgeObservations.push({x:round(x),y:round(y),z:round(z),...measured})
      }
      if(ground.kind!=='road' && hits.some(h=>h.kind==='paint' && h.y>=ground.y-.001)) report('off-road-paint','high',x,y,z,{under:ground.kind})
      const key=Math.floor(x)+','+Math.floor(z)
      for(const [dx,dz] of [[-1,0],[0,-1]]) {
        let neighbor=points.get((Math.floor(x)+dx)+','+(Math.floor(z)+dz))
        if(!neighbor && (Math.floor(x)+dx<cell.x || Math.floor(z)+dz<cell.z) && game.inside(x+dx,z+dz)) neighbor=sampleAt(x+dx,z+dz,ground.y).ground
        if(neighbor?.kind===ground.kind && Math.abs(neighbor.y-ground.y)>(ground.kind==='grass'?1.2:.65)) {
          const guard=h=>h.item.mesh.name==='Bridge decks and approaches' && ['rail','prop'].includes(h.kind) && Math.abs(h.y-Math.max(ground.y,neighbor.y))<1.7
          let jump=0,last=ground.y,protectedEdge=hits.some(guard)
          for(let i=1;i<=10;i++){
            const {ground:layer,hits:edge}=sampleAt(x+dx*i/10,z+dz*i/10,last)
            protectedEdge ||= edge.some(guard)
            if(!layer)continue
            if(layer.kind===ground.kind)jump=Math.max(jump,Math.abs(layer.y-last))
            last=layer.y
          }
          if(!protectedEdge && jump>.34 && Math.abs(last-neighbor.y)<.4) report('height-step','high',x,ground.y,z,{dx,dz,neighbor:round(neighbor.y),jump:round(jump),surface:ground.kind},Math.abs(neighbor.y-ground.y))
        }
      }
      points.set(key,{kind:ground.kind,y:ground.y})
    }
    const expected=game.buildings.roof(x,z)
    const shells=hits.filter(h=>h.kind==='building')
    for(const part of expected){
      const own=shells.filter(h=>h.owner===part.id)
      const nearest=own.reduce((best,h)=>Math.abs(h.y-part.y)<Math.abs(best-part.y)?h.y:best,Infinity)
      if(Math.abs(nearest-part.y)>.16) report('building-height','high',x,part.y,z,{building:part.id,expected:round(part.y),nearest:Number.isFinite(nearest)?round(nearest):null,part:part.part,lidarTrusted:part.trusted})
    }
    const missing=buildings.find(b=>b.present && !game.buildings.record(b.id) && insideRing(b.footprint,x,z) && !b.holes.some(h=>insideRing(h,x,z)))
    if(missing) report('building-height','high',x,y,z,{building:missing.id,expected:'inventory and present specification',reason:'missing runtime building'})
    const absent=buildings.find(b=>!b.present && insideRing(b.footprint,x,z) && !b.holes.some(h=>insideRing(h,x,z)))
    for(const owner of new Set(shells.map(h=>h.owner))){
      const own=shells.find(h=>h.owner===owner)
      if(!expected.some(b=>b.id===owner) && !game.buildings.allowed(owner,x,own.y,z)) report('stray-building','medium',x,own.y,z,{building:owner,absentInventory:absent?.id??null,aboveGround:round(own.y-y)})
    }
    const pair=coincident(hits)
    if(pair && [[.04,0],[0,.04],[-.04,0]].every(([dx,dz])=>{
      const other=coincident(game.column(index,x+dx,z+dz))
      return other && other.every(h=>pair.some(p=>p.item.mesh===h.item.mesh))
    })){
      const conflict=game.layerConflict(pair,x,z)
      if(conflict) report('coincident-surfaces','medium',x,pair[0].y,z,{upper:pair[0].kind,lower:pair[1].kind,gap:round(pair[0].y-pair[1].y),...conflict})
    }
    if((Math.floor(x)%2===0 && Math.floor(z)%2===0) && ground?.kind!=='water' && game.inside(x+.9,z) && game.inside(x-.9,z) && game.inside(x,z-.9) && game.inside(x,z+.9)) {
      collisionProbes++
      const reason=game.blockerKind(x,z,y,.9),blocked=Boolean(reason)
      const radius=blocked?1.02:.78
      const solid=index.solid(x,y+.16,z,radius,1.3,true)
      const enclosed=blocked && !solid && expected.some(b=>b.closed?.some(top=>top>=y+1.5 && shells.some(h=>h.owner===b.id && Math.abs(h.y-top)<.16)))
      if(!enclosed && blocked!==Boolean(solid) && !visibleLimit(game,index,x,z,reason)) report('collision-parity','high',x,y,z,{blocked,reason:reason||null,geometry:solid?.kind??null,...(reason==='solid' && !solid?{solidSource:game.solidSource?.(x,z,y,.9)}:{}),mesh:solid?.mesh.name||solid?.mesh.parent.name,radius:.9,visualRadius:radius})
    }
  }
  if(stages.includes('checks')) for(const item of index.objects) {
    if(item.kind!=='tree') continue
    const {min,max}=item.box,[x,,z]=item.matrix.elements.slice(12,15)
    if(x<cell.x || x>=cell.x+50 || z<cell.z || z>=cell.z+50 || !game.inside(x,z) || max.x-min.x>15 || max.z-min.z>15 || max.y-min.y<.55) continue
    const ground=sampleAt(x,z).ground
    if(!ground) continue
    const delta=item.matrix.elements[13]-ground.y
    if(delta>.55 || delta<-.85) report('object-base','medium',x,min.y,z,{kind:item.kind,delta:round(delta),instance:item.instance},Math.abs(delta))
  }
  if(stages.includes('checks')) {
    for(const [x,z] of index.paintSamples()) {
      if(!game.inside(x,z)) continue
      const {hits,ground}=sampleAt(x,z)
      const paint=hits.find(h=>h.kind==='paint')
      if(paint && ground && paint.y>=ground.y-.001 && ground.kind!=='road') report('off-road-paint','high',x,paint.y,z,{under:ground.kind,probe:'triangle'})
    }
    const bases=[...game.anchors(cell)]
    for(const inv of buildings) {
      const b=game.buildings.record(inv.id)
      if(!b || !inv.present)continue
      for(const [x,z] of game.buildings.bases(b.id)){
        if(x>=cell.x && x<cell.x+50 && z>=cell.z && z<cell.z+50)bases.push({x,z,kind:'building',type:b.id,r:.25,foundation:b.foundation})
      }
      for(const part of b.parts.filter(p=>p.low===0 && (b.spec.style!=='parking-structure' || /stair|lift|elevator|enclosed/i.test(p.name??'')))) for(const ring of part.solidRings??part.rings){
        for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
          const [ax,az]=ring[j],[bx,bz]=ring[i],n=Math.ceil(Math.hypot(bx-ax,bz-az)/4)
          for(let k=0;k<n;k++){
            const x=ax+(bx-ax)*(k+.5)/n,z=az+(bz-az)*(k+.5)/n
            if(x>=cell.x && x<cell.x+50 && z>=cell.z && z<cell.z+50) bases.push({x,z,kind:'building',type:b.id,r:.25,foundation:b.foundation})
          }
        }
      }
    }
    for(const {x,z,kind,type,r,foundation} of bases) {
      if(!game.inside(x,z)) continue
      const ground=game.column(index,x,z).find(h=>h.item.kind==='terrain'||h.item.kind==='estate')
      if(!ground) continue
      const y=kind==='branch'||kind==='limb'?index.trunkBase(x,z,kind):index.base(x,z,ground.y,kind,r,kind==='building'?type:null),delta=y-ground.y
      if(Number.isFinite(y) && (delta>.65 || delta< -1.1 && y<(foundation??ground.y)-1.1)) report('object-base','medium',x,y,z,{kind:type,delta:round(delta)},Math.abs(delta))
    }
  }
  const checksMs=performance.now()-startChecks,driveStart=performance.now()
  if(stages.includes('drive')) {
    const starts=new Map()
    for(const [x,z] of [...anchors.filter(p=>Math.floor(p.x)%10===0 && Math.floor(p.z)%10===0).map(p=>[p.x,p.z]),...game.roadStarts(cell)]) {
      const key=Math.floor(x/3)+','+Math.floor(z/3)
      if(!starts.has(key) && game.inside(x,z)) starts.set(key,game.sample(x,z))
    }
    for(const p of starts.values()) for(const heading of [0,Math.PI/2,Math.PI,3*Math.PI/2]) {
      const sin=Math.sin(heading),cos=Math.cos(heading)
      if([-1.34,0,1.34].some(d=>game.blocked(p.x+sin*d,p.z+cos*d,p.y,.90))) continue
      const sim=game.simulate(p,heading),car=sim.state
      const camera=game.cameraRig(car)
      car.speed=12
      driveRuns++
      const emitted=new Set()
      const issue=(name,measured)=>{
        if(emitted.has(name)) return
        emitted.add(name)
        report(name,'high',p.x,p.y,p.z,{heading:round(heading),at:[round(car.x),round(car.y),round(car.z)],...measured})
      }
      let penetrated=Boolean(driveBody(index,game,car))
      let previous=p.y
      for(let step=1;step<=36;step++) {
        sim.step({throttle:1})
        if(!Number.isFinite(car.y+car.x+car.z)) {issue('fall-through',{step});break}
        if(car.y-previous>.45) issue('launch',{step,rise:round(car.y-previous)})
        previous=car.y
        if(step%9) continue
        const drawn=sampleAt(car.x,car.z,car.y).ground
        if(!drawn || car.y<drawn.y-.55)issue('sinking',{step,drawn:drawn?round(drawn.y):null})
        if(drawn && car.y<drawn.y-2)issue('fall-through',{step,penetration:round(drawn.y-car.y)})
        const body=driveBody(index,game,car)
        if(body && !penetrated && !car.contact) issue('passed-solid',{step,probe:body})
        penetrated=Boolean(body)
        const [cx,cy,cz]=camera(car)
        const visible=game.inside(cx,cz)
        const cameraHit=visible && index.solid(cx,cy-.12,cz,.12,.24)
        const terrain=visible && game.column(index,cx,cz).find(h=>h.item.kind==='terrain'||h.item.kind==='estate')
        if(cameraHit || terrain?.y>cy-.12) issue('camera-clip',{step,camera:[cx,cy,cz].map(round),geometry:cameraHit?.kind??'terrain',terrain:terrain?.y})
      }
      const advance=Math.hypot(car.x-p.x,car.z-p.z)
      if(advance<.6 && !contactEvidence(game,index,p.x,p.y,p.z,heading)){
        let first,explained=false
        const replay=game.simulate(p,heading,(x,z,y,r,reason)=>{
          first??={x:round(x),y:round(y),z:round(z),radius:r,reason}
          if(!explained)explained=Boolean(index.solid(x,y+.10,z,r+.12,1.4,true))||visibleLimit(game,index,x,z,reason)
        })
        replay.state.speed=12
        for(let i=0;i<36;i++)replay.step({throttle:1})
        if(!explained)issue('stuck',{advance:round(advance),blocker:first??null})
      }
    }
  }
  const anchor=anchors.sort((a,b)=>Number(b.surface==='road')-Number(a.surface==='road') || Math.hypot(a.x-cell.x-25,a.z-cell.z-25)-Math.hypot(b.x-cell.x-25,b.z-cell.z-25)).find(p=>!game.blocked(p.x,p.z,p.y,.22) && !index.solid(p.x,p.y+.4,p.z,.2,1.4) && sampleAt(p.x,p.z).ground)
  return {checked,areaChecked,driveRuns,collisionProbes,counts,worst,findings,edgeObservations,anchor,checksMs,driveMs:performance.now()-driveStart,totalMs:performance.now()-started}
}

function poses(game,cell,anchor) {
  const x=cell.x+25,z=cell.z+25,y=game.sample(x,z).y
  const list=[{name:'top',eye:[x,y+145,z],at:[x,y,z],up:[0,0,-1],span:50,width:1000,height:1000}]
  list.push({...list[0],name:'ground',layer:'ground'})
  for(const sign of [-1,1]) list.push({name:sign<0?'oblique-nw':'oblique-se',eye:[x+sign*46,y+48,z+sign*46],at:[x,y+3,z],fov:55,width:500,height:360})
  if(anchor) for(const [name,heading] of [['N',Math.PI],['E',Math.PI/2],['S',0],['W',-Math.PI/2]]) for(const kind of ['eye','chase']) {
    list.push({name:kind+'-'+name,...game.cameraPose(anchor,heading,kind,500,300)})
  }
  return list
}

export async function install(context) {
  const game=await adapter(context)
  let cellIndex
  window.campusAudit={
    focus:cell=>game.focus(cell),
    measure(cell,buildings,stages){
      cellIndex=game.index(cell)
      return measure(game,cellIndex,cell,buildings,stages)
    },
    inspect(cell,x,y,z){
      const index=game.index(cell)
      const describe=i=>i?{kind:i.kind,name:i.mesh.name,parent:i.mesh.parent?.name,instance:i.instance}:null
      const hits=game.column(index,x,z).slice(0,14).map(h=>({kind:h.kind,y:round(h.y),owner:h.owner,item:describe(h.item)}))
      const physics=game.sample(x,z,y)
      return {hits,physics,blocked:game.blocked(x,z,physics.y,.9),body:describe(index.solid(x,physics.y+.16,z,.9,1.3)),eye:describe(index.solid(x,y-.15,z,.18,.30))}
    },
    poses:(cell,anchor)=>poses(game,cell,anchor),
    render:pose=>game.render(pose)
  }
}
