import * as THREE from 'three';

export function protectMotionDetails(renderer,maskTarget,groups){
  const maskOpacity={get value(){return renderer.getRenderTarget()===maskTarget?0:1;}};
  const materials=new Set();
  for(const group of groups)group.traverse(object=>{
    if(object.isMesh)for(const material of [].concat(object.material))materials.add(material);
  });
  for(const material of materials){
    if(material.transparent)continue;
    const compile=material.onBeforeCompile,key=material.customProgramCacheKey.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      compile.call(this,shader,renderer);
      shader.uniforms.motionMaskOpacity=maskOpacity;
      shader.fragmentShader='uniform float motionMaskOpacity;\n'+shader.fragmentShader.replace('#include <dithering_fragment>','#include <dithering_fragment>\ngl_FragColor.a*=motionMaskOpacity;');
    };
    material.customProgramCacheKey=()=>key()+'-sharp-motion';
    material.needsUpdate=true;
  }
}

export function cameraTravel(){
  const last=new THREE.Vector3(),rotation=new THREE.Quaternion(),inverse=new THREE.Quaternion();
  const displacement=new THREE.Vector3();
  let lastView;
  return {displacement,update(camera,dt,speed,view){
    displacement.subVectors(camera.position,last);
    const distance=displacement.length(),pace=Math.abs(speed);
    const continuous=lastView===view && dt>0 && dt<.10 && Math.abs(rotation.dot(camera.quaternion))>.97 && distance<.3+pace*dt*2;
    if(continuous && distance>.0001 && pace>3){
      const shutter=.017*THREE.MathUtils.smoothstep(pace,3,27);
      displacement.multiplyScalar(shutter*Math.min(1/dt,pace/distance)).applyQuaternion(inverse.copy(camera.quaternion).invert());
    }else displacement.set(0,0,0);
    last.copy(camera.position);rotation.copy(camera.quaternion);lastView=view;
  }};
}

export const motionFilter=`
  uniform vec3 shutterTravel;
  uniform vec2 focal;
  vec3 motionColor(vec3 sharp,float coverage,float z){
    if(coverage<.99 || dot(shutterTravel,shutterTravel)<.000001 || z<1.65)return sharp;
    vec2 ndc=uvScreen*2.-1.;
    vec2 travel=.5*(focal*shutterTravel.xy+ndc*shutterTravel.z)/max(.3,z-shutterTravel.z);
    travel*=mix(.12,1.,smoothstep(.12,.91,length(ndc)));
    float pixels=length(travel/texel);
    if(pixels<.7)return sharp;
    travel*=min(1.,.0135/(texel.x*pixels));
    vec3 sum=sharp;
    float total=1.;
    for(int i=0;i<6;i++){
      float t=(float(i)-2.5)/5.;
      vec2 uv=uvScreen+travel*t;
      vec4 tap=texture2D(sceneColor,uv);
      float weight=(1.-abs(t)*.65)*smoothstep(.95,1.,tap.a);
      sum+=tap.rgb*weight;
      total+=weight;
    }
    return mix(sharp,sum/total,smoothstep(.7,2.,pixels));
  }`;
