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
  vec3 riverColour(vec3 land,vec2 p,float weight){
    float footprint=length(fwidth(p));
    if(weight<=0.)return land;
    float s=riverNoise(p*.13);
    float ripple=riverNoise(p*.75+vec2(s,-s)*1.4)-.5;
    float gravel=(riverNoise(p*13.0)-.5)*(1.-smoothstep(.025,.090,footprint));
    float fetch=riverNoise(p*.32+vec2(s,-s));
    vec2 wind=vec2(dot(p,vec2(.86,.51)),dot(p,vec2(-.51,.86)));
    float crests=riverNoise(wind*vec2(1.40,6.7)+2.2*fetch)-.5;
    float resolved=1.-smoothstep(.065,.36,footprint);
    vec3 bed=mix(vec3(.037,.049,.024),vec3(.075,.080,.044),s)*(1.+.19*ripple+.17*gravel);
    bed+=vec3(.010,.012,.016)*crests*(.38+.62*fetch)*resolved;
    return mix(land,bed,weight);
  }
  vec3 riverNormal(vec2 p,float footprint){
    float shift=riverNoise(p*.31)*6.+riverNoise(p*.91)*1.7;
    vec2 a=vec2(.87,.50),b=vec2(-.31,.95);
    float u=dot(a,p)*6.3+shift,v=dot(b,p)*11.4-1.7*shift;
    float strength=.35+.65*riverNoise(p*.68);
    float capillary=1.-smoothstep(.03,.23,footprint);
    vec2 slope=strength*(a*sin(u)*.067+b*cos(v)*.041)*capillary;
    return normalize(mat3(viewMatrix)*vec3(slope.x,1.,slope.y));
  }`;

export function riverFinish(shader,site,weight){
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+riverGLSL)
    .replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
      roughnessFactor=mix(roughnessFactor,.27,${weight});`)
    .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
      float rippleFootprint=length(fwidth(${site}));
      if(${weight}>0.)normal=normalize(mix(normal,riverNormal(${site},rippleFootprint),${weight}));`)
    .replace('#include <opaque_fragment>',`if(${weight}>0.){
        float waterGrazing=pow(1.-clamp(dot(normal,normalize(vViewPosition)),0.,1.),3.);
        outgoingLight=mix(outgoingLight,vec3(.178,.254,.308),${weight}*(.045+.47*waterGrazing));
      }
      #include <opaque_fragment>`);
}
