import {foliageCluster,leafSprayTexture,lightLeafBacks,leafPatchGLSL} from 'leaf-sprays';

export function createMunicipalDetail(THREE,data,region,network) {
  const group=new THREE.Group();
  group.name='London municipal survey';
  const {size,tiles}=data;
  const material=new THREE.MeshStandardMaterial({vertexColors:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  const clusters=[foliageCluster(.53),foliageCluster(.40)];
  const foliage=new THREE.MeshStandardMaterial({map:leafSprayTexture(),alphaTest:.36,side:THREE.DoubleSide});
  foliage.onBeforeCompile=lightLeafBacks;
  const transform=new THREE.Object3D();
  const sourceLeaf=new THREE.IcosahedronGeometry(1,0).attributes.position;
  material.customProgramCacheKey=()=>'municipal-survey-grain';
  material.onBeforeCompile=shader=>{
    shader.uniforms.leafPatch={value:foliage.map};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 localPoint;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\n #ifdef USE_INSTANCING\nlocalPoint=(instanceMatrix*vec4(position,1.)).xyz;\n#else\nlocalPoint=position;\n#endif');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 localPoint;uniform sampler2D leafPatch;\n'+leafPatchGLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 coords=localPoint*vec3(19.8,28.2,22.6);
        float grain=sin(dot(coords,vec3(.831,.41,-.22))+1.8*sin(dot(coords,vec3(-.65,.49,.73))))*.5+.5;
        float isLeaf=smoothstep(.008,.045,diffuseColor.g-max(diffuseColor.r,diffuseColor.b));
        float nearCrown=1.-smoothstep(.035,.24,length(fwidth(localPoint)));
        diffuseColor.rgb*=1.+(grain-.5)*.035*nearCrown;
        if(isLeaf>.1)diffuseColor.rgb*=.68+.44*smallLeaves(leafPatch,localPoint);
        #ifdef USE_INSTANCING
          vec3 spray=floor(localPoint*2.65+sin(floor(localPoint*6.1))*.19);
          float cluster=fract(sin(dot(mod(spray,167.),vec3(24.73,7.91,15.93)))*28657.3);
          float rim=1.-smoothstep(.10,.46,abs(dot(normalize(vNormal),normalize(vViewPosition))));
          if(cluster+grain*.28<rim*nearCrown*.55) discard;
          diffuseColor.rgb*=1.+(cluster-.49)*nearCrown*.26;
        #endif`);
  };
  const colors=new Map();
  function color(hex){
    if(!colors.has(hex)) colors.set(hex,new THREE.Color(hex));
    return colors.get(hex);
  }
  function batch(){
    return {positions:[],indices:[],colors:[],mulch:[],foliage:[[],[]]};
  }
  function vertex(mesh,x,y,z,tint){
    mesh.positions.push(x,y,z);
    mesh.colors.push(tint.r,tint.g,tint.b);
    return mesh.positions.length/3-1;
  }
  function shaft(mesh,a,b,rA,rB,hex,sides=7) {
    if(!mesh){
      network.addBranch(a.toArray(),b.toArray(),rA,rB,'municipal wood or mast');
      return;
    }
    const axis=new THREE.Vector3().subVectors(b,a).normalize();
    const radial=new THREE.Vector3(1,0,0);
    if(Math.abs(axis.x)>.88) radial.set(0,0,1);
    radial.cross(axis).normalize();
    const other=new THREE.Vector3().crossVectors(axis,radial);
    const tint=color(hex), start=mesh.positions.length/3;
    for(let i=0;i<sides;i++){
      const angle=i*2*Math.PI/sides, c=Math.cos(angle), s=Math.sin(angle);
      const dx=radial.x*c+other.x*s, dy=radial.y*c+other.y*s, dz=radial.z*c+other.z*s;
      vertex(mesh,a.x+dx*rA,a.y+dy*rA,a.z+dz*rA,tint);
      vertex(mesh,b.x+dx*rB,b.y+dy*rB,b.z+dz*rB,tint);
    }
    for(let i=0;i<sides;i++){
      const j=(i+1)%sides,k=start+2*i,l=start+2*j;
      mesh.indices.push(k,l,k+1,l,l+1,k+1);
      if(i>0 && i<sides-1) mesh.indices.push(start+1,k+1,l+1);
    }
  }
  function crown(mesh,x,y,z,rx,ry,rz,yaw,hex,foliage=false) {
    if(!mesh)return;
    if(foliage){
      mesh.foliage[foliage===true?1:0].push([x,y,z,rx,ry,rz,yaw,hex]);
      return;
    }
    const c=Math.cos(yaw),s=Math.sin(yaw),tint=color(hex);
    for(let i=0;i<sourceLeaf.count;i++){
      const xx=sourceLeaf.getX(i)*rx,zz=sourceLeaf.getZ(i)*rz;
      mesh.indices.push(vertex(mesh,x+xx*c+zz*s,y+sourceLeaf.getY(i)*ry,z-xx*s+zz*c,tint));
    }
  }
  function lamp(mesh,[x,z,h,yaw,form,wood]){
    const y=network.groundAt(x,z), mast=wood?0x9a8673:0x768287;
    const point=(u,v)=>new THREE.Vector3(x+Math.sin(yaw)*u,y+v,z+Math.cos(yaw)*u);
    shaft(mesh,point(0,-.12),point(0,h),wood ? .13 : .103,.071,mast);
    if(!wood) shaft(mesh,point(0,.03),point(0,.42),.21,.14,0x69787e);
    if(form===2) {
      shaft(mesh,point(0,h-.07),point(0,h+.33),.13,.29,0xf3f0dc);
      shaft(mesh,point(0,h+.33),point(0,h+.48),.34,.045,0x475862);
      return;
    }
    for(const side of form===1?[-1,1]:[1]){
      const p=(u,v)=>point(side*u,v);
      shaft(mesh,p(0,h-.84),p(.96,h-.06),.065,.053,mast,6);
      shaft(mesh,p(.96,h-.06),p(2.18,h+.13),.053,.048,mast,6);
      const tip=p(2.38,h+.09);
      crown(mesh,tip.x,tip.y,tip.z,.25,.135,.48,yaw,0x67767d);
      crown(mesh,tip.x,tip.y-.09,tip.z,.20,.064,.34,yaw,0xf7f1d9);
    }
  }
  const green=[0x648853,0x64834f,0x738a4e,0x6d8b57,0x597b50,0x668c5c,0x82975a];
  const conifer=[0x466a51,0x4a7057,0x597b58,0x496e5b];
  function tree(mesh,[x,z,h,r,dbh,form,seed]){
    const y=network.groundAt(x,z),origin=new THREE.Vector3(x,y-.08,z);
    const splay=form===5?1.09:form===8?.84:1;
    const forkRatio=form===2?.63:form===6?.32:form===7?.55:.43;
    const fork=new THREE.Vector3(x,y+h*forkRatio,z);
    shaft(mesh,origin,fork,Math.max(.07,dbh),Math.max(.05,dbh*.65),0x756a57);
    if(form===10){
      const leader=new THREE.Vector3(x+.06*r,y+h*.93,z-.05*r);
      shaft(mesh,fork,leader,dbh*.65,.019,0x786c60,6);
      for(let i=0;i<8;i++){
        const t=i/9,a=seed*1.23+i*2.40+.27*Math.sin(seed+i);
        const reach=r*(1-.58*t)*(.82+.16*Math.cos(a));
        const start=fork.clone().lerp(leader,t*.86);
        const bend=new THREE.Vector3(x+Math.sin(a)*reach*.54,start.y+h*.12,z+Math.cos(a)*reach*.54);
        const tip=new THREE.Vector3(x+Math.sin(a+.19)*reach,bend.y+h*(.09+.055*Math.sin(a)),z+Math.cos(a+.19)*reach);
        shaft(mesh,start,bend,dbh*(.38-.21*t),dbh*.14,0x736858,5);
        shaft(mesh,bend,tip,dbh*.14,.015,0x80766c,5);
        for(const side of [-1,1]){
          const twig=bend.clone().lerp(tip,.42);
          twig.x+=Math.sin(a+side*.78)*reach*.49;
          twig.z+=Math.cos(a+side*.78)*reach*.49;
          twig.y+=h*.12;
          shaft(mesh,bend,twig,dbh*.09,.009,0x8b8072,4);
        }
      }
      return;
    }
    if(form===1 || form===3){
      const tall=form===3;
      const layers=tall?7:6;
      const width=r*(tall ? .72 : 1);
      for(let level=0;level<layers;level++){
        const band=(level+.45)/layers,angle=seed+.85*level;
        const reach=width*(1-.78*band);
        const Y=y+h*(.23+.66*band);
        for(let lobe=0;lobe<3;lobe++){
          const a=angle+lobe*2.094;
          const X=x+Math.sin(a)*reach*.45, Z=z+Math.cos(a)*reach*.45;
          crown(mesh,X,Y,Z,reach*.74,h*.112,reach*.60,a,conifer[(seed+level+lobe)%conifer.length],2);
        }
      }
      crown(mesh,x,y+h*.90,z,width*.22,h*.11,width*.23,seed,conifer[2],2);
      return;
    }
    const pine=form===2, willow=form===4;
    const arms=form===7?9:form===6?6:7;
    for(let i=0;i<arms;i++){
      const crest=i===arms-1;
      const a=seed*1.67+i*2.4, d=crest ? .12*r : r*splay*(.46+.13*Math.sin(seed+i));
      const X=x+Math.sin(a)*d,Z=z+Math.cos(a)*d;
      const Y=y+h*(crest ? .83 : (pine || form===6 ? .76 : form===8 ? .61 : .66)+.055*Math.sin(1.13*i+seed));
      if(!crest){
        const elbow=new THREE.Vector3(x+(X-x)*.47,y+h*(forkRatio+.14+.045*Math.sin(a)),z+(Z-z)*.47);
        shaft(mesh,fork,elbow,Math.max(.055,dbh*.46),Math.max(.04,dbh*.28),0x6d6052,5);
        shaft(mesh,elbow,new THREE.Vector3(X,Y,Z),Math.max(.04,dbh*.28),.026,0x756a57,5);
      }
      const width=r*splay*(form===7?.42:crest?.62:.64+.07*Math.sin(a));
      const height=h*(pine ? .145 : willow || form===8 ? .27 : form===7 ? .15 : crest ? .19 : .218);
      const tint=pine?conifer[(seed+i)%conifer.length]:green[(seed+i)%green.length];
      crown(mesh,X,Y,Z,width,height,width*.93,a,tint,true);
      if(i%2===0 && !pine){
        crown(mesh,X+Math.sin(a)*width*.56,Y-height*.27,Z+Math.cos(a)*width*.56,
          width*.54,height*.60,width*.49,a+.4,tint,2);
      }
    }
  }
  function shrub(mesh,[x,z,h]){
    if((region.campusBoundary&&!region.campusBoundary.containsDisc(x,z,.75+.41*h))||!network.plantable(x,z))return;
    const y=network.groundAt(x,z);
    const width=.36+.27*h;
    for(let i=0;i<4;i++){
      const angle=x*.71+z*.17+i*2.4;
      const radius=i===3?0:width*.57;
      crown(mesh,x+Math.cos(angle)*radius,y+h*(i===3?.69:.43),z+Math.sin(angle)*radius,
        width*.79,h*.35,width*.75,angle,green[Math.abs(Math.round(angle*7))%green.length],true);
    }
  }
  function hedgePlants([line,height],bedWidth){
    const plants=[];
    let offset=.42;
    for(let i=2;i<line.length;i+=2){
      const ax=line[i-2],az=line[i-1],dx=line[i]-ax,dz=line[i+1]-az,length=Math.hypot(dx,dz);
      if(length<.001)continue;
      while(offset<=length){
        const x=ax+dx*offset/length,z=az+dz*offset/length;
        const phase=Math.sin(x*1.7+z*.41),radius=bedWidth?bedWidth*(.37+.06*phase):.57+.14*phase;
        const h=(bedWidth?height:.28+.39*Math.min(height,2.4))*(1+.18*phase);
        if((!region.campusBoundary||region.campusBoundary.containsDisc(x,z,radius*1.6))&&network.plantable(x,z,radius)&&network.crownClear(x,network.groundAt(x,z)+h*.5,z,radius,h*.58)){
          plants.push([x,z,h,radius,Math.atan2(dx,dz),bedWidth]);
        }
        offset+=.88+.12*phase;
      }
      offset-=length;
    }
    return plants;
  }
  function hedge(mesh,[x,z,h,r,yaw,bedWidth]){
    const y=network.groundAt(x,z),turn=x*.53+z*.86;
    const root=new THREE.Vector3(x,y-.04,z);
    const fork=new THREE.Vector3(x,y+h*.42,z);
    shaft(mesh,root,fork,.10+.065*r,.072,0x685643,6);
    for(let i=0;i<3;i++){
      const a=turn+i*2.4,spread=i===2?.12:.47;
      const end=new THREE.Vector3(x+Math.cos(a)*r*spread,y+h*(i===2?.68:.49),z+Math.sin(a)*r*spread);
      shaft(mesh,fork,end,.053,.024,0x655742,5);
      crown(mesh,end.x,end.y,end.z,r*(i===2?.65:.83),h*(i===2?.43:.49),r*.70,a,bedWidth?(h<.43?0xae9677:0x715746):conifer[Math.abs(Math.floor(turn+i))%4],true);
    }
    if(!mesh)return;
    const point=(a)=>{
      const dx=Math.cos(a)*(bedWidth?bedWidth*.55:r*1.33),dz=Math.sin(a)*.79;
      const px=x+dx*Math.cos(yaw)+dz*Math.sin(yaw),pz=z-dx*Math.sin(yaw)+dz*Math.cos(yaw);
      return [px,network.groundAt(px,pz)+.014,pz];
    };
    for(let i=0;i<8;i++)mesh.mulch.push(x,y+.014,z,...point((i+1)*Math.PI/4),...point(i*Math.PI/4));
  }
  const plantsByTile=new Map();
  for(const tile of Object.values(tiles)){
    const plants=(tile.hedge??[]).flatMap(row=>hedgePlants(row));
    for(const [line,w,h] of tile.beds??[])plants.push(...hedgePlants([line,h],w));
    plantsByTile.set(tile,plants);
    for(const row of tile.lamps??[])lamp(null,row);
    for(const row of tile.trees??[])tree(null,row);
    for(const row of plants)hedge(null,row);
  }
  const mulch=new THREE.MeshStandardMaterial({color:0x66513c,roughness:1,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  function makeMesh(tile) {
    const buf=batch();
    for(const record of tile.lamps??[]) lamp(buf,record);
    for(const record of tile.trees??[]) tree(buf,record);
    for(const row of tile.shrubs??[])shrub(buf,row);
    for(const row of plantsByTile.get(tile)) hedge(buf,row);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(buf.positions,3));
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(buf.colors,3));
    geometry.setIndex(buf.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const structures=new THREE.Mesh(geometry,material);
    structures.castShadow=structures.receiveShadow=true;
    const group=new THREE.Group();
    group.add(structures);
    if(buf.mulch.length){
      const bed=new THREE.BufferGeometry();
      bed.setAttribute('position',new THREE.Float32BufferAttribute(buf.mulch,3));
      bed.computeVertexNormals();
      const soil=new THREE.Mesh(bed,mulch);
      soil.name='Hedge mulch';
      soil.userData.auditKind='field';
      soil.receiveShadow=true;
      group.add(soil);
    }
    for(const [detail,instances] of buf.foliage.entries()){
      if(!instances.length) continue;
      const clumps=new THREE.InstancedMesh(clusters[detail],foliage,instances.length);
      instances.forEach(([x,y,z,rx,ry,rz,yaw,tint],i)=>{
        transform.position.set(x,y,z);
        transform.rotation.set(0,yaw,0);
        transform.scale.set(rx,ry,rz);
        transform.updateMatrix();
        clumps.setMatrixAt(i,transform.matrix);
        clumps.setColorAt(i,color(tint));
      });
      clumps.computeBoundingSphere();
      clumps.castShadow=clumps.receiveShadow=true;
      group.add(clumps);
    }
    return group;
  }
  const active=new Map();
  let last='';
  function update(x,z,distance){
    const tx=Math.floor(x/size),tz=Math.floor(z/size);
    const radius=distance>600?-1:distance>320?1:2;
    const key=tx+':'+tz+':'+radius;
    if(key===last) return false;
    last=key;
    const visible=new Set();
    for(let i=-radius;i<=radius;i++) for(let j=-radius;j<=radius;j++){
      const name=(tx+i)+':'+(tz+j);
      if(tiles[name]) visible.add(name);
    }
    for(const [name,mesh] of active) if(!visible.has(name)){
      group.remove(mesh);
      for(const part of mesh.children){
        if(part.isInstancedMesh) part.dispose();
        else part.geometry.dispose();
      }
      active.delete(name);
    }
    for(const name of visible) if(!active.has(name)){
      const mesh=makeMesh(tiles[name]);
      mesh.name='Municipal '+name;
      group.add(mesh);active.set(name,mesh);
    }
    return true;
  }
  return {group,update};
}


export function addSurveyedGround(observed,municipal,features){
  function tile(data,size,x,z){
    const key=Math.floor(x/size)+':'+Math.floor(z/size);
    return data.tiles[key]??={};
  }
  for(const [id,points] of municipal.surveyFences??[]){
    for(let i=2;i<points.length;i+=2){
      const x=points[i-2],z=points[i-1],X=points[i],Z=points[i+1];
      const mx=(x+X)/2,mz=(z+Z)/2;
      (tile(features,features.tileSize,mx,mz).l??=[]).push(['survey_fence',id,x,0,z,X,0,Z]);
    }
  }
  const fixture=municipal.furniture;
  if(fixture){
    features.gardens=fixture.gardens;
    for(const garden of fixture.gardens??[]){
      const [cx,cz]=garden.center;
      for(const entry of Object.values(municipal.tiles))if(entry.hedge)entry.hedge=entry.hedge.filter(([line])=>Math.hypot(line[0]-cx,line[1]-cz)>garden.radius);
      for(const bed of garden.beds){
        const [line]=bed;
        (tile(municipal,municipal.size,line[0],line[1]).beds??=[]).push(bed);
      }
    }
    for(const [kind,id,x,z] of fixture.relocations??[]){
      for(const entry of Object.values(features.tiles)){
        const prop=entry.p?.find(p=>p[0]===kind&&p[1]===id);
        if(prop){prop[2]=x;prop[4]=z;break;}
      }
    }
    const lampCorrections=new Map((fixture.lampCorrections??[]).map(([x,z,X,Z])=>[[x,z].join(','),[X,Z]]));
    observed.lamps=observed.lamps.map(p=>lampCorrections.get(p.join(','))??p);
    const mappedLamps=Object.values(municipal.tiles).flatMap(t=>t.lamps??[]);
    mappedLamps.push(...observed.lamps,...Object.values(features.tiles).flatMap(t=>(t.p??[]).filter(p=>p[0]==='street_lamp').map(p=>[p[2],p[4]])));
    for(const [x,z,height=5.6,yaw=0,form=2] of fixture.lamps){
      if(mappedLamps.some(p=>Math.hypot(p[0]-x,p[1]-z)<2.4))continue;
      (tile(municipal,municipal.size,x,z).lamps??=[]).push([x,z,height,yaw,form,false]);
      mappedLamps.push([x,z]);
    }
    const existing=Object.values(features.tiles).flatMap(t=>t.p??[]);
    for(const [i,[kind,x,z,yaw,count=4]] of fixture.props.entries()){
      if(existing.some(p=>p[0]===kind&&Math.hypot(p[2]-x,p[4]-z)<1.6))continue;
      if(kind==='bench'&&observed.seats.some(p=>Math.hypot(p[0]-x,p[1]-z)<1.6))continue;
      (tile(features,features.tileSize,x,z).p??=[]).push([kind,-10000-i,x,0,z,yaw,2,1,count]);
    }
  }
  if(observed.sports){
    features.sports=observed.sports;
    for(const [i,[x,z,yaw]] of observed.sports.bleachers.entries())(tile(features,features.tileSize,x,z).p??=[]).push(['bleachers',-30-i,x,0,z,yaw,7.7,1,1]);
    let i=0;
    for(const row of features.macro)if(row[0]==='track'&&!observed.sports.laneBasis){
      [row[2],row[4],row[5],row[7]]=observed.sports.lanes[i++];
    }
  }
  const bare=new Set((municipal.woodlots?.bare??[]).map(p=>p.join(',')));
  for(const entry of Object.values(municipal.tiles)){
    for(const tree of entry.trees??[])if(bare.has(tree[0]+','+tree[1]))tree[5]=10;
  }
  for(const [x,z,h,r,form] of [...observed.trees,...(municipal.woodlots?.trees??[]),...(municipal.woodlots?.estates??[]),...(municipal.woodlots?.park??[])]){
    const seed=Math.abs(Math.round(x*7+z*13))%1009;
    (tile(municipal,municipal.size,x,z).trees??=[]).push([x,z,h,r,Math.max(.055,h*.014),bare.has(x+','+z)?10:form,seed]);
  }
  for(const [x,z,h] of observed.shrubs)(tile(municipal,municipal.size,x,z).shrubs??=[]).push([x,z,h]);
  for(const [x,z] of observed.lamps)(tile(municipal,municipal.size,x,z).lamps??=[]).push([x,z,5.6,0,2,false]);
  for(const [line,h] of observed.hedges)(tile(municipal,municipal.size,line[0],line[1]).hedge??=[]).push([line,h]);
  for(const [i,[x,z,yaw]] of observed.seats.entries())(tile(features,features.tileSize,x,z).p??=[]).push(['bench',-1-i,x,0,z,yaw,1.7,1,1]);
  for(const [i,[x,z,X,Z]] of observed.fences.entries())(tile(features,features.tileSize,(x+X)/2,(z+Z)/2).l??=[]).push(['fence',-1-i,x,0,z,X,0,Z]);
}


export function createContextTrees(THREE,records){
  const group=new THREE.Group(),cells=new Map(),size=125;
  const foliage=new THREE.MeshStandardMaterial({map:leafSprayTexture(),alphaTest:.39,side:THREE.DoubleSide,roughness:.94});
  foliage.onBeforeCompile=lightLeafBacks;
  const crown=foliageCluster(.44),bark=new THREE.CylinderGeometry(.62,1,1,6);
  const wood=new THREE.MeshStandardMaterial({color:0x736451,roughness:.93});
  for(let i=0;i<records.length;i+=4){
    const x=records[i],z=records[i+1],key=Math.floor(x/size)+','+Math.floor(z/size);
    if(!cells.has(key))cells.set(key,[]);
    cells.get(key).push(records.subarray(i,i+4));
  }
  const pose=new THREE.Object3D(),color=new THREE.Color(),up=new THREE.Vector3(0,1,0),axis=new THREE.Vector3();
  const tiles=[];
  for(const [key,trees] of cells){
    const branches=new THREE.InstancedMesh(bark,wood,trees.length*6);
    const leaves=new THREE.InstancedMesh(crown,foliage,trees.length*8);
    function branch(i,a,b,r){
      axis.subVectors(b,a);
      pose.position.copy(a).lerp(b,.5);
      pose.scale.set(r,axis.length(),r);
      pose.quaternion.setFromUnitVectors(up,axis.normalize());
      pose.updateMatrix();
      branches.setMatrixAt(i,pose.matrix);
    }
    for(const [i,[x,z,h,y]] of trees.entries()){
      const r=h*(.28+.035*Math.sin(x)),fork=new THREE.Vector3(x,y+h*.37,z);
      branch(i*6,new THREE.Vector3(x,y-.08,z),fork,h*.021);
      for(let j=0;j<8;j++){
        const yaw=x*.71+j*2.4,spread=r*(j<5?.49:.17);
        const X=x+Math.cos(yaw)*spread,Z=z+Math.sin(yaw)*spread,Y=y+h*(j<5?.65+.045*Math.sin(yaw):.82);
        if(j<5)branch(i*6+j+1,fork,new THREE.Vector3(X,Y,Z),h*.014);
        pose.position.set(X,Y,Z);pose.rotation.set(.13*Math.sin(yaw),yaw,.13*Math.cos(yaw));
        pose.scale.set(r*.73,h*(j<5?.245:.185),r*.66);
        pose.updateMatrix();
        leaves.setMatrixAt(i*8+j,pose.matrix);
        leaves.setColorAt(i*8+j,color.setHSL(.258+.018*Math.sin(x),.26+.045*Math.cos(yaw),.34+.032*Math.sin(yaw),THREE.SRGBColorSpace));
      }
    }
    branches.computeBoundingSphere();leaves.computeBoundingSphere();
    branches.castShadow=leaves.castShadow=true;
    branches.receiveShadow=leaves.receiveShadow=true;
    const cell=new THREE.Group();
    cell.add(branches,leaves);
    const [a,b]=key.split(',').map(Number);
    tiles.push([cell,(a+.5)*size,(b+.5)*size]);
    group.add(cell);
  }
  group.userData.update=(x,z)=>{
    for(const [cell,X,Z] of tiles)cell.visible=(x-X)**2+(z-Z)**2<610**2;
  };
  return group;
}
