import * as THREE from 'three';
import survey from './reflection-survey.mjs';

let atlas;

export async function prepareReflections(){
  if(atlas || new URLSearchParams(globalThis.location?.search).has('bakeReflections'))return;
  const image=await new THREE.ImageLoader().loadAsync(new URL('./reflection-atlas.webp',import.meta.url).href);
  if(atlas)return;
  atlas=new THREE.Texture(image);
  atlas.flipY=false;
  atlas.generateMipmaps=false;
  atlas.colorSpace=THREE.SRGBColorSpace;
  atlas.minFilter=atlas.magFilter=THREE.LinearFilter;atlas.needsUpdate=true;
}

export function reflectedCampus(shader){
  if(!atlas)return;
  shader.uniforms.glazingAtlas={value:atlas};
  shader.uniforms.glazingBounds={value:new THREE.Vector4(...survey.bounds)};
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
    uniform sampler2D glazingAtlas;
    uniform vec4 glazingBounds;
    const vec2 probeGrid=vec2(${survey.columns}.,${survey.rows}.);
    const vec2 probeTile=vec2(${survey.wide}.,${survey.high}.);
    vec3 localReflection(vec2 world,vec3 ray){
      vec2 grid=clamp((world-glazingBounds.xy)/(glazingBounds.zw-glazingBounds.xy),0.,1.)*(probeGrid-1.);
      vec2 cell=floor(grid),blend=smoothstep(vec2(.32),vec2(.68),fract(grid));
      float azimuth=fract(atan(ray.x,-ray.z)/6.2831853+.9999999);
      float elevation=clamp((degrees(asin(clamp(ray.y,-1.,1.)))+28.)/68.,.5/probeTile.y,1.-.5/probeTile.y);
      vec2 uv=vec2((1.+azimuth*(probeTile.x-2.))/probeTile.x,elevation);
      vec2 next=min(cell+1.,probeGrid-1.);
      return mix(mix(texture2D(glazingAtlas,(cell+uv)/probeGrid).rgb,texture2D(glazingAtlas,(vec2(next.x,cell.y)+uv)/probeGrid).rgb,blend.x),
                 mix(texture2D(glazingAtlas,(vec2(cell.x,next.y)+uv)/probeGrid).rgb,texture2D(glazingAtlas,(next+uv)/probeGrid).rgb,blend.x),blend.y);
    }`).replace('#include <opaque_fragment>',`float coating=family==0 && physical.w>.35 && physical.z<.6 && surface.z<.5?1.:0.;
      if(glazing || coating>.5){
      vec3 ray=inverseTransformDirection(reflect(-normalize(vViewPosition),normal),viewMatrix);
      float latitude=smoothstep(-.53,-.30,ray.y)*(1.-smoothstep(.43,.68,ray.y));
      if(latitude>.001){
        float fresnel=pow(1.-abs(dot(normalize(vViewPosition),normal)),3.);
        vec3 reflection=localReflection(campusP.xz,ray);
        float reflectance=mix(.33+.36*fresnel,.14+.28*fresnel,coating);
        outgoingLight=mix(outgoingLight,reflection,latitude*reflectance*(1.-glassFrame));
      }
    }
    #include <opaque_fragment>`);
}
