import './building_test_imports.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DataTexture,ShaderLib} from 'three';
import {surveyMaterial} from '../building-materials.mjs';
import {buildArchitecture} from '../building-kernel.mjs';

function proceduralMaterial(material){
  for(const [key,value] of Object.entries(material))assert.ok(!value?.isTexture,'Building finish has a raster map on '+key);
  const shader={...ShaderLib.standard,uniforms:{}};
  material.onBeforeCompile(shader);
  for(const [name,uniform] of Object.entries(shader.uniforms)){
    if(!uniform.value?.isTexture)continue;
    assert.equal(uniform.value,material.userData.styles,'Building finish samples imagery through '+name);
    const width=uniform.value.image.width;
    assert.ok([11,13,15,17,19].includes(width));
    const table=uniform.value.image.data;
    for(let offset=40;offset<table.length;offset+=4*width)assert.ok(Math.abs(Math.hypot(table[offset],table[offset+1])-1)<1e-5,'Roof axis must be a unit vector');
    assert.ok(uniform.value.image.data instanceof Float32Array);
  }
}
const records=JSON.parse(readFileSync(new URL('../campus-buildings.json',import.meta.url)));
let surveys=0,patches=0;
const plants=new Set();
for(const {parts,id} of records)for(const part of parts){
  for(const feature of part.roof.features??[])if(feature.style==='measured roof plant')plants.add(id+JSON.stringify(feature.at));
  if(!part.roofFinish)continue;
  surveys++;
  for(const key of Object.keys(part.roofFinish))assert.ok(['color','weathering','repairs','roofAxis'].includes(key),id+' raster or unknown finish '+key);
  assert.ok(Number.isFinite(part.roofFinish.roofAxis) && part.roofFinish.roofAxis>=0 && part.roofFinish.roofAxis<=Math.PI,'Measured roof orientation');
  assert.match(part.roofFinish.color,/^#[a-f0-9]{6}$/i);
  assert.ok(part.roofFinish.weathering>=0 && part.roofFinish.weathering<=1);
  for(const repair of part.roofFinish.repairs??[]){assert.equal(repair.length,6);assert.ok(repair.every(Number.isFinite));patches++;}
}
assert.ok(surveys>350 && plants.size>75 && patches>15);
for(const id of ['w118764108','w118764094','w142286181','w118764092','r21319537-0']){
  const building=records.find(b=>b.id===id);
  for(const lod of [0,1,2]){
    const packet=buildArchitecture([building],lod);
    assert.ok(packet.palette.some(style=>style.roofSurface));
    const mat=surveyMaterial(packet.palette);
    proceduralMaterial(mat);
    mat.userData.styles.dispose();mat.dispose();
  }
}
const roofChannels=(id,part)=>records.find(b=>b.id===id).parts.find(p=>p.name===part).roofFinish.color.match(/[a-f0-9]{2}/gi).map(channel=>parseInt(channel,16));
const westminster=roofChannels('w126668348','East accommodation wing');
assert.ok(westminster[1]>westminster[0] && westminster[0]>westminster[2]+12 && westminster[1]<125,'Westminster olive membrane must retain its measured depth of colour in daylight');
const researchSlab=roofChannels('w527547917','Tall research slab');
assert.ok(Math.min(...researchSlab)>205,'The pale WIRB roof must retain its bright finish');
const repairs=Array.from({length:6},(_,i)=>[i*4,8,1.5,2,.12*i,.13*(i-2)]);
const patched=surveyMaterial([{kind:'membrane',color:'#666666',roofSurface:true,repairs}]);
proceduralMaterial(patched);
const {data,width}=patched.userData.styles.image;
assert.equal(width,19);
assert.equal(data[22],7);
for(const [i,[x,z,w,d,angle,tone]] of repairs.entries()){
  const offset=(i<2?6+2*i:11+2*(i-2))*4;
  assert.deepEqual([...data.slice(offset,offset+4)],[x,z,w,d]);
  assert.ok(Math.abs(data[offset+6]-tone)<1e-6 && Math.abs(data[offset+4]-Math.cos(angle))<1e-6);
}
patched.userData.styles.dispose();patched.dispose();
const ivy=records.find(b=>b.id==='w116779543').spec.materials.ivy;
const leaves=surveyMaterial([ivy]);
assert.equal(leaves.userData.styles.image.data[21],19,'Talbot foliage must use the surveyed vertical leaf finish');
leaves.userData.styles.dispose();leaves.dispose();
const pond=records.find(b=>b.id==='w144343833').parts.find(p=>p.name==='Apartment block').roofFinish.repairs;
const damp=(x,z)=>pond.some(([cx,cz,w,d,a,tone])=>{
  const dx=x-cx,dz=z-cz,co=Math.cos(a),si=Math.sin(a);
  return tone<-.35 && Math.abs(dx*co+dz*si)<w && Math.abs(dz*co-dx*si)<d;
});
for(const [x,z] of [[9,1528],[15.84,1524.97],[22.44,1522.47],[29.33,1519.7]])assert.ok(damp(x,z),'Missing surveyed drainage strip at '+[x,z]);
assert.ok(!damp(16,1518),'Roof weathering crosses the dry membrane');
const invalid=surveyMaterial([{kind:'membrane',color:'#777777'}]);
invalid.map=new DataTexture(new Uint8Array(4),1,1);
assert.throws(()=>proceduralMaterial(invalid),/raster map/);
invalid.map.dispose();invalid.userData.styles.dispose();invalid.dispose();
console.log(surveys+' procedural roof surveys, '+patches+' modeled repairs, '+plants.size+' separate measured plant positions, five models at three LODs');
