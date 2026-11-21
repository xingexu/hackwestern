import assert from 'node:assert/strict';
import * as THREE from 'three';
import {buildArchitecture} from 'building-kernel';
import {architectureMesh,fitArchitecture,addBoundaryHousing} from 'campus-buildings';

export function checkBuildingOpenings(records,network,roads,region,ground){
  const buildings=[...records];
  addBoundaryHousing(buildings,region);
  const ray=new THREE.Raycaster(),up=new THREE.Vector3(0,1,0),models=new Map();
  function model(b){
    if(!models.has(b.id)){
      const packet=buildArchitecture([b],2),m=architectureMesh(packet);
      m.userData.palette=packet.palette;
      m.name=b.id; m.updateMatrixWorld(true);
      models.set(b.id,m);
    }
    return models.get(b.id);
  }
  function cast(origin,dir,far,targets){
    ray.set(origin,dir);ray.far=far;
    return ray.intersectObjects(targets,true);
  }
  const covered=new Set([562334870,562334877,1554621133,778714473]),seen=new Set();
  let clear=0,roofs=0;
  for(const way of roads.ways.filter(w=>w.covered && covered.has(w.id))){
    let roof=false;
    for(let i=1;i<way.points.length;i++){
      const [a,h,c]=way.points[i-1],[b,k,d]=way.points[i],x=(a+b)/2,z=(c+d)/2,len=Math.hypot(b-a,d-c);
      const nearby=buildings.filter(p=>x>=p.bounds[0]-len-3 && x<=p.bounds[2]+len+3 && z>=p.bounds[1]-len-3 && z<=p.bounds[3]+len+3).map(model);
      const dir=new THREE.Vector3((b-a)/len,0,(d-c)/len);
      for(const offset of [-.7,0,.7])for(const height of [.42,1.45,2.25]){
        const origin=new THREE.Vector3(a+dir.z*offset,Math.min(h,k)+height,c-dir.x*offset);
        const obstruction=cast(origin,dir,len,nearby)[0];
        assert.ok(!obstruction,`Visible ${obstruction?.object.parent.name} geometry crosses covered road ${way.id} at ${obstruction?.point.toArray()}, instance ${obstruction?.instanceId}, triangle ${obstruction?.faceIndex}, material ${JSON.stringify(obstruction?.object.parent.userData.palette[obstruction?.object.geometry.attributes.finishId.getX(obstruction?.instanceId??obstruction?.face.a)])}, vertices ${obstruction?[obstruction.face.a,obstruction.face.b,obstruction.face.c].map(i=>new THREE.Vector3().fromBufferAttribute(obstruction.object.geometry.attributes.position,i).toArray()):[]}`);
        clear++;
      }
      assert.ok(!network.blocked(x,z,(h+k)/2,.92),'Blocked covered road '+way.id+' at '+[x,(h+k)/2,z]);
      roof||=cast(new THREE.Vector3(x,(h+k)/2+1.4,z),up,14,nearby).length>0;
    }
    assert.ok(roof,'Missing overhead slab '+way.id);
    roofs++;seen.add(way.id);
  }
  assert.deepEqual(covered,seen);
  let houses=0;
  for(const housing of region.southernHousing){
    const b=buildings.find(p=>p.id==='w'+housing.way);
    assert.ok(b);
    const [,v,index]=housing.hip,targets=[model(b)];
    for(let i=0;i<index.length;i+=3){
      const pts=index.slice(i,i+3).map(k=>v.slice(3*k,3*k+3)),x=pts.reduce((s,p)=>s+p[0],0)/3,z=pts.reduce((s,p)=>s+p[1],0)/3;
      if(z<=region.bounds[3]+1)continue;
      const hits=cast(new THREE.Vector3(x,ground(x,z)+23,z),new THREE.Vector3(0,-1,0),26,targets);
      if(!hits.length)continue;
      assert.ok(hits[0].point.y>ground(x,z)+1.5,'House roof below local street');
      assert.ok(network.blocked(x,z,ground(x,z)+.1,.22),'Southern house roof without matching collision');
      houses++;
    }
  }
  assert.ok(houses>=32,`Found ${houses} southern roof probes`);
  console.log(`${clear} street-clearance rays, ${roofs} covered routes, ${houses} southern roof/collision pairs`);
}

export function checkEntranceGrades(buildings,network,ground){
  let measured=0,sills=0;
  for(const b of buildings){
    if(b.spec.present===false)continue;
    const entries=b.spec.entrances??[];
    for(const [i,e] of entries.entries()){
      assert.ok(e.boundEdge && e.gradePoint,b.id+' entrance missing on measured facade');
      assert.ok(Math.abs(ground(...e.gradePoint)-b.entryGround[i])<.05,b.id+' threshold diverged from terrain');
      measured++;
    }
    if(!['w123525238','w778714502'].includes(b.id))continue;
    const packet=buildArchitecture([b],2),object=architectureMesh(packet);
    object.updateMatrixWorld(true);
    for(const [i,e] of entries.entries()){
      const [pi,r,j]=e.boundEdge.split(':').map(Number),edge=b.parts[pi].rings[r],a=edge[j],c=edge[(j+1)%edge.length];
      const length=Math.hypot(c[0]-a[0],c[1]-a[1]),tx=(c[0]-a[0])/length,tz=(c[1]-a[1])/length;
      const x=e.gradePoint[0]+tz*.55+tx*.17*e.width,z=e.gradePoint[1]-tx*.55+tz*.17*e.width;
      const sill=b.entryGround[i]+(e.steps??0)*.155+.035;
      function hits(y){
        const ray=new THREE.Raycaster(new THREE.Vector3(x,y,z),new THREE.Vector3(-tz,0,tx),0,3+(e.recess??.28));
        return ray.intersectObject(object).some(hit=>packet.palette[hit.object.geometry.attributes.finishId.getX(hit.instanceId??hit.face.a)].kind==='door');
      }
      assert.ok(hits(sill+.38) && !hits(sill-.15),b.id+' rendered door threshold must meet its surveyed landing');
      sills++;
    }
  }
  for(const id of ['w527547917','r7380709-0']){
    const b=buildings.find(v=>v.id===id),p=b.parts.find(x=>x.low===0),loop=p.rings[0];
    const a=loop[0],c=loop[1],x=(a[0]+c[0])/2,z=(a[1]+c[1])/2,y=b.ground+2.5;
    assert.equal(network.crownClear(x,y,z,.75),false,id+' foliage entering facade');
    assert.ok(network.crownClear(x,b.ground+100,z,.75),id+' pruning foliage above roof');
  }
  console.log(measured+' grade-bound entrances, '+sills+' raycast door thresholds, WIRB and John Labatt foliage clearance');
}

export function checkGlazing(){
  const rings=[[[0,0],[15,0],[15,9],[0,9]]], vertices=rings[0].map(([x,z])=>[x,0,z]);
  const curtain={bands:[{at:"floor-lines",height:.24,depth:.19}],bays:{count:3},windows:{type:'curtain-wall',sill:.15,recess:.40,mullions:{vertical:2,horizontal:1}}};
  const b={ground:2,parts:[{rings,wallIds:[[-1,-1,-1,-1]],low:0,high:12,floors:3,facade:curtain,roof:{form:'flat'},surface:[vertices,[0,1,2,0,2,3]]}],walls:[],spec:{materials:{wall:{kind:'stone-ashlar',color:'#b0a89c'},frame:{kind:'painted-metal',color:'#556677'}},floors:{count:3},roof:{form:'flat'},walls:{default:curtain}}};
  fitArchitecture([b],()=>2);
  const packet=buildArchitecture([b],2),depths=[],windowHeights=new Map();
  for(let j=0;j<packet.styles.length;j++){
    const m=packet.palette[packet.styles[j]],x=packet.positions[j*3],y=packet.positions[j*3+1],z=packet.positions[j*3+2];
    if(x<.1 || x>14.9 || z>2 || m.kind!=='glazing')continue;
    assert.ok(m.opacity>.1 && m.opacity<.95,'Curtain wall needs visible transmission');
    depths.push(z);
    const key=x.toFixed(2),column=windowHeights.get(key)??[Infinity,-Infinity];
    column[0]=Math.min(column[0],y);column[1]=Math.max(column[1],y);windowHeights.set(key,column);
  }
  assert.ok(depths.length>0 && Math.min(...depths)>.29,'Curtain glazing must sit inside the reveal');
  const geometry=architectureMesh(packet);geometry.updateMatrixWorld(true);
  for(const x of [1.67,7.94])for(const y of [5.97,6.04,9.96,10.06]){
    const ray=new THREE.Raycaster(new THREE.Vector3(x,y,-2),new THREE.Vector3(0,0,1),0,3);
    const first=ray.intersectObject(geometry)[0];
    assert.ok(first && first.object.material.transparent,`Opaque storey line cuts through continuous glazing at y=${y}, hit ${first?.point.toArray()} style ${JSON.stringify(packet.palette[first?.object.geometry.attributes.finishId.getX(first?.instanceId??first?.face.a)])}`);
  }
  assert.ok([...windowHeights.values()].some(v=>v[1]-v[0]>11.4),'Curtain wall must span the full three-storey opening');
}
