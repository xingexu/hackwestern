function cell(axis,value){
  let lo=0,hi=axis.length-1;
  while(hi-lo>1){
    const mid=(lo+hi)>>1;
    if(axis[mid]<=value)lo=mid;else hi=mid;
  }
  return lo;
}

function crossings(axis,start,end,times){
  if(start===end)return;
  const lower=Math.min(start,end),upper=Math.max(start,end);
  for(let i=cell(axis,lower)+1;i<axis.length && axis[i]<upper;i++){
    times.push((axis[i]-start)/(end-start));
  }
}

export function estateBoundary(vertices,indices,elevation){
  const edges=new Map();
  for(let i=0;i<indices.length;i+=3)for(let k=0;k<3;k++){
    const a=indices[i+k],b=indices[i+(k+1)%3],key=Math.min(a,b)*vertices.length+Math.max(a,b);
    if(edges.has(key))edges.delete(key);else edges.set(key,[a,b]);
  }
  const rim=[...edges.values()].map(pair=>pair.map(i=>{
    const v=vertices[i];return [v[0],elevation(...v),v[2]];
  }));
  return {
    height(x,z){
      let nearest=.10**2,height;
      for(const [[ax,ay,az],[bx,by,bz]] of rim){
        const dx=bx-ax,dz=bz-az,t=Math.min(1,Math.max(0,((x-ax)*dx+(z-az)*dz)/(dx*dx+dz*dz)));
        const distance=(x-ax-t*dx)**2+(z-az-t*dz)**2;
        if(distance<nearest){nearest=distance;height=ay+t*(by-ay);}
      }
      return height;
    },
    crossings(x,z,dx,dz){
      const square=dx*dx+dz*dz,times=[];
      for(const segment of rim)for(const [ax,,az] of segment){
        const t=((ax-x)*dx+(az-z)*dz)/square;
        if(t>1e-5 && t<.99999 && (ax-x-t*dx)**2+(az-z-t*dz)**2<.0025)times.push(t);
      }
      return [...new Set(times)].sort((a,b)=>a-b);
    }
  };
}

export function joinTerrainEdges(positions,indices,source,landscape){
  const {xs,zs,heightAt,estateBoundary}=landscape,n=positions.length/3;
  const outer=new Set(),key=(a,b)=>Math.min(a,b)*n+Math.max(a,b);
  for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){
    const a=indices[i+j],b=indices[i+(j+1)%3];
    if(source[4*a+3]>.0002 || source[4*b+3]>.0002)continue;
    const edge=key(a,b);
    if(outer.has(edge))outer.delete(edge);else outer.add(edge);
  }
  const extra=[],faces=[];
  for(let i=0;i<indices.length;i+=3){
    const ring=[];
    for(let j=0;j<3;j++){
      const a=indices[i+j],b=indices[i+(j+1)%3];ring.push(a);
      if(!outer.has(key(a,b)))continue;
      const x=positions[3*a],z=positions[3*a+2],dx=positions[3*b]-x,dz=positions[3*b+2]-z;
      const estate=z+dz*.5>zs.at(-1);
      if(z+dz*.5<zs[0] || (estate && !estateBoundary) || x+dx*.5<xs[0] || x+dx*.5>xs.at(-1))continue;
      const times=[0,1];
      crossings(xs,x,x+dx,times);crossings(zs,z,z+dz,times);times.sort((a,b)=>a-b);
      const cuts=estate?estateBoundary.crossings(x,z,dx,dz):[];
      for(let k=1;!estate && k<times.length;k++){
        const start=times[k-1],end=times[k],mid=(start+end)*.5;
        const u=cell(xs,x+dx*mid),v=cell(zs,z+dz*mid),w=xs[u+1]-xs[u],h=zs[v+1]-zs[v];
        const diagonal=(1-(x-xs[u])/w-(z-zs[v])/h)/(dx/w+dz/h);
        if(diagonal>start+.00001 && diagonal<end-.00001)cuts.push(diagonal);
        if(end<.99999 && end>start+.00001)cuts.push(end);
      }
      const outline=[a];
      for(const t of cuts){
        const px=x+t*dx,pz=z+t*dz;ring.push(n+extra.length/3);
        outline.push(n+extra.length/3);extra.push(px,(estate?estateBoundary.height(px,pz):undefined)??heightAt(px,pz),pz);
      }
      outline.push(b);
      const distance=Math.hypot(dx,dz);
      if(distance<.001)continue;
      const under=outline.map(vertex=>{
        const array=vertex<n?positions:extra,offset=3*(vertex<n?vertex:vertex-n);
        const px=array[offset]-.32*dz/distance,pz=array[offset+2]+.32*dx/distance;
        const index=n+extra.length/3;
        extra.push(px,heightAt(px,pz)-.055,pz);
        return index;
      });
      for(let k=1;k<outline.length;k++)faces.push(outline[k-1],under[k-1],outline[k],outline[k],under[k-1],under[k]);
    }
    if(ring.length===3){faces.push(...ring);continue;}
    const center=n+extra.length/3;
    for(let axis=0;axis<3;axis++)extra.push((positions[3*indices[i]+axis]+positions[3*indices[i+1]+axis]+positions[3*indices[i+2]+axis])/3);
    for(let j=0;j<ring.length;j++)faces.push(ring[j],ring[(j+1)%ring.length],center);
  }
  const vertices=new Float32Array(positions.length+extra.length);
  vertices.set(positions);vertices.set(extra,positions.length);
  return {vertices,faces:new Uint32Array(faces)};
}
