import * as THREE from 'three';

export function foundationLight(buildings){
  const parts=buildings.flatMap(b=>b.parts.filter(p=>p.low<=.05 && p.high>1 && b.spec.present!==false && (b.spec.style!=='parking-structure' || /stair|lift|elevator|enclosed/i.test(p.name??''))));
  const rings=parts.flatMap(p=>p.solidRings??p.rings);
  let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;
  for(const ring of rings)for(const [x,z] of ring){
    x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z);
  }
  if(!rings.length)return;
  x0-=8;z0-=8;x1+=8;z1+=8;
  const scale=Math.min(1.6,3072/Math.max(x1-x0,z1-z0));
  const width=Math.ceil((x1-x0)*scale),height=Math.ceil((z1-z0)*scale);
  const mask=new OffscreenCanvas(width,height),ink=mask.getContext('2d');
  ink.fillStyle='white';
  for(const part of parts){
    ink.beginPath();
    for(const ring of part.solidRings??part.rings){
      ring.forEach(([x,z],i)=>ink[i?'lineTo':'moveTo']((x-x0)*scale,(z-z0)*scale));
      ink.closePath();
    }
    ink.fill('evenodd');
  }
  const softened=new OffscreenCanvas(width,height),brush=softened.getContext('2d');
  brush.filter='blur('+1.15*scale+'px)';brush.drawImage(mask,0,0);
  const rgba=brush.getImageData(0,0,width,height).data,values=new Uint8Array(width*height);
  for(let i=0;i<values.length;i++)values[i]=rgba[4*i+3];
  const map=new THREE.DataTexture(values,width,height,THREE.RedFormat);
  map.magFilter=THREE.LinearFilter;map.minFilter=THREE.LinearMipmapLinearFilter;map.generateMipmaps=true;map.needsUpdate=true;
  const bounds=new THREE.Vector4(x0,z0,scale/width,scale/height);
  return shader=>{
    shader.uniforms.footprintShade={value:map};shader.uniforms.footprintTransform={value:bounds};
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform sampler2D footprintShade;uniform vec4 footprintTransform;')
      .replace('#include <aomap_fragment>',`#include <aomap_fragment>
        float foundation=texture2D(footprintShade,(surveyPoint-footprintTransform.xy)*footprintTransform.zw).r;
        reflectedLight.indirectDiffuse*=1.-.34*foundation;
        reflectedLight.indirectSpecular*=1.-.30*foundation;`);
  };
}
