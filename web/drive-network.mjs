import {kerbProfile,streetProfiles} from './pavement-profile.mjs'
import {groundObstacles} from './ground-obstacles.mjs'
const CELL = 32
const clamp = (n, low, high) => Math.max(low, Math.min(high, n))

function bins() {
  const cells = new Map()
  const key = (x, z) => Math.floor(z / CELL) * 10000 + Math.floor(x / CELL)
  return {
    at(x, z) { return cells.get(key(x, z)) ?? [] },
    add(item, x0, z0, x1, z1) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
          const k = iz * 10000 + ix
          if (!cells.has(k)) cells.set(k, [])
          cells.get(k).push(item)
        }
      }
    }
  }
}

function segment(x, z, x1, z1) {
  const dx = x1-x, dz = z1-z
  const length = Math.hypot(dx,dz)
  return {x, z, dx, dz, length, invSquare: length ? 1/(length*length) : 0}
}

function fraction(s,x,z) {
  return clamp(((x-s.x)*s.dx + (z-s.z)*s.dz)*s.invSquare, 0, 1)
}

function distSq(s,x,z,t = fraction(s,x,z)) {
  const dx = x - s.x - t*s.dx, dz = z - s.z - t*s.dz
  return dx*dx + dz*dz
}

function bucketSegment(index, s, pad) {
  index.add(s, s.x+Math.min(0,s.dx)-pad, s.z+Math.min(0,s.dz)-pad,
    s.x+Math.max(0,s.dx)+pad, s.z+Math.max(0,s.dz)+pad)
}

function addPolygon(index, rings, low, high, area, padding=2) {
  const loops = []
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const ring of rings) {
    const edges = []
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i], z = ring[i+1], next = (i+2) % ring.length
      edges.push(segment(x,z,ring[next],ring[next+1]))
      x0 = Math.min(x0,x); x1 = Math.max(x1,x)
      z0 = Math.min(z0,z); z1 = Math.max(z1,z)
    }
    loops.push(edges)
  }
  index.add({loops, low, high, area, x0, z0, x1, z1}, x0-padding,z0-padding,x1+padding,z1+padding)
}

function touchesPolygon(p,x,z,r) {
  if (x<p.x0-r || x>p.x1+r || z<p.z0-r || z>p.z1+r) return false
  let inside = false
  for (const loop of p.loops) {
    for (const edge of loop) {
      if ((edge.z>z) !== (edge.z+edge.dz>z) && edge.x + (z-edge.z)*edge.dx/edge.dz>x) inside = !inside
      if (r && distSq(edge,x,z) <= r*r) return true
    }
  }
  return inside
}

function interval(ticks, n) {
  let a = 0, b = ticks.length-1
  while (b-a>1) {
    const m = (a+b) >>> 1
    if (ticks[m] > n) b = m
    else a = m
  }
  return a
}

function terrainSampler(region, ground) {
  const {xs,zs} = region
  const bytes = Uint8Array.from(atob(region.elevation), c=>c.charCodeAt(0))
  const terrain = new DataView(bytes.buffer)
  const height = (i,j) => terrain.getInt16((j*xs.length+i)*2, true)*.1
  return function groundAt(x,z) {
    const core = ground?.(x,z)
    if (Number.isFinite(core)) return core
    const i = interval(xs,x), j = interval(zs,z)
    const u = clamp((x-xs[i])/(xs[i+1]-xs[i]),0,1), v = clamp((z-zs[j])/(zs[j+1]-zs[j]),0,1)
    const b = height(i+1,j), c = height(i,j+1)
    if (u+v<=1) {
      const a = height(i,j)
      return a+(b-a)*u+(c-a)*v
    }
    const d = height(i+1,j+1)
    return d+(c-d)*(1-u)+(b-d)*(1-v)
  }
}

function facetHeight(triangles,x,z){
  for(const [a,b,c] of triangles){
    const bx=b[0]-a[0],bz=b[2]-a[2],cx=c[0]-a[0],cz=c[2]-a[2],det=bx*cz-bz*cx;
    const u=((x-a[0])*cz-(z-a[2])*cx)/det,v=(bx*(z-a[2])-bz*(x-a[0]))/det;
    if(u>=-.000001&&v>=-.000001&&u+v<=1.000001) return a[1]+(b[1]-a[1])*u+(c[1]-a[1])*v;
  }
}

function deckPanel(way,cross,next,groundAt){
  const half=way.width/2, faces=[],carriage=[],walks=[],banks=[],skirts=[];
  let reach=0;
  const a=cross(0),b=next(0),length=Math.hypot(b[0]-a[0],b[2]-a[2]);
  const rows=way.bridge?1:Math.ceil(length/.9);
  const mix=(x,y,t)=>x+(y-x)*t;
  function at(t,offsetA,offsetB,rise=0){
    const p=cross(offsetA),q=next(offsetB),x=mix(p[0],q[0],t),z=mix(p[2],q[2],t);
    const crown=mix(cross.deckY,next.deckY,t);
    if(way.bridge) return [x,crown+rise,z];
    const ground=groundAt(x,z)+.035;
    return [x,ground+mix(cross.weight,next.weight,t)*Math.max(0,crown-ground)+rise,z];
  }
  function strip(leftA,leftB,rightA,rightB,walk){
    const count=way.bridge?1:Math.max(1,Math.ceil(Math.max(Math.abs(rightA-leftA),Math.abs(rightB-leftB))/.85));
    for(let j=0;j<rows;j++){
      const t=j/rows,u=(j+1)/rows,low=walk?.12*mix(cross.weight,next.weight,t):0,high=walk?.12*mix(cross.weight,next.weight,u):0;
      for(let k=0;k<count;k++){
        const l=k/count,r=(k+1)/count;
        const al=mix(leftA,rightA,l),ar=mix(leftA,rightA,r),bl=mix(leftB,rightB,l),br=mix(leftB,rightB,r);
        const p=at(t,al,bl,low),q=at(u,al,bl,high),s=at(u,ar,br,high),v=at(t,ar,br,low);
        faces.push({points:[p,q,s,v],walk});
        (walk?walks:carriage).push([p,q,s],[p,s,v]);
      }
    }
  }
  for(const [i,side] of [-1,1].entries()){
    const sa=cross.sides[i],sb=next.sides[i],edge=side*half;
    const innerA=edge*(1-sa.walk/sa.span),innerB=edge*(1-sb.walk/sb.span);
    strip(0,0,edge,edge,false);
    if(Math.max(sa.walk,sb.walk)>.01) strip(innerA,innerB,edge,edge,true);
  }
  if(!way.bridge)for(const [i,side] of [-1,1].entries()){
    const offset=side*half;
    function bankRow(t){
      const center=at(t,0,0),edge=at(t,offset,offset);
      const ux=edge[0]-center[0],uz=edge[2]-center[2],span=Math.hypot(ux,uz);
      const curb=mix(cross.sides[i].walk,next.sides[i].walk,t)>.01 || way.kind==='path';
      edge[1]+=curb?.12*mix(cross.weight,next.weight,t):0;
      let toe,d=.26;
      do{
        const x=edge[0]+d*ux/span,z=edge[2]+d*uz/span;
        toe=[x,groundAt(x,z)-.008,z];
        if(edge[1]-toe[1]<.36*d || d>=19)break;
        d+=.5;
      }while(true);
      reach=Math.max(reach,span+d);
      return [edge,toe];
    }
    let row=bankRow(0);
    for(let j=1;j<=rows;j++){
      const nextRow=bankRow(j/rows),quad=[row[0],nextRow[0],nextRow[1],row[1]];
      skirts.push(quad);
      banks.push([quad[0],quad[1],quad[2]],[quad[0],quad[2],quad[3]]);
      row=nextRow;
    }
  }
  function layerAt(x,z){
    const road=facetHeight(carriage,x,z);
    if(road===undefined){
      const bank=facetHeight(banks,x,z);
      if(bank!==undefined && bank>=groundAt(x,z))return {y:bank,bank:true};
      return;
    }
    const walk=facetHeight(walks,x,z);
    return walk>road ? {y:walk,walk:true} : {y:road,walk:false};
  }
  return {at,faces,skirts,reach,layerAt};
}

function bridgeProfiles(ways,groundAt,pavement) {
  const tips=new Map(), ramps=new WeakMap(), decks=new WeakMap();
  const key=p=>p[0]+','+p[2];
  const unit=(a,b)=>{
    const dx=b[0]-a[0], dz=b[2]-a[2], len=Math.hypot(dx,dz)||1;
    return [dx/len,dz/len];
  };
  for(const way of ways){
    if(way.bridge) continue;
    way.points.forEach((point,i)=>{
      const k=key(point);
      if(!tips.has(k)) tips.set(k,[]);
      tips.get(k).push({way,i});
    });
  }
  for(const way of ways.filter(w=>w.bridge)){
    const sections=way.points.map((p,i)=>{
      const dir=unit(way.points[Math.max(0,i-1)],way.points[Math.min(way.points.length-1,i+1)]);
      const half=way.width/2;
      const sides=[-1,1].map(side=>{
        const walk=way.deckWalks?.find(w=>w.side===side);
        if(walk) return {span:walk.offsets[i]+walk.width/2,walk:walk.width};
        let span=half;
        if(way.kind==='road' && pavement?.(p[0],p[2])){
          let distance=0;
          while(distance<Math.max(12,half+3) && pavement(p[0]+dir[1]*side*distance,p[2]-dir[0]*side*distance)) distance+=.25;
          span=clamp(distance,half*.78,half+3);
        }
        return {span,walk:0};
      });
      return {sides,weight:1,y:p[1],lanes:way.lanes};
    });
    if(!way.covered && !way.level && !way.onDeck){
      const length=way.points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p[0]-way.points[i][0],p[2]-way.points[i][2]),0);
      const lift=[0,0];
      let along=0;
      for(let i=0;i<sections.length-1;i++){
        const a=way.points[i],b=way.points[i+1],dir=unit(a,b);
        const span=Math.hypot(b[0]-a[0],b[2]-a[2]),steps=Math.ceil(span);
        for(let j=0;j<=steps;j++){
          const t=j/steps,f=(along+span*t)/length;
          for(let k=-4;k<=4;k++){
            const side=k<0?0:1;
            const offset=k*.25*(sections[i].sides[side].span*(1-t)+sections[i+1].sides[side].span*t);
            const x=a[0]+(b[0]-a[0])*t+dir[1]*offset,z=a[2]+(b[2]-a[2])*t-dir[0]*offset;
            const clearance=groundAt(x,z)+.10-(a[1]+(b[1]-a[1])*t);
            const end=f<.5?0:1;
            lift[end]=Math.max(lift[end],clearance/(end?f:1-f));
          }
        }
        along+=span;
      }
      along=0;
      sections.forEach((section,i)=>{
        if(i) along+=Math.hypot(way.points[i][0]-way.points[i-1][0],way.points[i][2]-way.points[i-1][2]);
        section.y+=lift[0]+(lift[1]-lift[0])*along/length;
      });
    }
    decks.set(way,sections);
    if(way.covered || way.level || way.onDeck) continue;
    for(const i of [0,way.points.length-1]){
      const point=way.points[i], inward=unit(point,way.points[i===0?1:i-1]);
      const section=sections[i];
      for(const {way:approach,i:start} of tips.get(key(point))??[]){
        if(approach.kind!==way.kind || approach.level!==way.level) continue;
        for(const step of [-1,1]){
          const next=approach.points[start+step];
          if(!next) continue;
          const direction=unit(point,next);
          if(direction[0]*inward[0]+direction[1]*inward[1]>-.20) continue;
          const forwards=i===0?-1:1;
          const sign=forwards*step;
          const points=approach.points;
          const bisect=[direction[0]-inward[0],direction[1]-inward[1]];
          const len=Math.hypot(...bisect);
          const normal=[bisect[1]/len*forwards,-bisect[0]/len*forwards];
          section.normal=normal;
          const far=way.points[i===0?1:i-1];
          const grade=(section.y-sections[i===0?1:i-1].y)/Math.hypot(point[0]-far[0],point[2]-far[2]);
          const range=clamp(Math.abs(section.y-groundAt(point[0],point[2]))*18+12,18,55);
          let distance=0;
          if(!ramps.has(approach)) ramps.set(approach,new Map());
          const entries=ramps.get(approach);
          for(let j=start;j>=0 && j<points.length;j+=step){
            const [x,,z]=points[j];
            if(j!==start) distance+=Math.hypot(x-points[j-step][0],z-points[j-step][2]);
            const t=Math.min(1,distance/range), weight=1-t*t*(3-2*t);
            const sides=[-1,1].map((side,index)=>{
              const bridge=section.sides[sign>0?index:1-index];
              const forward=unit(points[Math.max(0,j-1)],points[Math.min(points.length-1,j+1)]);
              let groundWidth=approach.width/2;
              if(approach.kind==='road' && pavement?.(x,z)){
                let d=0;
                while(d<Math.max(12,groundWidth+4) && pavement(x+forward[1]*side*d,z-forward[0]*side*d)) d+=.25;
                groundWidth=clamp(d,.65*groundWidth,groundWidth+4);
              }
              return {span:groundWidth+(bridge.span-groundWidth)*weight,walk:bridge.walk*weight};
            });
            const old=entries.get(j);
            if(!old || old.weight<weight)
              entries.set(j,{weight,sides,lanes:way.lanes,deckY:section.y+grade*distance,normal:j===start?[normal[0]*sign,normal[1]*sign]:null});
            if(!weight) break;
          }
        }
      }
    }
  }
  return {
    section(way,i){return way.bridge?decks.get(way)[i]:ramps.get(way)?.get(i);},
    approach(way,i){const ramp=ramps.get(way);return ramp?.has(i)&&ramp.has(i+1) && (ramp.get(i).weight>0||ramp.get(i+1).weight>0);}
  };
}

export function createRoadNetwork(data,region,ground,pavement,landClass) {
  const groundAt = terrainSampler(region,ground)
  const roads = bins(), buildings = bins(), water = bins(), barriers = bins(), rails = bins()
  const areas = bins()
  for (const area of data.areas) addPolygon(areas,area.rings,-Infinity,Infinity,area)
  const bounds = data.campusBoundary?.bounds ?? data.bounds
  const withinCampus=data.insideCampus ?? (()=>true)
  const profiles = new WeakMap(), deckPanels=new WeakMap()
  const bridge=bridgeProfiles(data.ways,groundAt,pavement)
  function frames(way) {
    if (profiles.has(way)) return profiles.get(way)
    const points = way.points, half = way.width/2
    const normals = points.slice(1).map(([x,,z],i) => {
      const dx = x-points[i][0], dz = z-points[i][2], length = Math.hypot(dx,dz) || 1
      return [dz/length,-dx/length]
    })
    const result = points.map(([x,y,z],i) => {
      const a = normals[Math.max(0,i-1)], b = normals[Math.min(i,normals.length-1)]
      const divisor = Math.max(.5,1+a[0]*b[0]+a[1]*b[1])
      const section=bridge.section(way,i);
      const [nx,nz]=section?.normal??[(a[0]+b[0])/divisor,(a[1]+b[1])/divisor];
      const edgeHeight = side => Math.max(y-.15,groundAt(x+nx*half*side,z+nz*half*side)+.045)
      const left = edgeHeight(-1), right = edgeHeight(1)
      const frame=(offset,rise=0)=>{
        if(!section) return [x+offset*nx,y+Math.abs(offset)/half*((offset<0 ? left : right)-y)+rise,z+offset*nz];
        const side=section.sides[offset<0?0:1];
        const shift=offset*side.span/half,px=x+shift*nx,pz=z+shift*nz;
        const terrain=way.bridge ? 0 : groundAt(px,pz)+.035;
        const base=way.bridge ? section.y : terrain+section.weight*Math.max(0,section.deckY-terrain);
        return [px,base+rise,pz];
      };
      frame.sides=section?.sides;
      frame.weight=section?.weight;
      frame.lanes=section?.lanes;
      frame.deckY=way.bridge?section?.y:section?.deckY;
      return frame;
    })
    profiles.set(way,result)
    return result
  }
  const obstacles=groundObstacles(),fieldPaint=bins()
  function addField(points){
    addPolygon(fieldPaint,[points.flat()],-Infinity,Infinity)
  }
  const posts = bins()
  function addPost(x,z,y,radius,height,owner='post') {
    posts.add({x,z,y,radius,height,owner},x-radius-2,z-radius-2,x+radius+2,z+radius+2)
  }

  const enclosed=bins();
  for(const [low,high,rings] of region.buildingSolids?.enclosures??[])addPolygon(enclosed,rings,low,high,null,0);
  if(region.buildingSolids){
    for(const [low,high,rings] of region.buildingSolids)addPolygon(buildings,rings,low,high,null,12)
  }else{
  for (const [i,[ring,holes,low,height]] of region.blocks.entries()) {
    const building=data.buildingBases?.[i]
    for (const floor of building?.floors??[[ring,...holes]]) addPolygon(buildings,floor,low-3,low+height)
    for (const [soffit,rings] of building?.passages??[]) addPolygon(buildings,rings,soffit,Math.max(soffit+.23,low+height))
  }
  for (const {block,index} of region.southernHousing??[]) {
    if(index!==null) continue
    const [ring,holes,low,height]=block
    addPolygon(buildings,[ring,...holes],low-3,low+height)
  }
  for (const rings of data.coreBuildings) addPolygon(buildings,rings,-Infinity,Infinity)
  function addWall(ax,az,bx,bz,base,top,nx,nz,back,front) {
    addPolygon(buildings,[[ax-back*nx,az-back*nz,bx-back*nx,bz-back*nz,
      bx+front*nx,bz+front*nz,ax+front*nx,az+front*nz]],base,top)
  }
  for(const [name,base,faces] of region.coreFrontages??[]) {
    const relief=['universityBay','middlesexBay'].includes(name)?.4:.03
    for(const [ax,az,bx,bz,top,nx,nz] of faces)
      addWall(ax,az,bx,bz,Math.min(base-1,groundAt(ax,az),groundAt(bx,bz))-3,top,nx,nz,1.6,relief)
  }
  for(const tile of region.modeledFrontages??[]) {
    for(const [ax,az,bx,bz,base,top,nx,nz] of tile.panels) addWall(ax,az,bx,bz,base,top,nx,nz,.06,.34)
  }
  }
  for (const rings of data.water) addPolygon(water,rings,-Infinity,Infinity)
  for (const [type,points] of data.barriers) {
    if(points.length===2 && region.renderedBarrierNodes?.has(type+':'+points[0].toFixed(2)+':'+points[1].toFixed(2)))continue
    for (let i = 0; i < Math.max(2,points.length-2); i+=2) {
      const next = Math.min(i+2,points.length-2)
      const s = segment(points[i],points[i+1],points[next],points[next+1])
      s.radius = points.length===2 ? type==='block' ? .55 : .18 : .12
      bucketSegment(barriers,s,s.radius+2)
    }
  }
  for (const way of data.ways) {
    if(way.onDeck) continue
    const junctions = new Set(way.junctions), framesAlong = frames(way)
    const half = way.width/2
    for (let i = 0; i < way.points.length-1; i++) {
      const [x,y,z] = way.points[i], [x1,y1,z1] = way.points[i+1]
      const s = segment(x,z,x1,z1)
      if (s.length<.01) continue
      Object.assign(s,{y,dy:y1-y,half,way,tx:s.dx/s.length,tz:s.dz/s.length,
        junction: junctions.has(i) || junctions.has(i+1)})
      const cross = framesAlong[i], next = framesAlong[i+1]
      s.elevated=way.bridge || bridge.approach(way,i);
      if(s.elevated){
        const a=cross(0),b=next(0),l=cross(-half),r=cross(half),l1=next(-half),r1=next(half);
        s.y=a[1];s.dy=b[1]-a[1];
        const panel=deckPanel(way,cross,next,groundAt);
        if(!deckPanels.has(way)) deckPanels.set(way,new Map());
        deckPanels.get(way).set(i,panel);
        s.deckAt=panel.layerAt;
        s.span=Math.max(panel.reach,...[l,r].map(p=>Math.hypot(p[0]-a[0],p[2]-a[2])),...[l1,r1].map(p=>Math.hypot(p[0]-b[0],p[2]-b[2])));
        s.sides=cross.sides;s.endSides=next.sides;
      }
      s.left = cross(-half)[1]-y; s.right = cross(half)[1]-y
      s.leftChange = next(-half)[1]-y1-s.left; s.rightChange = next(half)[1]-y1-s.right
      s.curb = way.kind==='road' && !s.junction && !way.bridge && way.class!=='service' && way.class!=='living_street'
      bucketSegment(roads,s,(s.span??half)+.5)
      if (way.bridge) {
        for (const side of [-1,1]) {
          const a = cross(half*side), b = next(half*side)
          const rail = segment(a[0],a[2],b[0],b[2])
          Object.assign(rail,{y,dy:s.dy})
          bucketSegment(rails,rail,2.15)
        }
      }
    }
  }

  const kerbs=bins()
  const streetFinish=streetProfiles(data.pavementSurvey)
  const kerbWidths=[-.16,.005,.031,.055,.26]
  function addKerb(ax,az,bx,bz,inwardX,inwardZ,lo=1,hi=1,lift=0){
    const edge=segment(ax,az,bx,bz)
    edge.levels=new Float32Array(10)
    for(let i=0;i<kerbWidths.length;i++){
      const w=kerbWidths[i],x=inwardX*w,z=inwardZ*w
      edge.levels[2*i]=groundAt(ax+x,az+z)+kerbProfile(w,lo)+lift
      edge.levels[2*i+1]=groundAt(bx+x,bz+z)+kerbProfile(w,hi)+lift
    }
    edge.inwardX=inwardX
    edge.inwardZ=inwardZ
    bucketSegment(kerbs,edge,.27)
  }
  function kerbHeight(x,z){
    let level=-Infinity
    for(const edge of kerbs.at(x,z)){
      const t=((x-edge.x)*edge.dx+(z-edge.z)*edge.dz)/(edge.length*edge.length)
      if(t<0||t>1)continue
      const offset=(x-edge.x)*edge.inwardX+(z-edge.z)*edge.inwardZ
      if(offset<-.16||offset>.26)continue
      let i=0
      while(offset>kerbWidths[i+1])i++
      const v=(offset-kerbWidths[i])/(kerbWidths[i+1]-kerbWidths[i])
      const h=edge.levels,j=2*i
      const y=t>=v?h[j]*(1-t)+h[j+1]*(t-v)+h[j+3]*v:h[j]*(1-v)+h[j+3]*t+h[j+2]*(v-t)
      level=Math.max(level,y)
    }
    return level===-Infinity?0:Math.max(0,level-groundAt(x,z))
  }

  function locate(x,z,previousY) {
    let best, score = Infinity, bestT, bestR
    for (const s of roads.at(x,z)) {
      const t = fraction(s,x,z)
      const r = Math.sqrt(distSq(s,x,z,t))
      const edge = s.curb ? .20 : 0
      if (r>(s.span??s.half)+edge) continue
      let layer;
      if(s.elevated){
        layer=s.deckAt(x,z);
        if(!layer) continue;
      }
      const difference = Number.isFinite(previousY) ? Math.abs(previousY-s.y-t*s.dy) : 0
      if (s.way.bridge && difference>1.8 && Math.abs(groundAt(x,z)-previousY)+.4<difference) continue
      const rank = Math.max(0,difference-1.5)*4 + (r>s.half ? 2 : 0)
        + (s.way.kind==='road' ? 0 : s.way.kind==='steps' ? 1.3 : 1) + .5*r/(s.span??s.half) - (s.elevated?(layer.bank?1:2.5):0)
      const sameLevel=layer && best?.layer && Math.abs(layer.y-best.layer.y)<1.8;
      let preferred=rank<score;
      if(best && Boolean(layer)!==Boolean(best.layer))preferred=Boolean(layer);
      if(sameLevel && Math.abs(layer.y-best.layer.y)>.007)preferred=layer.y>best.layer.y;
      if (preferred) {
        best = {s,layer}; score = rank; bestT = t; bestR = r
      }
    }
    return best && {...best,t:bestT,r:bestR}
  }

  function crownClear(x,y,z,radius,depth=radius){
    return !buildings.at(x,z).some(p=>p.high>=y-depth && p.low<=y+depth && touchesPolygon(p,x,z,radius))
  }
  function plantable(x,z,radius=.12){
    radius=Math.max(.12,radius)
    if([3,5,12,13].includes(landClass?.(x,z)))return false
    if(pavement?.(x,z)||(landClass&&pavement?locate(x,z)?.s.elevated:locate(x,z)))return false
    for(const [dx,dz] of [[radius,0],[-radius,0],[0,radius],[0,-radius]]){
      if(pavement?.(x+dx,z+dz)||[3,5,12,13].includes(landClass?.(x+dx,z+dz)))return false
    }
    return ![water,buildings].some(index=>index.at(x,z).some(p=>touchesPolygon(p,x,z,radius)))
  }
  if(!region.renderedTreeContacts)for(const [x,,z,h] of region.trees){
    if(plantable(x,z,h*.019) && crownClear(x,groundAt(x,z)+h*.7,z,Math.min(8,h*.38),h*.31)) addPost(x,z,groundAt(x,z),h*.019,h*.58,'regional trunk')
  }

  function solidAt(x,z,y,r,height,vehicle=false,bodyY=y) {
    for (const p of posts.at(x,z)) {
      if (y+height>=p.y && y<=p.y+p.height && (x-p.x)**2+(z-p.z)**2<=(p.radius+r)**2) return p
    }
    if(vehicle && region.buildingSolids?.surfaceContact){
      for(const p of enclosed.at(x,z)){
        if(p.low>y+.16 || p.high<y+.035 || !touchesPolygon(p,x,z,1e-5))continue;
        if(p.high>=y+height || p.loops.some(loop=>loop.some(edge=>distSq(edge,x,z)<=r*r)))return true;
      }
      const terrain=groundAt(x,z);
      const parking=region.buildingSolids.parkingSurface?.(x,z,y,terrain);
      const wheel=Math.abs(terrain-y)<1.2?terrain:y;
      const low=parking?parking.y:Math.min(y,wheel),high=parking?parking.y:Math.max(y,wheel);
      if(region.buildingSolids.surfaceContact(x,z,low+.16,high+height-.04,r))return true;
    }else for (const p of buildings.at(x,z)) {
      if (y+height>=p.low && y<=p.high && touchesPolygon(p,x,z,r)) return p
    }
    return obstacles.contact(x,z,bodyY+(vehicle ? .16 : 0),r,vehicle ? 1.30 : height)??false
  }

  function solidNormal(x,z,y,r) {
    let normal,deepest=-Infinity
    function consider(dx,dz,distance,radius,side=1){
      const overlap=radius-distance
      if(overlap>=0 && overlap>deepest && distance>1e-6){
        deepest=overlap
        normal=[side*dx/distance,side*dz/distance]
      }
    }
    for(const p of buildings.at(x,z)){
      if(y+1.5<p.low || y>p.high || !touchesPolygon(p,x,z,r)) continue
      const side=touchesPolygon(p,x,z,0)?-1:1
      for(const loop of p.loops) for(const edge of loop){
        const t=fraction(edge,x,z),dx=x-edge.x-edge.dx*t,dz=z-edge.z-edge.dz*t
        consider(dx,dz,Math.hypot(dx,dz),r,side)
      }
    }
    for(const p of posts.at(x,z)){
      if(y+1.5<p.y || y>p.y+p.height) continue
      const dx=x-p.x,dz=z-p.z
      consider(dx,dz,Math.hypot(dx,dz),r+p.radius)
    }
    return normal
  }

  function vehicleSolid(x,z,y,r,hit){
    const support=hit?.layer?.y??(groundAt(x,z)+Math.max(kerbHeight(x,z),streetFinish.tableAt(x,z),streetFinish.islandAt(x,z) ? .105 : 0));
    const drop=y-support;
    const bodyY=drop>-.8 && drop<=.12?support:y;
    return solidAt(x,z,y,r,1.5,true,bodyY);
  }

  function obstructed(x,z,y,r,hit) {
    if (x-r<bounds[0] || z-r<bounds[1] || x+r>bounds[2] || z+r>bounds[3]) return 'boundary'
    if (!withinCampus(x,z) || (r>0 && (!withinCampus(x+r,z) || !withinCampus(x-r,z) || !withinCampus(x,z+r) || !withinCampus(x,z-r)))) return 'boundary'
    if (vehicleSolid(x,z,y,r,hit)) return 'solid'
    for (const s of barriers.at(x,z)) {
      if (distSq(s,x,z) <= (r+s.radius)**2 && Math.abs(groundAt(x,z)-y)<2.5) return 'barrier'
    }
    for (const s of rails.at(x,z)) {
      const t = fraction(s,x,z)
      if (Math.abs(y-s.y-s.dy*t)<2 && distSq(s,x,z,t) <= (r+.09)**2) return 'rail'
    }
    if (hit?.s.way.kind==='steps') return 'steps'
    if(landClass?.(x,z)===6 && !(hit?.s.elevated && Math.abs(y-hit.layer.y)<2.5)) return 'water'
    for (const p of water.at(x,z)) {
      if (!touchesPolygon(p,x,z,r)) continue
      if (hit?.s.elevated && Math.abs(y-hit.layer.y)<2.5) continue
      return 'water'
    }
    return false
  }

  function blockerKind(x,z,y,radius=0) {
    return obstructed(x,z,y,radius,locate(x,z,y))
  }

  function blocked(x,z,y,radius=0) {return Boolean(blockerKind(x,z,y,radius))}

  function sample(x,z,previousY) {
    const hit = locate(x,z,previousY)
    let material=hit?.s.way.material
    let y, grade, tangentX, tangentZ, lateral=0, halfWidth=0, surface='grass', curb=0, street=hit?.s.way.name ?? ''
    if (hit) {
      const {s,t,r} = hit
      tangentX = s.tx; tangentZ = s.tz
      lateral = (x-s.x)*s.tz-(z-s.z)*s.tx
      halfWidth = s.half
      surface = s.way.kind==='road' ? 'road' : 'path'
      grade = s.dy/s.length
      if (s.curb && r>s.half) curb = .10
      const cross = lateral<0 ? s.left+s.leftChange*t : s.right+s.rightChange*t
      y = s.y+s.dy*t+Math.min(1,Math.abs(lateral)/s.half)*cross+curb
      if(s.elevated){
        const side=lateral<0?0:1, first=s.sides[side], end=s.endSides[side];
        halfWidth=first.span+(end.span-first.span)*t;
        curb=hit.layer.walk?.12:0;
        y=hit.layer.y;
        if(curb||hit.layer.bank) surface='path';
      }
    } else {
      y = groundAt(x,z)
      for (const p of areas.at(x,z)) {
        if (!touchesPolygon(p,x,z,0)) continue
        material=p.area.material
        const driving = p.area.kind==='parking' || p.area.kind==='road'
        surface = driving && !['gravel','dirt','ground','compacted','unpaved','fine_gravel'].includes(p.area.material) ? 'road' : 'path'
        let edge = Infinity
        for (const ring of p.loops) {
          for (const s of ring) edge = Math.min(edge,distSq(s,x,z))
        }
        halfWidth = Math.sqrt(edge)
        street = p.area.name
        break
      }
      const dx = (groundAt(x+1,z)-groundAt(x-1,z))*.5
      const dz = (groundAt(x,z+1)-groundAt(x,z-1))*.5
      grade = Math.hypot(dx,dz)
      tangentX = grade>1e-6 ? dx/grade : 0
      tangentZ = grade>1e-6 ? dz/grade : 1
    }
    if(pavement && !hit?.s.elevated && !(hit?.s.way.level)) {
      const material=landClass?.(x,z)
      const edgeHeight=kerbHeight(x,z)
      const island=streetFinish.islandAt(x,z)
      const table=streetFinish.tableAt(x,z)
      curb=Math.max(edgeHeight,table,island ? .105 : 0)
      y=groundAt(x,z)+curb
      if(table>0||(edgeHeight>0&&edgeHeight<.03)||pavement(x,z)||material===5||material===12) surface='road'
      else if(edgeHeight||material===3||material===13||(!landClass&&hit?.s.way.kind==='path'))surface='path'
      else if(hit?.s.way.kind==='road'||landClass)surface='grass'
      if(island && !edgeHeight)surface=island===3?'path':'grass'
      if(surface!=='grass' && fieldPaint.at(x,z).some(p=>touchesPolygon(p,x,z,0)))surface='grass'
      const dx=(groundAt(x+.6,z)-groundAt(x-.6,z))/1.2
      const dz=(groundAt(x,z+.6)-groundAt(x,z-.6))/1.2
      if(hit) grade=dx*tangentX+dz*tangentZ
      else {
        grade=Math.hypot(dx,dz)
        tangentX=grade>1e-6?dx/grade:0
        tangentZ=grade>1e-6?dz/grade:1
      }
    }
    const parking=region.buildingSolids?.parkingSurface?.(x,z,previousY,y);
    if(parking){
      y=parking.y;grade=Math.hypot(parking.gx,parking.gz);
      tangentX=grade?parking.gx/grade:0;tangentZ=grade?parking.gz/grade:1;
      surface='road';street='Parking deck';curb=0;
    }
    return {x,y,z,grade,tangentX,tangentZ,lateral,halfWidth,surface,street,way:hit?.s.way,material,curb,blocked:Boolean(obstructed(x,z,y,0,hit))}
  }

  const circuits = data.circuits.map(({id,name,points,streets}) => {
    let distance = 0, previousY
    const samples = points.map(([x,z],i)=>{
      const before = points[i===0 ? points.length-2 : i-1]
      const after = points[i===points.length-1 ? 1 : i+1]
      if (i) distance += Math.hypot(x-before[0],z-before[1])
      const contact = sample(x,z,previousY)
      previousY = contact.y
      return {x,y:contact.y,z,heading:Math.atan2(after[0]-before[0],after[1]-before[1]),distance,halfWidth:contact.halfWidth}
    })
    return {id,name,samples,streets}
  })
  function chaseDistance(x,y,z,sin,cos,slope) {
    const reach=6.45
    function occluded(distance){
      const px=x-distance*sin, pz=z-distance*cos, py=y+1.8+distance*(1.05/reach-slope)
      return solidAt(px,pz,py-.24,.28,.48) || network.canopyInView?.(px,pz,py-.24,.28,.48) || py<groundAt(px,pz)+.3
    }
    for(let i=1;i<=12;i++){
      let hit=reach*i/12
      if(!occluded(hit)) continue
      let clear=reach*(i-1)/12
      for(let j=0;j<5;j++){
        const middle=(hit+clear)*.5
        if(occluded(middle)) hit=middle
        else clear=middle
      }
      return Math.max(0,clear-.04)
    }
    return reach
  }
  function solidSource(x,z,y,r){
    const p=vehicleSolid(x,z,y,r,locate(x,z,y));
    if(!p)return null;
    if(p===true)return {owner:'architecture',x,z,low:y,high:y+1.5};
    if(p.loops)return {owner:'architecture',bounds:[p.x0,p.z0,p.x1,p.z1],low:p.low,high:p.high};
    if(p.min)return {owner:p.owner,bounds:[p.min[0],p.min[2],p.max[0],p.max[2]],low:p.min[1],high:p.max[1]};
    return {owner:p.owner,x:p.x,z:p.z,low:p.y,high:p.y+p.height};
  }
  const network={nearOpening:streetFinish.nearOpening,kerbFactor:streetFinish.kerbFactor,solidSource,addShell:obstacles.addShell,addBranch:obstacles.addBranch,addBox:obstacles.addBox,addFace:obstacles.addFace,addField,groundAt,frames,addKerb,withinCampus,approach:bridge.approach,deckPanel:(way,i)=>deckPanels.get(way)?.get(i),isDeck:(x,z)=>roads.at(x,z).some(s=>s.elevated && s.deckAt(x,z)) || Boolean(region.buildingSolids?.parkingSurface?.covers(x,z)),addPost,plantable,crownClear,sample,blocked,blockerKind,solidAt,solidNormal,chaseDistance,circuits,bounds}
  return network
}
