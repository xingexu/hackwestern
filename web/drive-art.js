import {speedKph} from './race/input.mjs';
import {carFinishes,colorTexture} from 'look-materials';

export function shapeBatch(THREE, geometry) {
  const transforms = [];
  const colors = [];
  const shape = new THREE.Object3D();
  function place(transform, color) {
    transform.updateMatrix();
    transforms.push(transform.matrix.clone());
    colors.push(color);
  }
  return {
    place,
    add(x, y, z, width, height, length, color, yaw = 0, pitch = 0, roll = 0) {
      shape.position.set(x, y, z);
      shape.rotation.set(pitch, yaw, roll);
      shape.scale.set(width, height, length);
      place(shape, color);
    },
    mesh(material=new THREE.MeshStandardMaterial({roughness:.82})) {
      const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
      const tint = new THREE.Color();
      transforms.forEach((matrix, i) => {
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, tint.set(colors[i]));
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    }
  };
}

const coupeSections = [
  [-2.13, .67, .62, .64, 0, .64],
  [-2.03, .81, .73, .78, 0, .78],
  [-1.79, .90, .84, .83, 0, .83],
  [-1.53, .93, .89, .85, .53, .90],
  [-1.20, .93, .89, .83, .66, 1.07],
  [-.79, .89, .83, .82, .72, 1.25],
  [-.40, .85, .78, .81, .73, 1.34],
  [.05, .85, .77, .80, .71, 1.35],
  [.39, .86, .78, .79, .68, 1.29],
  [.71, .89, .84, .78, .61, 1.08],
  [.99, .91, .88, .76, .55, .84],
  [1.17, .92, .89, .74, 0, .74],
  [1.58, .89, .84, .69, 0, .69],
  [1.93, .82, .72, .62, 0, .62],
  [2.12, .68, .56, .56, 0, .56]
];

function shellGeometry(THREE,rings){
  const columns=rings[0].length;
  const positions=rings.flat(2);
  const indices=[];
  for(let row=0;row<rings.length-1;row++){
    for(let col=0;col<columns-1;col++){
      const a=row*columns+col,b=a+columns;
      indices.push(a,b,a+1,a+1,b,b+1);
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function coupeShell(THREE,finishes){
  const sections=z=>{
    const i=coupeSections.findIndex(section=>section[0]>=z);
    if(i<1) return coupeSections[i===0?0:coupeSections.length-1].slice(1);
    const a=coupeSections[i-1],b=coupeSections[i],t=(z-a[0])/(b[0]-a[0]);
    return a.slice(1).map((value,j)=>value+(b[j+1]-value)*t);
  };
  const zs=[...new Set([...coupeSections.map(s=>s[0]),...Array.from({length:84},(_,i)=>-2.1+i*.05)])].sort((a,b)=>a-b);
  const rings=zs.map(z=>{
    const [width,shoulder,deck]=sections(z);
    const wheel=Math.min(Math.abs(z+1.24),Math.abs(z-1.27));
    const arch=wheel<.39?.33+Math.sqrt(.39**2-wheel**2):.21;
    const side=[[width*.77,.21],[width*.95,arch],[width,Math.max(arch+.012,shoulder-.15)],
      [width*.985,shoulder-.052],[width*.91,shoulder],[width*.77,shoulder+.012],[width*.63,deck+.012]];
    return [...side.map(([x,y])=>[-x,y,z]),[0,deck+.022,z],...side.reverse().map(([x,y])=>[x,y,z])];
  });
  const cap=(ring,z)=>ring.map(([x,y])=>[x*.95,.24+(.52*(y-.21)),z]);
  rings.unshift(cap(rings[0],-2.138));
  rings.push(cap(rings.at(-1),2.131));
  const geometry=shellGeometry(THREE,rings);
  const indices=Array.from(geometry.index.array);
  for(const [row,rear] of [[0,true],[rings.length-1,false]]){
    const base=row*rings[0].length;
    for(let i=1;i<rings[0].length-1;i++){
      if(rear) indices.push(base,base+i,base+i+1);
      else indices.push(base,base+i+1,base+i);
    }
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const body=new THREE.Mesh(geometry,finishes.paint);
  const cabinSections=[-1.47,-1.39,-1.20,-.79,-.53,-.46,-.26,-.205,-.14,.05,.32,.40,.71,.91,.99];
  const cabinRings=cabinSections.map(z=>{
    const [, ,deck,width,top]=sections(z);
    const bottom=deck+.018;
    const height=Math.max(.006,top-bottom);
    const side=[[width+.025,bottom],[width*.986,bottom+height*.10],[width*.81,bottom+height*.84],
      [width*.765,bottom+height*.95],[width*.70,top]];
    return [...side.map(([x,y])=>[-x,y,z]),[0,top+.012,z],...side.reverse().map(([x,y])=>[x,y,z])];
  });
  const glazing=shellGeometry(THREE,cabinRings);
  const stride=cabinRings[0].length-1;
  const batches=[[],[]];
  for(let row=0;row<cabinSections.length-1;row++){
    const z=(cabinSections[row]+cabinSections[row+1])*.5;
    for(let col=0;col<stride;col++){
      const side=Math.min(col,stride-1-col);
      const window=side>=3?(z>-.999 && z<-.52 || z>.4 && z<.91)
        :(side===1 || side===2) && z> -1.2 && z<.71 && (z<-.26 || z>-.14);
      const i=(row*stride+col)*6;
      batches[Number(window)].push(...glazing.index.array.subarray(i,i+6));
    }
  }
  glazing.setIndex([...batches[0],...batches[1]]);
  glazing.addGroup(0,batches[0].length,0);
  glazing.addGroup(batches[0].length,batches[1].length,1);
  body.add(new THREE.Mesh(glazing,[finishes.paint,finishes.glass]));
  return body;
}

export function createCoupe(THREE) {
  const coupe = new THREE.Group();
  const finishes=carFinishes();
  coupe.name = 'Sports coupe';
  coupe.add(coupeShell(THREE,finishes));
  const trim = shapeBatch(THREE, new THREE.BoxGeometry());
  const wheelGeometry=new THREE.CylinderGeometry(1,1,1,40);
  const discs=shapeBatch(THREE,wheelGeometry);
  const tyres=shapeBatch(THREE,wheelGeometry);
  const dark = 0x292d30;
  trim.add(0, .70, -2.054, 1.50, .125, .145, dark);
  trim.add(0, .70, -2.132, 1.41, .053, .018, 0x9b251e);
  trim.add(0, .46, -2.109, 1.43, .13, .14, 0xc04024);
  trim.add(0, .41, -2.184, .33, .135, .024, 0x303638);
  trim.add(0, .418, -2.200, .25, .085, .014, 0xe6dbc0);
  trim.add(0, .29, -2.047, 1.42, .10, .18, dark);
  trim.add(0, .838, -1.86, 1.49, .09, .24, 0xcf4022);
  trim.add(0, .892, -1.937, 1.53, .035, .11, 0x3f3c36);
  for (let slat = 0; slat < 5; slat++) {
    trim.add(0, .874 + .005 * slat, -1.765 + .062 * slat, .82, .028, .039, dark);
  }
  for (const side of [-1, 1]) {
    trim.add(side * .563, .714, -2.145, .26, .083, .028, 0xf1543b);
    trim.add(side * .717, .713, -2.120, .058, .078, .053, 0xe99038);
    trim.add(side * .585, .249, -2.119, .14, .095, .20, 0x8a8f88);
    trim.add(side * .585, .249, -2.222, .096, .061, .014, 0x242727);
    trim.add(side * .835, .33, .01, .08, .105, 1.50, 0x992e1d);
    trim.add(side * .855, .718, -.38, .04, .044, .16, dark);
    trim.add(side * .796, .837, .53, .13, .05, .085, dark);
    trim.add(side * .907, .878, .53, .138, .093, .15, 0xd94724);
    trim.add(side * .903, .882, .449, .104, .060, .014, 0x8f9a98);
    trim.add(side * .654, .687, 1.958, .19, .12, .13, 0x403d38);
    trim.add(side * .654, .696, 2.023, .15, .091, .075, 0xf2dca4);
    trim.add(side * .654, .755, 1.981, .105, .040, .08, 0xffe9ac);
    trim.add(side * .61, .424, 2.071, .243, .067, .07, dark);
    for (const z of [-1.24, 1.27]) {
      const axle = side * .752;
      const disc = (radius, thickness, offset, color) => {
        discs.add(axle + side * offset, .338, z, radius, thickness, radius, color, 0, 0, Math.PI / 2);
      };
      tyres.add(axle,.338,z,.338,.268,.338,0xffffff,0,0,Math.PI/2);
      disc(.215, .013, .139, 0x9da6a2);
      disc(.172, .015, .149, 0x393e40);
      disc(.070, .026, .160, 0xb9c0b9);
      for (let spoke = 0; spoke < 5; spoke++) {
        const angle = 2 * Math.PI * spoke / 5;
        trim.add(axle + side * .161, .338 - .11 * Math.sin(angle), z + .11 * Math.cos(angle),
          .024, .055, .146, 0xa0a9a7, 0, angle);
      }
    }
  }
  trim.add(0, .36, 2.088, .76, .09, .13, dark);
  coupe.add(trim.mesh(finishes.trim),discs.mesh(finishes.trim),tyres.mesh(finishes.tyre));
  return coupe;
}

export function createDriverInterior(THREE, shell) {
  const interior = new THREE.Group();
  const vertices = shell.geometry.attributes.position;
  const indices = shell.geometry.index.array;
  const hoodFaces = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (Math.min(vertices.getZ(a), vertices.getZ(b), vertices.getZ(c)) > .91) hoodFaces.push(a, b, c);
  }
  const hood = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(shell.geometry.attributes)) hood.setAttribute(name, attr);
  hood.setIndex(hoodFaces);
  interior.add(new THREE.Mesh(hood, shell.material));
  const cabin = shapeBatch(THREE, new THREE.BoxGeometry());
  cabin.add(0, .70, .64, 1.75, .31, .85, 0x303738, 0, -.035);
  cabin.add(0, .69, .30, 1.70, .14, .13, 0x202629);
  cabin.add(.34, .82, .64, .51, .11, .32, 0x22292b);
  cabin.add(-.34, .825, .54, .36, .04, .14, 0x151a1a);
  for (const x of [-.80, .80]) cabin.add(x, 1.29, .49, .045, 1.47, .058, 0x353b3b, 0, -.64, x * .13);
  interior.add(cabin.mesh());
  const wheel = new THREE.Group();
  wheel.position.set(.34, .78, .40);
  const leather = new THREE.MeshStandardMaterial({color:0x252a2c,roughness:.8});
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(.178, .022, 7, 32), leather));
  const spokes = shapeBatch(THREE, new THREE.BoxGeometry());
  spokes.add(0, 0, 0, .13, .085, .05, 0x32383b);
  spokes.add(0, -.094, 0, .039, .15, .03, 0x454b4d);
  spokes.add(0, .003, 0, .335, .032, .029, 0x454b4d);
  spokes.add(0, .178, -.005, .025, .032, .037, 0xc7a767);
  wheel.add(spokes.mesh());
  interior.add(wheel);
  const dial = document.createElement('canvas');
  dial.width = dial.height = 128;
  const ctx = dial.getContext('2d');
  ctx.fillStyle = '#1d2427';
  ctx.beginPath();
  ctx.arc(64, 64, 63, 0, 2 * Math.PI);
  ctx.fill();
  for (let tick = 0; tick <= 24; tick++) {
    const angle = Math.PI * (.77 + 1.46 * tick / 24);
    const inner = tick % 4 ? 50 : 44;
    ctx.lineWidth = tick % 4 ? 2 : 4;
    ctx.strokeStyle = tick >= 21 ? '#cb7452' : '#d3d3bc';
    ctx.beginPath();
    ctx.moveTo(64 + inner * Math.cos(angle), 64 + inner * Math.sin(angle));
    ctx.lineTo(64 + 56 * Math.cos(angle), 64 + 56 * Math.sin(angle));
    ctx.stroke();
  }
  const face = new THREE.MeshBasicMaterial({ map: colorTexture(new THREE.CanvasTexture(dial)), transparent: true, depthWrite: false });
  const dialGeo = new THREE.CircleGeometry(.075, 24);
  const needles = [];
  for (const x of [.43, .25]) {
    const gauge = new THREE.Group();
    gauge.position.set(x, .84, .477);
    gauge.rotation.set(.67, Math.PI, 0, 'YXZ');
    gauge.add(new THREE.Mesh(dialGeo, face));
    const pivot = new THREE.Group();
    const needle = new THREE.Mesh(new THREE.BoxGeometry(.046, .0045, .002), new THREE.MeshBasicMaterial({ color: 0xe4a549 }));
    needle.position.set(.024, 0, .004);
    pivot.add(needle);
    gauge.add(pivot);
    interior.add(gauge);
    needles.push(pivot);
  }
  function instruments(car) {
    wheel.rotation.set(-.25, 0, car.steer * 9.2);
    needles[0].rotation.z = -Math.PI * (.77 + 1.46 * Math.min(1, speedKph(car) / 220));
    needles[1].rotation.z = -Math.PI * (.77 + 1.46 * Math.min(1, car.rpm / 7500));
  }
  return { interior, instruments };
}

export function createRoadside(THREE, samples, groundHeight) {
  const group = new THREE.Group();
  group.name = 'Course furniture';
  if (samples.length < 2) return group;
  const boxes = shapeBatch(THREE, new THREE.BoxGeometry());
  const purple = 0x503577;
  const bone = 0xe7dfc7;
  const iron = 0x364740;
  function place(sample, side, build) {
    const sin = Math.sin(sample.heading), cos = Math.cos(sample.heading);
    const x = sample.x + cos * side, z = sample.z - sin * side;
    const roadHeight = groundHeight ? groundHeight(x, z) : sample.y;
    const box = (across, y, along, width, height, length, color) => {
      boxes.add(x + cos * across + sin * along, roadHeight + y, z - sin * across + cos * along,
        width, height, length, color, sample.heading);
    };
    build(box);
  }
  function gate(box, finish) {
    box(0, .08, 0, .50, .16, .49, 0x797972);
    box(0, 1.13, 0, .105, 2.25, .10, iron);
    box(0, 1.88, 0, .78, 1.12, .12, purple);
    if (finish) {
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) {
          box((col-1)*.22, 1.51 + row*.22, -.078, .22, .22, .04, (row+col)%2 ? iron : bone);
        }
      }
    } else {
      for (let row = 0; row < 3; row++) {
        box(0, 2.04 - .115 * row, -.078, .17 + .17 * row, .105, .04, bone);
      }
    }
  }
  function lamp(box) {
    box(0, .10, 0, .36, .20, .36, 0x85877b);
    box(0, .42, 0, .19, .48, .19, iron);
    box(0, 2.14, 0, .092, 3.42, .092, iron);
    box(0, 3.84, 0, .27, .13, .27, iron);
    box(0, 4.05, 0, .25, .33, .25, 0xeadcb8);
    box(0, 4.26, 0, .40, .10, .40, iron);
    box(0, 4.35, 0, .23, .09, .23, iron);
  }
  function cone(box) {
    box(0, .036, 0, .37, .072, .37, 0x353c3a);
    for (let tier = 0; tier < 5; tier++) {
      box(0, .113 + tier*.087, 0, .23-tier*.038, .087, .23-tier*.038, tier === 2 ? bone : 0xe9753c);
    }
  }
  const firstDistance = samples[0].distance;
  const last = samples[samples.length - 1];
  let nextLamp = firstDistance + 13, lampNumber = 0;
  for (const sample of samples) {
    if (sample.distance > last.distance - 8) break;
    if (sample.distance >= nextLamp) {
      place(sample, lampNumber++ % 2 === 0 ? -6.8 : 6.8, lamp);
      nextLamp += 48;
    }
  }
  for (const apex of [374, 554, 593]) {
    for (const offset of [-14, -4, 6]) {
      const sample = samples.find(point => point.distance >= apex + offset);
      if (!sample) continue;
      place(sample, -6.8, box => {
        box(0, .81, 0, .11, 1.62, .12, iron);
        box(0, 1.53, 0, 1.36, .62, .12, iron);
        for (const across of [-.28, .27]) {
          for (let step = -2; step <= 2; step++) {
            box(across + .11 * (2 - Math.abs(step)), 1.53 + step * .10, -.077, .22, .104, .04, 0xf2be55);
          }
        }
      });
    }
  }
  for (const side of [-1, 1]) {
    place(samples[0], side * 5.9, box => gate(box, false));
    place(last, side * 5.9, box => gate(box, true));
    for (const d of [2, 6, 10]) {
      const nearStart = samples.find(sample => sample.distance >= firstDistance + d);
      const nearFinish = samples.find(sample => sample.distance >= last.distance - d);
      if (nearStart) place(nearStart, side * 4.75, cone);
      if (nearFinish) place(nearFinish, side * 4.75, cone);
    }
  }
  group.add(boxes.mesh());
  return group;
}
