function parkingFrame(part){
  const ring=part.rings[0];
  const edges=ring.map((a,i)=>{const b=ring[(i+1)%ring.length];return [b[0]-a[0],b[1]-a[1]];});
  const [dx,dz]=edges.sort((a,b)=>Math.hypot(...b)-Math.hypot(...a))[0];
  return Math.atan2(dz,dx);
}

function fitDeckStructure(part,heightAt){
  const angle=parkingFrame(part),c=Math.cos(angle),s=Math.sin(angle);
  const [ox,oz]=part.center;
  const local=([x,z])=>[(x-ox)*c+(z-oz)*s,-(x-ox)*s+(z-oz)*c];
  const loops=part.rings.map(r=>r.map(local));
  const inRing=(u,v,ring)=>{
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [x,z]=ring[i],[a,b]=ring[j];
      if((z>v)!==(b>v) && u<(a-x)*(v-z)/(b-z)+x)inside=!inside;
    }
    return inside;
  };
  const clear=(u,v)=>[[-.38,-.38],[.38,-.38],[-.38,.38],[.38,.38]].every(([x,z])=>inRing(u+x,v+z,loops[0]) && !loops.slice(1).some(r=>inRing(u+x,v+z,r)));
  const bounds=[0,1].map(k=>[Math.min(...loops[0].map(p=>p[k])),Math.max(...loops[0].map(p=>p[k]))]);
  const [width,depth]=bounds.map(([lo,hi])=>hi-lo);
  const nx=Math.max(1,Math.round(width/7.5)),nz=Math.max(1,Math.round(depth/7.8));
  const point=(u,v)=>[ox+u*c-v*s,oz+u*s+v*c];
  const posts=[],spans=[];
  for(let j=1;j<nz;j++)for(let i=1;i<nx;i++){
    const u=bounds[0][0]+i*width/nx,v=bounds[1][0]+j*depth/nz;
    if(!clear(u,v))continue;
    const [x,z]=point(u,v);
    posts.push([x,z,heightAt(x,z)]);
    if(i+1<nx && [.25,.5,.75,1].every(t=>clear(u+width/nx*t,v))){
      const [cx,cz]=point(u+width/nx*.5,v);
      spans.push([cx,cz,width/nx]);
    }
  }
  const apron=[],[vertices,index]=part.surface;
  const groundPoint=v=>[v[0],heightAt(v[0],v[2])+.014,v[2]];
  const length=(a,b)=>Math.hypot(b[0]-a[0],b[2]-a[2]);
  function pave(a,b,c){
    const sides=[length(a,b),length(b,c),length(c,a)];
    const edge=sides.indexOf(Math.max(...sides));
    if(sides[edge]<=3.25){apron.push([a,b,c]);return;}
    const v=[a,b,c],l=v[edge],r=v[(edge+1)%3],tip=v[(edge+2)%3];
    const m=groundPoint([(l[0]+r[0])/2,0,(l[2]+r[2])/2]);
    pave(l,m,tip);pave(m,r,tip);
  }
  for(let i=0;i<index.length;i+=3)pave(...index.slice(i,i+3).map(k=>groundPoint(vertices[k])));
  part.garageApron=apron;
  part.deckStructure={angle,posts,spans};
}

export function fitParkingDecks(building,heightAt){
  const decks=[];
  for(const p of building.parts){
    if(p.low!==0 || p.high>.30 || !/pad|pav|apron|landing|floor|platform|slab/i.test(p.name??''))continue;
    const [vertices,indices]=p.surface;
    p.paving=true;
    const graded=vertices.map(([x,,z])=>[x,heightAt(x,z)-building.ground,z]);
    p.surface=[graded,indices];
    for(let i=0;i<indices.length;i+=3)decks.push(indices.slice(i,i+3).map(k=>[graded[k][0],building.ground+p.high+graded[k][1],graded[k][2]]));
  }
  for(const terrace of building.spec.attachments??[]){
    if(terrace.type!=='terrace' || terrace.baseOffset || !terrace.path || !(terrace.height>0 && terrace.height<=.15))continue;
    terrace.paving=[];
    for(let i=1;i<terrace.path.length;i++){
      const [x,z]=terrace.path[i-1],[endX,endZ]=terrace.path[i];
      const dx=endX-x,dz=endZ-z,length=Math.hypot(dx,dz);
      if(length<.001){terrace.paving.push([]);continue;}
      const half=(terrace.width??2.2)/2,nx=dz/length*half,nz=-dx/length*half,n=Math.ceil(length/2.4);
      const row=[];
      for(let j=0;j<=n;j++){
        const centerX=x+dx*j/n,centerZ=z+dz*j/n;
        const section=[-1,1].map(sign=>{
          const px=centerX+sign*nx,pz=centerZ+sign*nz;
          return [px,heightAt(px,pz)+terrace.height,pz];
        });
        if(j){
          const prev=row[j-1];
          decks.push([prev[0],prev[1],section[1]],[prev[0],section[1],section[0]]);
        }
        row.push(section);
      }
      terrace.paving.push(row);
    }
  }
  const spec=building.spec;
  const garageEntrance=(spec.entrances??[]).some(e=>e.type==='garage');
  const officeAboveParking=garageEntrance && building.parts.some(p=>/recessed court deck/i.test(p.name));
  for(const p of building.parts){
    const open=p.facade?.openGroundFloor??(officeAboveParking && p.low===0 && p.floors>1 && /frontage/i.test(p.name));
    if(!open)continue;
    p.openSoffit=building.ground+Math.min(p.high-.16,p.facade?.groundFloor?.height??spec.walls.default.groundFloor?.height??p.high/p.floors);
    fitDeckStructure(p,heightAt);
    decks.push(...p.garageApron);
  }
  if(spec.style!=='parking-structure')return decks;
  const parts=building.parts.filter(p=>!/stair|lift|elevator|enclosed/i.test(p.name??''));
  for(const p of parts){
    const [vertices,indices]=p.surface;
    const joined=parts.filter(other=>other.floors===p.floors);
    const levels=Math.max(1,p.floors-1);
    const top=building.ground+Math.max(...joined.map(other=>other.high));
    const entranceGrade=Math.max(building.ground,...joined.flatMap(other=>other.grade?.flat()??[]),...building.entryGround);
    const first=Math.min(top-(levels-1)*2.30,Math.max(building.ground+(top-building.ground)/levels,entranceGrade+2.55));
    const floor=n=>n===0?building.ground:first+(top-first)*(n-1)/Math.max(1,levels-1);
    if(!p.officeTop && p.roof.form==='flat' && p.floors>=4){
      p.parkingAngle=parkingFrame(p);
      fitDeckStructure(p,heightAt);
      decks.push(...p.garageApron);
    }
    const ramp=/ramp/i.test(p.name??'') && p.roof.form==='shed';
    const rise=ramp?Math.max(...vertices.map(v=>v[1])):0;
    p.deckLevels=Array.from({length:levels},(_,n)=>vertices.map(([x,h,z])=>{
      if(!rise)return n===levels-1?building.ground+p.high+h:floor(n+1);
      if(n===levels-1)return building.ground+p.high+h;
      const t=h/rise;
      const toe=n===0?heightAt(x,z)-.045:floor(n);
      return toe+(floor(n+1)-toe)*t;
    }));
    p.deckEdges=p.rings.map(ring=>ring.map((a,i)=>{
      const c=ring[(i+1)%ring.length];
      return parts.some(other=>other!==p && other.rings.some(loop=>loop.some((v,j)=>{
        const w=loop[(j+1)%loop.length],dx=w[0]-v[0],dz=w[1]-v[1],len=Math.hypot(dx,dz);
        if(!len)return false;
        return [a,c].every(point=>{
          const t=((point[0]-v[0])*dx+(point[1]-v[1])*dz)/(len*len);
          return t>=-.002 && t<=1.002 && Math.abs((point[0]-v[0])*dz-(point[1]-v[1])*dx)<len*.06;
        });
      })));
    }));
    for(const layer of p.deckLevels)for(let i=0;i<indices.length;i+=3){
      decks.push(indices.slice(i,i+3).map(k=>[vertices[k][0],layer[k],vertices[k][2]]));
    }
  }
  return decks;
}

export function parkingSurfaceIndex(triangles){
  const cells=new Map();
  const key=(x,z)=>Math.floor(x/12)*65536+Math.floor(z/12);
  for(const [a,b,c] of triangles){
    const dx=b[0]-a[0],dz=b[2]-a[2],ex=c[0]-a[0],ez=c[2]-a[2],det=dx*ez-dz*ex;
    if(Math.abs(det)<1e-6)continue;
    const gx=((b[1]-a[1])*ez-(c[1]-a[1])*dz)/det,gz=(dx*(c[1]-a[1])-ex*(b[1]-a[1]))/det;
    const row={a,dx,dz,ex,ez,det,gx,gz};
    for(let j=Math.floor(Math.min(a[2],b[2],c[2])/12);j<=Math.floor(Math.max(a[2],b[2],c[2])/12);j++){
      for(let i=Math.floor(Math.min(a[0],b[0],c[0])/12);i<=Math.floor(Math.max(a[0],b[0],c[0])/12);i++){
        const k=i*65536+j;
        if(!cells.has(k))cells.set(k,[]);
        cells.get(k).push(row);
      }
    }
  }
  function surface(x,z,previous,ground,coverage=false){
    const spawn=!Number.isFinite(previous);
    let best;
    for(const {a,dx,dz,ex,ez,det,gx,gz} of cells.get(key(x,z))??[]){
      const u=x-a[0],v=z-a[2],s=(u*ez-v*ex)/det,t=(v*dx-u*dz)/det;
      if(s<0 || t<0 || s+t>1)continue;
      if(coverage)return true;
      const y=a[1]+gx*u+gz*v,delta=Math.abs(y-(spawn?ground:previous));
      if(y<ground-.05 || delta>(spawn?.14:Math.min(.38,Math.abs(ground-previous)+.14)) || best && best.delta<=delta)continue;
      best={y,delta,gx,gz};
    }
    return best;
  }
  surface.covers=(x,z)=>Boolean(surface(x,z,0,0,true));
  return surface;
}
