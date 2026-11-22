import {groundDetailGLSL} from 'campus-terrain';
import {riverFinish} from './water.mjs';
import * as THREE from 'three';
import {anchoredHeight} from 'driving-horizon';

import {barkFinish,foliageCluster,leafSprayTexture,lightLeafBacks} from 'leaf-sprays';
import southSurvey from './landscape-data.mjs';

const palette=[[0,0,0],[0,0,0],[0,0,0],[255,0,0],[0,255,0]];
function coverTexture(data,width,height){
  const pixels=new Uint8Array(data.length*4);
  for(let i=0;i<data.length;i++){
    const rgb=palette[data[i]]??palette[0];
    pixels[i*4]=rgb[0];pixels[i*4+1]=rgb[1];pixels[i*4+2]=rgb[2];pixels[i*4+3]=data[i]===1?255:0;
  }
  const texture=new THREE.DataTexture(pixels,width,height);
  texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.magFilter=THREE.LinearFilter;
  texture.generateMipmaps=true;texture.anisotropy=4;texture.needsUpdate=true;
  return texture;
}

export async function landscapeBackground(region,landscape,boundary,cover,unpack,join,surveyVertices){
  const [left,top,right,bottom]=region.bounds;
  const [west,north,east,south]=boundary.bounds;
  const x0=Math.max(left,west-500),z0=Math.max(top,north-500);
  const x1=Math.min(right,east+500),z1=Math.min(southSurvey.bounds[3],south+500);
  const [surface,elevation,treeData]=await Promise.all([southSurvey.surface,southSurvey.elevation,southSurvey.trees].map(unpack));
  const ground=coverTexture(cover.data,cover.width,cover.height);
  const southCover=coverTexture(new Uint8Array(surface),southSurvey.width,southSurvey.height);
  const heights=new Int16Array(elevation),columns=southSurvey.width/4+1,rows=southSurvey.height/4+1;
  function grade(x,z){
    if(z<=bottom)return landscape.heightAt(x,z);
    const u=Math.max(0,Math.min(columns-1.00001,(x-southSurvey.bounds[0])/16));
    const v=Math.max(0,Math.min(rows-1.00001,(z-bottom)/16));
    const i=Math.floor(u),j=Math.floor(v),dx=u-i,dz=v-j,k=j*columns+i;
    const y=((1-dz)*(heights[k]*(1-dx)+heights[k+1]*dx)+dz*(heights[k+columns]*(1-dx)+heights[k+columns+1]*dx))/16;
    const blend=Math.min((z-bottom)/12,1);
    return y*blend+landscape.heightAt(x,bottom)*(1-blend);
  }
  const material=new THREE.MeshStandardMaterial({roughness:1});
  material.customProgramCacheKey=()=>'surrounding-terrain';
  material.onBeforeCompile=shader=>{
    shader.uniforms.extent={value:new THREE.Vector4(...region.bounds)};
    shader.uniforms.ground={value:ground};
    shader.uniforms.southExtent={value:new THREE.Vector4(...southSurvey.bounds)};
    shader.uniforms.southCover={value:southCover};
    shader.uniforms.roads={value:landscape.pavement};
    shader.uniforms.groundGrain={value:landscape.groundGrain};
    shader.uniforms.surveyColour={value:landscape.grassVigor};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 site;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nsite=position.xz;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform vec4 extent,southExtent; uniform sampler2D ground,southCover,roads,surveyColour; varying vec2 site;\n'+groundDetailGLSL)
      .replace('#include <color_fragment>',`#include <color_fragment>
        vec2 uv=(site-extent.xy)/(extent.zw-extent.xy);
        vec4 groundCover=texture2D(ground,uv);
        float pavement=texture2D(roads,uv).r;
        if(site.y>extent.w){
          groundCover=texture2D(southCover,(site-southExtent.xy)/(southExtent.zw-southExtent.xy));
          pavement=0.;
        }
        float aa=clamp(fwidth(pavement),.025,.47);
        vec3 particle=groundParticle(site);
        vec2 surveyTone=texture2D(surveyColour,uv).rg;
        if(site.y>extent.w)surveyTone=mix(surveyTone,vec2(.50),smoothstep(0.,35.,site.y-extent.w));
        float waterAA=clamp(fwidth(groundCover.a),.03,.45);
        float water=smoothstep(.5-waterAA,.5+waterAA,groundCover.a);
        vec3 land=mix(summerLawn(site,surveyTone.r,particle.r),forestFloor(site,particle),groundCover.r);
        land=mix(land,vec3(.125,.119,.101)*(1.+particle.b*.36),groundCover.g);
        land=riverColour(land,site,water);
        float chips=riverNoise(site*2.6)-.5;
        float ageing=riverNoise(site*.091)-.5;
        float repair=texture2D(groundGrain,mat2(.90,-.43,.43,.90)*site*.051+ageing*.06).a;
        vec3 asphalt=vec3(.068,.067,.063)*(1.+particle.g*.55+.17*chips+.21*ageing+.55*(surveyTone.g-.502)-.09*repair);
        diffuseColor.rgb=mix(land,asphalt,smoothstep(.5-aa,.5+aa,pavement));`);
    riverFinish(shader,'site','water');
  };
  boundary.coatExterior(material);
  const geometry=new THREE.BufferGeometry();
  let stems;
  if(join){
    const [points,faces,anchors]=await Promise.all([join.vertices,join.indices,join.stems].map(unpack));
    const vertices=new Float32Array(points);
    for(let i=0;i<vertices.length;i+=3){
      if(!Number.isFinite(vertices[i+1]))vertices[i+1]=grade(vertices[i],vertices[i+2]);
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faces),1));
    geometry.setAttribute('position',new THREE.BufferAttribute(vertices,3));
    const bindings=new Float32Array(anchors);
    stems=new Map();
    for(let i=0;i<bindings.length;i+=6){
      stems.set(bindings[i],anchoredHeight(surveyVertices,bindings,i));
    }
  }else{
    const xs=Math.ceil((x1-x0)/12),zs=Math.ceil((z1-z0)/12);
    const stepX=(x1-x0)/xs,stepZ=(z1-z0)/zs;
    const vertices=[],indices=[];
    for(let j=0;j<=zs;j++)for(let i=0;i<=xs;i++){
      const x=x0+i*stepX,z=z0+j*stepZ;
      vertices.push(x,grade(x,z),z);
      if(i===xs || j===zs)continue;
      const a=j*(xs+1)+i,b=a+xs+1;
      if(!boundary.containsDisc(x+stepX*.5,z+stepZ*.5,Math.hypot(stepX,stepZ)*.5))indices.push(a,b,a+1,a+1,b,b+1);
    }
    geometry.setIndex(indices);
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  }
  geometry.computeVertexNormals();
  const mesh=new THREE.Mesh(geometry,material);
  mesh.name='Surrounding landscape';
  mesh.receiveShadow=true;
  mesh.layers.set(1);
  addTreeline(mesh,new Int16Array(treeData),grade,boundary,stems,landscape.permitsContextTree);
  return mesh;
}

function addTreeline(ground,records,grade,boundary,anchors,permitted){
  const tiles=new Map();
  for(let i=0;i<records.length;i+=5){
    const x=records[i]*.5,z=records[i+1]*.5;
    if(boundary.contains(x,z)||!permitted(x,z)||(anchors && !anchors.has(i/5)))continue;
    const key=Math.floor(x/128)+','+Math.floor(z/128);
    if(!tiles.has(key))tiles.set(key,[]);
    tiles.get(key).push(i);
  }
  const leaves=foliageCluster(.39),wood=new THREE.CylinderGeometry(.52,1,1,6);
  const canopy=new THREE.MeshStandardMaterial({map:leafSprayTexture(),alphaTest:.36,side:THREE.DoubleSide,roughness:.92});
  canopy.onBeforeCompile=lightLeafBacks;
  const bark=new THREE.MeshStandardMaterial({color:0x63594a});
  bark.onBeforeCompile=barkFinish;
  const crownDepth=new THREE.MeshDepthMaterial({map:canopy.map,alphaTest:canopy.alphaTest,side:THREE.DoubleSide,depthPacking:THREE.RGBADepthPacking});
  const barkDepth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  const transform=new THREE.Object3D(),color=new THREE.Color();
  for(const sites of tiles.values()){
    const crowns=new THREE.InstancedMesh(leaves,canopy,sites.length*8);
    const stems=new THREE.InstancedMesh(wood,bark,sites.length);
    for(const [j,i] of sites.entries()){
      const x=records[i]*.5,z=records[i+1]*.5,h=records[i+2]/8,r=Math.min(h*.53,records[i+3]/16);
      const y=anchors?.get(i/5)??grade(x,z),yaw=x*.47+z*1.3,tone=THREE.MathUtils.clamp((records[i+4]-55)/75,0,1);
      transform.rotation.set(0,yaw,0);transform.position.set(x,y+h*.22,z);
      transform.scale.set(.085+h*.012,h*.45,.085+h*.012);transform.updateMatrix();
      stems.setMatrixAt(j,transform.matrix);
      for(let n=0;n<8;n++){
        const a=yaw+n*2.39996,top=n===7,reach=top?0:r*(.38+.1*Math.sin(a*2.));
        const width=top?.66:.62+.08*Math.sin(a*3.);
        transform.position.set(x+reach*Math.sin(a),y+h*(top?.83:.59+.09*Math.cos(a)),z+reach*Math.cos(a));
        transform.rotation.set(.12*Math.sin(a),a,.13*Math.cos(a));
        transform.scale.set(r*width,h*(top?.21:.27),r*(width+.06));transform.updateMatrix();
        crowns.setMatrixAt(j*8+n,transform.matrix);
        color.setHSL(.278+.027*Math.sin(yaw),.32+.045*Math.sin(a),.245+.11*tone+.022*Math.cos(a),THREE.SRGBColorSpace);
        crowns.setColorAt(j*8+n,color);
      }
    }
    crowns.customDepthMaterial=crownDepth;stems.customDepthMaterial=barkDepth;
    for(const batch of [crowns,stems]){
      batch.layers.set(1);batch.castShadow=batch.receiveShadow=true;batch.computeBoundingSphere();ground.add(batch);
    }
  }
}
