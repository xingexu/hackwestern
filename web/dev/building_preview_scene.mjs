import * as THREE from 'three';
import {architectureMesh,fitArchitecture} from 'campus-buildings';
import {buildArchitecture} from 'building-kernel';

import {prepareCampus} from 'campus-scene';
import {campusSightlines,gradePhotoPose} from './building_sightlines.mjs';

let production,renderer;
export async function renderBuilding({building,neighbors,frames,aerial,surveyBounds,obliqueReference,shadowReference=false}){
  const scene=new THREE.Scene();
  scene.background=new THREE.Color('#a9cee5');
  scene.fog=new THREE.FogExp2('#c4d7dd',.0014);
  renderer??=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.02;
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const [x0,z0,x1,z1]=building.bounds;
  const x=(x0+x1)/2,z=(z0+z1)/2,y=building.ground;
  const extent=Math.max(x1-x0,z1-z0,12);
  const hemi=new THREE.HemisphereLight(0xdae6f1,0x918875,1.17);scene.add(hemi);
  const sun=new THREE.DirectionalLight(0xfff2da,2.5);
  sun.position.set(x-105,y+160,z-83);sun.target.position.set(x,y,z);
  sun.castShadow=true;sun.shadow.mapSize.set(1536,1536);
  const shadowRange=Math.max(50,extent*.84);
  Object.assign(sun.shadow.camera,{left:-shadowRange,right:shadowRange,top:shadowRange,bottom:-shadowRange,near:.5,far:440});
  sun.shadow.camera.updateProjectionMatrix();
  const shadowTexel=shadowRange*2/sun.shadow.mapSize.x;
  sun.shadow.normalBias=Math.max(.045,shadowTexel*.58);
  sun.shadow.bias=-Math.max(.00012,shadowTexel*.8/(sun.shadow.camera.far-sun.shadow.camera.near));
  scene.add(sun,sun.target);
  production??=await prepareCampus(await (await fetch('/world.json')).json(),null,true,false);
  const ground=production.network.groundAt;
  scene.add(production.scenery);
  production.sprintRoad.visible=false;
  production.updateDetail(x,z,80,true);
  if(!renderer.userDataEnvironment){
    const sphere=new THREE.Mesh(new THREE.SphereGeometry(90,40,24),new THREE.ShaderMaterial({side:THREE.BackSide,vertexShader:'varying vec3 dir;void main(){dir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'varying vec3 dir;void main(){vec3 d=normalize(dir);vec3 sky=mix(vec3(.72,.85,.94),vec3(.20,.46,.82),smoothstep(.01,.8,d.y));float horizon=.055+.07*sin(atan(d.x,d.z)*11.)+.025*sin(atan(d.x,d.z)*39.);vec3 ground=mix(vec3(.28,.29,.23),vec3(.078,.16,.09),smoothstep(-.35,.014,d.y));gl_FragColor=vec4(mix(ground,sky,smoothstep(horizon-.02,horizon+.02,d.y)),1.);}'}));
    const sky=new THREE.Scene();sky.add(sphere);
    const pmrem=new THREE.PMREMGenerator(renderer);renderer.userDataEnvironment=pmrem.fromScene(sky);
    pmrem.dispose();sphere.geometry.dispose();sphere.material.dispose();
  }
  scene.environment=renderer.userDataEnvironment.texture;scene.environmentIntensity=.48;
  fitArchitecture([building,...neighbors],ground,[],false);
  let visibility;
  const streetVisibility=campusSightlines(building,neighbors,true);
  const model=architectureMesh(buildArchitecture([building],2));
  const context=architectureMesh(buildArchitecture(neighbors,1));
  scene.add(model,context);
  const bounds=new THREE.Box3().setFromObject(model);
  const high=Number.isFinite(bounds.max.y)?bounds.max.y:y+3;
  const pictures=[],obliques={};
  function capture(camera,width,height){
    renderer.setSize(width,height,false);camera.updateProjectionMatrix();renderer.render(scene,camera);
    return renderer.domElement;
  }
  function jpg(canvas){return canvas.toDataURL('image/jpeg',.92).split(',')[1];}
  const view=new THREE.PerspectiveCamera(39,1.5,.15,2200);
  for(const [name,dx,dz] of [['ne',1,-1],['se',1,1],['sw',-1,1],['nw',-1,-1]]){
    const registered=obliqueReference?.[name];
    const target=registered?.target??[x,y+(high-y)*.43,z];
    let eye=registered?.eye;
    if(!eye){
      visibility??=campusSightlines(building,neighbors);
      const reach=Math.max(extent*.94,(high-y)*1.48);
      let best=-1;
      for(const elevation of [.77,1.15,1.55])for(const degrees of [0,-18,18,-34,34]){
        const a=degrees*Math.PI/180;
        const point=[x+reach*(dx*Math.cos(a)-dz*Math.sin(a)),y+reach*elevation+(high-y)*.3,z+reach*(dx*Math.sin(a)+dz*Math.cos(a))];
        const score=visibility(point)/(1+Math.abs(degrees)*.007+(elevation-.77)*.38);
        if(score>best){best=score;eye=point;}
      }
    }
    obliques[name]={eye,target};
    view.position.set(...eye);
    view.lookAt(...target);
    pictures.push([name,jpg(capture(view,900,600))]);
    if(shadowReference && name==='ne'){
      sun.castShadow=false;
      pictures.push(['ne-unshadowed',jpg(capture(view,900,600))]);
      sun.castShadow=true;
      const control=structuredClone(building);
      for(const part of control.parts){
        delete part.roofFinish;
        part.roof.features=(part.roof.features??[]).filter(f=>f.style!=='measured roof plant');
      }
      const surface=architectureMesh(buildArchitecture([control],2));
      model.visible=false;scene.add(surface);
      pictures.push(['ne-shadow-control',jpg(capture(view,900,600))]);
      scene.remove(surface);model.visible=true;
      surface.traverse(o=>{o.geometry?.dispose();o.material?.userData.styles?.dispose();o.material?.dispose();if(o.isInstancedMesh)o.dispose();});
    }
  }
  const image=async url=>{const img=new Image();img.src=url;await img.decode();return img;};
  function pair(name,camera,photo){
    const scale=Math.min(900/photo.width,760/photo.height),w=Math.round(photo.width*scale),h=Math.round(photo.height*scale);
    const sheet=document.createElement('canvas');sheet.width=w*2;sheet.height=h;
    const ctx=sheet.getContext('2d');
    ctx.drawImage(photo,0,0,w,h);ctx.drawImage(capture(camera,w,h),w,0,w,h);
    pictures.push([name,jpg(sheet)]);
  }
  let paired=0;
  const poses=[];
  for(const f of frames){
    const y0=production.network.sample(f.x,f.z,ground(f.x,f.z)).y+1.7;
    const pose=gradePhotoPose(f,y0,streetVisibility);
    poses.push(pose);
    if(pose.result!=='paired')continue;
    const photo=await image('/'+f.path);
    const ratio=photo.width/photo.height,rads=f.heading*Math.PI/180;
    production.updateDetail(f.x,f.z,50,true);
    const cam=new THREE.PerspectiveCamera(2*Math.atan(Math.tan((f.hfov??64)*Math.PI/360)/ratio)*180/Math.PI,ratio,.1,1600);
    cam.position.set(f.x,y0,f.z);cam.lookAt(f.x+Math.sin(rads),y0+Math.tan((f.elevationAngle??0)*Math.PI/180),f.z-Math.cos(rads));
    cam.rotateZ(-(f.roll??0)*Math.PI/180);
    pair('street-'+f.id,cam,photo);
    if(++paired===6)break;
  }
  if(aerial){
    const photo=await image('/'+aerial),[l,t,r,b]=surveyBounds,ww=r-l+36,hh=b-t+36,ax=(l+r)/2,az=(b+t)/2;
    const cam=new THREE.OrthographicCamera(-ww/2,ww/2,hh/2,-hh/2,.1,1500);
    cam.position.set(ax,high+270,az);cam.up.set(0,0,-1);cam.lookAt(ax,y,az);
    pair('aerial',cam,photo);
  }
  const stats={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};
  for(const obj of [model,context])obj.traverse(m=>{m.geometry?.dispose();m.material?.userData.styles?.dispose();m.material?.dispose();if(m.isInstancedMesh)m.dispose();});
  sun.shadow.map?.dispose();
  return {pictures,poses,obliques,stats};
}
