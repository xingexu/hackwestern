import * as THREE from 'three';

export function leafSprayTexture(){
  const canvas=document.createElement('canvas');
  canvas.width=256;canvas.height=192;
  const ink=canvas.getContext('2d');
  let seed=2839;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  function shoot(x,y,tipX,tipY,width){
    ink.strokeStyle='#818771';
    ink.lineWidth=width;
    ink.beginPath();ink.moveTo(x,y);ink.lineTo(tipX,tipY);ink.stroke();
  }
  function leaf(x,y,angle,length){
    const width=length*(.25+.14*random()),light=Math.round(187+68*random());
    ink.save();
    ink.translate(x,y);ink.rotate(angle);
    ink.fillStyle='rgb('+light+','+Math.min(255,light+4)+','+(light-12)+')';
    ink.beginPath();
    ink.moveTo(0,0);ink.lineTo(.21*length,-width*.72);ink.lineTo(.42*length,-width*.65);
    ink.lineTo(.54*length,-width);ink.lineTo(.68*length,-width*.68);ink.lineTo(length,0);
    ink.lineTo(.68*length,width*.72);ink.lineTo(.48*length,width);ink.lineTo(.22*length,width*.64);
    ink.closePath();ink.fill();ink.restore();
  }
  for(let j=0;j<9;j++){
    const originX=94+(random()-.5)*15,originY=178-random()*20;
    const direction=-2.61+j*.258+(random()-.5)*.18;
    const length=(91+50*Math.sin((j+1)*Math.PI/10))*(.94+.12*random());
    const endX=originX+Math.cos(direction)*length,endY=originY+Math.sin(direction)*length;
    shoot(originX,originY,endX,endY,2);
    for(let k=1;k<9;k++){
      const t=(k+random()*.35)/9,baseX=originX+(endX-originX)*t,baseY=originY+(endY-originY)*t;
      for(const side of [-1,1]){
        const a=direction+side*(.54+.24*random()),reach=12+(.9-t)*24+random()*8;
        const dx=Math.cos(a),dy=Math.sin(a);
        shoot(baseX,baseY,baseX+dx*reach,baseY+dy*reach,1);
        for(const frac of [.42,.75,1]){
          leaf(baseX+dx*reach*frac,baseY+dy*reach*frac,a+side*(1-frac)*2.5,7+random()*9);
        }
      }
    }
  }
  ink.clearRect(192,0,64,192);
  ink.save();
  ink.beginPath();ink.rect(192,0,64,192);ink.clip();
  for(let i=0;i<1150;i++){
    const x=192+64*random(),y=192*random(),direction=random()*6.283;
    const length=2+5*random();
    leaf(x,y,direction,length);
  }
  ink.restore();
  ink.fillStyle='#ffffff';ink.fillRect(249,0,7,6);
  const image=ink.getImageData(0,0,canvas.width,canvas.height);
  for(let i=0;i<image.data.length;i+=4){
    if(image.data[i+3]!==0)continue;
    image.data[i]=212;image.data[i+1]=216;image.data[i+2]=200;
  }
  const texture=new THREE.DataTexture(new Uint8Array(image.data.buffer),canvas.width,canvas.height);
  texture.flipY=true;texture.generateMipmaps=true;texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.needsUpdate=true;
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.magFilter=THREE.LinearFilter;
  texture.anisotropy=4;
  return texture;
}

export function foliageCluster(lift=.35){
  const core=new THREE.IcosahedronGeometry(1,0);
  const pos=core.getAttribute('position');
  const positions=[],normals=[],uv=[],indices=[];
  const v=new THREE.Vector3(),a=new THREE.Vector3(),b=new THREE.Vector3(),face=new THREE.Vector3();
  for(let i=0;i<pos.count;i++){
    v.fromBufferAttribute(pos,i);
    const radius=.81+.13*Math.sin(v.x*7.3+v.z*4.9+v.y*1.6);
    positions.push(v.x*radius,v.y*radius*.94,v.z*radius);
    if(i%3===0){
      a.fromBufferAttribute(pos,i+1).sub(v);b.fromBufferAttribute(pos,i+2).sub(v);
      face.crossVectors(a,b).normalize();
      a.normalize();b.crossVectors(face,a).normalize();
    }
    uv.push(.87+.112*v.dot(a),.50+.31*v.dot(b));
    v.y+=lift;v.normalize();
    normals.push(v.x,v.y,v.z);
    indices.push(i);
  }
  core.dispose();
  for(let i=0;i<6;i++){
    const a=i*2.39996+lift*3.7, dx=Math.cos(a),dz=Math.sin(a), height=[.66,.29,.48,.13,.73,.34][i];
    const first=positions.length/3;
    for(const [side,rise,u,vv] of [[-1,0,.055,.06],[1,0,.945,.06],[-1,1,.055,.97],[1,1,.945,.97]]){
      const reach=.24+rise*(i%2===0?.72:.89), spread=side*(.45+rise*.30);
      positions.push(reach*dx-spread*dz,-.44+height*rise*1.65+side*.21*Math.sin(a+1.),reach*dz+spread*dx);
      normals.push(.68*dx,.73,.68*dz);
      uv.push(u*.75,vv);
    }
    indices.push(first,first+2,first+1,first+1,first+2,first+3);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  const coreVertices=new Uint8Array(positions.length/3);
  coreVertices.fill(1,0,pos.count);
  geometry.setAttribute('cameraSolid',new THREE.Uint8BufferAttribute(coreVertices,1));
  geometry.setIndex(indices);
  return geometry;
}

export const leafPatchGLSL=`
  float smallLeaves(sampler2D sprays,vec3 p){
    vec2 uv=p.xz*mat2(.48,-.70,.70,.48)+p.y*vec2(.59,-.47);
    vec2 scale=vec2(.214,.89);
    return textureGrad(sprays,vec2(.762,.051)+scale*fract(uv),scale*dFdx(uv),scale*dFdy(uv)).g;
  }`;

export function lightLeafBacks(shader){
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 leafSite;')
    .replace('#include <project_vertex>',`vec4 leafWorld=vec4(transformed,1.);
      #ifdef USE_INSTANCING
        leafWorld=instanceMatrix*leafWorld;
      #endif
      leafSite=(modelMatrix*leafWorld).xyz;
      #include <project_vertex>`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 leafSite;\n'+leafPatchGLSL)
    .replace('#include <map_fragment>',`#include <map_fragment>
      #ifdef USE_MAP
        if(vMapUv.x>.75 && vMapUv.x<.979){
          float leaf=smallLeaves(map,leafSite);
          diffuseColor.rgb=diffuse*(.24+.77*leaf);
        }
      #endif`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>',`#include <normal_fragment_begin>
    #if defined(DOUBLE_SIDED) && !defined(FLAT_SHADED)
      normal*=faceDirection;
    #endif`);
}
