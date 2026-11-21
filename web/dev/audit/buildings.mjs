import {buildArchitecture} from '../../building-kernel.mjs'

function extent(ring) {
  const xs=ring.map(p=>p[0]),zs=ring.map(p=>p[1])
  return [Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)]
}

function near(b,x,z,r=0){return x>=b[0]-r && x<=b[2]+r && z>=b[1]-r && z<=b[3]+r}

function contains(rings,x,z,pad=0) {
  let inside=false
  for(const ring of rings) for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [a,b]=ring[j],[c,d]=ring[i],dx=c-a,dz=d-b
    if((b>z)!==(d>z) && a+(z-b)*dx/dz>x) inside=!inside
    if(pad){
      const t=Math.max(0,Math.min(1,((x-a)*dx+(z-b)*dz)/(dx*dx+dz*dz||1)))
      if((x-a-t*dx)**2+(z-b-t*dz)**2<=pad*pad) return true
    }
  }
  return inside
}

function accessory(b,part,x,y,z) {
  const top=b.ground+part.high,base=b.ground+part.low
  for(let r=0;r<part.rings.length;r++) for(let j=0;j<part.rings[r].length;j++){
    const ring=part.rings[r],[ax,az]=ring[j],[bx,bz]=ring[(j+1)%ring.length]
    const len=Math.hypot(bx-ax,bz-az)
    if(!len)continue
    const along=((x-ax)*(bx-ax)+(z-az)*(bz-az))/len
    if(along<-.25 || along>len+.25)continue
    const q=Math.max(0,Math.min(1,along/len)),curve=part.curves?.[r]?.[j]??0
    const depth=((x-ax)*(bz-az)-(z-az)*(bx-ax))/len-4*q*(1-q)*curve
    if(depth<-.45)continue
    const id=part.wallIds[r][j],wall=b.walls[id]
    const styles=[b.spec.walls.default]
    for(const [key,pf] of Object.entries(b.spec.walls.byWall??{})){
      const [lo,hi=lo]=key.split('-').map(Number)
      if(key==='all'||key==='street'&&wall?.street||key===wall?.faces||lo<=id&&id<=hi)styles.push(pf)
    }
    const profile=Object.assign({},...styles,part.facade)
    const pi=b.parts.findIndex(p=>p.surface===part.surface)
    for(const [i,e] of (b.spec.entrances??[]).entries()){
      if(b.entranceEdges?.[i]!==pi+':'+r+':'+j)continue
      if(e.vault?.balcony){
        const w=e.width??2.3,u=along-e.boundAlong,back=(b.entryGround?.[i]??base)+(e.steps??0)*.155+.035+(e.height??2.7)
        if(Math.abs(u)<=w*.52+.09 && depth<=1.1+1.1*Math.cos(u/w*Math.PI)+.08 && y>=back-.23 && y<=back+.92)return true
      }
      if(!e.canopy)continue
      const width=e.canopy.width??(e.width??2.3)+1
      const floor=(b.entryGround?.[i]??base)+(e.steps??0)*.155
      const level=floor+(e.height??2.7)
      if(Math.abs(along-e.boundAlong)<=width/2+.15 && depth<=(e.canopy.depth??1.5)+.15 && y>=level-.2 && y<=level+(e.canopy.rise??Math.min(1.55,width/(e.canopy.peaks??1)*.26))+.32)return true
    }
    if(['oriel','bay-window'].includes(profile.windows?.type) && depth<=.70 && y>=base+.1 && y<top)return true
    if([...styles,part.facade].some(p=>p?.windows?.shading==='overhang') && depth<.89 && y>base+.7 && y<=top+.2)return true
    const corn=profile.cornice
    if(corn && y>=top-(corn.height??.22)-.1 && y<=top+.1 && depth<=(corn.depth??.14)+.14)return true
    for(const member of [profile.piers,profile.buttresses]){
      if(member && y>=base-.1 && y<=top+(member.pinnacles?2:.1) && depth<=(member.depth??.25)*(member.stepped?1.7:1)+.1)return true
    }
    const count=Math.max(1,part.floors),start=base+(part.low===0?(b.spec.floors.raisedGround??0):0)
    const first=Math.min(top-start,profile.groundFloor?.height??b.spec.floors.groundFloorHeight??(top-start)/count)
    const margin=Math.min(profile.bays?.edgeMargin??.25,len*.22)
    const bays=Math.min(160,Math.max(1,Math.round(profile.bays?.count??(len-2*margin)/(profile.bays?.width??3.8))))
    const pitch=(len-2*margin)/bays,k=Math.floor((along-margin)/pitch)
    if(k<0||k>=bays||Math.abs(along-margin-(k+.5)*pitch)>pitch*.42+.1)continue
    for(let f=0;f<count;f++){
      const pf=Object.assign({},profile,f===0?profile.groundFloor:null,f===count-1?profile.topFloor:null,profile.floorOverrides?.[f])
      const bal=pf.balconies
      if(!bal?.floors?.includes(f) || (bal.bayPattern?!bal.bayPattern[k%bal.bayPattern.length]:k%Math.max(1,bal.every??1)!==0))continue
      const floor=f===0?start:start+first+(f-1)*(top-start-first)/Math.max(1,count-1)
      if(y>=floor-.12 && y<=floor+1.4 && depth<=(bal.depth??1.3)+.12)return true
    }
  }
  return false
}

export function buildingSurvey(records) {
  const byId=new Map()
  const bins=new Map()
  const key=(x,z)=>Math.floor(x/16)+','+Math.floor(z/16)
  for(const b of records) {
    const parts=b.parts.map(p=>({...p,bounds:extent(p.rings[0])}))
    const collision=buildArchitecture([b],-1)
    const doors=b.spec.entrances??[]
    const feet=doors.some(e=>e.ramp)?buildArchitecture([{...b,spec:{...b.spec,entrances:doors.map(e=>({...e,ramp:false}))}}],-1).footings:collision.footings
    const solids=collision.solids.map(([low,high,flat])=>{
      const rings=flat.map(r=>Array.from({length:r.length/2},(_,i)=>[r[i*2],r[i*2+1]]))
      return {low,high,rings,bounds:extent(rings[0])}
    })
    byId.set(b.id,{b,parts,solids,feet})
    if(b.spec.present===false) continue
    for(const p of parts) {
      const [vertices,indices]=p.surface
      for(let i=0;i<indices.length;i+=3) {
        const [a,c,d]=indices.slice(i,i+3).map(k=>vertices[k])
        const bounds=extent([a,c,d].map(v=>[v[0],v[2]]))
        const tri={a,c,d,b,p}
        for(let j=Math.floor(bounds[1]/16);j<=Math.floor(bounds[3]/16);j++)
          for(let k=Math.floor(bounds[0]/16);k<=Math.floor(bounds[2]/16);k++){
            const s=k+','+j
            if(!bins.has(s)) bins.set(s,[])
            bins.get(s).push(tri)
          }
      }
    }
  }
  function roof(x,z) {
    const result=new Map()
    for(const {a,c,d,b,p} of bins.get(key(x,z))??[]) {
      const dx=c[0]-a[0],dz=c[2]-a[2],ex=d[0]-a[0],ez=d[2]-a[2],det=dx*ez-ex*dz
      if(Math.abs(det)<1e-8) continue
      const u=((x-a[0])*ez-(z-a[2])*ex)/det,v=(dx*(z-a[2])-dz*(x-a[0]))/det
      if(u<0 || v<0 || u+v>1) continue
      const y=b.ground+p.high+a[1]+u*(c[1]-a[1])+v*(d[1]-a[1])
      const prev=result.get(b.id),closed=prev?.closed??[]
      if(p.low===0 && b.spec.style!=='parking-structure' && !p.seats && (!p.collisionShells || p.collisionShells.some(rings=>contains(rings,x,z))))closed.push(y)
      if(!prev || y>prev.y)result.set(b.id,{id:b.id,y,low:p.low===0?(b.foundation??b.ground):b.ground+p.low,part:p.name,trusted:b.spec.lidarTrusted!==false,closed})
    }
    return [...result.values()]
  }
  function allowed(id,x,y,z) {
    const owner=byId.get(id)
    if(!owner || owner.b.spec.present===false) return false
    if([...owner.parts,...owner.solids].some(p=>near(p.bounds,x,z,.6) && contains(p.rings,x,z,.6)))return true
    return owner.parts.some(p=>accessory(owner.b,p,x,y,z))
  }
  function bases(id) {
    const owner=byId.get(id)
    if(!owner)return []
    const out=owner.feet.map(([,x,z])=>[x,z])
    if(owner.b.spec.style==='parking-structure')for(const p of owner.solids){
      const [l,t,r,b]=p.bounds
      if(r-l<=1.6 && b-t<=1.6 && p.high-p.low>2 && p.low<=owner.b.ground+.2)out.push([(l+r)/2,(t+b)/2])
    }
    return out
  }
  return {roof,allowed,bases,record:id=>byId.get(id)?.b}
}
