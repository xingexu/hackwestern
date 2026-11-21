export function roadsidePosition(x,z,heading,side,paved,allowed,clearance=.65){
  const clear=(px,pz)=>allowed(px,pz)&&[[0,0],[clearance,0],[-clearance,0],[0,clearance],[0,-clearance],[clearance*.71,clearance*.71],[-clearance*.71,clearance*.71],[clearance*.71,-clearance*.71],[-clearance*.71,-clearance*.71]].every(([dx,dz])=>!paved(px+dx,pz+dz));
  if(clear(x,z))return [x,z,heading];
  let best=null,score=Infinity;
  for(let distance=.75;distance<=26&&distance<score;distance+=.75){
    for(let i=0;i<24;i++){
      const angle=i*Math.PI/12,dx=Math.cos(angle),dz=Math.sin(angle);
      const cost=distance*(1.20-.20*side*(dx*Math.cos(heading)-dz*Math.sin(heading)));
      if(cost>=score)continue;
      const px=x+distance*dx,pz=z+distance*dz;
      if(clear(px,pz)){
        best=[px,pz,Math.atan2(-side*dz,side*dx)];
        score=cost;
      }
    }
  }
  return best;
}

export function createStreetDetail(THREE, data, network) {
  const group = new THREE.Group();
  group.name = 'Mapped campus streets and landmark details';
  const iron = 0x373d39, trim = 0xcbbfa2, metal = 0x868981, glass = 0x50636b, stone = 0xada28c;
  const sidewalk = 0xb6ab98, paint = 0xebe7d4, yellow = 0xefc951, oak = 0x7c6750;
  const cube = new THREE.BoxGeometry();
  const buckets = new Map();
  const frame = new THREE.Object3D(), piece = new THREE.Object3D(), matrix = new THREE.Matrix4();
  let owner;
  function pose(x, y, z, yaw) {
    frame.position.set(x, y, z);
    frame.rotation.set(0, yaw, 0);
    frame.updateMatrix();
  }
  function box(x, y, z, w, h, l, color, yaw = 0, roll = 0, pitch = 0, transparent = false) {
    piece.position.set(x, y, z);
    piece.rotation.set(pitch, yaw, roll, 'YXZ');
    piece.scale.set(w, h, l);
    piece.updateMatrix();
    const key = transparent ? 'glass' : 'solid';
    if (!buckets.has(key)) buckets.set(key, []);
    matrix.multiplyMatrices(frame.matrix,piece.matrix);
    network.addBox?.(matrix.elements,owner);
    buckets.get(key).push([matrix.clone(),color]);
  }

  function bench(x, y, z, length) {
    for (const end of [-1, 1]) {
      box(x, y + .23, z + end * length * .36, .48, .45, .065, iron);
      box(x + .22, y + .63, z + end * length * .36, .045, .49, .06, iron);
    }
    for (let i = 0; i < 4; i++) box(x - .19 + i * .125, y + .47, z, .095, .065, length, oak);
    for (let i = 0; i < 3; i++) box(x + .23, y + .59 + i * .12, z, .048, .09, length, oak);
  }
  function stopPole(x, z) {
    box(x, 1.42, z, .075, 2.84, .075, metal);
    box(x, 2.53, z, .32, .52, .06, 0x295584);
    box(x, 2.55, z - .038, .25, .13, .025, paint);
    box(x, 2.43, z - .038, .12, .048, .025, paint);
    box(x, 1.76, z, .22, .33, .09, sidewalk);
  }
  function shelter() {
    box(0, .085, 0, 1.97, .17, 4.2, sidewalk);
    for (const z of [-1.88, 0, 1.88]) {
      for (const x of [-.83, .83]) box(x, 1.18, z, .055, 2.2, .07, metal);
      for (let k = -4; k <= 4; k++) {
        const x = k * .185;
        const y = 2.27 + Math.sqrt(Math.max(0, .85 ** 2 - x ** 2)) * .48;
        const a = Math.atan2(-.48 * x, Math.sqrt(Math.max(.01, .85 ** 2 - x ** 2)));
        box(x, y, z, .22, .08, .10, metal, 0, a);
        if (z === 0) box(x, y - .045, 0, .22, .05, 3.78, 0x94babe, 0, a, 0, true);
      }
    }
    for (const end of [-1, 1]) {
      box(.82, 1.26, end * .93, .032, 1.86, 1.78, 0x8eafb3, 0, 0, 0, true);
      box(0, 1.13, end * 1.86, 1.58, 1.68, .04, 0x9eb8b5, 0, 0, 0, true);
      box(.83, 1.12, end * .95, .06, .06, 1.83, metal);
    }
    bench(.32, .17, 0, 2.6);
    stopPole(-.45, -2.34);
  }
  function signal(post, direction) {
    const x=0,z=0;
    box(x, .2, z, .55, .4, .55, sidewalk);
    box(x, 3.25, z, .18, 6.3, .18, iron);
    box(x - post * 2.12, 5.79, z, 4.38, .13, .13, iron, 0, -post * .13);
    box(x - post * 4.19, 5.78, z, .43, 1.2, .32, 0xcd942e);
    for (let n = 0; n < 3; n++) box(x - post * 4.19, 6.12 - n * .34, z + direction * .19,
      .22, .24, .085, n === 2 ? 0x42b88b : 0x514335);
    box(x, 2.43, z - .13, .39, .44, .23, iron);
    box(x, 1.05, z - .15, .16, .21, .09, yellow);
  }
  function speedSign() {
    box(0, 1.29, 0, .075, 2.58, .075, metal);
    box(0, 2.35, 0, .61, .84, .06, 0xe7e4d8);
    const glyphs = [['101','101','111','001','001'], ['111','101','101','101','111']];
    for (let d = 0; d < 2; d++) for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
      if (glyphs[d][row][col] === '1') box(.209 - d * .225 - col * .074, 2.50 - row * .08, -.039, .075, .081, .027, iron);
    }
  }
  function rack(n) {
    for (let i = 0; i < n; i++) {
      const z = .64 * (i - (n - 1) / 2);
      for (const side of [-1, 1]) {
        box(side * .39, .34, z, .048, .68, .05, metal);
        box(side * .33, .71, z, .19, .05, .05, metal, 0, -side * .69);
      }
      box(0, .77, z, .58, .05, .05, metal);
    }
  }

  for (const f of data.features) {
    owner=f.kind;
    pose(f.x,network.groundAt?.(f.x,f.z)??f.y,f.z,f.yaw);
    switch (f.kind) {
      case 'shelter': shelter(); break;
      case 'transit': stopPole(0, 0); break;
      case 'speed': speedSign(); break;
      case 'bench': bench(0, 0, 0, 1.72); break;
      case 'rack': rack(f.label); break;
      case 'pedestrian':
        box(0, 1.36, 0, .075, 2.72, .075, iron);
        box(0, 2.46, 0, .5, .5, .06, 0xc5d24f, 0, Math.PI / 4);
        box(.035, 2.51, -.045, .10, .17, .032, iron, 0, -.23);
        box(-.04, 2.36, -.045, .085, .16, .032, iron, 0, -.58);
        break;
      case 'signals':
        for(const side of [-1,1]){
          const u=side*6.9,t=-side*8;
          const x=f.x+Math.cos(f.yaw)*u+Math.sin(f.yaw)*t,z=f.z-Math.sin(f.yaw)*u+Math.cos(f.yaw)*t;
          const site=network.roadsidePosition?network.roadsidePosition(x,z,f.yaw,side):[x,z,f.yaw];
          if(!site)continue;
          pose(site[0],network.groundAt?.(site[0],site[1])??f.y,site[1],site[2]);
          signal(side,side);
        }
        break;
    }
  }

  function signboard(x, z, width) {
    for (const side of [-1, 1]) box(x + side * width * .40, .82, z, .065, 1.64, .065, iron);
    box(x, 1.30, z, width, .76, .08, 0x312744);
    box(x, 1.45, z + .05, width * .62, .05, .02, paint);
    box(x, 1.29, z + .05, width * .47, .025, .02, paint);
  }
  function clockFace() {
    const threshold=1.02, doorWidth=3.1;
    box(-5.82,threshold+1.53,0,.30,3.06,doorWidth+.22,0x514a41);
    for(const side of [-1,1]){
      const centre=side*doorWidth/4;
      box(-6.01,threshold+1.32,centre,.12,2.59,doorWidth/2-.06,0x735a45);
      box(-6.085,threshold+1.81,centre,.07,1.07,1.17,0x424f51);
      box(-6.13,threshold+.98,side*.17,.08,.37,.06,0xc1b497);
      box(-5.98,threshold+1.66,side*1.80,.49,3.32,.26,0xbfb09a);
      box(-6.12,threshold+1.64,side*1.63,.29,3.27,.09,0xd0c5b1);
      for(const level of [.36,2.95]) box(-6.02,threshold+level,side*1.79,.52,.11,.33,trim);
    }
    box(-5.76,threshold+4.72,0,.39,2.48,3.68,0xb2a58e);
    for(const z of [-1.08,0,1.08]){
      box(-5.98,threshold+4.63,z,.09,1.42,.86,0x424f50);
      box(-6.04,threshold+4.63,z,.06,1.42,.058,0xa89f8c);
      box(-6.04,threshold+4.61,z,.06,.075,.86,0xa89f8c);
    }
    for(const z of [-1.10,-.366,.366,1.10]) box(-6.02,threshold+2.92,z,.12,.40,.68,0x526065);
    box(-6.03,threshold+3.22,0,.49,.21,3.99,trim);
    box(-6.00,threshold+3.45,0,.58,.13,4.17,0xb8ac98);
    for(let i=0;i<3;i++) box(-6.17-i*.30,threshold-.10-i*.15,0,.68,.22,3.98+i*.13,0xbeb8a9);
    for (let face = 0; face < 4; face++) {
      const a = face * Math.PI / 2, co = Math.cos(a), si = Math.sin(a);
      function dial(x, y, z, w, h, l, tint, roll = 0) {
        box(x * co + z * si, y, z * co - x * si, w, h, l, tint, a, roll);
      }
      const faceZ = 5.86;
      for (let row = -11; row <= 11; row++) {
        const y = row * .2, w = Math.sqrt(Math.max(0, 2.35 ** 2 - y ** 2));
        dial(0, 35.5 + y, faceZ, 2 * w, .205, .105, 0xede4cc);
      }
      for (let k = 0; k < 12; k++) {
        const t = k * Math.PI / 6;
        dial(1.9 * Math.sin(t), 35.5 + 1.9 * Math.cos(t), faceZ + .084, .10, .36, .07, iron, -t);
      }
      dial(.18, 36.23, faceZ + .12, .135, 1.58, .085, iron, -.25);
      dial(-.62, 35.67, faceZ + .15, 1.28, .15, .075, iron, -.24);
    }
  }
  function collegeMullions() {
    const spring=4.20;
    for(let mould=0;mould<4;mould++){
      const half=1.92+.21*mould,depth=5.31+.115*mould;
      const rise=1.22+.11*mould;
      const stone=mould%2?0xc2b39b:0xab9d85;
      for(const side of [-1,1]){
        box(depth,(spring+1.07)/2,side*half,.30,spring-1.07,.14,stone);
        for(let n=0;n<8;n++){
          const t0=n/8,t1=(n+1)/8;
          const v0=half*(1-t0*t0)*side,v1=half*(1-t1*t1)*side;
          const y0=spring+rise*(1.42*t0-.42*t0*t0),y1=spring+rise*(1.42*t1-.42*t1*t1);
          box(depth,(y0+y1)/2,(v0+v1)/2,.31,.16,Math.hypot(v1-v0,y1-y0)+.04,
            stone,0,0,-Math.atan2(y1-y0,v1-v0));
        }
      }
    }
    for (let bay = 0; bay < 5; bay++) {
      const centre = 7.36 + bay * 5.72;
      for (const offset of [-1.28, -.64, 0, .64, 1.28]) {
        box(1.55, 10.43, centre + offset, .21, 5.9 - Math.abs(offset) * .72, .13, trim);
      }
      for (const y of [8.65, 11.45]) box(1.55, y, centre, .18, .13, 3.44, trim);
    }
    for (const side of [-1, 1]) {
      box(4.54, 3.2, side * .99, .16, 2.42, 1.71, 0x694c3d);
      box(4.65, 3.1, side * .26, .09, .24, .11, 0xac966e);
      for (const z of [.56, 1.34]) box(4.64, 3.55, side * z, .06, 1.07, .49, 0x493930);
    }
  }
  function scienceEntrance() {
    for (let i = -6; i <= 6; i++) {
      const angle = i * .21, si = Math.sin(angle), co = Math.cos(angle);
      box(8.5 * si, 3.66, 9.3 * co, .14, 5.47, .24, trim, angle);
      for (const y of [2.57, 4.85, 5.59]) box(8.5 * si, y, 9.3 * co, 1.94, .09, .16, trim, angle);
      if (i % 3 === 0) box(8.63 * si, 3.7, 9.46 * co, .41, 6.36, .43, trim, angle);
    }
    for (const side of [-1, 1]) {
      box(side * .9, 2.25, 9.49, 1.49, 2.4, .10, glass);
      box(side * 1.67, 2.28, 9.56, .11, 2.52, .095, trim);
      box(side * .27, 2.19, 9.59, .06, .36, .06, trim);
    }
    box(0, 3.52, 9.55, 3.52, .13, .12, trim);
  }
  function physicsEntrance() {
    for (const storey of [9.1, 13.15]) for (const u of [-2.26, -1.13, 0, 1.13, 2.26]) {
      box(u, storey + .97, 3.56 - Math.max(0, Math.abs(u) - 1.5) * .44, .12, 2.19 - .18 * Math.abs(u), .18, trim);
    }
    for (const y of [9.57, 13.45]) box(0, y, 3.54, 4.54, .12, .14, trim);
    signboard(-9.4, 10.25, 1.32);
  }
  const details = { UC: collegeMullions, MC: clockFace, NSC: scienceEntrance, PAB: physicsEntrance };
  for (const [code, x, y, z, yaw] of data.landmarks) {
    if (!details[code]) continue;
    owner=code;
    pose(x, y, z, yaw);
    details[code]();
  }
  for (const [kind, parts] of buckets) {
    const seeThrough = kind === 'glass';
    const material = new THREE.MeshStandardMaterial({ transparent: seeThrough, opacity: seeThrough ? .28 : 1, depthWrite: !seeThrough });
    const mesh = new THREE.InstancedMesh(cube, material, parts.length);
    const tint = new THREE.Color();
    for (let i = 0; i < parts.length; i++) {
      mesh.setMatrixAt(i, parts[i][0]);
      mesh.setColorAt(i, tint.setHex(parts[i][1]));
    }
    mesh.receiveShadow = true;
    mesh.castShadow = !seeThrough;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
