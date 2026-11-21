import {removeFoliage} from 'core-volume';
import {createGroveLevels} from 'grove-lod';
import * as THREE from 'three';

import { shapeBatch } from 'drive-art';

import {barkFinish,foliageCluster,leafSprayTexture,lightLeafBacks} from 'leaf-sprays';

export function summerFoliage(red, green, blue, variation, target = new THREE.Color()) {
  const brightness = (.3 * red + .55 * green + .15 * blue) / 255;
  const hue = .206 + .096 * variation + .035 * Math.max(-1, Math.min(1, (green - red) / 40));
  const saturation = .285 + .15 * (1 - variation);
  const lightness = .3 + .15 * Math.min(1, Math.max(0, (brightness - .2) / .45));
  return target.setHSL(hue, saturation, lightness, THREE.SRGBColorSpace);
}

export async function createCampusTrees(volume, treeData, samples, network) {
  if(volume) {
    const packed=Uint8Array.from(atob(treeData.cells),c=>c.charCodeAt(0));
    const bitmap=new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    removeFoliage(volume,bitmap);
  }
  const woodGeometry = new THREE.CylinderGeometry(.73, 1, 1, 7);
  const leafGeometry=foliageCluster(.47);
  const groves = new Map();
  const shape = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3();
  const wood = new THREE.Color(0x5a4a3b);
  function branch(bark, a, b, radius) {
    axis.subVectors(b, a);
    shape.position.copy(a).lerp(b, .5);
    shape.scale.set(radius, axis.length(), radius);
    shape.quaternion.setFromUnitVectors(up, axis.normalize());
    bark.place(shape, wood);
    network.addBranch(a.toArray(),b.toArray(),radius,radius*.73,'core tree');
  }
  const planted = [];
  const foliage = new THREE.Color(), tuft = new THREE.Color();
  for (const [x, y, z, radius, center, red, green, blue, conifer] of treeData.trees) {
    if (samples.some(s => Math.abs(s.x - x) < 10 && Math.hypot(s.x - x, s.z - z) < 9)) continue;
    if (planted.some(t => Math.abs(t.x - x) < 8 && Math.hypot(t.x - x, t.z - z) < (t.r + radius) * .68)) continue;
    if(network.sample(x,z,y).surface==='road') continue;
    planted.push({ x, z, r: radius });
    const key = Math.floor(x / 64) + ',' + Math.floor(z / 64);
    if (!groves.has(key)) groves.set(key, [shapeBatch(THREE, woodGeometry), shapeBatch(THREE, leafGeometry),[]]);
    const [bark, crown, standing] = groves.get(key);
    let seed = ((x * 2033 + z * 9151) | 0) >>> 0;
    function random() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    const trunk = new THREE.Vector3(x, y - .12, z);
    const stature = (center - y) / radius;
    const evergreen = conifer===undefined ? blue > red + 10 && red + green + blue < 210 && stature > 1.8 : Boolean(conifer);
    const columnar = !evergreen && stature > 2.2;
    const fork = new THREE.Vector3(x + random() * .42 - .21, Math.max(y + 1.8, center - radius * (evergreen ? .9 : .62)), z + random() * .42 - .21);
    const top = new THREE.Vector3(fork.x * .5 + x * .5, center + radius * (evergreen ? .95 : .3), fork.z * .5 + z * .5);
    branch(bark, trunk, fork, .12 + radius * .044);
    summerFoliage(red, green, blue, random(), foliage);
    if (evergreen) foliage.offsetHSL(.07, -.06, -.06);
    standing.push({x,z,center,radius,evergreen,columnar,color:foliage.clone()});
    const base = center - radius * .62, span = radius * 1.35;
    function leaves(px, py, pz, width, height, depth, brightness) {
      shape.position.set(px, py, pz);
      shape.rotation.set(0, random() * Math.PI, .2 * (random() - .5));
      shape.scale.set(width, height, depth);
      const lift = Math.min(1, Math.max(0, (py - base) / span));
      const reach = Math.hypot(px - x, pz - z) || 1;
      const facing = (-.8 * (px - x) - .6 * (pz - z)) / reach;
      tuft.copy(foliage).multiplyScalar(brightness * (.76 + .4 * lift) * (1 + .1 * facing * Math.min(1, reach / radius * 2)));
      tuft.offsetHSL((random() - .5) * .025 - .014 * lift, .04 * lift, .025 * lift);
      crown.place(shape, tuft.clone());
    }
    if (evergreen) {
      branch(bark, fork, top, .05 + radius * .03);
      for (let tier = 0; tier < 6; tier++) {
        const t = tier / 5, w = radius * (.9 - .68 * t);
        leaves(x + (random() - .5) * .3, fork.y - radius * .25 + (top.y - fork.y + radius * .25) * t, z + (random() - .5) * .3, w, radius * (.34 - .1 * t), w * .96, .78 + .3 * t);
      }
      continue;
    }
    leaves(x, center + radius * .02, z, radius * .56, radius * .42, radius * .56, .74);
    branch(bark, fork, top, .05 + radius * .026);
    leaves(top.x, top.y, top.z, radius * (columnar ? .4 : .44), radius * .36, radius * (columnar ? .4 : .44), 1.04);
    leaves(top.x + (random() - .5) * radius * .3, top.y - radius * .2, top.z + (random() - .5) * radius * .3, radius * .36, radius * .3, radius * .36, .94);
    const angle = random() * 2 * Math.PI, limbs = (columnar ? 4 : 5)+Math.floor(random()*3);
    for (let limb = 0; limb < limbs; limb++) {
      const a = angle + limb * 2.39996 + (random() - .5) * .59;
      const reach = (columnar ? .3 + .12 * random() : .46 + .22 * random()) * radius;
      const start = fork.clone().lerp(top, columnar ? limb / limbs * .6 : random() * .25);
      const tip = new THREE.Vector3(x + Math.cos(a) * reach, center + radius * (columnar ? (limb / limbs - .4) * .7 : (limb/limbs-.45)*.65+random()*.14), z + Math.sin(a) * reach);
      branch(bark, start, tip, .05 + radius * .022);
      const w = radius * (columnar ? .3 + random() * .08 : .33 + random() * .1);
      leaves(tip.x, tip.y + radius * .06, tip.z, w * 1.12, w * .82, w, .92 + random() * .16);
      const out = new THREE.Vector3(tip.x + Math.cos(a + .5) * radius * .26, tip.y - radius * .1, tip.z + Math.sin(a + .5) * radius * .26);
      branch(bark, tip, out, .03 + radius * .012);
      leaves(out.x, out.y, out.z, w * .86, w * .66, w * .82, .86 + random() * .14);
      leaves(tip.x * .6 + top.x * .4, tip.y * .5 + top.y * .5 + radius * .05, tip.z * .6 + top.z * .4, w * .92, w * .74, w * .9, .96 + random() * .14);
    }
  }
  const group = new THREE.Group();
  const leaves=leafSprayTexture();
  const levels=[];
  for (const [bark, crown, standing] of groves.values()) {
    const canopy = crown.mesh(new THREE.MeshStandardMaterial({roughness:.86}));
    canopy.material.flatShading = false;
    canopy.material.map = leaves;
    canopy.material.alphaTest=.38;
    canopy.material.onBeforeCompile=lightLeafBacks;
    canopy.material.side=THREE.DoubleSide;
    const trunkMaterial=new THREE.MeshStandardMaterial({roughness:.96});
    trunkMaterial.onBeforeCompile=barkFinish;
    const trunks=bark.mesh(trunkMaterial);
    group.add(trunks, canopy);
    levels.push(createGroveLevels(canopy,trunks,standing,group));
  }
  group.userData.updateLevels=(x,z,distance)=>{for(const update of levels) update(x,z,distance);};
  return group;
}
