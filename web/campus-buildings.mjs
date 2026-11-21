import * as THREE from 'three';
import {buildArchitecture} from 'building-kernel';
import {fitParkingDecks,parkingSurfaceIndex} from 'parking-decks';
import {createBuildingContacts} from 'building-contacts';
import {surveyMaterial,glazingShadow,pressureCapProfile} from 'building-materials';

export function retireSurveyedArchitecture(features,records){
  const ids=new Set(records.map(b=>b.id));
  features.landmarks=[];
  features.macro=features.macro.filter(([kind,id])=>kind!=='lidar' && !(kind==='grandstand' && ids.has('w'+id)));
  const contains=(ring,x,z)=>{
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const a=ring[j],c=ring[i],dx=c[0]-a[0],dz=c[1]-a[1];
      const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));
      if(Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz)<.09)return true;
      if((a[1]>z)!==(c[1]>z) && x<(a[0]-c[0])*(z-c[1])/(a[1]-c[1])+c[0])inside=!inside;
    }
    return inside;
  };
  const envelopes=records.filter(b=>b.spec.present!==false && b.bounds);
  for(const tile of Object.values(features.tiles)){
    delete tile.r;delete tile.b;
    if(tile.p)tile.p=tile.p.filter(([kind,,x,,z])=>{
      if(kind!=='entrance' && kind!=='shelter')return true;
      return !envelopes.some(b=>x>=b.bounds[0] && x<=b.bounds[2] && z>=b.bounds[1] && z<=b.bounds[3] && b.parts.some(p=>p.low<2.8 && contains(p.rings[0],x,z) && !p.rings.slice(1).some(r=>contains(r,x,z))));
    });
  }
}

export function addBoundaryHousing(records,region){
  for(const {way,block,hip} of region.southernHousing??[]){
    const id='w'+way;
    if(records.some(b=>b.id===id))continue;
    const [outer,holes,ground,height]=block,[rise,vertices,indices]=hip;
    const loops=[outer,...holes].map(r=>Array.from({length:r.length/2},(_,i)=>[r[i*2],r[i*2+1]]));
    loops.forEach((ring,i)=>{
      const area=ring.reduce((sum,[x,z],j)=>{const next=ring[(j+1)%ring.length];return sum+x*next[1]-z*next[0];},0);
      if((area>0)!==(i===0))ring.reverse();
    });
    const points=Array.from({length:vertices.length/3},(_,i)=>[vertices[i*3],vertices[i*3+2],vertices[i*3+1]]);
    const xs=loops[0].map(p=>p[0]),zs=loops[0].map(p=>p[1]),bounds=[Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)];
    const center=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2];
    const roof={form:'hip',material:'roof'};
    const footprintArea=Math.abs(loops.reduce((sum,ring)=>sum+ring.reduce((area,v,j)=>{const q=ring[(j+1)%ring.length];return area+v[0]*q[1]-q[0]*v[1];},0),0))/2;
    records.push({id,ground,center,bounds,footprintArea,walls:[],sources:[],parts:[{rings:loops,wallIds:loops.map(r=>r.map(()=>-1)),low:0,high:height-rise*.5,floors:2,facade:{},roof,surface:[points,indices],center}],spec:{id,style:'house',floors:{count:2},walls:{default:{bays:{width:3.2},windows:{width:1.45,height:1.25,sill:.75}}},materials:{wall:{kind:'brick',color:'#ab765f'},roof:{kind:'asphalt-shingle',color:'#76736d'},trim:{kind:'painted-metal',color:'#cac5ba'}},roof}});
  }
}

export function pruneBuildingTrees(region,core,municipal,network){
  const {groundAt,crownClear}=network;
  region.trees=region.trees.filter(([x,,z,h])=>crownClear(x,groundAt(x,z)+h*.7,z,Math.min(8,h*.38),h*.31));
  core.trees=core.trees.filter(([x,old,z,r,center])=>crownClear(x,groundAt(x,z)+center-old,z,r*1.13,r));
  for(const tile of Object.values(municipal.tiles)){
    if(tile.trees)tile.trees=tile.trees.filter(([x,z,h,r])=>crownClear(x,groundAt(x,z)+h*.69,z,r*1.1,h*.33));
  }
}

export function fitArchitecture(records,heightAt,roadWays=[],collectCollisions=true){
  const solids=[],enclosures=[],decks=[],contacts=createBuildingContacts();
  const footprintWeight=b=>{
    if(!b.bounds || b.spec.present===false)return 0;
    const [l,t,r,z]=b.bounds;
    return 64+10.65*Math.sqrt(Math.max(1,b.footprintArea??(r-l)*(z-t)));
  };
  const occupied=records.filter(b=>b.spec.present!==false);
  const normalizer=Math.min(1,(115000-32*occupied.length)/Math.max(1,occupied.reduce((sum,b)=>sum+Math.max(0,footprintWeight(b)-32),0)));
  for(const b of records){
    b.farBudget=Math.max(32,Math.floor(32+Math.max(0,footprintWeight(b)-32)*normalizer));
    let min=Infinity;
    const grade=[];
    const lowest=Math.min(...b.parts.map(p=>p.low));
    b.parts.forEach((p,k)=>p.rings.forEach((ring,r)=>ring.forEach((a,j)=>{
      if(p.low>Math.max(0,lowest)+.01)return;
      const c=ring[(j+1)%ring.length],dx=c[0]-a[0],dz=c[1]-a[1],length=Math.hypot(dx,dz),count=Math.ceil(length/1.25);
      for(let i=0;i<=count;i++){
        const y=heightAt(a[0]+dx*i/Math.max(1,count),a[1]+dz*i/Math.max(1,count));
        if(Number.isFinite(y)){min=Math.min(min,y);grade.push(y);}
      }
    })));
    if(grade.length){
      grade.sort((a,b)=>a-b);
      b.surveyGround??=b.ground;
      b.ground=grade[Math.floor((grade.length-1)*.22)];
    }
    if(b.parts.some(p=>p.porchEntry!==undefined) && b.spec.floors.count<=3){
      const thresholds=(b.spec.entrances??[]).filter(e=>e.gradePoint).map(e=>heightAt(...e.gradePoint)).filter(Number.isFinite).sort((a,c)=>a-c);
      if(thresholds.length)b.ground=thresholds[Math.floor((thresholds.length-1)/2)];
    }
    for(const p of b.parts)if(p.absoluteSoffit!==undefined){
      p.low=p.absoluteSoffit-b.ground;p.high=p.low+.30;
    }
    b.foundation=Math.min(b.ground-.5,min-.65);
    b.entryGround=[];b.entranceEdges=[];
    for(const entry of b.spec.entrances??[]){
      const point=entry.gradePoint;
      const local=point?heightAt(...point):b.ground;
      const y=entry.stairToe?Math.max(local,heightAt(...entry.stairToe)-(entry.steps??0)*.155):local;
      b.entryGround.push(Number.isFinite(y)?y:b.ground);
      b.entranceEdges.push(entry.boundEdge??'');
    }
    for(const part of b.parts){
      if(part.porchEntry===undefined)continue;
      part.surveyLow??=part.low;part.surveyHigh??=part.high;
      const offset=b.entryGround[part.porchEntry]-b.ground;
      part.low=part.surveyLow+offset;part.high=part.surveyHigh+offset;
    }
    for(const p of b.parts){
      if(p.low===0)p.grade=p.rings.map(r=>r.map(([x,z])=>heightAt(x,z)));
    }
    for(const a of b.spec.attachments??[]){
      if(a.type==='retaining-wall' && a.path && !a.baseOffset)a.pathGround=a.path.map(([x,z])=>heightAt(x,z));
      if(a.type==='ramp' && a.path?.length>=2){
        const distances=[0];
        for(let j=1;j<a.path.length;j++)distances.push(distances[j-1]+Math.hypot(a.path[j][0]-a.path[j-1][0],a.path[j][1]-a.path[j-1][1]));
        const last=a.path.at(-1),nearest=(b.spec.entrances??[]).map((e,i)=>({i,d:e.gradePoint?Math.hypot(last[0]-e.gradePoint[0],last[1]-e.gradePoint[1]):Infinity})).sort((e,f)=>e.d-f.d)[0];
        const toe=heightAt(...a.path[0])+(a.baseOffset??0)+.035;
        const head=nearest?.d<Math.max(1.35,(a.width??1.6)*.8)?b.entryGround[nearest.i]+(b.spec.entrances[nearest.i].steps??0)*.155+.035:toe+(a.height??.65);
        a.stairLevels=distances.map(length=>toe+(head-toe)*length/Math.max(.001,distances.at(-1)));
      }
      if(a.type!=='exterior-stair' || a.gradeEntry===undefined || !a.path?.length)continue;
      const entry=b.spec.entrances[a.gradeEntry],sill=b.entryGround[a.gradeEntry]+(entry.steps??0)*.155+.035;
      const toe=Math.min(sill-.035,heightAt(...a.path[0]));
      const distances=[0];
      for(let i=1;i<a.path.length;i++)distances.push(distances[i-1]+Math.hypot(a.path[i][0]-a.path[i-1][0],a.path[i][1]-a.path[i-1][1]));
      a.stairLevels=distances.map(distance=>toe+(sill-toe)*distance/Math.max(.001,distances.at(-1)));
    }
    decks.push(...fitParkingDecks(b,heightAt));
    const preliminary=buildArchitecture([b],-1);
    b.contactHeights=Object.fromEntries(preliminary.footings.map(([key,x,z])=>[key,heightAt(x,z)]));
    if(!collectCollisions)continue;
    solids.push(...(preliminary.footings.length?buildArchitecture([b],-1).solids:preliminary.solids));
    for(const p of b.parts){
      if(p.low!==0 || p.high<=0 || p.paving || b.spec.style==='parking-structure')continue;
      for(const rings of p.collisionShells??[p.solidRings??p.rings])enclosures.push([p.openSoffit??b.foundation,b.ground+p.high,rings.map(r=>r.flat())]);
    }
    contacts.sink.ceiling=Math.max(grade.at(-1)??b.ground,...b.entryGround,b.ground)+4;
    if(b.parts.some(p=>p.deckLevels))contacts.sink.ceiling=Infinity;
    else if(b.bounds)for(const way of roadWays){
      if(!way.bridge && !way.level)continue;
      for(const [x,y,z] of way.points)if(x>b.bounds[0]-15 && x<b.bounds[2]+15 && z>b.bounds[1]-15 && z<b.bounds[3]+15)contacts.sink.ceiling=Math.max(contacts.sink.ceiling,y+3);
    }
    buildArchitecture([b],2,false,contacts.sink);
  }
  contacts.finish();solids.surfaceContact=contacts.touches;solids.enclosures=enclosures;solids.parkingSurface=parkingSurfaceIndex(decks);
  return solids;
}
export function architectureMesh(packet){
  const group=new THREE.Group();
  if(!packet.positions.length)return group;
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(packet.positions,3));
  g.setAttribute('normal',new THREE.BufferAttribute(packet.normals,3,true));
  g.setAttribute('uv',new THREE.BufferAttribute(packet.uvs,2));
  g.setAttribute('finishId',new THREE.BufferAttribute(packet.styles,1));
  g.setIndex(new THREE.BufferAttribute(packet.index,1));
  g.computeBoundingSphere();
  const isGlass=packet.palette.map(m=>m.opacity<1||['glass-curtain','perforated-mesh'].includes(m.kind));
  const layers=isGlass.includes(true)?[false,true]:[false];
  for(const alpha of layers){
    let geometry=g;
    if(layers.length>1){
      const selected=[];
      for(let i=0;i<packet.index.length;i+=3)if(isGlass[packet.styles[packet.index[i]]]===alpha)selected.push(packet.index[i],packet.index[i+1],packet.index[i+2]);
      geometry=new THREE.BufferGeometry();
      for(const [key,value] of Object.entries(g.attributes))geometry.setAttribute(key,value);
      geometry.setIndex(selected);geometry.boundingSphere=g.boundingSphere;
    }
    if(geometry.index.count){
      const shell=new THREE.Mesh(geometry,surveyMaterial(packet.palette,false,alpha));
      if(alpha)shell.customDepthMaterial=glazingShadow(shell.material.userData.styles);
      shell.castShadow=true;shell.receiveShadow=true;
      if(packet.ranges){
        shell.userData.buildingRanges=packet.ranges;
        shell.userData.parkingFloors=new Set(packet.palette.flatMap((m,i)=>m.drivingSurface==='parking'?[i]:[]));
      }
      group.add(shell);
    }
    const ids=[];
    for(let i=0;i<packet.boxes.length;i+=8)if(isGlass[packet.boxes[i+7]]===alpha)ids.push(i);
    if(!ids.length)continue;
    const box=new THREE.BoxGeometry(1,1,1);
    const finishes=new Uint16Array(ids.length),profiles=new Uint8Array(ids.length);
    box.setAttribute('instanceProfile',new THREE.InstancedBufferAttribute(profiles,1));
    box.setAttribute('finishId',new THREE.InstancedBufferAttribute(finishes,1));
    const detail=new THREE.InstancedMesh(box,surveyMaterial(packet.palette,true,alpha),ids.length);
    const transform=new THREE.Object3D();
    for(const [i,k] of ids.entries()){
      const v=packet.boxes;
      transform.position.set(v[k],v[k+1],v[k+2]);
      transform.scale.set(v[k+3],v[k+4],v[k+5]);
      transform.rotation.y=-v[k+6];transform.updateMatrix();detail.setMatrixAt(i,transform.matrix);
      finishes[i]=v[k+7];
      if(packet.palette[v[k+7]].profile==='pressure-cap')profiles[i]=v[k+3]<v[k+4]?1:2;
    }
    detail.computeBoundingSphere();
    if(alpha)detail.customDepthMaterial=glazingShadow(detail.material.userData.styles);
    else if(profiles.some(Boolean)){
      detail.customDepthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
      detail.customDepthMaterial.onBeforeCompile=pressureCapProfile;
      detail.customDepthMaterial.customProgramCacheKey=()=>'western-pressure-cap-shadow';
    }
    detail.castShadow=true;detail.receiveShadow=true;
    if(packet.ranges){detail.userData.buildingRanges=packet.ranges;detail.userData.boxIds=ids.map(k=>k/8);}
    group.add(detail);
  }
  return group;
}
function dispose(obj){
  obj?.traverse(m=>{m.geometry?.dispose();m.customDepthMaterial?.dispose();m.material?.userData.styles?.dispose();m.material?.dispose();if(m.isInstancedMesh)m.dispose();});
}
function workerLoop(build){
  let tiles,audit;
  self.onmessage=({data})=>{
    if(data.tiles){tiles=data.tiles;audit=data.audit;return;}
    const packet=build(tiles[data.key],data.level,audit);
    self.postMessage({...data,packet},Object.values(packet).filter(ArrayBuffer.isView).map(v=>v.buffer));
  };
}
export async function createCampusBuildings(records,frames,onReady){
  const group=new THREE.Group(),tiles={},states=new Map();
  for(const b of records){
    if(b.spec.present===false)continue;
    const key=Math.floor(b.center[0]/130)+':'+Math.floor(b.center[1]/130);
    (tiles[key]??=[]).push(b);
  }
  for(const [key,items] of Object.entries(tiles)){
    const bounds=[Infinity,Infinity,-Infinity,-Infinity];
    for(const b of items)for(let i=0;i<4;i++)bounds[i]=(i<2?Math.min:Math.max)(bounds[i],b.bounds[i]);
    states.set(key,{key,bounds,level:-1,target:0,range:Infinity,mesh:null,coarse:null});
  }
  const url=URL.createObjectURL(new Blob(['"use strict";(',workerLoop.toString(),')(',buildArchitecture.toString(),');'],{type:'text/javascript'}));
  const worker=new Worker(url);
  URL.revokeObjectURL(url);
  worker.postMessage({tiles,audit:new URLSearchParams(globalThis.location?.search).has('audit')});
  let busy=false,remaining=states.size;
  let resolveReady,rejectReady;
  const initialized=new Promise((a,b)=>{resolveReady=a;rejectReady=b;});
  worker.onerror=e=>{rejectReady(new Error(e.message));console.error(e.message);};
  const transitions=new Map();
  let animation=0;
  function coverage(mesh,lo,hi){for(const m of mesh.children)m.material.userData.coverage.value.set(lo,hi);}
  function finish(st){
    const old=transitions.get(st)?.old;
    if(!old)return;
    transitions.delete(st);
    group.remove(old);
    if(old!==st.coarse)dispose(old);
    coverage(st.mesh,0,1);
  }
  function blend(now){
    animation=0;
    for(const [st,{old,start}] of transitions){
      const t=Math.min(1,(now-start)/220);
      if(t===1){finish(st);continue;}
      coverage(old,t,1);coverage(st.mesh,0,t);
    }
    onReady?.();
    if(transitions.size)animation=requestAnimationFrame(blend);
  }
  function install(st,obj,level){
    obj.name='Campus building tile '+st.key;
    obj.userData.tile=st.key;obj.userData.level=level;obj.userData.bounds=st.bounds;
    finish(st);
    if(st.mesh && st.mesh!==obj){
      coverage(st.mesh,0,1);coverage(obj,0,0);
      transitions.set(st,{old:st.mesh,start:performance.now()});
      if(!animation)animation=requestAnimationFrame(blend);
    }
    st.mesh=obj;st.level=level;group.add(obj);
  }
  function next(){
    if(busy)return;
    let best;
    for(const st of states.values()){
      if(st.level===st.target)continue;
      if(st.target===0 && st.coarse){install(st,st.coarse,0);continue;}
      if(!best||st.range<best.range)best=st;
    }
    if(!best)return;
    busy=true;worker.postMessage({key:best.key,level:best.target});
  }
  worker.onmessage=({data})=>{
    const st=states.get(data.key),obj=architectureMesh(data.packet);
    if(data.level===0 && !st.coarse){st.coarse=obj;remaining--;}
    install(st,obj,data.level);
    busy=false;
    if(!remaining)resolveReady();
    onReady?.();next();
  };
  next();
  if(remaining)await initialized;
  const credit=globalThis.document?.getElementById('facade-credit');
  const settings=globalThis.document?.querySelector('#look-quality');
  let lastX=Infinity,lastZ=Infinity,lastDistance=Infinity,lastPhone;
  return {group,settledNear(radius){return [...states.values()].every(st=>st.range>radius || st.level===st.target && !transitions.has(st));},update(x,z,distance=80){
    const mobile=globalThis.matchMedia?.('(pointer: coarse)').matches || (globalThis.navigator?.maxTouchPoints??0)>1 || settings?.value==='low';
    if(mobile===lastPhone && Math.hypot(x-lastX,z-lastZ)<6 && Math.abs(lastDistance-distance)<8)return;
    lastPhone=mobile;
    lastX=x;lastZ=z;lastDistance=distance;
    let closest=Infinity,id;
    for(const st of states.values()){
      const [l,t,r,b]=st.bounds;
      st.range=Math.hypot(Math.max(0,l-x,x-r),Math.max(0,t-z,z-b),Math.max(0,distance-105));
      const edge=(st.target===2?18:0)+(mobile?105:165);
      st.target=st.range<edge?2:st.range<(mobile?260:480)+(st.target===1?25:0)?1:0;
      if(st.range<175)for(const item of tiles[st.key]){
        const dist=Math.hypot(x-item.center[0],z-item.center[1]);
        const source=item.sources.find(k=>frames[k]);
        if(source&&dist<closest){closest=dist;id=source;}
      }
    }
    if(credit){credit.hidden=!id;if(id){credit.href=frames[id].url;credit.textContent='Building survey · '+frames[id].username+' on KartaView';}}
    next();
  },dispose(){worker.terminate();cancelAnimationFrame(animation);for(const st of states.values()){finish(st);dispose(st.mesh);if(st.coarse!==st.mesh)dispose(st.coarse);}}};
}
