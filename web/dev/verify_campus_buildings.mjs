import './building_test_imports.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inflateSync,brotliCompressSync} from 'node:zlib';
import * as THREE from 'three';
import {createLandscapeGrid,createCarriageway} from '../campus-terrain.mjs';
import {createRoadNetwork} from '../drive-network.mjs';

const {checkBuildingContacts}=await import('./check_building_contacts.mjs');
const {buildArchitecture}=await import('building-kernel');
const {checkBuildingOpenings,checkEntranceGrades,checkGlazing}=await import('./check_building_openings.mjs');
const {addBoundaryHousing,fitArchitecture,architectureMesh}=await import('campus-buildings');
const read=name=>JSON.parse(fs.readFileSync(new URL('../'+name+'.json',import.meta.url)));
const buildings=read('campus-buildings'),rd=read('drive-network'),region=read('campus-region'),ground=read('campus-ground'),srf=read('surface-tiles');
const inventory=JSON.parse(fs.readFileSync(new URL('../../data/buildings/inventory.json',import.meta.url))).buildingsList;
const unpack=(Type,s)=>{const bytes=inflateSync(Buffer.from(s,'base64'));return new Type(bytes.buffer,bytes.byteOffset,bytes.byteLength/Type.BYTES_PER_ELEMENT);};
const terrain=unpack(Uint16Array,ground.heightMillimeters);
const core=(x,z)=>terrain[Math.floor(z)*ground.width+Math.floor(x)]*.001;
const carriage=createCarriageway(THREE,srf.carriageway,unpack(Uint8Array,srf.carriageway.samples),region.bounds);
const grid=createLandscapeGrid(region,ground,core,srf.relief,unpack(Int16Array,srf.relief.samples),carriage.contains);
const visible=[...buildings];addBoundaryHousing(visible,region);
region.buildingSolids=fitArchitecture(visible,grid.heightAt);
const network=createRoadNetwork(rd,region,grid.heightAt,carriage.contains);
assert.deepEqual(buildings.map(b=>b.id).sort(),inventory.map(b=>b.id).sort());
const ray=new THREE.Raycaster(),direction=new THREE.Vector3(0,-1,0);
const down=(obj,x,z,y)=>{ray.set(new THREE.Vector3(x,y,z),direction);ray.far=200;return ray.intersectObject(obj)[0]?.point.y;};
let total=[0,0,0],contacts=0,collisions=0,bytes=0,relief=0,nearMax=0,absent=0;
const models=new Map(),representatives=new Set(['w118764092','w118764099','w118764108','w141710481','r21319537-1','w778714502']);
for(const b of buildings){
  for(const level of [0,1,2]){
    const result=buildArchitecture([b],level);
    assert.ok(result.positions.every(Number.isFinite)&&result.boxes.every(Number.isFinite)&&result.uvs.every(Number.isFinite),b.id);
    assert.ok(result.index.every(i=>i<result.positions.length/3),b.id);
    const triangles=result.index.length/3+result.boxes.length/8*12;
    total[level]+=triangles;
    if(b.spec.present===false){assert.equal(triangles,0);if(level===0)absent++;continue;}
    assert.ok(triangles>0 && triangles<230000,`${b.id} LOD ${level}: ${triangles} triangles`);
    if(level!==2)continue;
    nearMax=Math.max(nearMax,triangles);
    const obj=architectureMesh(result);
    assert.ok(obj.children.length<=4);
    obj.updateMatrixWorld(true);
    if(representatives.has(b.id))models.set(b.id,obj);
    const allMats=new Set(Array.from(result.styles,k=>result.palette[k].kind));
    if(allMats.has('glazing'))relief++;
    for(const p of b.parts){
      if(p.low!==0)continue;
      let low=Infinity,high=-Infinity;
      for(const ring of p.solidRings??p.rings){
        for(const [i,a] of ring.entries()){
          const end=ring[(i+1)%ring.length],count=Math.max(1,Math.ceil(Math.hypot(end[0]-a[0],end[1]-a[1])/1.75));
          for(let j=0;j<count;j++){
            const x=a[0]+(end[0]-a[0])*j/count,z=a[1]+(end[1]-a[1])*j/count,y=grid.heightAt(x,z);
            assert.ok(b.foundation<=y+.30,`${b.id} plinth above grade at ${x},${z}`);contacts++;
            low=Math.min(low,y);high=Math.max(high,y);
          }
        }
      }
      if(p.paving){
        const [vertices,indices]=p.surface;
        for(let i=0;i<indices.length;i+=3){
          const keys=indices.slice(i,i+3),x=keys.reduce((sum,k)=>sum+vertices[k][0],0)/3,z=keys.reduce((sum,k)=>sum+vertices[k][2],0)/3,y=p.high+keys.reduce((sum,k)=>sum+grid.heightAt(vertices[k][0],vertices[k][2]),0)/3;
          assert.ok(region.buildingSolids.parkingSurface.covers(x,z),b.id+' missing pavement support');
          assert.ok(region.buildingSolids.surfaceContact(x,z,y-.02,y+.02,.012),b.id+' visible paved surface missing from collision');
          collisions++;
        }
        continue;
      }
      const loops=p.collisionShells?.length?p.collisionShells.map(s=>s[0]):[p.solidRings?.[0]??p.rings[0]];
      if(b.spec.style==='parking-structure')continue;
      for(const ring of loops){
        const edge=ring.findIndex((a,i)=>Math.hypot(ring[(i+1)%ring.length][0]-a[0],ring[(i+1)%ring.length][1]-a[1])>2);
        if(edge<0)continue;
        const a=ring[edge],c=ring[(edge+1)%ring.length],x=(a[0]+c[0])/2,z=(a[1]+c[1])/2;
        assert.ok(network.blocked(x,z,b.ground+.1,.10),b.id+' collision missing at '+p.name+' shell '+[x,b.ground+.1,z]);collisions++;
      }
    }
    bytes+=Object.values(result).reduce((sum,v)=>sum+(v.byteLength??0),0);
    if(!representatives.has(b.id))obj.traverse(m=>{m.geometry?.dispose();m.material?.userData.styles?.dispose();m.material?.dispose();});
  }
}
assert.ok(total[0]<120000 && total[1]<850000 && total[2]<4400000,'Campus LOD triangles '+total.join(', '));
assert.ok(contacts>12000 && collisions>170 && relief>75);
for(const [id,x,z,min,max] of [['w118764092',300.6,309.5,42,46],['w118764099',530.1,199.4,55.66,57.26]]){
  const b=buildings.find(v=>v.id===id),obj=models.get(id),bounds=new THREE.Box3().setFromObject(obj);
  assert.ok(bounds.max.y-b.ground>=min && bounds.max.y-b.ground<=max,`${id} landmark height ${bounds.max.y-b.ground}`);
  assert.ok(down(obj,x,z,b.ground+85)-b.ground>min-1,id);
}
const uc=models.get('w118764092'),mc=models.get('w118764099'),lib=models.get('w118764108');
assert.ok(down(uc,301,309.5,110)-down(uc,302,281,110)>=22);
assert.ok(down(mc,530.1,199.4,120)-down(mc,537,246,120)>=40);

for(const [id,color,required] of [['w118764099','#e2dcca',4],['w118764099','#3f4f49',1],['w141710481','#cb2e35',1]]){
 const b=buildings.find(b=>b.id===id),packet=buildArchitecture([b],2),centers=new Set();
 for(let k=0;k<packet.styles.length;k++)if(packet.palette[packet.styles[k]].color===color){
   const [x,y,z]=packet.positions.subarray(k*3,k*3+3);
   if(required===4){const a=Math.atan2(z-199.4,x-530.1)+35*Math.PI/180;centers.add((Math.round(a/(Math.PI/2))%4+4)%4);}
   else if(id!=='w141710481'||(x>269&&x<285&&z>192&&z<203))centers.add('visible');
 }
 assert.ok(centers.size>=required,id+' lost surveyed '+color);
}
const p=buildings.find(b=>b.id==='w778714502');
if(p){const lows=p.parts.flatMap(part=>part.rings[0].map(([x,z])=>grid.heightAt(x,z)));assert.ok(p.ground>=Math.min(...lows)-.3,'Western Road ground floor buried');}
const adjacent=buildings.find(b=>b.id==='r21319537-1');
assert.ok(adjacent.foundation<grid.heightAt(...adjacent.center)+.3);
const roof=down(models.get(adjacent.id),...adjacent.center,95);
assert.ok(roof>adjacent.ground+2 && network.blocked(...[adjacent.center[0],adjacent.center[1],adjacent.ground+.4,.15]),'Perth Drive stair tower requires solid ground contact');
const support=[];
for(const b of buildings)for(const [low,high,rings] of buildArchitecture([b],-1).solids){
  const coords=rings[0],values=[];
  for(let i=0;i<coords.length;i+=2)values.push(grid.heightAt(coords[i],coords[i+1]));
  support.push({id:b.id,low,high,rings,terrain:Math.max(...values)});
}
for(const b of buildings)for(const p of b.parts){
  const [verts,idx]=p.surface;
  for(let i=0;i<idx.length;i+=3){
    const tri=idx.slice(i,i+3).map(k=>verts[k]),max=Math.max(...tri.map(v=>v[1]));
    const [a,c,d]=tri,area=(c[0]-a[0])*(d[2]-a[2])-(d[0]-a[0])*(c[2]-a[2]);
    if(max<.12 || Math.abs(area)<1e-6)continue;
    const low=b.ground+p.high,rings=[tri.flatMap(v=>[v[0],v[2]])];
    support.push({id:b.id,low,high:low+max,rings,roof:tri.map(v=>[v[0],low+v[1],v[2]]),terrain:Math.max(...tri.map(v=>grid.heightAt(v[0],v[2])))});
  }
}
const root=fileURLToPath(new URL('../../',import.meta.url));
const scratch=fs.mkdtempSync(join(tmpdir(),'campus-support-'));
try{
  const input=join(scratch,'solids.json');
  fs.writeFileSync(input,JSON.stringify(support));
  const fd=fs.openSync(input,'r');
  try{
    console.log(execFileSync(root+'.venv/bin/python',[root+'build/check_building_support.py'],{stdio:[fd,'pipe','inherit'],encoding:'utf8'}).trim());
  }finally{fs.closeSync(fd);}
}finally{fs.rmSync(scratch,{recursive:true});}
const packed=brotliCompressSync(Buffer.from(JSON.stringify(buildings))).length;
console.log(JSON.stringify({buildings:buildings.length,absent,groundSamples:contacts,collisionProbes:collisions,glazed:relief,triangles:total,maxNear:nearMax,fullCampusNearBufferBytes:bytes,compressedBytes:packed}));

assert.ok(down(lib,74,368,120)-down(lib,108,426,120)>=10);
checkGlazing();
checkBuildingContacts(visible,network,region.buildingSolids.surfaceContact);
checkEntranceGrades(buildings,network,grid.heightAt);
checkBuildingOpenings(visible,network,rd,region,grid.heightAt);
