import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createRoadNetwork} from '../drive-network.mjs';
import {createCampusRoads} from '../campus-roads.js';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createLandscapeGrid,createCarriageway} from '../campus-terrain.mjs';

const read=name=>JSON.parse(readFileSync(new URL('../'+name+'.json',import.meta.url)));
const world=read('world'),region=read('campus-region'),surface=read('surface-tiles'),core=read('campus-ground');
function decode(text) {
  const bytes=inflateSync(Buffer.from(text,'base64'));
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}
const coreHeights=new Uint16Array(decode(core.heightMillimeters));
const coreAt=(x,z)=>coreHeights[Math.min(world.depth-1,Math.max(0,Math.floor(z)))*world.width+Math.min(world.width-1,Math.max(0,Math.floor(x)))]*.001;
const streets=createCarriageway(THREE,surface.carriageway,new Uint8Array(decode(surface.carriageway.samples)),region.bounds);
const grid=createLandscapeGrid(region,world,coreAt,surface.relief,new Int16Array(decode(surface.relief.samples)),streets.contains);
const driveData=read('drive-network');
const network=createRoadNetwork(driveData,region,grid.heightAt,streets.contains);
const layer=createCampusRoads(driveData,network,streets);
const mesh=layer.group.getObjectByName('Bridge decks and approaches');
assert.ok(mesh,'Bridge decks and graded approaches must be available in one tested layer');
const pos=mesh.geometry.attributes.position,ids=mesh.geometry.index;
const cells=new Map(),size=12,key=(x,z)=>Math.floor(x/size)+','+Math.floor(z/size);
for(let i=0;i<ids.count;i+=3){
  const tri=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(pos,ids.getX(i+k)));
  const [a,b,c]=tri,det=(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  if(Math.abs(det)<.0001) continue;
  for(let row=Math.floor(Math.min(a.z,b.z,c.z)/size);row<=Math.floor(Math.max(a.z,b.z,c.z)/size);row++)
    for(let col=Math.floor(Math.min(a.x,b.x,c.x)/size);col<=Math.floor(Math.max(a.x,b.x,c.x)/size);col++){
      const k=col+','+row;
      if(!cells.has(k)) cells.set(k,[]);
      cells.get(k).push(tri);
    }
}
function crossings(x,z){
  const hits=[];
  for(const [a,b,c] of cells.get(key(x,z))??[]){
    const bx=b.x-a.x,bz=b.z-a.z,cx=c.x-a.x,cz=c.z-a.z,det=bx*cz-bz*cx;
    const u=((x-a.x)*cz-(z-a.z)*cx)/det,v=(bx*(z-a.z)-bz*(x-a.x))/det;
    const rounding=.00017*Math.max(Math.hypot(bx,bz),Math.hypot(cx,cz))/Math.abs(det);
    if(u>=-rounding&&v>=-rounding&&u+v<=1+rounding) hits.push(a.y+(b.y-a.y)*u+(c.y-a.y)*v);
  }
  return hits;
}
let sections=0,approaches=0,positions=0,groundJoins=0;
const failures=[];
for(const way of driveData.ways){
  if(way.onDeck) continue;
  const frames=network.frames(way);
  for(let i=0;i+1<frames.length;i++){
    const ramp=network.approach(way,i);
    if(!way.bridge&&!ramp) continue;
    sections++;
    if(ramp) approaches++;
    const a=frames[i],b=frames[i+1];
    for(const f of [-.87,-.53,0,.53,.87]){
      const l=a(way.width*.5*f),r=b(way.width*.5*f);
      const steps=Math.ceil(Math.hypot(r[0]-l[0],r[2]-l[2])/.42);
      for(let j=0;j<=steps;j++){
        const t=j/steps,x=l[0]+(r[0]-l[0])*t,z=l[2]+(r[2]-l[2])*t,y=l[1]+(r[1]-l[1])*t;
        const road=network.sample(x,z,y);
        const hits=crossings(x,z);
        if(!hits.some(h=>Math.abs(h-road.y)<.04)) failures.push([way.id,i,+x.toFixed(2),+z.toFixed(2),+y.toFixed(2),+road.y.toFixed(2),hits.map(h=>+h.toFixed(2))]);
        if(way.bridge && !way.covered && !way.level) assert.ok(grid.heightAt(x,z)<road.y+.015,'Bare terrain penetrates bridge '+way.id+' at '+[x,z]);
        positions++;
      }
    }
    if(ramp){
      for(const frame of [a,b]) if(frame.weight===0){
        for(const f of [-.95,0,.95]){
          const [x,y,z]=frame(way.width*.5*f);
          assert.ok(Math.abs(y-grid.heightAt(x,z))<=.036,'Ramp must feather into the drivable ground at '+[x,z]);
          groundJoins++;
        }
      }
    }
  }
}
let sidewalkProbes=0;
for(const way of driveData.ways.filter(w=>w.onDeck)){
  const frames=network.frames(way);
  for(let i=0;i+1<frames.length;i++) for(const fraction of [-.6,0,.6]){
    const p=frames[i](way.width*.5*fraction),q=frames[i+1](way.width*.5*fraction);
    for(let j=0;j<=5;j++){
      const t=j/5,x=p[0]+(q[0]-p[0])*t,z=p[2]+(q[2]-p[2])*t,y=p[1]+(q[1]-p[1])*t;
      const hits=crossings(x,z),h=network.sample(x,z,y).y;
      if(!hits.some(v=>Math.abs(v-h)<.04) || Math.abs(y-h)>.48) failures.push([way.id,i,+x.toFixed(2),+z.toFixed(2),+y.toFixed(2),+h.toFixed(2),hits.map(n=>+n.toFixed(2))]);
      sidewalkProbes++;
    }
  }
}
const independentDecks=driveData.ways.filter(w=>w.bridge&&!w.onDeck);
assert.equal(sections-approaches,independentDecks.reduce((sum,w)=>sum+w.points.length-1,0));
assert.ok(approaches>100&&positions>16000&&groundJoins>50);
assert.equal(failures.length,0,'Rendered deck and tire mismatch: '+JSON.stringify(failures.slice(0,12)));
const portals=new Map();
for(const w of driveData.ways.filter(w=>w.bridge&&!w.onDeck)) for(const i of [0,w.points.length-1]){
  const [x,y,z]=w.points[i];
  if(!w.covered && !w.level) portals.set(x+','+z,{way:w,i,y});
}
let connected=0;
for(const w of driveData.ways.filter(w=>!w.bridge)){
  for(let i=0;i<w.points.length;i++){
    const [x,,z]=w.points[i],portal=portals.get(x+','+z);
    if(!portal||w.kind!==portal.way.kind) continue;
    const ramp=network.frames(w)[i],deck=network.frames(portal.way)[portal.i];
    assert.equal(ramp.weight,1,'Connected abutment lost at '+w.id);
    for(const f of [-1,0,1]){
      const p=deck(f*portal.way.width/2);
      const delta=Math.min(...[-1,1].map(sign=>{const q=ramp(sign*f*w.width/2);return Math.hypot(p[0]-q[0],p[1]-q[1],p[2]-q[2]);}));
      assert.ok(delta<.001,'Shared bridge cross-section splits at '+w.id+' by '+delta+' m');
    }
    connected++;
  }
}
assert.ok(connected>=20);
console.log(sidewalkProbes+' parallel sidewalk probes, '+positions+' rendered deck/contact probes, '+connected+' welded abutments, '+groundJoins+' terrain contacts and '+approaches+' approach segments.');

let shoulder=network.sample(72.45,169.5).y;
for(let i=1;i<=24;i++){
  const x=72.45+.05*i,contact=network.sample(x,169.5).y;
  assert.ok(Math.abs(contact-shoulder)<.09,'Pedestrian abutment has a step at '+x);
  assert.ok(crossings(x,169.5).some(y=>Math.abs(y-contact)<.04) || Math.abs(grid.heightAt(x,169.5)-contact)<.04);
  shoulder=contact;
}

for(const [x,z] of [[345.5,-306.3],[758.5,405.5]]){
  const ground=network.groundAt(x,z),contact=network.sample(x,z,ground);
  assert.ok(Math.abs(ground-contact.y)<.21,'Bridge fill intrudes on a steep river bank at '+x+','+z);
}
