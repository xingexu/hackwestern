const walkable=new Set(['grass','road','path','water','field','kerb','gutter','bank'])

export function support(hits,y) {
  const floor=hits.filter(h=>walkable.has(h.kind))
  if(!Number.isFinite(y)) return floor[0]
  const parking=hits.filter(h=>h.parkingFloor && Math.abs(h.y-y)<.5).sort((a,b)=>Math.abs(a.y-y)-Math.abs(b.y-y))[0]
  if(parking && floor.every(h=>Math.abs(parking.y-y)<Math.abs(h.y-y)+.025))return {...parking,kind:'road'}
  return floor.find(h=>!(h.item.kind==='deck' && h.y>y+1.8 && floor.some(lower=>lower.y<h.y-1.8 && Math.abs(lower.y-y)<Math.abs(h.y-y))))??floor[0]
}

export function driveBody(index,game,car,r=.75) {
  for(const d of [-1.34,0,1.34]) {
    const x=car.x+Math.sin(car.heading)*d,z=car.z+Math.cos(car.heading)*d
    const wheel=game.sample(x,z,car.y).y
    const deck=Math.abs(wheel-car.y)<.8?wheel:car.y
    const base=Math.max(car.y+.16,deck+.16)
    const hit=index.solid(x,base,z,r,1.25,true)
    if(hit)return {x,y:base,z,r,geometry:hit.kind,mesh:hit.mesh.name||hit.mesh.parent.name}
  }
}

export function contactEvidence(game,index,x,y,z,heading) {
  for(let forward=0;forward<=4;forward+=.3){
    const px=x+Math.sin(heading)*forward,pz=z+Math.cos(heading)*forward
    const floor=game.sample(px,pz,y)
    for(const offset of [-1.34,0,1.34]){
      const vx=px+Math.sin(heading)*offset,vz=pz+Math.cos(heading)*offset
      const reason=game.blockerKind(vx,vz,floor.y,.90)
      if(visibleLimit(game,index,vx,vz,reason))return reason
    }
    const hit=driveBody(index,game,{x:px,y:floor.y,z:pz,heading},.92)
    if(hit) return hit.mesh
  }
}

export function coincident(hits) {
  const exposed=hits.filter(h=>!['leaves','branch'].includes(h.kind) && h.item.mesh.material.depthWrite && !h.item.mesh.material.transparent)
  const first=exposed[0]
  if(!first || first.face.normal.y<.75) return
  for(const other of exposed.slice(1)) {
    if(first.y-other.y>.0005) return
    if(first.item.mesh===other.item.mesh || other.face.normal.y<.75) continue
    const a=first.item.mesh.material,b=other.item.mesh.material
    if(a.polygonOffset!==b.polygonOffset || a.polygonOffset && (a.polygonOffsetFactor!==b.polygonOffsetFactor || a.polygonOffsetUnits!==b.polygonOffsetUnits))continue
    const finish=h=>{
      const attr=h.item.mesh.geometry.attributes.finishId
      return attr?.getX(attr.isInstancedBufferAttribute?h.item.instance:h.face.a)
    }
    if(first.owner && first.owner===other.owner && finish(first)===finish(other))continue
    return [first,other]
  }
}

export function visibleLimit(game,index,x,z,reason){
  if(reason==='boundary')return true
  if(reason==='steps')return game.column(index,x,z).some(h=>h.kind==='path'||h.kind==='prop')
  if(reason!=='water')return false
  for(let i=-1;i<12;i++){
    const a=i*Math.PI/6,r=i<0?0:.9
    if(game.column(index,x+r*Math.cos(a),z+r*Math.sin(a)).some(h=>h.kind==='water'))return true
  }
  return false
}
