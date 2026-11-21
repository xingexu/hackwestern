function interval(axis, value) {
  let lo=0, hi=axis.length-1;
  while(hi-lo>1) {
    const mid=(lo+hi)>>1;
    if(value<axis[mid]) hi=mid;
    else lo=mid;
  }
  return lo;
}

function sampledAxis(source,coreEdge) {
  const values=[], starts=[];
  for(let i=0;i<source.length-1;i++) {
    starts.push(values.length);
    const a=source[i], b=source[i+1];
    const parts=Math.ceil((b-a)/(a>=0 && b<=coreEdge ? 2.01 : 4.01));
    for(let j=0;j<parts;j++) values.push(a+(b-a)*j/parts);
  }
  starts.push(values.length);
  values.push(source.at(-1));
  return {values,starts};
}

export function createLandscapeGrid(region,world,coreAt,relief,terrain,pavement) {
  const xAxis=sampledAxis(region.xs,world.width), zAxis=sampledAxis(region.zs,world.depth);
  const xs=xAxis.values, zs=zAxis.values, count=xs.length;
  const heights=new Float32Array(count*zs.length);
  const [left,top,right,bottom]=region.bounds;
  function regionalHeight(x,z) {
    const u=Math.max(0,Math.min(relief.width-1,(x-left)/(right-left)*relief.width-.5));
    const v=Math.max(0,Math.min(relief.height-1,(z-top)/(bottom-top)*relief.height-.5));
    const ix=Math.min(relief.width-2,Math.floor(u)), iz=Math.min(relief.height-2,Math.floor(v));
    const at=iz*relief.width+ix, dx=u-ix, dz=v-iz;
    return ((terrain[at]*(1-dx)+terrain[at+1]*dx)*(1-dz)+(terrain[at+relief.width]*(1-dx)+terrain[at+relief.width+1]*dx)*dz)/relief.scale;
  }
  for(let iz=0;iz<zs.length;iz++) for(let ix=0;ix<count;ix++) {
    const x=xs[ix], z=zs[iz], coarse=regionalHeight(x,z);
    const border=Math.min(x,z,world.width-x,world.depth-z);
    let y=coarse;
    if(border>0) {
      const amount=Math.min(1,border/24), smooth=amount*amount*(3-2*amount);
      const coverage=pavement ? [pavement(x,z),pavement(x-2,z),pavement(x+2,z),pavement(x,z-2),pavement(x,z+2)].reduce((sum,paved)=>sum+Number(paved),0)/5 : 0;
      y+=(coreAt(x,z)-coarse)*smooth*(1-coverage);
    }
    heights[iz*count+ix]=y;
  }
  function heightAt(x,z) {
    const ix=interval(xs,x), iz=interval(zs,z), at=iz*count+ix;
    const u=Math.max(0,Math.min(1,(x-xs[ix])/(xs[ix+1]-xs[ix])));
    const v=Math.max(0,Math.min(1,(z-zs[iz])/(zs[iz+1]-zs[iz])));
    return u+v<=1 ? heights[at]*(1-u-v)+heights[at+1]*u+heights[at+count]*v :
      heights[at+count+1]*(u+v-1)+heights[at+count]*(1-u)+heights[at+1]*(1-v);
  }
  function projectPolygon(points,emit){
    const firstX=interval(xs,Math.min(...points.map(p=>p[0]))),lastX=interval(xs,Math.max(...points.map(p=>p[0])));
    const firstZ=interval(zs,Math.min(...points.map(p=>p[1]))),lastZ=interval(zs,Math.max(...points.map(p=>p[1])));
    function clip(poly,distance){
      const out=[];
      for(let i=0;i<poly.length;i++){
        const a=poly[i],b=poly[(i+1)%poly.length],da=distance(a),db=distance(b);
        if(da>=0)out.push(a);
        if((da<0)===(db<0))continue;
        const t=da/(da-db);
        out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);
      }
      return out;
    }
    for(let i=firstX;i<=lastX;i++){
      const column=clip(clip(points,p=>p[0]-xs[i]),p=>xs[i+1]-p[0]);
      for(let j=firstZ;j<=lastZ;j++){
        const cell=clip(clip(column,p=>p[1]-zs[j]),p=>zs[j+1]-p[1]);
        if(cell.length<3)continue;
        const diagonal=p=>(p[0]-xs[i])/(xs[i+1]-xs[i])+(p[1]-zs[j])/(zs[j+1]-zs[j])-1;
        for(const face of [clip(cell,diagonal),clip(cell,p=>-diagonal(p))]){
          for(let k=2;k<face.length;k++){
            for(const [x,z] of [face[0],face[k-1],face[k]])emit(x,heightAt(x,z),z);
          }
        }
      }
    }
  }
  return {xs,zs,heights,startsX:xAxis.starts,startsZ:zAxis.starts,heightAt,projectPolygon};
}

export function surveyImageURL(source) {
  return /^(?:https?:|data:|blob:|\/|\.\.?\/)/.test(source) ? source : 'data:image/webp;base64,'+source;
}

export function landcoverAt(meta,classes,bounds) {
  const [left,top,right,bottom]=bounds;
  const sx=meta.width/(right-left), sz=meta.height/(bottom-top);
  return (x,z)=>{
    const col=Math.floor((x-left)*sx), row=Math.floor((z-top)*sz);
    return col<0||row<0||col>=meta.width||row>=meta.height ? 0 : classes[row*meta.width+col];
  };
}

export function packLandClasses(classes,transitions){
  for(let i=0;i<classes.length;i++){
    const first=transitions[i*4]&15;
    transitions[i*4]=((classes[i]&15)<<4)|first;
  }
  return transitions;
}

export function surfaceOwnership(meta,classes,transitions){
  const {width,height,bounds:[left,top,right,bottom]}=meta;
  const sx=width/(right-left),sz=height/(bottom-top);
  return (x,z)=>{
    const u=(x-left)*sx-.5,v=(z-top)*sz-.5;
    if(u<-.5||v<-.5||u>=width-.5||v>=height-.5)return 0;
    const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j;
    const l=Math.max(0,i),r=Math.min(width-1,i+1),t=Math.max(0,j)*width,d=Math.min(height-1,j+1)*width;
    const nearest=classes[(b<.5?t:d)+(a<.5?l:r)];
    if(nearest===6)return 6;
    const p=t+l,q=t+r,s=d+l,w=d+r;
    const parking=(transitions[4*p+3]*(1-a)+transitions[4*q+3]*a)*(1-b)+(transitions[4*s+3]*(1-a)+transitions[4*w+3]*a)*b;
    if(parking>=127.5)return 5;
    if(classes[p]===classes[q]&&classes[p]===classes[s]&&classes[p]===classes[w])return nearest===5?0:nearest;
    const blend=id=>((classes[p]===id)*(1-a)+(classes[q]===id)*a)*(1-b)+((classes[s]===id)*(1-a)+(classes[w]===id)*a)*b;
    if(blend(6)>=.5)return 6;
    if(blend(3)>=.5)return 3;
    return nearest===3||nearest===5?0:nearest;
  };
}

export function createVergeDetail(THREE,landscape,cover) {
  const group=new THREE.Group(), resident=new Map(), size=22;
  group.name='Surveyed grass verges and riverbank sedges';
  const positions=[], colors=[], normals=[];
  for(let k=0;k<7;k++) {
    const a=k*2.4, length=.075+.064*(1+Math.sin(k*3.7)), lean=.025+.048*(k%3);
    const x=Math.sin(a)*k*.012, z=Math.cos(a)*k*.012;
    const dx=Math.sin(a)*lean,dz=Math.cos(a)*lean;
    const width=.016+(k%3)*.004, wx=Math.cos(a)*width,wz=-Math.sin(a)*width;
    positions.push(x-wx,0,z-wz,x+wx,0,z+wz,x+dx+wx*.43,length*.63,z+dz+wz*.43,
      x-wx,0,z-wz,x+dx+wx*.43,length*.63,z+dz+wz*.43,x+dx*1.43,length,z+dz*1.43);
    for(const shade of [.62,.69,.92,.62,.92,1.12]) {
      colors.push(shade,shade,shade*.92);
      normals.push(0,1,0);
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  const material=new THREE.MeshStandardMaterial({vertexColors:true,side:THREE.DoubleSide});
  const transform=new THREE.Object3D(), color=new THREE.Color(), dark=new THREE.Color(0x749151),light=new THREE.Color(0x99aa68);
  const reed=new THREE.Color(0x8b9c68);
  function tile(col,row) {
    let seed=Math.imul(col+181,105943)^Math.imul(row-325,135721);
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    const tufts=[];
    for(let j=0;j<19;j++) for(let i=0;i<19;i++) {
      const x=(col+(i+random())/19)*size,z=(row+(j+random())/19)*size;
      if(landscape.canGrowGrass&&!landscape.canGrowGrass(x,z))continue;
      const kind=cover(x,z);
      if(kind!==2 && kind!==3) continue;
      const sparse=.39+.24*Math.sin(x*.57+Math.sin(z*.43))+.24*Math.cos(z*.53+x*.11);
      if(random()>sparse && kind!==3) continue;
      tufts.push([x,landscape.heightAt(x,z)-.017,z,kind,random(),random(),random()]);
    }
    if(!tufts.length) return null;
    const mesh=new THREE.InstancedMesh(geometry,material,tufts.length);
    tufts.forEach(([x,y,z,kind,yaw,height,tint],i)=>{
      const wet=kind===3, scale=(wet?1.7:.65)+height*(wet?1.9:.83);
      transform.position.set(x,y,z);
      transform.rotation.set(0,yaw*Math.PI*2,0);
      transform.scale.set(scale*(wet ? .85 : 1.26),scale,scale);
      transform.updateMatrix();
      mesh.setMatrixAt(i,transform.matrix);
      color.copy(dark).lerp(wet?reed:light,tint);
      mesh.setColorAt(i,color);
    });
    mesh.receiveShadow=true;
    mesh.computeBoundingSphere();
    return mesh;
  }
  let priorCol,priorRow,priorRange;
  function update(x,z,distance) {
    const col=Math.floor(x/size),row=Math.floor(z/size),radius=distance>230?0:2;
    if(col===priorCol&&row===priorRow&&radius===priorRange) return;
    priorCol=col;priorRow=row;priorRange=radius;
    const wanted=new Set();
    if(radius) for(let i=-radius;i<=radius;i++) for(let j=-radius;j<=radius;j++) {
      const key=(col+i)+','+(row+j);
      wanted.add(key);
      if(resident.has(key)) continue;
      const mesh=tile(col+i,row+j);
      if(mesh) group.add(mesh);
      resident.set(key,mesh);
    }
    for(const [key,mesh] of resident) if(!wanted.has(key)) {
      if(mesh) {group.remove(mesh);mesh.dispose();}
      resident.delete(key);
    }
  }
  return {group,update};
}

export function createCarriageway(THREE,meta,pixels,bounds) {
  if(meta.format!=='coverage8'||pixels.length!==meta.width*meta.height) throw new Error('Carriageway coverage is incomplete.');
  const [left,top,right,bottom]=bounds;
  const sx=meta.width/(right-left),sz=meta.height/(bottom-top);
  function contains(x,z) {
    const u=(x-left)*sx-.5,v=(z-top)*sz-.5;
    if(u<-.5||v<-.5||u>=meta.width-.5||v>=meta.height-.5)return false;
    const ix=Math.floor(u),iz=Math.floor(v),dx=u-ix,dz=v-iz;
    const x0=Math.max(0,ix),x1=Math.min(meta.width-1,ix+1);
    const topRow=Math.max(0,iz)*meta.width,bottomRow=Math.min(meta.height-1,iz+1)*meta.width;
    return (pixels[topRow+x0]*(1-dx)+pixels[topRow+x1]*dx)*(1-dz)+(pixels[bottomRow+x0]*(1-dx)+pixels[bottomRow+x1]*dx)*dz>=127.5;
  }
  const texture=new THREE.DataTexture(pixels,meta.width,meta.height,THREE.RedFormat);
  texture.magFilter=texture.minFilter=THREE.LinearFilter;
  texture.needsUpdate=true;
  return {texture,contains,curbs:meta.curbs,bounds};
}

export function walkwaySampler(tiles){
  const bins=new Map();
  for(const {bounds:[left,top,right,bottom],width,height,spans,format} of tiles){
    const offsets=new Uint32Array(height+1);
    offsets[0]=height;
    for(let row=0;row<height;row++)offsets[row+1]=offsets[row]+spans[row];
    const tile={left,top,right,bottom,width,height,spans,offsets,stride:format===2?3:2};
    for(let i=Math.floor(left/128);i<=Math.floor(right/128);i++){
      for(let j=Math.floor(top/128);j<=Math.floor(bottom/128);j++){
        const k=i+','+j;
        if(!bins.has(k))bins.set(k,[]);
        bins.get(k).push(tile);
      }
    }
  }
  function texel(t,x,z){
    const col=Math.max(0,Math.min(t.width-1,x)),row=Math.max(0,Math.min(t.height-1,z));
    const base=t.offsets[row],stride=t.stride;
    let lo=0,hi=(t.offsets[row+1]-base)/stride;
    while(lo<hi){
      const mid=(lo+hi)>>>1,i=base+mid*stride;
      if(col<t.spans[i])hi=mid;
      else if(col>=t.spans[i+1])lo=mid+1;
      else return stride===3?t.spans[i+2]:255;
    }
    return 0;
  }
  return (x,z)=>{
    for(const t of bins.get(Math.floor(x/128)+','+Math.floor(z/128))??[]){
      if(x<t.left||x>=t.right||z<t.top||z>=t.bottom)continue;
      const u=(x-t.left)*t.width/(t.right-t.left)-.5,v=(z-t.top)*t.height/(t.bottom-t.top)-.5;
      const i=Math.floor(u),j=Math.floor(v),dx=u-i,dz=v-j;
      return (texel(t,i,j)*(1-dx)+texel(t,i+1,j)*dx)*(1-dz)+(texel(t,i,j+1)*(1-dx)+texel(t,i+1,j+1)*dx)*dz>127.5;
    }
    return false;
  };
}

export function conformPlantings(region,core,municipal,survey,network){
  const {groundAt,plantable}=network;
  region.trees=region.trees.filter(([x,,z,h])=>plantable(x,z,h*.019)).map(([x,,z,...rest])=>[x,groundAt(x,z),z,...rest]);
  core.trees=core.trees.filter(([x,,z,r])=>plantable(x,z,.12+r*.044)).map(([x,y,z,r,center,...rest])=>{
    const ground=groundAt(x,z);
    return [x,ground,z,r,ground+center-y,...rest];
  });
  for(const tile of Object.values(municipal.tiles)){
    if(tile.trees) tile.trees=tile.trees.filter(([x,z,,,r])=>plantable(x,z,r));
    if(tile.shrubs)tile.shrubs=tile.shrubs.filter(([x,z])=>plantable(x,z));
  }
  for(const tile of Object.values(survey.tiles)){
    if(tile.stems) tile.stems=tile.stems.filter(([x,z,h])=>plantable(x,z,Math.min(.39,.014*h+.07)));
  }
}

function groundGrain(THREE){
  const size=256,bytes=new Uint8Array(size*size*4);
  let state=47629;
  const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
  for(let i=0;i<bytes.length;i+=4){
    bytes[i]=78+random()*42;
    const quartz=random();
    bytes[i+1]=quartz>.95?210+random()*42:65+random()*95;
    bytes[i+2]=65+random()*127;
    bytes[i+3]=0;
  }
  for(let i=0;i<9000;i++){
    const x=random()*size,z=random()*size,angle=random()*6.283;
    const dx=Math.cos(angle),dz=Math.sin(angle),length=2+5*random(),tone=92+random()*130;
    for(let k=0;k<length;k+=.6){
      const index=4*(((Math.floor(z+dz*k)+size)%size)*size+(Math.floor(x+dx*k)+size)%size);
      bytes[index]=tone*(.78+.22*k/length);
    }
  }
  function seal(x,z,angle,steps){
    for(let j=0;j<steps;j++){
      angle+=(random()-.5)*.52;
      const run=2+random()*7,dx=Math.cos(angle),dz=Math.sin(angle);
      for(let t=0;t<run;t+=.45){
        const px=x+t*dx,pz=z+t*dz;
        for(let v=Math.floor(pz)-1;v<=Math.floor(pz)+1;v++)for(let u=Math.floor(px)-1;u<=Math.floor(px)+1;u++){
          const k=4*(((v%size+size)%size)*size+(u%size+size)%size)+3;
          bytes[k]=Math.max(bytes[k],220*Math.max(0,1-Math.hypot(u-px,v-pz)));
        }
      }
      x+=dx*run;z+=dz*run;
      if(steps>6 && j===Math.floor(steps*.6))seal(x,z,angle+1.17,4);
    }
  }
  for(let i=0;i<5;i++)seal(random()*size,random()*size,random()*6.28,9+Math.floor(random()*18));
  const tex=new THREE.DataTexture(bytes,size,size);
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
  tex.generateMipmaps=true;
  tex.magFilter=THREE.LinearFilter;
  tex.minFilter=THREE.LinearMipmapLinearFilter;
  tex.anisotropy=4;
  tex.needsUpdate=true;
  return tex;
}

export function bindGroundEdge(shader,landscape){
  shader.uniforms.fringe={value:landscape.fringe??null};
  shader.uniforms.fringeBounds={value:landscape.fringeBounds??{x:0,y:0,z:1,w:1}};
}

export const groundDetailGLSL=`
  uniform sampler2D groundGrain,fringe;
  uniform vec4 fringeBounds;
  vec3 groundParticle(vec2 p){
    vec2 rotated=mat2(.6,-.8,.8,.6)*p;
    return texture2D(groundGrain,p*.71+sin(rotated*.61)*.17).rgb*.65
      +texture2D(groundGrain,rotated*.36+sin(p*.45)*.12).rgb*.35-.46;
  }
  vec3 forestFloor(vec2 p,vec3 particle){
    vec2 leaf=p*.082;
    float tone=.5+.17*sin(leaf.x+.63*leaf.y+sin(leaf.y*.51))+.33*particle.b;
    return mix(vec3(.052,.059,.032),vec3(.128,.099,.054),tone)*(1.+.57*particle.b);
  }
  vec3 groundEdge(vec3 land,vec3 lawn,vec3 litter,vec2 p,float weight){
    vec2 transition=texture2D(fringe,(p-fringeBounds.xy)/(fringeBounds.zw-fringeBounds.xy)).rg;
    return mix(land,mix(lawn,litter,transition.y),transition.x*weight);
  }
  vec3 summerLawn(vec2 p,float moisture,float blade){
    vec2 swale=p*.039+vec2(sin(p.y*.023),cos(p.x*.027));
    float moisturePatch=sin(swale.x+swale.y*1.3)*.17+sin(swale.y*1.6-swale.x*.51)*.11;
    float dry=clamp(.63-moisture*.43+moisturePatch,0.,1.);
    float cut=.5+.5*cos(dot(p,vec2(.339,.233))+.48*sin(dot(p,vec2(.034,-.026))));
    float footprint=length(fwidth(p));
    float clump=.5+(.28*sin(p.x*1.8+sin(p.y*2.24))+.22*sin(dot(p,vec2(4.2,-2.11))))*(1.-smoothstep(.12,.8,footprint));
    vec3 turf=mix(vec3(.050,.111,.032),vec3(.167,.148,.062),dry);
    return turf*(.897+.103*cut+.085*clump+blade*1.04);
  }`;

export function installEstateSurfaces(THREE,landscape,carriageway,meta,pixels){
  const [left,top,right,bottom]=meta.bounds,width=meta.width,height=meta.height;
  function classAt(x,z){
    const u=(x-left)*width/(right-left)-.5,v=(z-top)*height/(bottom-top)-.5;
    if(u<-.5||v<-.5||u>=width-.5||v>=height-.5)return 255;
    const i=Math.floor(u),j=Math.floor(v),dx=u-i,dz=v-j;
    const a=Math.max(0,i),b=Math.min(width-1,i+1),c=Math.max(0,j)*width,d=Math.min(height-1,j+1)*width;
    const weight=k=>(pixels[(c+a)*3+k]*(1-dx)+pixels[(c+b)*3+k]*dx)*(1-dz)+(pixels[(d+a)*3+k]*(1-dx)+pixels[(d+b)*3+k]*dx)*dz;
    return weight(2)>=127.5?13:weight(1)>=127.5?12:weight(0)>=127.5?2:0;
  }
  const original=carriageway.contains;
  carriageway.contains=(x,z)=>{
    if(z<=top) return original(x,z);
    const kind=classAt(x,z);
    return kind===12 || kind===5;
  };
  landscape.estatesAt=classAt;
  const rgba=new Uint8Array(width*height*4);
  for(let i=0;i<width*height;i++){
    rgba[4*i]=pixels[3*i];rgba[4*i+1]=pixels[3*i+1];rgba[4*i+2]=pixels[3*i+2];rgba[4*i+3]=255;
  }
  const map=new THREE.DataTexture(rgba,width,height);
  map.minFilter=THREE.LinearMipmapLinearFilter;map.magFilter=THREE.LinearFilter;
  map.generateMipmaps=true;map.needsUpdate=true;
  const material=new THREE.MeshStandardMaterial();
  material.customProgramCacheKey=()=>'estates-ground-classes';
  material.onBeforeCompile=shader=>{
    shader.uniforms.groundGrain={value:landscape.groundGrain};
    bindGroundEdge(shader,landscape);
    shader.uniforms.parcelClasses={value:map};
    shader.uniforms.surveyColour={value:landscape.grassVigor};
    shader.uniforms.regionalBounds={value:new THREE.Vector4(...landscape.regionBounds)};
    shader.uniforms.parcelBounds={value:new THREE.Vector4(...meta.bounds)};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 parcelPoint;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nparcelPoint=position.xz;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
      ${groundDetailGLSL}
      varying vec2 parcelPoint; uniform vec4 parcelBounds,regionalBounds; uniform sampler2D parcelClasses,surveyColour;`)
      .replace('#include <color_fragment>',`#include <color_fragment>
        vec2 coord=(parcelPoint-parcelBounds.xy)/(parcelBounds.zw-parcelBounds.xy);
        vec3 weight=texture2D(parcelClasses,coord).rgb;
        vec2 stepUV=1.1/(parcelBounds.zw-parcelBounds.xy);
        vec2 low=vec2(stepUV.x,0.),high=vec2(0.,stepUV.y);
        weight.b=.42*weight.b+.145*(texture2D(parcelClasses,coord+low).b+texture2D(parcelClasses,coord-low).b+
                                     texture2D(parcelClasses,coord+high).b+texture2D(parcelClasses,coord-high).b);
        vec3 aa=clamp(fwidth(weight),.012,.44);
        vec3 labels=smoothstep(.5-aa,.5+aa,weight);
        float variation=sin(parcelPoint.x*.071+parcelPoint.y*.09)*cos(parcelPoint.y*.052);
        vec3 particle=groundParticle(parcelPoint);
        vec2 regionalUV=(parcelPoint-regionalBounds.xy)/(regionalBounds.zw-regionalBounds.xy);
        vec3 land=summerLawn(parcelPoint,texture2D(surveyColour,regionalUV).r,particle.r);
        vec3 lawn=land,litter=forestFloor(parcelPoint,particle);
        land=mix(land,litter,smoothstep(.025,.975,textureLod(parcelClasses,coord,2.25).r));
        land=groundEdge(land,lawn,litter,parcelPoint,1.);
        float asphalt=labels.g;
        land=mix(land,vec3(.061,.062,.061)*(1.+particle.g*.63),asphalt);
        land=mix(land,vec3(.286,.270,.240)*(1.+particle.b*.37),labels.b);
        float grit=particle.g;
        diffuseColor.rgb*=land*(1.+variation*.025+grit*.12*(1.-smoothstep(.05,.27,length(fwidth(parcelPoint)))));`);
  };
  landscape.groundGrain=groundGrain(THREE);
  landscape.estatesMaterial=material;
  return function extendWays(ways){
    const original=new Map(ways.map(w=>[w.id,w]));
    for(const f of meta.ways){
      const source=original.get(f.id);
      const points=f.points.map(([x,z])=>[x,landscape.heightAt(x,z)+.08,z]);
      ways.push({...source,id:f.id,name:f.name,kind:f.kind,class:source?.class??(f.kind==='road'?'service':'footway'),width:f.width,
        material:f.material,lanes:source?.lanes??1,level:0,bridge:false,oneway:source?.oneway??false,covered:false,junctions:[],points});
    }
  };
}
