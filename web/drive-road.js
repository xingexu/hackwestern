import * as THREE from 'three';

export function createRoad(samples,network) {
  const positions=[],colors=[];
  const light=new THREE.Color(0xdfdfd0),dark=new THREE.Color(0x303538);
  function corner(s,offset,along){
    const sin=Math.sin(s.heading),cos=Math.cos(s.heading);
    const x=s.x+offset*cos+along*sin,z=s.z-offset*sin+along*cos;
    return [x,network.groundAt(x,z)+.035,z];
  }
  for(const sample of [samples[0],samples.at(-1)]){
    for(let row=0;row<2;row++) for(let col=0;col<16;col++){
      const l=(col-8)*.5,r=l+.5,a=(row-1)*.45,b=a+.45;
      const corners=[corner(sample,l,a),corner(sample,l,b),corner(sample,r,b),corner(sample,r,a)];
      if(!corners.every(([x,y,z])=>network.sample(x,z,y).surface==='road')) continue;
      const tint=(col+row)%2?light:dark;
      for(const i of [0,1,2,0,2,3]){
        positions.push(...corners[i]);
        colors.push(tint.r,tint.g,tint.b);
      }
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.computeVertexNormals();
  const grid=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({side:THREE.DoubleSide,vertexColors:true,polygonOffset:true,polygonOffsetFactor:-1}));
  grid.receiveShadow=true;
  return grid;
}
