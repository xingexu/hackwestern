export const riverGLSL=`
  float riverCorner(ivec2 cell){
    uvec2 p=uvec2(cell);
    uint h=(p.x*1597334677u)^(p.y*3812015801u);
    h=(h^(h>>16u))*2246822519u;
    return float((h^(h>>13u))>>8u)/16777216.;
  }
  float riverNoise(vec2 p){
    ivec2 i=ivec2(floor(p));
    vec2 f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(riverCorner(i),riverCorner(i+ivec2(1,0)),f.x),
               mix(riverCorner(i+ivec2(0,1)),riverCorner(i+ivec2(1)),f.x),f.y);
  }
  vec3 riverBed(vec2 p){
    float s=riverNoise(p*.13);
    float ripple=riverNoise(p*.75+vec2(s,-s)*1.4)-.5;
    float gravel=(riverNoise(p*13.0)-.5)*(1.-smoothstep(.025,.090,length(fwidth(p))));
    return mix(vec3(.038,.050,.023),vec3(.083,.081,.046),s)*(1.+.17*ripple+.18*gravel);
  }
  vec3 riverNormal(vec2 p){
    float shift=riverNoise(p*.31)*6.+riverNoise(p*.91)*1.7;
    vec2 a=vec2(.87,.50),b=vec2(-.31,.95);
    float u=dot(a,p)*6.3+shift,v=dot(b,p)*11.4-1.7*shift;
    float strength=.34+.66*riverNoise(p*.68);
    vec2 slope=strength*(a*sin(u)*.064/(1.+fwidth(u))+b*cos(v)*.042/(1.+fwidth(v)));
    return normalize(mat3(viewMatrix)*vec3(slope.x,1.,slope.y));
  }`;

export function riverFinish(shader,site,weight){
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+riverGLSL)
    .replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
      roughnessFactor=mix(roughnessFactor,.32,${weight});`)
    .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
      normal=normalize(mix(normal,riverNormal(${site}),${weight}));`);
}
