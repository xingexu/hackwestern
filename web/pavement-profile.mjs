export function kerbProfile(u,scale=1){
  if(u<-.16||u>.26)return 0
  if(u<=-.09)return .105*scale
  if(u<=.005)return (.105-(u+.09)*.07)*scale
  if(u<=.031)return (.09835-(u-.005)*.66)*scale
  if(u<.055)return (.08119-(u-.031)*2.26)*scale
  return (.02695*(.26-u)/.205)*scale
}

export function tableProfile(row,x,z){
  const [cx,cz,dx,dz,width,depth,rise]=row
  const u=Math.abs((x-cx)*dx+(z-cz)*dz)/(width*.5)
  const v=Math.abs((z-cz)*dx-(x-cx)*dz)/(depth*.5)
  if(u>=1||v>=1)return 0
  const crown=t=>.5-.5*Math.cos(Math.PI*Math.min(1,t))
  return (rise??0)*crown((1-v)/.48)*crown((1-u)/.15)
}

export function streetProfiles(records){
  const bins=new Map()
  const key=(x,z)=>Math.floor(x/24)+','+Math.floor(z/24)
  for(const [kind,rows] of [['ramp',records?.ramps],['table',records?.tables]]){
    for(const row of rows??[]){
      const [x,z,,,width]=row
      const reach=width*.5+3
      for(let i=Math.floor((x-reach)/24);i<=Math.floor((x+reach)/24);i++){
        for(let j=Math.floor((z-reach)/24);j<=Math.floor((z+reach)/24);j++){
          const id=i+','+j
          if(!bins.has(id))bins.set(id,{ramp:[],table:[]})
          bins.get(id)[kind].push(row)
        }
      }
    }
  }
  const islands=new Map()
  for(const island of records?.islands??[]){
    const xs=island.ring.map(p=>p[0]),zs=island.ring.map(p=>p[1])
    for(let i=Math.floor(Math.min(...xs)/24);i<=Math.floor(Math.max(...xs)/24);i++){
      for(let j=Math.floor(Math.min(...zs)/24);j<=Math.floor(Math.max(...zs)/24);j++){
        const id=i+','+j
        if(!islands.has(id))islands.set(id,[])
        islands.get(id).push(island)
      }
    }
  }
  return {
    islandAt(x,z){
      for(const {ring,kind} of islands.get(key(x,z))??[]){
        let inside=false
        for(let i=0,j=ring.length-1;i<ring.length;j=i++){
          const [ax,az]=ring[i],[bx,bz]=ring[j]
          if((az>z)!==(bz>z) && x<(bx-ax)*(z-az)/(bz-az)+ax)inside=!inside
        }
        if(inside)return kind
      }
      return 0
    },
    nearOpening(x,z){return Boolean(bins.get(key(x,z))?.ramp.length)},
    kerbFactor(x,z){
      let lowest=1
      for(const [cx,cz,dx,dz,width] of bins.get(key(x,z))?.ramp??[]){
        const perpendicular=Math.abs((z-cz)*dx-(x-cx)*dz)
        if(perpendicular>2.2)continue
        const side=(Math.abs((x-cx)*dx+(z-cz)*dz)-width*.5)/.76
        const t=Math.max(0,Math.min(1,side))
        lowest=Math.min(lowest,.055+.945*t*t*(3-2*t))
      }
      return lowest
    },
    tableAt(x,z){
      let result=0
      for(const table of bins.get(key(x,z))?.table??[])result=Math.max(result,tableProfile(table,x,z))
      return result
    }
  }
}
