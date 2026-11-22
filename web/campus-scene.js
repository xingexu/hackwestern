import {rasterBytes,surveyTexture} from './survey-raster.mjs';
import {prepareReflections} from './look/reflections.mjs';
import {boundaryEcology,coveredCourts,weatheringSamples,weatheringSize} from './look/survey-weathering.mjs';
import {landscapeBackground} from './look/landscape-background.mjs';
import {campusClip} from 'campus-clip';
import {createDrivingHorizon,createCampusContext,campusEntranceMarker} from 'driving-horizon';
import {removeGround} from 'core-volume';
import {retireSurveyedArchitecture,createCampusBuildings,fitArchitecture,addBoundaryHousing,pruneBuildingTrees} from 'campus-buildings';
import {campusAmbience} from './audio/world.mjs';
import { createSurveyCanopy } from 'survey-canopy';
import {createMunicipalDetail,addSurveyedGround,surveyConductors,fitSurveyedTrees,reconcileTreeObservations,createContextTrees} from 'municipal-detail';
import * as THREE from 'three';
import { createLandscapeGrid, groundDetailGLSL, walkwaySampler, packLandClasses, surfaceOwnership, surveyImageURL, landcoverAt, createVergeDetail, createCarriageway, conformPlantings, installEstateSurfaces } from 'campus-terrain';
import {padLandcover} from './look/materials.mjs';
import {surfaceCoverage,surveyedPavingTone,walkwayGuide} from './look/surface-response.mjs';
import {foundationLight} from './look/ground-light.mjs';
import { createCampusRegion } from 'campus-region';
import { createStreetDetail, clearOfPavement, roadsidePosition } from 'street-detail';
import { createCampusTrees } from 'drive-trees';
import { createRoad } from 'drive-road';

import { createRoadNetwork } from 'drive-network';
import { createCampusRoads } from 'campus-roads';
import { createRegionDetail, pruneStadiumTrees } from 'region-detail';

async function data(name) {
  const embedded = document.getElementById('embedded-' + name);
  if (embedded?.dataset.compression === 'deflate') return JSON.parse(new TextDecoder().decode(await unpack(embedded.textContent)));
  if (embedded) return JSON.parse(embedded.textContent);
  const response = await fetch(globalThis.campusAssetUrls?.[name+'.json']??'./'+name+'.json');
  if (!response.ok) throw new Error('Could not load ' + name);
  return response.json();
}

async function unpack(encoded) {
  if(typeof encoded==='object')return rasterBytes(encoded);
  let stream;
  if(encoded.startsWith('./')){
    const response=await fetch(encoded);
    if(!response.ok) throw new Error('Could not load campus terrain.');
    stream=response.body;
  }else{
    const bytes=typeof Uint8Array.fromBase64==='function'?Uint8Array.fromBase64(encoded):Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    stream=new Blob([bytes]).stream();
  }
  return new Response(stream.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
}

async function coreTerrain(world,volume,ground) {
  const {width,depth}=world;
  const heightBytes=await unpack(ground.heightMillimeters);
  const heights=new Uint16Array(heightBytes),step=ground.heightStep??1;
  const columns=Math.ceil((width-1)/step)+1,rows=Math.ceil((depth-1)/step)+1;
  if(heights.length!==columns*rows) throw new Error('Campus terrain dimensions do not match the map.');
  if(volume) removeGround(volume,new Uint8Array(await unpack(ground.cut)));
  return (x,z) => {
    if(x<0||x>=width||z<0||z>=depth) return NaN;
    const ix=Math.floor(x/2)*2, iz=Math.floor(z/2)*2;
    const at=(xx,zz)=>heights[Math.ceil(Math.min(depth-1,zz)/step)*columns+Math.ceil(Math.min(width-1,xx)/step)]*.001;
    const u=(x-ix)/2, v=(z-iz)/2;
    return u+v<=1 ? at(ix,iz)*(1-u-v)+at(ix+2,iz)*u+at(ix,iz+2)*v :
      at(ix+2,iz+2)*(u+v-1)+at(ix+2,iz)*(1-v)+at(ix,iz+2)*(1-u);
  };
}

function stoneMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.customProgramCacheKey = () => 'campus-stone';
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 blockPoint; varying vec3 blockFace;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nblockPoint = position; blockFace = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 blockPoint; varying vec3 blockFace;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 wall = vec2(abs(blockFace.z) > .5 ? blockPoint.x : blockPoint.z, blockPoint.y);
        vec2 blocks = wall / vec2(.64, .28);
        blocks.x += .5 * mod(floor(blocks.y), 2.);
        vec2 joints = min(fract(blocks), 1. - fract(blocks));
        float joint = 1. - smoothstep(.015, .065, min(joints.x, joints.y));
        float stone = fract(sin(dot(mod(floor(blocks), 233.), vec2(13.71, 7.92))) * 413.43);
        float masonry = smoothstep(.015, .065, diffuseColor.r - diffuseColor.b) * (1. - abs(blockFace.y));
        float detail = 1. - smoothstep(.1, .8, max(fwidth(wall.x), fwidth(wall.y)));
        diffuseColor.rgb *= 1. + masonry * detail * ((stone - .5) * .15 - joint * .26);`);
  };
  return material;
}

export async function prepareCampus(world, volume, racing, includeBuildings=true) {
  const [ground, region, detail, trees, samples, roadData, features, aerial, survey, municipalData, groundMaterials, facadeData,signData,boundaryData,park,buildings] = await Promise.all(
    ['campus-ground','campus-region','street-detail','drive-trees','drive-route','drive-network','region-detail','surface-tiles','canopy-survey','municipal-detail','ground-materials','streetview-facades','street-signs','campus-boundary','driving-horizon','campus-buildings'].map(data));
  if(groundMaterials.landcover.observations)addSurveyedGround(groundMaterials.landcover.observations,municipalData,features);
  const boundary=campusClip(THREE,boundaryData);
  reconcileTreeObservations(municipalData.furniture,region,trees,municipalData,survey);
  detail.furnitureStyles=features.furnitureStyles=municipalData.furniture?.styles;
  detail.signalBases=municipalData.furniture?.signalBases;
  region.regionalHabits=new Map((municipalData.woodlots?.regionalHabits??[]).map(([x,z,form])=>[x+','+z,form]));
  region.campusBoundary=boundary;
  roadData.campusBoundary=boundaryData;
  roadData.pavementSurvey=aerial.pavementSurvey;
  roadData.insideCampus=boundary.contains;
  for(const [layer,size] of [[features,features.tileSize],[survey,survey.tileSize],[municipalData,municipalData.size]]){
    for(const key of Object.keys(layer.tiles)){
      const [i,j]=key.split(/[:,]/).map(Number);
      if(!boundary.intersects(i*size,j*size,(i+1)*size,(j+1)*size))delete layer.tiles[key];
    }
  }
  for(const tile of Object.values(features.tiles)){
    if(tile.p)tile.p=tile.p.filter(p=>boundary.contains(p[2],p[4]));
  }
  for(const tile of Object.values(municipalData.tiles)){
    for(const key of ['trees','lamps'])if(tile[key])tile[key]=tile[key].filter(p=>key==='trees'?boundary.containsDisc(p[0],p[1],p[4]+.10):boundary.contains(p[0],p[1]));
  }
  for(const tile of facadeData.tiles){
    tile.panels=tile.panels.filter(([x,z,ex,ez])=>boundary.intersects(Math.min(x,ex),Math.min(z,ez),Math.max(x,ex),Math.max(z,ez)));
  }
  features.signRecords=signData.records;
  const credit=document.getElementById('sign-credits');
  if(credit){
    const contributors=[];
    for(const record of Object.values(signData.records))for(const image of record.evidence??[]){
      if(contributors.some(item=>item.author===image.author))continue;
      contributors.push(image);
    }
    credit.replaceChildren(...contributors.map(image=>{
      const link=document.createElement('a');
      link.href=image.source;link.target='_blank';link.rel='noreferrer';
      link.textContent='Street sign survey · '+image.author+' on KartaView';
      return link;
    }));
  }
  aerial.groundMaterials=groundMaterials.tiles;
  region.buildingBases=roadData.buildingBases;
  world.unifiedBuildings=true;
  pruneStadiumTrees(region,features);
  retireSurveyedArchitecture(features,buildings);
  const stone=stoneMaterial();
  const [coreAt,reliefBytes,preview,coverBytes,carriageBytes]=await Promise.all([
    coreTerrain(world,volume,ground),unpack(aerial.relief.samples),
    racing?new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1):new THREE.TextureLoader().loadAsync(surveyImageURL(aerial.preview)),unpack(aerial.groundCover.samples),unpack(aerial.carriageway.samples)
  ]);
  const carriageway=createCarriageway(THREE,aerial.carriageway,new Uint8Array(carriageBytes),region.bounds);
  const landscape=createLandscapeGrid(region,world,coreAt,aerial.relief,new Int16Array(reliefBytes),carriageway.contains);
  landscape.preview=preview;
  landscape.racing=Boolean(racing);
  const outlines=aerial.walkwayOutlines;
  if(outlines)landscape.walkwayGuide=walkwayGuide(outlines.tiles,new Uint16Array(await unpack(outlines.coordinates)),roadData.ways);
  const landBytes=await unpack(groundMaterials.landcover.samples);
  const land=groundMaterials.landcover;
  await prepareReflections();
  const fringe=new THREE.DataTexture(new Uint8Array(await unpack(boundaryEcology.samples)),boundaryEcology.width,boundaryEcology.height,THREE.RGFormat);
  fringe.minFilter=fringe.magFilter=THREE.LinearFilter;fringe.needsUpdate=true;
  landscape.fringe=fringe;landscape.fringeBounds=new THREE.Vector4(...boundaryEcology.bounds);
  const vigor=land.vigor;
  const [growth,wear]=await Promise.all([vigor.samples,weatheringSamples].map(unpack));
  const turf=new Uint8Array(growth),pavementWear=new Uint8Array(wear),surface=new Uint8Array(turf.length*2);
  for(let z=0;z<vigor.height;z++)for(let x=0;x<vigor.width;x++){
    const index=z*vigor.width+x;
    surface[index*2]=turf[index];
    surface[index*2+1]=pavementWear[Math.floor(z*weatheringSize/vigor.height)*weatheringSize+Math.floor(x*weatheringSize/vigor.width)];
  }
  landscape.grassVigor=new THREE.DataTexture(surface,vigor.width,vigor.height,THREE.RGFormat);
  const surfaceDetail=land.pavementDetail;
  landscape.pavementDetail=surfaceDetail?await surveyTexture(THREE,surfaceDetail.samples,surfaceDetail.width,surfaceDetail.height,land.bounds??region.bounds,unpack):new THREE.DataTexture(new Uint8Array([0,0,128,128]),1,1);
  landscape.pavementDetail.minFilter=landscape.pavementDetail.magFilter=THREE.LinearFilter;
  landscape.pavementDetail.needsUpdate=true;
  const tone=land.pavingTone;
  if(tone){
    const mineral=tone.aggregate?new Uint8Array(await unpack(tone.aggregate)):null;
    const paving=surveyedPavingTone(new Uint8Array(await unpack(tone.samples)),tone,land.bounds??region.bounds,roadData.areas,coveredCourts,mineral);
    if(tone.courts){
      const courts=new Uint8Array(await unpack(tone.courts));
      for(let i=0;i<courts.length;i++)paving[i*4+2]=Math.max(paving[i*4+2],courts[i]);
    }
    if(tone.shadedLawn){
      const shade=new Uint8Array(await unpack(tone.shadedLawn));
      for(let i=0;i<shade.length;i++)paving[i*4+3]=shade[i];
    }
    if(tone.frontages){
      const survey=new Uint8Array(await unpack(tone.frontages));
      for(let p=0;p<survey.length;p+=2){
        const coverage=(survey[p]>>3)/31,kind=survey[p]&7,index=p*2;
        if(!coverage)continue;
        paving[index+1]+=coverage*((kind===5?255:0)-paving[index+1]);
        paving[index+2]+=coverage*((kind===3?255:0)-paving[index+2]);
        if((kind===5 || kind===6) && mineral){
          const tone=survey[p+1];
          paving[index]+=coverage*(tone-paving[index]);
          mineral[index]+=coverage*(tone-mineral[index]);
          mineral[index+1]+=coverage*(tone-mineral[index+1]);
        }
      }
    }
    const layers=new Uint8Array(paving.length*2);
    layers.set(paving);
    if(mineral)layers.set(mineral,paving.length);
    landscape.pavingTone=new THREE.DataArrayTexture(layers,tone.width,tone.height,2);
    landscape.pavingTone.magFilter=THREE.LinearFilter;landscape.pavingTone.minFilter=THREE.LinearMipmapLinearFilter;
    landscape.pavingTone.generateMipmaps=true;
    landscape.pavingTone.userData.woodlandEdges=!!tone.woodlandEdges;
    landscape.pavingTone.needsUpdate=true;
  }
  landscape.grassVigor.minFilter=landscape.grassVigor.magFilter=THREE.LinearFilter;
  landscape.grassVigor.needsUpdate=true;
  const coverClasses=new Uint8Array(landBytes);
  const blendBytes=new Uint8Array(await unpack(land.transitions));
  const padded=padLandcover(coverClasses,blendBytes,land.width);
  landscape.surfaceCoverage=surfaceCoverage(padded.cover,land.width,land.height);
  landscape.landTransitions=new THREE.DataTexture(packLandClasses(padded.cover,padded.blend),land.width,land.height);
  landscape.landTransitions.userData.bounds=land.bounds??region.bounds;
  landscape.landTransitions.needsUpdate=true;
  const extendEstateWays=installEstateSurfaces(THREE,landscape,carriageway,groundMaterials.estates,new Uint8Array(await unpack(groundMaterials.estates.coverage)));
  landscape.pavement=carriageway.texture;
  landscape.regionBounds=region.bounds;
  const coverSamples=new Uint8Array(coverBytes);
  const cover=landcoverAt(aerial.groundCover,coverSamples,region.bounds);
  region.trees=region.trees.filter(([x,,z,h])=>boundary.containsDisc(x,z,Math.min(8,h*.42+1))&&cover(x,z)!==1);
  trees.trees=trees.trees.filter(([x,,z,r])=>boundary.containsDisc(x,z,r+1));
  for(const tile of Object.values(survey.tiles)){
    if(tile.stems)tile.stems=tile.stems.filter(([x,z,h])=>boundary.containsDisc(x,z,Math.min(11,h*.47+1)));
  }
  const coverAt=surfaceOwnership(land,padded.cover,padded.blend);
  landscape.permitsContextTree=(x,z)=>!carriageway.contains(x,z)&&![5,6,12,13].includes(coverAt(x,z));
  const verges=createVergeDetail(THREE,landscape,cover);
  const estateGround=createDrivingHorizon(THREE,park,landscape);
  const context=racing&&land.context?await createCampusContext(THREE,land.context,landscape,unpack,groundDetailGLSL,createContextTrees):null;
  const backdrop=racing?await landscapeBackground(region,landscape,boundary,{...aerial.groundCover,data:coverSamples},unpack,land.context?.backdrop,context?.userData.vertices):null;
  extendEstateWays(roadData.ways);
  const walkwayBuffer=aerial.walkwaySamples?await unpack(aerial.walkwaySamples):null;
  const walkways=aerial.walkways.filter(tile=>boundary.intersects(...tile.bounds));
  const walkAt=walkwaySampler(await Promise.all(walkways.map(async tile=>({...tile,spans:walkwayBuffer?
    new Uint16Array(walkwayBuffer,tile.offset*2,tile.length):new Uint16Array(await unpack(tile.samples))}))));
  addBoundaryHousing(buildings,region);
  region.buildingSolids=fitArchitecture(buildings,landscape.heightAt,roadData.ways);
  if(includeBuildings)landscape.foundationLight=foundationLight(buildings);
  region.renderedTreeContacts=true;
  region.renderedBarrierNodes=new Set(Object.values(features.tiles).flatMap(tile=>(tile.p??[]).map(([kind,,x,,z])=>kind+':'+x.toFixed(2)+':'+z.toFixed(2))));
  for(const key of features.retiredBarrierNodes??[])region.renderedBarrierNodes.add(key);
  function groundClass(x,z){
    if(z>groundMaterials.estates.bounds[1])return landscape.estatesAt(x,z);
    const base=coverAt(x,z);
    return base===6?6:walkAt(x,z)?13:base;
  }
  const fenceOffsets=new Map((municipalData.furniture?.roadsideFences??[]).map(([id,dx,dz])=>[id,[dx,dz]]));
  const oldFenceVertices=new Set();
  for(const entry of Object.values(features.tiles))for(const line of entry.l??[]){
    const shift=fenceOffsets.get(line[1]);
    if(!shift||line[0]!=='fence')continue;
    for(const j of [2,5]){
      const x=line[j],z=line[j+2],length=Math.hypot(...shift);
      oldFenceVertices.add(x.toFixed(1)+','+z.toFixed(1));
      for(let d=0;d<=9;d+=.25){
        const X=x+shift[0]*d/length,Z=z+shift[1]*d/length;
        if(carriageway.contains(X,Z)||[5,12].includes(groundClass(X,Z)))continue;
        line[j]=X+shift[0]*.3/length;line[j+2]=Z+shift[1]*.3/length;
        break;
      }
    }
  }
  roadData.barriers=roadData.barriers.filter(([kind,points])=>kind!=='fence'||points.length<4||!points.every((v,i)=>i%2||oldFenceVertices.has(v.toFixed(1)+','+points[i+1].toFixed(1))));
  const network=createRoadNetwork(roadData,region,landscape.heightAt,carriageway.contains,groundClass);
  landscape.canGrowGrass=(x,z)=>[0,1,2,11].includes(groundClass(x,z))&&!carriageway.contains(x,z);
  landscape.addBranch=network.addBranch;
  landscape.addShell=network.addShell;
  landscape.isDeck=network.isDeck;
  landscape.paintable=(x,z)=>!network.isDeck(x,z)&&network.sample(x,z).surface==='road';
  const paved=(x,z)=>carriageway.contains(x,z)||[5,12].includes(groundClass(x,z));
  const poleSite=(x,z)=>boundary.contains(x,z)&&groundClass(x,z)!==6&&network.crownClear(x,network.groundAt(x,z)+2,z,.5,2);
  network.roadsidePosition=(x,z,yaw,side)=>roadsidePosition(x,z,yaw,side,paved,poleSite);
  for(const tile of Object.values(features.tiles)){
    if(tile.p)tile.p=tile.p.filter(row=>{
      if(row[0]==='picnic_table'||row[0]==='bench'){
        const [kind,,x,,z,heading]=row;
        const clearance=kind==='bench'?.92:1.36;
        if(clearOfPavement(x,z,carriageway.contains,clearance))return true;
        const site=roadsidePosition(x,z,heading,1,carriageway.contains,(X,Z)=>poleSite(X,Z)&&network.crownClear(X,network.groundAt(X,Z)+.65,Z,clearance,.65),clearance,8);
        if(!site)return false;
        const finish=features.fixtureFinishes?.get([kind,x,z].join(','));
        [row[2],row[4]]=site;
        if(finish)features.fixtureFinishes.set([kind,...site.slice(0,2)].join(','),finish);
        return true;
      }
      const shelter=row[0]==='shelter'&&row[1]<=-10000;
      if(row[0]!=='traffic_signals'&&!shelter)return true;
      const site=shelter?roadsidePosition(row[2],row[4],row[5],row[7],paved,(x,z)=>poleSite(x,z)&&network.crownClear(x,network.groundAt(x,z)+1.2,z,1.85,1.3),1.85):network.roadsidePosition(row[2],row[4],row[5],row[7]);
      if(!site)return false;
      [row[2],row[4]]=site;
      if(!shelter)row[5]=site[2];
      return true;
    });
  }
  for(const tile of Object.values(municipalData.tiles)){
    if(tile.lamps)tile.lamps=tile.lamps.filter(row=>{
      if(!carriageway.contains(row[0],row[1]))return true;
      const site=network.roadsidePosition(row[0],row[1],row[3],1);
      if(!site)return false;
      [row[0],row[1]]=site;
      return true;
    });
  }
  surveyConductors(municipalData,network,boundary);
  const courts=Object.values(features.tiles).flatMap(tile=>tile.a??[]).filter(row=>row[0]==='tennis');
  const occupied=(municipalData.furniture?.siteStructures??[]).filter(([kind])=>['field_shed','parking_enclosure','park_enclosure','shipping_container','survey_bleachers','gate_island'].includes(kind));
  const offCourt=(x,z)=>!occupied.some(([,cx,cz,yaw,w,l])=>{
    const dx=x-cx,dz=z-cz,c=Math.cos(yaw),s=Math.sin(yaw);
    return Math.abs(dx*c-dz*s)<w*.5+.16&&Math.abs(dx*s+dz*c)<l*.5+.16;
  })&&!courts.some(([,,cx,,cz,yaw,w,l])=>{
    const dx=x-cx,dz=z-cz,c=Math.cos(yaw),s=Math.sin(yaw);
    return Math.abs(dx*c-dz*s)<w*.5+.4&&Math.abs(dx*s+dz*c)<l*.5+.4;
  });
  trees.trees=trees.trees.filter(([x,,z])=>offCourt(x,z));
  region.trees=region.trees.filter(([x,,z])=>offCourt(x,z));
  for(const tile of Object.values(municipalData.tiles))if(tile.trees)tile.trees=tile.trees.filter(([x,z])=>offCourt(x,z));
  for(const tile of Object.values(survey.tiles))if(tile.stems)tile.stems=tile.stems.filter(([x,z])=>offCourt(x,z));
  fitSurveyedTrees(municipalData,boundary,network,offCourt);
  pruneBuildingTrees(region,trees,municipalData,network);
  conformPlantings(region,trees,municipalData,survey,network,carriageway.contains);
  const outer=createCampusRegion(THREE,region,world,aerial,stone,null,landscape);
  const vegetation = await createCampusTrees(volume, trees, racing ? samples : [],network);
  const roads = createCampusRoads(roadData,network,carriageway);
  const furnishings = createRegionDetail(THREE,features,region,network,landscape);
  let canopyRevision=0,previousCanopy=-1;
  const springRoots=new Set(Object.values(municipalData.tiles).flatMap(t=>(t.trees??[]).filter(row=>row[5]===10).map(([x,z])=>x+','+z)));
  for(const tile of Object.values(survey.tiles))if(tile.springReturns)
    tile.springReturns=tile.springReturns.filter(([x,z])=>springRoots.has(x+','+z));
  const canopy=createSurveyCanopy(survey,network,()=>{canopyRevision++;outer.userData.onTextureReady?.();},boundary);
  for(const tree of land.shrubs){
    if(!boundary.containsDisc(tree[0],tree[1],1+tree[2]*.45)||!network.plantable(tree[0],tree[1]))continue;
    const key=Math.floor(tree[0]/municipalData.size)+':'+Math.floor(tree[1]/municipalData.size);
    const tile=municipalData.tiles[key]??={};
    (tile.shrubs??=[]).push(tree);
  }
  const innerTiles={},edgeTiles={};
  for(const [key,tile] of Object.entries(municipalData.tiles)){
    const inner=[],edge=[];
    for(const tree of tile.trees??[]){
      const [x,z,,radius]=tree;
      (boundary.containsDisc(x,z,radius*1.48+.25)?inner:edge).push(tree);
    }
    innerTiles[key]=edge.length?{...tile,trees:inner}:tile;
    if(edge.length)edgeTiles[key]={trees:edge};
  }
  const municipal=createMunicipalDetail(THREE,{...municipalData,tiles:innerTiles},region,network,landscape);
  const edgeCanopy=createMunicipalDetail(THREE,{size:municipalData.size,tiles:edgeTiles},region,network,landscape);
  edgeCanopy.group.name='Campus boundary trees';
  edgeCanopy.group.userData.parcelRootedCanopy=true;
  const facades=await createCampusBuildings(includeBuildings?buildings:[],facadeData.frames,()=>outer.userData.onTextureReady?.());
  const scenery = new THREE.Group();
  scenery.add(estateGround);
  const exitMarker=racing?campusEntranceMarker(THREE,roadData,network,boundary):null;
  if(exitMarker)scenery.add(exitMarker);
  scenery.add(canopy.group,municipal.group,edgeCanopy.group,facades.group);
  scenery.add(verges.group,vegetation, outer, createStreetDetail(THREE, detail,network),roads.group,furnishings.group);
  const sprintRoad=racing ? createRoad(samples,network) : null;
  if(sprintRoad) scenery.add(sprintRoad);
  boundary.attach(scenery);
  function focusRasters(x,z){
    return Promise.all([landscape.pavementDetail.userData.focus?.(x,z),context?.userData.focusRaster?.(x,z)]);
  }
  let lastX,lastZ,lastDistance,revision=-1;
  function updateDetail(x,z,distance,force=false) {
    const stamp=outer.userData.updateAerial(x,z,distance);
    context?.userData.update(x,z);
    canopy.update(x,z,distance);
    facades.update(x,z,distance);
    municipal.update(x,z,distance);
    edgeCanopy.update(x,z,distance);
    if(!force && previousCanopy===canopyRevision && Math.hypot(x-lastX,z-lastZ)<7 && Math.abs(distance-lastDistance)<12 && stamp===revision) return false;
    focusRasters(x,z).catch(error=>console.warn(error.message));
    previousCanopy=canopyRevision;lastX=x; lastZ=z; lastDistance=distance; revision=stamp;
    vegetation.userData.updateLevels?.(x,z,distance);
    roads.update(x,z,distance);
    verges.update(x,z,distance);
    furnishings.update(x,z,distance);
    return true;
  }
  const ambience=racing?campusAmbience(region.trees,trees.trees,municipalData,roadData):null;
  return {ambience,scenery,backdrop,context,focusRasters,buildingMaterial:stone,boundary,bounds:boundary.bounds,labels:(region.labels??[]).filter(p=>boundary.contains(p.x,p.z)),samples,network,roadData,sprintRoad,...(new URLSearchParams(globalThis.location?.search).has('audit')?{auditSources:{region,survey,trees,municipalData,features,groundSettledNear:outer.userData.groundSettledNear}}:{}),photoFrames:facadeData.frames,buildingRecords:buildings,facades,updateDetail,
    paintReady:outer.userData.paintReady,
    onTextureReady(fn){outer.userData.onTextureReady=fn;},setCanopyCoverage(fn){outer.userData.setCanopyCoverage(fn);}};
}
