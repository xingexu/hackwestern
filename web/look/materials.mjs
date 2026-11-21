import * as THREE from 'three';

export function colorTexture(texture,anisotropy=4){
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=anisotropy;
  texture.generateMipmaps=true;
  texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.magFilter=THREE.LinearFilter;
  return texture;
}

export function carFinishes(){
  const paint=new THREE.MeshPhysicalMaterial({
    color:0xc63514,roughness:.27,metalness:.52,clearcoat:1,clearcoatRoughness:.095
  });
  const glass=new THREE.MeshPhysicalMaterial({
    color:0x192e3d,roughness:.095,metalness:.32,clearcoat:1,clearcoatRoughness:.045,ior:1.52
  });
  const tyre=new THREE.MeshStandardMaterial({color:0x1d2125,roughness:.91});
  const trim=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.39,metalness:.46});
  return {paint,glass,tyre,trim};
}

export function padLandcover(classes,transitions,width){
  const cover=classes.slice(),blend=transitions.slice();
  let frontier=[];
  for(let i=width;i<cover.length-width;i++){
    if(cover[i]!==255 && (cover[i-1]===255 || cover[i+1]===255 || cover[i-width]===255 || cover[i+width]===255))frontier.push(i);
  }
  for(let ring=0;ring<3;ring++){
    const next=[];
    for(const i of frontier){
      for(const j of [i-width,i+width,i-1,i+1]){
        if(cover[j]!==255 || Math.abs(i%width-j%width)>1)continue;
        cover[j]=cover[i];
        blend.copyWithin(4*j,4*i,4*i+4);
        next.push(j);
      }
    }
    frontier=next;
  }
  return {cover,blend};
}
