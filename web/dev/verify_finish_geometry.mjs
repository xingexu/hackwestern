import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import * as THREE from 'three';
import {createCarriageway,createLandscapeGrid,surfaceOwnership} from '../campus-terrain.mjs';

const read=name=>JSON.parse(readFileSync(new URL('../'+name+'.json',import.meta.url)));
const unpack=data=>Uint8Array.from(inflateSync(Buffer.from(data,'base64'))).buffer;
const region=read('campus-region'),world=read('world'),surface=read('surface-tiles');
const core=new Uint16Array(unpack(read('campus-ground').heightMillimeters));
const relief=new Int16Array(unpack(surface.relief.samples));
const streets=createCarriageway(THREE,surface.carriageway,new Uint8Array(unpack(surface.carriageway.samples)),region.bounds);
const coreAt=(x,z)=>core[Math.max(0,Math.min(world.depth-1,Math.round(z)))*world.width+Math.max(0,Math.min(world.width-1,Math.round(x)))]*.001;
const ground=createLandscapeGrid(region,world,coreAt,surface.relief,relief,streets.contains);
const land=read('ground-materials').landcover;
const cover=surfaceOwnership(land,new Uint8Array(unpack(land.samples)),new Uint8Array(unpack(land.transitions)));
const measured=JSON.parse(readFileSync(new URL('../../build/survey_parking.json',import.meta.url))).surveyedLots;
const lots=[...read('drive-network').areas.filter(a=>a.kind==='parking').map(a=>a.rings),...measured].map(rings=>{
  const xs=rings[0].filter((_,i)=>i%2===0),zs=rings[0].filter((_,i)=>i%2);
  return {rings,left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...zs),bottom:Math.max(...zs)};
});
function inside(ring,x,z){
  let result=false;
  for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
    const ax=ring[i],az=ring[i+1],bx=ring[j],bz=ring[j+1];
    if((az>z)!==(bz>z) && x<(bx-ax)*(z-az)/(bz-az)+ax) result=!result;
  }
  return result;
}
function parking(x,z){
  return lots.some(p=>x>=p.left && x<=p.right && z>=p.top && z<=p.bottom && inside(p.rings[0],x,z) && !p.rings.slice(1).some(h=>inside(h,x,z)));
}
let triangles=0,maximum=0,tested=0,stalls=0;
assert.deepEqual(Object.keys(surface.strokes).sort(),Object.keys(surface.tiles).sort());
for(const [key,colors] of Object.entries(surface.strokes)){
  const [i,j]=key.split(',').map(Number);
  for(const [kind,packed] of colors.entries()){
    const data=new Uint16Array(Uint8Array.from(Buffer.from(packed,'base64')).buffer);
    assert.equal(data.length%6,0);
    for(let k=0;k<data.length;k+=6){
      const corners=[];
      for(let v=0;v<3;v++){
        const x=region.xs[i]+data[k+v*2]/128,z=region.zs[j]+data[k+v*2+1]/128;
        corners.push([x,ground.heightAt(x,z),z]);
      }
      for(const w of [[0,0,1],[0,1,0],[1,0,0],[.5,.5,0],[0,.5,.5],[.5,0,.5],[.333,.333,.334]]){
        const [x,y,z]=[0,1,2].map(c=>corners.reduce((n,p,i)=>n+w[i]*p[c],0));
        const error=Math.abs(y-ground.heightAt(x,z));
        assert.ok(error<.010,'Paint diverges from terrain at '+x+','+z+' by '+error+'m');
        assert.ok(kind>=2?parking(x,z)&&cover(x,z)===5&&!streets.contains(x,z):streets.contains(x,z),'A painted stripe is outside its paved area at '+x+','+z);
        maximum=Math.max(maximum,error);
        tested++;
      }
      triangles++;if(kind>=2) stalls++;
    }
  }
}
assert.ok(triangles>20000 && stalls>200);
console.log(triangles+' terrain-conforming paint triangles, '+tested+' paint probes, maximum road clearance error '+maximum.toFixed(5)+' m.');
