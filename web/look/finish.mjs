import * as THREE from 'three';
import {motionFilter,protectMotionDetails} from './motion-blur.mjs';

const vertexShader=`
  varying vec2 uvScreen;
  void main(){
    uvScreen=position.xy*.5+.5;
    gl_Position=vec4(position.xy,0.,1.);
  }
`;

const fragmentShader=`
  uniform sampler2D sceneColor,sceneDepth;
  uniform vec2 texel,planes;
  uniform float sampleScale;
  uniform float focalLength,ao,bloom;
  uniform bool orthographic;
  varying vec2 uvScreen;
  ${motionFilter}
  float viewDistance(float d){
    if(orthographic)return mix(planes.x,planes.y,d);
    return planes.x*planes.y/(planes.y-d*(planes.y-planes.x));
  }
  float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
  float obscurance(vec2 offset,vec2 pixel,float depth,float z,vec2 gradient){
    vec2 samplePixel=floor((uvScreen+offset)/texel);
    float sampleZ=viewDistance(texture2D(sceneDepth,(samplePixel+.5)*texel).r);
    float expected=viewDistance(clamp(depth+dot(samplePixel-pixel,gradient),0.,1.));
    float diff=expected-sampleZ;
    return smoothstep(.06,.55,diff)*(1.-smoothstep(.75,2.4,abs(sampleZ-z)));
  }
  void main(){
    vec4 center=texture2D(sceneColor,uvScreen);
    vec3 c=center.rgb;
    if(sampleScale>1.01){
      vec2 footprint=texel*sampleScale*.25;
      c=.25*(texture2D(sceneColor,uvScreen+footprint).rgb+texture2D(sceneColor,uvScreen-footprint).rgb+
             texture2D(sceneColor,uvScreen+vec2(footprint.x,-footprint.y)).rgb+texture2D(sceneColor,uvScreen+vec2(-footprint.x,footprint.y)).rgb);
    }
    vec3 n=texture2D(sceneColor,uvScreen+vec2(0.,texel.y)).rgb;
    vec3 s=texture2D(sceneColor,uvScreen-vec2(0.,texel.y)).rgb;
    vec3 e=texture2D(sceneColor,uvScreen+vec2(texel.x,0.)).rgb;
    vec3 w=texture2D(sceneColor,uvScreen-vec2(texel.x,0.)).rgb;
    vec2 slope=vec2(luma(e-w),luma(n-s));
    float edge=length(slope);
    if(edge>.035){
      vec2 tangent=vec2(-slope.y,slope.x)*texel/max(abs(slope.x),abs(slope.y));
      vec3 along=.5*(texture2D(sceneColor,uvScreen+.58*tangent).rgb+texture2D(sceneColor,uvScreen-.58*tangent).rgb);
      c=mix(c,along,smoothstep(.045,.24,edge/(.15+luma(c)))*(.78/sampleScale));
    }
    float depth=texture2D(sceneDepth,uvScreen).r;
    float z=viewDistance(depth);
    c=motionColor(c,center.a,z);
    vec2 pixel=floor(uvScreen/texel);
    vec2 gradient=vec2(dFdx(depth),dFdy(depth))/max(vec2(dFdx(pixel.x),dFdy(pixel.y)),vec2(1.));
    vec2 discontinuity=abs(vec2(dFdx(z),dFdy(z)));
    gradient*=1.-step(vec2(max(.8,z*.08)),discontinuity);
    if(z<95.){
      vec2 radius=texel*clamp(focalLength*.85/(orthographic?1.:z),1.5,22.);
      vec2 a=radius*vec2(.93,.36),b=radius*vec2(-.36,.93);
      float shade=obscurance(a,pixel,depth,z,gradient)+obscurance(-a,pixel,depth,z,gradient)
                +obscurance(b,pixel,depth,z,gradient)+obscurance(-b,pixel,depth,z,gradient);
      c*=1.-ao*.25*shade*(1.-smoothstep(55.,95.,z));
    }
    vec3 glow=vec3(0.);
    for(int i=0;i<4;i++){
      vec2 dir=vec2((i==0 || i==3)?-1.:1.,i<2?-1.:1.);
      vec3 tap=texture2D(sceneColor,uvScreen+dir*texel*4.).rgb;
      glow+=tap*smoothstep(1.15,2.8,luma(tap));
    }
    c+=glow*(.25*bloom);
    gl_FragColor=vec4(c,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function driveFinish(renderer,scene,camera,quality,sharpObjects){
  const size=new THREE.Vector2();
  const gpu=renderer.extensions.has('EXT_color_buffer_float');
  const target=new THREE.WebGLRenderTarget(1,1,{
    type:THREE.HalfFloatType,
    samples:Math.min(4,renderer.capabilities.maxSamples),
    depthTexture:new THREE.DepthTexture(1,1,THREE.UnsignedIntType)
  });
  protectMotionDetails(renderer,target,sharpObjects);
  const uniforms={
    shutterTravel:{value:new THREE.Vector3()},focal:{value:new THREE.Vector2()},
    sceneColor:{value:target.texture},sceneDepth:{value:target.depthTexture},
    texel:{value:new THREE.Vector2()},planes:{value:new THREE.Vector2(camera.near,camera.far)},
    sampleScale:{value:1},orthographic:{value:false},focalLength:{value:1},ao:{value:0},bloom:{value:0}
  };
  const material=new THREE.ShaderMaterial({uniforms,vertexShader,fragmentShader,depthTest:false,depthWrite:false});
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const screen=new THREE.Mesh(geometry,material);
  screen.frustumCulled=false;
  const screenCamera=new THREE.Camera();
  renderer.info.autoReset=false;
  return function render(activeCamera=camera,travel){
    renderer.info.reset();
    const {ao,bloom}=quality.current;
    if(!gpu || !ao){
      renderer.render(scene,activeCamera);
      return;
    }
    renderer.getDrawingBufferSize(size);
    const sampleScale=renderer.getPixelRatio()>=.99?Math.max(1,Math.min(2,Math.sqrt(1480000/(size.x*size.y)))):1;
    size.set(Math.ceil(size.x*sampleScale),Math.ceil(size.y*sampleScale));
    target.setSize(size.x,size.y);
    uniforms.sampleScale.value=sampleScale;
    uniforms.texel.value.set(1/size.x,1/size.y);
    uniforms.orthographic.value=Boolean(activeCamera.isOrthographicCamera);
    uniforms.planes.value.set(activeCamera.near,activeCamera.far);
    uniforms.focalLength.value=size.y*.5*activeCamera.projectionMatrix.elements[5];
    if(travel && quality.motionBlur && activeCamera.isPerspectiveCamera)uniforms.shutterTravel.value.copy(travel);
    else uniforms.shutterTravel.value.set(0,0,0);
    uniforms.focal.value.set(activeCamera.projectionMatrix.elements[0],activeCamera.projectionMatrix.elements[5]);
    uniforms.ao.value=ao;
    uniforms.bloom.value=bloom;
    renderer.setRenderTarget(target);
    renderer.render(scene,activeCamera);
    renderer.setRenderTarget(null);
    renderer.render(screen,screenCamera);
  };
}
