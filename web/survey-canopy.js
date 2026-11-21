import * as THREE from 'three';
import {groundObstacles} from './ground-obstacles.mjs';
import {campusCanopyFilter} from 'campus-clip';
import {barkFinish,foliageCluster,leafSprayTexture,lightLeafBacks} from 'leaf-sprays';

const crownAttributes=`#include <common>
  attribute vec3 crownCenter;
  attribute vec3 crownNormal;
  attribute float crownRadius;
  float crownSeed(){return fract(dot(crownCenter,vec3(.217,.363,.193)));}
  mat2 crownTurn(){
    float yaw=crownSeed()*6.283185;
    return mat2(cos(yaw),sin(yaw),-sin(yaw),cos(yaw));
  }`;
const crownVertex=`
  vec3 spray=position;
  spray.xz=crownTurn()*(spray.xz*vec2(1.12,.86));
  spray.xz+=crownNormal.xz*spray.y*.37;
  vec3 transformed=crownCenter+crownRadius*vec3(spray.x,.8*spray.y-.09,spray.z);`;

function crownShape(shader){
  shader.vertexShader=shader.vertexShader.replace('#include <common>',crownAttributes).replace('#include <begin_vertex>',crownVertex);
}

function foliageMaterials(budding=false){
  const map=leafSprayTexture(budding),alphaTest=budding?.23:.38,side=THREE.DoubleSide;
  const depth=new THREE.MeshDepthMaterial({map,alphaTest,side,depthPacking:THREE.RGBADepthPacking});
  depth.customProgramCacheKey=()=>'survey-crown-depth';
  depth.onBeforeCompile=crownShape;
  const material=new THREE.MeshStandardMaterial({map,alphaTest,side});
  material.customProgramCacheKey=()=>'survey-leaf-volume';
  material.onBeforeCompile=shader=>{
    lightLeafBacks(shader);
    crownShape(shader);
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
      attribute vec3 crownColor;
      varying vec3 leafPosition;
      varying vec3 leafColor;`)
      .replace('#include <beginnormal_vertex>',`
        vec3 objectNormal=normal;
        objectNormal.xz=crownTurn()*objectNormal.xz;
        objectNormal=normalize(objectNormal*.68+crownNormal*.44+vec3(0.,.18,0.));`)
      .replace(crownVertex,crownVertex+`
        leafPosition=transformed;
        leafColor=crownColor*(1.14+.15*spray.y+.16*crownSeed());`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
      varying vec3 leafPosition;
      varying vec3 leafColor;`)
      .replace('#include <color_fragment>',`
        vec3 cell=floor(leafPosition*6.);
        float speck=fract(sin(dot(mod(cell,167.),vec3(12.71,32.93,17.87)))*31513.37);
        float fine=1.-smoothstep(.025,.14,length(fwidth(leafPosition)));
        diffuseColor.rgb*=leafColor*(1.+fine*(speck-.5)*.29);`);
  };
  return {material,depth};
}

function canopyEnvelope(data,first,count,siteX,siteZ,tx,tz){
  let meanX=0,meanZ=0,mxx=0,mzz=0,mxz=0;
  for(let i=0;i<count;i++){
    const off=(first+i)*12,x=siteX+data.getInt16(off,true)/32-tx,z=siteZ+data.getInt16(off+2,true)/32-tz;
    meanX+=x;meanZ+=z;mxx+=x*x;mzz+=z*z;mxz+=x*z;
  }
  meanX/=count;meanZ/=count;mxx=mxx/count-meanX*meanX;mzz=mzz/count-meanZ*meanZ;mxz=mxz/count-meanX*meanZ;
  const axis=.5*Math.atan2(2*mxz,mxx-mzz),delta=Math.hypot(mxx-mzz,2*mxz);
  const along=.76+1.77*Math.sqrt(Math.max(.05,(mxx+mzz+delta)*.5));
  const across=.76+1.77*Math.sqrt(Math.max(.05,(mxx+mzz-delta)*.5));
  const cx=tx+.86*meanX,cz=tz+.86*meanZ,c=Math.cos(axis),s=Math.sin(axis),seed=tx*.403+tz*.712;
  return (x,z,r)=>{
    const dx=x-cx,dz=z-cz,u=(dx*c+dz*s)/along,v=(dz*c-dx*s)/across;
    const az=Math.atan2(v,u),dist=Math.hypot(u,v);
    const edge=1+.10*Math.sin(3*az+seed)+.075*Math.sin(5*az-seed*1.34);
    const fraction=dist>edge?edge/dist:1;
    const jitter=Math.min(.36,r*.21);
    return [cx+dx*fraction+jitter*Math.sin(4.21*x+2.31*z),cz+dz*fraction+jitter*Math.cos(3.29*z-2.72*x),r*(1-.23*Math.min(1,dist)*Math.min(1,dist))];
  };
}

function buildTile(bytes,tile,foliage,size,network,boundary,bark,wood,budding=false){
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(data.byteLength!==tile.count*12) throw new Error('Canopy survey tile has incomplete records.');
  const stems=budding?tile.springReturns:tile.stems;
  const capacity=stems.reduce((n,stem)=>n+Math.ceil(stem[4]/(budding?2:1)),0);
  const centers=new Float32Array(capacity*3), normals=new Float32Array(centers.length);
  const colors=new Float32Array(centers.length), radii=new Float32Array(capacity);
  const color=new THREE.Color();
  const ownsCrown=boundary?campusCanopyFilter(boundary,stems.map(([x,z,h])=>[x,network.groundAt(x,z),z,h])):null;
  const segments=[],cameraWood=groundObstacles();
  let kept=0;
  for(const [tx,tz,height,first,count,surveyBase] of stems){
    const contour=canopyEnvelope(data,first,count,tile.col*size,tile.row*size,tx,tz);
    const floor=network.groundAt(tx,tz);
    const root=new THREE.Vector3(tx,floor-.08,tz);
    const fork=new THREE.Vector3(tx+.08,floor+height*.43,tz-.06);
    const angleOffset=(tx*.75487+tz*.56984)%6.283185;
    const arms=height>10?6:4;
    const elbows=new Map(),junctions=[];
    for(let record=first;record<first+count;record+=budding?2:1){
      const off=record*12;
      const [x,z,r]=contour(tile.col*size+data.getInt16(off,true)/32,tile.row*size+data.getInt16(off+2,true)/32,data.getUint8(off+11)/32);
      const y=floor+data.getInt16(off+4,true)/32-surveyBase;
      if(ownsCrown&&!ownsCrown(x,y,z,r))continue;
      if(!network.crownClear(x,y,z,r*1.32))continue;
      if(!budding){
        const bearing=(Math.atan2(z-tz,x-tx)-angleOffset+Math.PI*4)%(Math.PI*2);
        const sector=Math.floor(bearing*arms/(Math.PI*2));
        let elbow=elbows.get(sector);
        if(!elbow){
          const yaw=angleOffset+(sector+.5)*Math.PI*2/arms;
          const reach=height*(.06+.045*(.5+.5*Math.sin(yaw)));
          const junction=fork.clone().lerp(root,.07+sector/arms*.34);
          elbow=new THREE.Vector3(tx+Math.cos(yaw)*reach,floor+height*(.46+.12*sector/arms),tz+Math.sin(yaw)*reach);
          junctions.push(junction);
          segments.push([junction,elbow,.014*height]);
          elbows.set(sector,elbow);
        }
        segments.push([elbow,new THREE.Vector3(x,y,z),.004*height+.018]);
      }
      const i=kept++;
      centers.set([x,y,z],i*3);
      const nx=data.getInt8(off+6)/126,nz=data.getInt8(off+7)/126;
      normals.set([nx,Math.sqrt(Math.max(0,1-nx*nx-nz*nz)),nz],i*3);
      color.setRGB(data.getUint8(off+8)/255,data.getUint8(off+9)/255,data.getUint8(off+10)/255,THREE.SRGBColorSpace);
      if(budding){
        const shade=.42+.19*data.getUint8(off+9)/255;
        color.setRGB(shade*1.04,shade*.91,shade*.70,THREE.SRGBColorSpace);
      }
      color.toArray(colors,i*3);
      radii[i]=r;
    }
    if(budding)continue;
    const spine=[root,...junctions.sort((a,b)=>a.y-b.y),fork];
    const trunkRadius=Math.min(.39,.014*height+.07);
    for(let i=1;i<spine.length;i++){
      const rise=(spine[i-1].y-root.y)/(fork.y-root.y);
      segments.push([spine[i-1],spine[i],trunkRadius*(1-.5*rise)]);
    }
  }
  const geometry=new THREE.InstancedBufferGeometry();
  const cluster=foliageCluster();
  for(const [name,attribute] of Object.entries(cluster.attributes)) geometry.setAttribute(name,attribute);
  geometry.setIndex(cluster.index);
  for(const [name,values,arity] of [['crownCenter',centers,3],['crownColor',colors,3],['crownNormal',normals,3],['crownRadius',radii,1]])
    geometry.setAttribute(name,new THREE.InstancedBufferAttribute(values,arity));
  geometry.instanceCount=kept;
  geometry.boundingSphere=new THREE.Sphere().setFromPoints([
    new THREE.Vector3(tile.col*size,-15,tile.row*size),
    new THREE.Vector3((tile.col+1)*size,110,(tile.row+1)*size)
  ]);
  const mesh=new THREE.Mesh(geometry,foliage.material);
  mesh.customDepthMaterial=foliage.depth;
  mesh.castShadow=true;
  mesh.name='Surveyed canopy clusters';
  mesh.receiveShadow=true;
  if(budding)return mesh;
  const tree=new THREE.InstancedMesh(bark,wood,segments.length);
  const transform=new THREE.Object3D(),up=new THREE.Vector3(0,1,0),axis=new THREE.Vector3();
  for(const [index,[a,b,r]] of segments.entries()){
    axis.subVectors(b,a);
    transform.position.copy(a).lerp(b,.5);
    transform.scale.set(r,axis.length(),r);
    transform.quaternion.setFromUnitVectors(up,axis.normalize());
    transform.updateMatrix();
    tree.setMatrixAt(index,transform.matrix);
    cameraWood.addBranch(a.toArray(),b.toArray(),r,r*.5,'LiDAR branch');
  }
  tree.computeBoundingSphere();
  tree.receiveShadow=true;
  tree.castShadow=true;
  mesh.add(tree);
  mesh.userData.cameraWood=cameraWood;
  return mesh;
}

export function createSurveyCanopy(data,network,ready,boundary) {
  const group=new THREE.Group(),foliage=foliageMaterials(),spring=foliageMaterials(true);
  group.name='Rooted LiDAR canopy';
  const loaded=new Map(),inflight=new Map(),failed=new Set();
  const tiles=Object.entries(data.tiles).map(([key,tile])=>{
    const [col,row]=key.split(',').map(Number);
    return {...tile,key,col,row};
  });
  const size=data.tileSize;
  network.canopyInView=(x,z,y,r,h)=>{
    const col=Math.floor(x/size),row=Math.floor(z/size);
    for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){
      if(loaded.get((col+i)+','+(row+j))?.userData.cameraWood.contact(x,z,y,r,h))return true;
    }
    return false;
  };
  const bark=new THREE.CylinderGeometry(.50,1,1,5);
  const wood=new THREE.MeshStandardMaterial({color:0x756851,roughness:.95});
  wood.onBeforeCompile=barkFinish;
  for(const tile of tiles) for(const [x,z,h] of tile.stems??[]) {
    const y=network.groundAt(x,z),r=Math.min(.39,.014*h+.07);
    network.addBranch([x,y-.08,z],[x+.08,y+h*.43,z-.06],r,r*.5,'survey stem');
  }
  let wanted=new Map(),queue=[];
  function pump(){
    while(inflight.size<6 && queue.length){
      const tile=queue.shift();
      if(loaded.has(tile.key)||inflight.has(tile.key)||failed.has(tile.key)) continue;
      const controller=new AbortController();
      inflight.set(tile.key,controller);
      async function load(){
        if(!tile.data.startsWith('./')) return Uint8Array.from(atob(tile.data),c=>c.charCodeAt(0));
        const response=await fetch(tile.data,{signal:controller.signal});
        if(!response.ok) throw new Error('Canopy tile unavailable.');
        return new Uint8Array(await response.arrayBuffer());
      }
      load().then(bytes=>{
        if(controller.signal.aborted||!wanted.has(tile.key)) return;
        const mesh=buildTile(bytes,tile,foliage,size,network,boundary,bark,wood);
        if(tile.springReturns?.length)mesh.add(buildTile(bytes,tile,spring,size,network,boundary,bark,wood,true));
        loaded.set(tile.key,mesh);
        group.add(mesh);
        ready?.();
      }).catch(error=>{
        if(controller.signal.aborted) return;
        failed.add(tile.key);
        console.warn(error.message);
      }).finally(()=>{inflight.delete(tile.key);pump();});
    }
  }
  let lastX,lastZ,lastRange;
  function update(x,z,distance){
    const range=distance>700?0:distance>330?155:210;
    if(Math.hypot(x-lastX,z-lastZ)<28 && lastRange===range) return;
    lastX=x;lastZ=z;lastRange=range;
    const separation=tile=>Math.hypot((tile.col+.5)*size-x,(tile.row+.5)*size-z);
    queue=range ? tiles.filter(t=>separation(t)<range+size*.7).sort((a,b)=>separation(a)-separation(b)) : [];
    wanted=new Map(queue.map(t=>[t.key,t]));
    for(const [key,mesh] of loaded) if(!wanted.has(key)){group.remove(mesh);mesh.geometry.dispose();for(const part of mesh.children){if(part.isInstancedMesh)part.dispose();else part.geometry.dispose();}loaded.delete(key);}
    for(const [key,controller] of inflight) if(!wanted.has(key)) controller.abort();
    pump();
  }
  return {group,update};
}
