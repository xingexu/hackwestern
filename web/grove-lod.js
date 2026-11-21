import * as THREE from 'three';

const coarseGeometry=new THREE.IcosahedronGeometry(1,0);
const intermediateGeometry=new THREE.IcosahedronGeometry(1,1);

export function createGroveLevels(crown,trunks,trees,group) {
  const transform=new THREE.Object3D(),hue=new THREE.Color();
  const material=new THREE.MeshStandardMaterial({roughness:.9});
  function replacement(parts,geometry){
    const mesh=new THREE.InstancedMesh(geometry,material,trees.length*parts);
    let index=0;
    for(const tree of trees){
      const {x,z,center,radius,color,evergreen,columnar}=tree;
      const turn=(x*1.43+z*.76)%6.28;
      for(let part=0;part<parts;part++){
        const top=part===parts-1,angle=turn+part*2.39996,t=part/(parts-1);
        const reach=evergreen||top ? 0 : radius*(columnar?.18:.28+.17*Math.sin(angle));
        transform.position.set(x+Math.cos(angle)*reach,center+(evergreen ? t*1.75-.86 : top ? .30 : .32*t-.22)*radius,z+Math.sin(angle)*reach);
        transform.rotation.set(0,angle,0);
        const width=radius*(evergreen ? .91-.70*t : top ? .51 : columnar?.53:.67+.07*Math.cos(angle));
        transform.scale.set(width,radius*(evergreen?.43:columnar?.75:.53),width*.94);
        transform.updateMatrix();
        mesh.setMatrixAt(index,transform.matrix);
        mesh.setColorAt(index,hue.copy(color).multiplyScalar(top?1.05:.88+part*.04));
        index++;
      }
    }
    mesh.computeBoundingSphere();
    mesh.castShadow=mesh.receiveShadow=true;
    mesh.visible=false;
    group.add(mesh);
    return mesh;
  }
  const middle=replacement(4,intermediateGeometry),far=replacement(3,coarseGeometry);
  const {center}=crown.boundingSphere;
  let tier=0;
  return (x,z,distance)=>{
    const range=Math.hypot(x-center.x,z-center.z);
    const next=distance>620?2:range<(tier===0?130:110)&&distance<380?0:range<(tier===1?285:255)&&distance<580?1:2;
    crown.visible=next===0;
    middle.visible=next===1;
    far.visible=next===2;
    trunks.visible=true;
    tier=next;
  };
}
