import {conformPlantings} from "../campus-terrain.mjs";
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createRoadNetwork} from '../drive-network.mjs';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createLandscapeGrid,surveyImageURL,createCarriageway,landcoverAt,walkwaySampler,surfaceOwnership} from '../campus-terrain.mjs';

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
const grosvenorLoop=driveData.ways.find(way=>way.id===258791963);
assert.ok(grosvenorLoop.points.every(([x,,z])=>streets.contains(x,z)),'The whole Grosvenor service loop must have a continuous paved surface');
for(const [x,z] of [[-945,1516],[-919,1516],[1484.61,586.26],[1381.49,1422.32],[1377.34,1422.51],[1374.26,1420.95]]) {
  assert.equal(streets.contains(x,z),true,`Continuous surveyed asphalt expected at ${x},${z}`);
  const contact=network.sample(x,z);
  assert.equal(contact.surface,'road');
  assert.equal(contact.y,grid.heightAt(x,z),'Pavement and vehicle must use the same facet');
}
assert.ok(streets.curbs.length>100);
const cover=landcoverAt(surface.groundCover,new Uint8Array(decode(surface.groundCover.samples)),region.bounds);
assert.ok(region.trees.some(([x,,z])=>cover(x,z)===1),'Surveyed water must exclude submerged canopy peaks');
streets.texture.dispose();
assert.equal(grid.xs[grid.startsX.at(-1)],region.xs.at(-1));
assert.equal(grid.zs[grid.startsZ.at(-1)],region.zs.at(-1));
assert.equal(grid.heights.length,grid.xs.length*grid.zs.length);
assert.ok(grid.heights.every(Number.isFinite));
let maxJump=0, compared=0;
function crossing(x,z,dx,dz) {
  const jump=Math.abs(grid.heightAt(x+dx,z+dz)-grid.heightAt(x-dx,z-dz));
  maxJump=Math.max(maxJump,jump);
  assert.ok(jump<.025,`Open terrain join at ${x},${z}: ${jump} m`);
  compared++;
}
for(let i=0;i<region.xs.length;i+=24) for(const z of grid.zs) crossing(region.xs[i],z,.001,0);
for(let i=0;i<region.zs.length;i+=24) for(const x of grid.xs) crossing(x,region.zs[i],0,.001);
for(const z of grid.zs.filter(z=>z>=0&&z<=world.depth)) {
  crossing(0,z,.001,0);crossing(world.width,z,.001,0);
}
for(const x of grid.xs.filter(x=>x>=0&&x<=world.width)) {
  crossing(x,0,0,.001);crossing(x,world.depth,0,.001);
}
let maxContactError=0;
for(let j=0;j<grid.zs.length-1;j+=13) for(let i=0;i<grid.xs.length-1;i+=17) {
  const at=j*grid.xs.length+i;
  const x=grid.xs[i]*.8+grid.xs[i+1]*.2,z=grid.zs[j]*.6+grid.zs[j+1]*.4;
  const expected=.4*grid.heights[at]+.2*grid.heights[at+1]+.4*grid.heights[at+grid.xs.length];
  maxContactError=Math.max(maxContactError,Math.abs(grid.heightAt(x,z)-expected));
}
assert.ok(maxContactError<.000001);
assert.equal(surveyImageURL('./assets/foliage.webp'),'./assets/foliage.webp');
assert.equal(surveyImageURL('c2FtcGxl'),'data:image/webp;base64,c2FtcGxl');
console.log(`Terrain: ${compared} tile/core seam locations, max step ${maxJump.toFixed(4)} m across 2 mm, rendered facet vs contact error ${maxContactError.toFixed(8)} m.`);

const coreTrees=read('drive-trees'),municipal=read('municipal-detail'),survey=read('canopy-survey');
const rawTreeCount=region.trees.length+coreTrees.trees.length;
conformPlantings(region,coreTrees,municipal,survey,network);
const geographicTrees=[...region.trees,...coreTrees.trees];
assert.ok(geographicTrees.length<rawTreeCount);
for(const [x,y,z] of geographicTrees){
  assert.ok(network.plantable(x,z) && !streets.contains(x,z));
  assert.equal(y,grid.heightAt(x,z));
}
for(const record of [...Object.values(municipal.tiles).flatMap(t=>t.trees??[]),...Object.values(survey.tiles).flatMap(t=>t.stems??[])]){
  assert.ok(network.plantable(record[0],record[1]));
}
console.log('Tree trunks checked against building footprints, mapped water, paths and pavement across all four inventories.');

const boundary=await import('../campus-clip.js').then(m=>m.campusFootprint(read('campus-boundary')));
const land=read('ground-materials').landcover;
const classAt=surfaceOwnership(land,new Uint8Array(decode(land.samples)),new Uint8Array(decode(land.transitions)));
const walkway=walkwaySampler(surface.walkways.map(t=>({...t,spans:new Uint16Array(decode(t.samples))})));
const actual=createRoadNetwork(driveData,region,grid.heightAt,streets.contains,(x,z)=>walkway(x,z)?13:classAt(x,z));
const {createCampusRoads}=await import('../campus-roads.js');
createCampusRoads(driveData,actual,streets);
let inspected=0,kerbs=0,paths=0,worst=0;
for(let j=0;j<grid.zs.length-1;j++)for(let i=0;i<grid.xs.length-1;i++){
  const x0=grid.xs[i],x1=grid.xs[i+1],z0=grid.zs[j],z1=grid.zs[j+1];
  if(!boundary.contains((x0+x1)/2,(z0+z1)/2))continue;
  const at=j*grid.xs.length+i,stride=grid.xs.length;
  for(const side of [0,1]){
    const x=side?x1*.7+x0*.3:x1*.3+x0*.7,z=side?z1*.8+z0*.2:z1*.2+z0*.8;
    const triangle=side?[at+stride+1,at+stride,at+1]:[at,at+1,at+stride];
    const weights=[.5,.3,.2];
    const rendered=weights.reduce((sum,w,k)=>sum+w*grid.heights[triangle[k]],0);
    crossing(x0,z,.001,0);crossing(x,z0,0,.001);
    if(actual.isDeck(x,z))continue;
    const hit=actual.sample(x,z,rendered);
    const error=Math.abs(hit.y-hit.curb-rendered);
    assert.ok(error<.002,'Tire height disagrees with the visible terrain at '+[x,z,error]);
    worst=Math.max(worst,error);
    inspected++;
    if(hit.curb>0)kerbs++;
    if(walkway(x,z)&&!streets.contains(x,z)){
      assert.equal(hit.surface,hit.curb>0&&hit.curb<.03?'road':'path');
      paths++;
    }
  }
}
assert.ok(inspected>200000&&kerbs>200&&paths>500);
console.log(inspected+' campus facet contacts, '+kerbs+' raised kerbs, '+paths+' sidewalk contacts, max facet residual '+worst.toFixed(6)+' m.');
