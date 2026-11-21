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
    assert.equal(uniform.value.image.width,11);
    const table=uniform.value.image.data;
    for(let offset=40;offset<table.length;offset+=44)assert.ok(Math.abs(Math.hypot(table[offset],table[offset+1])-1)<1e-5,'Roof axis must be a unit vector');
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
const invalid=surveyMaterial([{kind:'membrane',color:'#777777'}]);
invalid.map=new DataTexture(new Uint8Array(4),1,1);
assert.throws(()=>proceduralMaterial(invalid),/raster map/);
invalid.map.dispose();invalid.userData.styles.dispose();invalid.dispose();
console.log(surveys+' procedural roof surveys, '+patches+' modeled repairs, '+plants.size+' separate measured plant positions, five models at three LODs');
