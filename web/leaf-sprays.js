import * as THREE from 'three';

export const barkGrainGLSL=`
  float barkGrain(vec3 p){
    vec2 grain=vec2(19.1*p.x+13.7*p.z,15.2*p.z-11.4*p.x);
    grain+=vec2(.41*sin(p.y*3.4+sin(p.z*2.8)),.46*sin(p.y*2.2+p.x*1.3));
    vec2 relief=abs(sin(grain*1.8+sin(grain*.63+p.y*.72)));
    float fissure=1.-smoothstep(.045,.34,min(relief.x,relief.y));
    float flakes=sin(p.y*37.+sin(dot(p.xz,vec2(11.3,19.7))))*.035;
    float detail=1.-smoothstep(.012,.13,length(fwidth(p)));
    return 1.+detail*(.09-.33*fissure+flakes);
  }`;

export function barkFinish(shader){
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 barkPosition;')
    .replace('#include <project_vertex>',`#include <project_vertex>
      #ifdef USE_INSTANCING
        barkPosition=(instanceMatrix*vec4(transformed,1.)).xyz;
      #else
        barkPosition=transformed;
      #endif`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 barkPosition;\n'+barkGrainGLSL)
    .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb*=barkGrain(barkPosition);');
}

export function leafSprayTexture(budding=false){
  const canvas=document.createElement('canvas');
  canvas.width=256;canvas.height=192;
  const ink=canvas.getContext('2d');
  let seed=2839;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  function shoot(x,y,tipX,tipY,width){
    ink.strokeStyle='#818771';
    ink.lineWidth=budding?width*1.7:width;
    ink.beginPath();ink.moveTo(x,y);ink.lineTo(tipX,tipY);ink.stroke();
  }
  function leaf(x,y,angle,length){
    if(budding)length*=.67;
    const width=length*(budding?.14:.25+.14*random()),light=Math.round(187+68*random());
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

export function budSprig(){
  const positions=[],uv=[];
  for(let j=0;j<6;j++){
    const a=j*2.40,reach=.14+.095*j,dy=.09*j;
    for(const side of [-1,1]){
      const x=Math.sin(a)*reach,z=Math.cos(a)*reach,turn=a+side*.79;
      const dx=Math.cos(turn)*.085,dz=-Math.sin(turn)*.085;
      const tx=x+Math.sin(turn)*.24,tz=z+Math.cos(turn)*.24;
      positions.push(x,dy,z,tx+dx,dy+.19,tz+dz,tx-dx,dy+.16,tz-dz);
      uv.push(.80,.47,.85,.55,.92,.56);
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.computeVertexNormals();
  return geometry;
}

export function terminalTwigs(depth=3){
  const vertices=[],uv=[];
  function shoot(x,y,z,angle,length,width,level){
    const dx=Math.sin(angle),dz=Math.cos(angle);
    const tx=x+dx*length,ty=y+length*(.49+.20*Math.cos(angle*1.3)),tz=z+dz*length;
    const ox=dz*width,oz=-dx*width;
    vertices.push(x+ox,y,z+oz,x-ox,y,z-oz,tx,ty,tz);
    vertices.push(x,y+width,z,x,y-width,z,tx,ty,tz);
    for(let i=0;i<6;i++)uv.push(.985,.986);
    if(level>0)for(const side of [-1,1]){
      const t=side<0?.62:.85;
      shoot(x+(tx-x)*t,y+(ty-y)*t,z+(tz-z)*t,angle+side*(.53+.23*Math.sin(angle+level)),length*(.66+.13*side),width*.62,level-1);
    }
  }
  for(const [bearing,length] of [[0,.91],[-.93,.74],[1.18,.81]])shoot(0,0,0,bearing,length*(depth===1?1.23:1),depth===1?.053:.036,depth);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.computeVertexNormals();
  return geometry;
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
  for(let i=0;i<7;i++){
    const angle=i*2.39996+lift*3.7+.36*Math.sin(i*4.3+lift);
    const dx=Math.cos(angle),dz=Math.sin(angle),height=.24+.38*(.5+.5*Math.sin(i*1.93+lift*3.2));
    const width=.56+.19*Math.cos(i*1.52+lift),reach=.90+.17*Math.sin(i*4.72);
    const outline=[[-.82,.15],[-1,.52],[-.43,.85],[.19,1],[.86,.74],[.95,.31],[.48,.02]];
    const first=positions.length/3;
    for(const [side,t] of [[0,.49],...outline]){
      const out=.17+reach*t-.18*side*side;
      positions.push(out*dx-width*side*dz,-.41+height*t*1.65+side*.18*Math.sin(angle)+.11*(1-side*side),out*dz+width*side*dx);
      normals.push(.68*dx,.73,.68*dz);
      uv.push((.5+.445*side)*.75,.06+.91*t);
    }
    for(let j=0;j<outline.length;j++)indices.push(first,first+1+j,first+1+(j+1)%outline.length);
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
