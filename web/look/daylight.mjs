import * as THREE from 'three';

export const sunDirection = new THREE.Vector3(-.80, .95, .32).normalize();
export const horizonHaze = new THREE.Color(0xd4dce0);

const autumnDisplay=THREE.ShaderChunk.tonemapping_fragment+`
  #ifdef TONE_MAPPING
    vec3 printRGB=gl_FragColor.rgb;
    float green=printRGB.g-max(printRGB.r,printRGB.b);
    float chroma=smoothstep(.035,.19,green);
    float shoulder=1.-smoothstep(.60,.95,printRGB.g);
    gl_FragColor.rgb+=chroma*shoulder*green*vec3(.47,-.15,.026);
  #endif`;

function daylightSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: {
      sunDirection: { value: sunDirection },
      zenith: { value: new THREE.Color(0x305487) },
      upper: { value: new THREE.Color(0x628ebc) },
      horizon: { value: horizonHaze.clone() },
      ground: { value: new THREE.Color(0x8c9376) }
    },
    vertexShader: `
      varying vec3 skyRay;
      void main() {
        skyRay = position;
        vec4 placed = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = placed.xyww;
      }`,
    fragmentShader: `
      uniform vec3 sunDirection, zenith, upper, horizon, ground;
      varying vec3 skyRay;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float billow(vec2 p) {
        float total = 0.0, weight = 0.55;
        for (int octave = 0; octave < 5; octave++) {
          total += weight * noise(p);
          p = mat2(1.6, 1.2, -1.2, 1.6) * p;
          weight *= 0.5;
        }
        return total;
      }
      void main() {
        vec3 ray = normalize(skyRay);
        float height = ray.y;
        vec3 colour = mix(horizon, upper, smoothstep(0.0, 0.28, height));
        colour = mix(colour, zenith, smoothstep(0.22, 0.95, height));
        vec2 compass=normalize(ray.xz+vec2(.00001));
        float ridge=.004+.012*noise(compass*5.)+.007*noise(compass*16.)+.002*noise(compass*60.);
        float grove=-.003+.012*noise(compass*9.+8.)+.006*noise(compass*32.)+.002*noise(compass*99.);
        float foliage=noise(compass*113.+height*68.)*.55+noise(compass*48.-height*34.)*.45;
        vec3 distant=mix(vec3(.34,.40,.416),vec3(.48,.51,.50),foliage);
        colour=mix(colour,distant,1.-smoothstep(ridge-.003,ridge+.003,height));
        vec3 treeline=mix(vec3(.155,.188,.168),vec3(.32,.355,.25),foliage);
        colour=mix(colour,treeline,1.-smoothstep(grove-.002,grove+.002,height));
        float field=noise(compass*8.+vec2(height*27.,height*18.));
        vec3 meadow=mix(ground*.67,ground*1.08,field);
        colour=mix(colour,meadow,1.-smoothstep(-.082,-.015,height));
        float facing = max(dot(ray, sunDirection), 0.0);
        colour += vec3(1.0, 0.86, 0.62) * (0.20 * pow(facing, 6.0) + 0.55 * pow(facing, 90.0));
        colour += vec3(1.0, 0.97, 0.88) * smoothstep(0.99994, 0.99998, facing) * 12.0;
        if (height > 0.015) {
          vec2 deck=ray.xz/(height+.065);
          vec2 wind=mat2(.86,.51,-.51,.86)*deck;
          vec2 stretched=wind*vec2(.43,2.65)+vec2(2.8,-1.1);
          float warp=billow(wind*.64);
          float strands=billow(stretched+vec2(warp*1.8,warp*2.6));
          float high=smoothstep(.43,.80,strands)*smoothstep(.12,.75,billow(wind*.51+.7));
          float cumulus=smoothstep(.66,.86,billow(deck*.98+vec2(-1.7,4.3)));
          float light=.72+.24*pow(facing,2.);
          vec3 veil=mix(vec3(.69,.74,.79),vec3(1.04,1.01,.94),light);
          colour=mix(colour,veil,high*.27*smoothstep(.015,.22,height));
          colour=mix(colour,vec3(.91,.91,.88),cumulus*.48*smoothstep(.01,.15,height));
        }
        gl_FragColor = vec4(colour, 1.0);
        #include <colorspace_fragment>
      }`
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), material);
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  return dome;
}

export function daylight(renderer,scene,background){
  THREE.ShaderChunk.tonemapping_fragment=autumnDisplay;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=.91;
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate=false;
  const skyScene=new THREE.Scene();
  const sky=daylightSky();
  skyScene.add(sky);
  const cube=new THREE.WebGLCubeRenderTarget(256,{type:THREE.HalfFloatType,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter});
  new THREE.CubeCamera(.1,1000,cube).update(renderer,skyScene);
  const generator=new THREE.PMREMGenerator(renderer);
  const environment=generator.fromCubemap(cube.texture);
  scene.environment=environment.texture;
  scene.environmentIntensity=.58;
  if(background){
    scene.background=cube.texture;
    scene.fog=new THREE.FogExp2(horizonHaze,.00128);
  }else cube.dispose();
  generator.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  const sun=new THREE.DirectionalLight(0xffefda,3.12);
  sun.castShadow=true;
  scene.add(sun,sun.target,new THREE.HemisphereLight(0xd6e1ee,0x958674,1.05));
  return sun;
}

export function followShadows(renderer,sun,quality){
  const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),sunDirection).normalize();
  const up=new THREE.Vector3().crossVectors(sunDirection,right);
  const anchor=new THREE.Vector3(Infinity,Infinity,Infinity);
  const point=new THREE.Vector3();
  function configure({mapSize,reach}){
    sun.shadow.map?.dispose();
    sun.shadow.map=null;
    sun.shadow.mapSize.setScalar(Math.min(mapSize,renderer.capabilities.maxTextureSize));
    Object.assign(sun.shadow.camera,{left:-reach,right:reach,bottom:-reach,top:reach,near:1,far:360});
    const texel=2*reach/sun.shadow.mapSize.x;
    sun.shadow.radius=Math.min(2.55,.18/texel);
    sun.shadow.normalBias=1.64*texel;
    sun.shadow.bias=-.55*texel/(sun.shadow.camera.far-sun.shadow.camera.near);
    sun.shadow.camera.updateProjectionMatrix();
    anchor.setScalar(Infinity);
  }
  configure(quality.current);
  quality.onChange(configure);
  return function update(pose,detailChanged){
    point.set(pose.x,pose.y,pose.z);
    if(detailChanged) renderer.shadowMap.needsUpdate=true;
    if(point.distanceToSquared(anchor)<144) return;
    anchor.copy(point);
    const texel=2*sun.shadow.camera.right/sun.shadow.mapSize.x;
    const x=point.dot(right),y=point.dot(up);
    point.addScaledVector(right,Math.round(x/texel)*texel-x);
    point.addScaledVector(up,Math.round(y/texel)*texel-y);
    sun.target.position.copy(point);
    sun.position.copy(point).addScaledVector(sunDirection,180);
    renderer.shadowMap.needsUpdate=true;
  };
}

export function carContact(){
  const material=new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,
    uniforms:{sun:{value:sunDirection}},
    vertexShader:`
      uniform vec3 sun;
      varying vec2 groundPoint,displacement;
      void main(){
        vec3 localSun=vec3(dot(sun,modelMatrix[0].xyz),dot(sun,modelMatrix[1].xyz),dot(sun,modelMatrix[2].xyz));
        displacement=-localSun.xz/max(.4,localSun.y);
        groundPoint=position.xz;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
      }`,
    fragmentShader:`
      varying vec2 groundPoint,displacement;
      float footprint(vec2 p,vec2 size,float radius){
        vec2 q=abs(p)-size+radius;
        return length(max(q,vec2(0.)))+min(max(q.x,q.y),0.)-radius;
      }
      void main(){
        float base=footprint(groundPoint-displacement*.19,vec2(.91,2.1),.26);
        float body=footprint(groundPoint-displacement*.74,vec2(.88,2.04),.38);
        float cabin=footprint(groundPoint-displacement*1.25-vec2(0.,-.12),vec2(.71,1.1),.28);
        float shade=1.-smoothstep(-.07,.12,min(base,min(body,cabin)));
        float contact=1.-smoothstep(-.15,.23,base);
        gl_FragColor=vec4(.017,.025,.035,.42*shade+.22*contact);
        #include <colorspace_fragment>
      }`
  });
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(6,8).rotateX(-Math.PI/2),material);
  mesh.position.y=.065;
  return mesh;
}
