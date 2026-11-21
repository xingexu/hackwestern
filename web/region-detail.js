import {campusSeat,campusBikeRack} from './street-detail.js';

export function pruneStadiumTrees(region,data) {
  const stands=data.macro.filter(f=>f[0]==='grandstand');
  region.trees=region.trees.filter(([x,,z])=>!stands.some(([kind,id,cx,y,cz,yaw,w,l])=>{
    const dx=x-cx,dz=z-cz, c=Math.cos(yaw),s=Math.sin(yaw);
    return Math.abs(dx*c-dz*s)<w/2+.3 && Math.abs(dx*s+dz*c)<l/2+.3;
  }));
}

const signLetters={
  S:[7,4,7,1,7],T:[7,2,2,2,2],O:[7,5,5,5,7],P:[7,5,7,4,4],B:[6,5,6,5,6],U:[5,5,5,5,7],
  0:[7,5,5,5,7],1:[2,6,2,2,7],2:[7,1,7,4,7],3:[7,1,7,1,7],4:[5,5,7,1,1],
  5:[7,4,7,1,7],6:[7,4,7,5,7],7:[7,1,2,2,2],8:[7,5,7,5,7],9:[7,5,7,1,7]
};

export function streetSignPanels(THREE,posts,records={},material){
  const positions=[],colors=[],ids=[];
  const white=new THREE.Color(0xf8f8ec),steel=new THREE.Color(0x9a9e95),red=new THREE.Color(0xb42d30);
  const blue=new THREE.Color(0x224976),lake=new THREE.Color(0x27678c),border=new THREE.Color(0xd6d6c8);
  function outline(w,h,bevel){
    return [[-w/2+bevel,-h/2],[w/2-bevel,-h/2],[w/2,-h/2+bevel],[w/2,h/2-bevel],
      [w/2-bevel,h/2],[-w/2+bevel,h/2],[-w/2,h/2-bevel],[-w/2,-h/2+bevel]];
  }
  for(const [kind,id,x,y,z,heading] of posts){
    if(kind!=='stop'&&kind!=='bus_stop')continue;
    ids.push(id);
    const record=records[id],yaw=record?.face??heading+Math.PI,c=Math.cos(yaw),s=Math.sin(yaw);
    const base=y+(kind==='stop'?2.17:2.35);
    function vertex(p,t,color){
      positions.push(x+c*p[0]+s*t,base+p[1],z-s*p[0]+c*t);
      colors.push(color.r,color.g,color.b);
    }
    function face(points,t,color){
      for(let n=2;n<points.length;n++){
        vertex(points[0],t,color);vertex(points[n-1],t,color);vertex(points[n],t,color);
      }
    }
    function plate(points,color){
      face([...points].reverse(),-.036,steel);face(points,.036,color);
      for(let i=0;i<points.length;i++){
        const a=points[i],b=points[(i+1)%points.length];
        vertex(a,-.036,steel);vertex(b,-.036,steel);vertex(b,.036,steel);
        vertex(a,-.036,steel);vertex(b,.036,steel);vertex(a,.036,steel);
      }
    }
    function rect(cx,cy,w,h,t,color){
      face([[cx-w/2,cy-h/2],[cx+w/2,cy-h/2],[cx+w/2,cy+h/2],[cx-w/2,cy+h/2]],t,color);
    }
    function word(text,cx,cy,cell,t,color){
      const width=(4*text.length-1)*cell;
      for(const [j,letter] of [...text].entries()){
        const rows=signLetters[letter]??[];
        for(let row=0;row<rows.length;row++){
          for(let col=0;col<3;col++){
            if(rows[row]&(4>>col))rect(cx-width/2+(4*j+col+.5)*cell,cy+(2-row)*cell,cell*1.01,cell*1.01,t,color);
          }
        }
      }
    }
    if(kind==='stop'){
      plate(outline(.73,.73,.214),white);
      face(outline(.684,.684,.20),.039,red);
      word('STOP',0,0,.036,.044,white);
    }else{
      const ink=record?.tone==='lake'?lake:blue;
      plate(outline(.435,.65,.033),border);
      face(outline(.404,.618,.021),.039,ink);
      rect(-.099,.147,.135,.162,.043,white);
      rect(-.099,.167,.103,.062,.046,ink);
      rect(-.135,.097,.022,.017,.046,ink);rect(-.062,.097,.022,.017,.046,ink);
      rect(-.145,.057,.026,.027,.043,white);rect(-.052,.057,.026,.027,.043,white);
      word('BUS',.080,.153,.015,.044,white);
      rect(0,.010,.327,.011,.043,border);
      if(record?.ref)word(record.ref,0,-.129,.020,.044,white);
    }
  }
  if(!positions.length)return null;
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.computeVertexNormals();geometry.computeBoundingSphere();
  const mesh=new THREE.Mesh(geometry,material);
  mesh.name='Street sign lettering and symbols';
  mesh.userData.posts=ids;
  return mesh;
}

export function createRegionDetail(THREE, data, region, network, landscape) {
  const group = new THREE.Group();
  group.name = 'Regional architecture and street furniture';
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial();
  const signMaterial=new THREE.MeshStandardMaterial({vertexColors:true});
  const transform = new THREE.Object3D();
  const palette = new Map();
  const iron = 0x454c50, steel = 0x859196, cream = 0xe2d8bf, white = 0xe9e7d8;
  const purple = 0x513174, glass = 0x768e96, stone = 0xb8aa93, wood = 0x99724f;
  const surfaces = [0xbdae96, 0xa99586, 0xb7a490, 0x968f87, 0xc3b497];
  let batches,register=false,owner;
  function boxMatrix(x,y,z,w,h,l,yaw,pitch,roll){
    transform.position.set(x,y,z);
    transform.rotation.set(pitch,yaw,roll,'YXZ');
    transform.scale.set(w,h,l);
    transform.updateMatrix();
    return transform.matrix;
  }
  const sportsMaterial=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.92,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  const paintMaterial=sportsMaterial.clone();
  paintMaterial.transparent=true;
  paintMaterial.depthWrite=false;
  let endZoneInk;
  function endZoneAtlas(){
    const canvas=new OffscreenCanvas(1024,256),ink=canvas.getContext('2d');
    ink.fillStyle='white';ink.font='bold 116px Georgia, serif';ink.textAlign='center';
    for(const [i,word] of ['WESTERN','MUSTANGS'].entries()){
      const measure=ink.measureText(word);
      ink.save();
      ink.translate(512,128*i+117);ink.scale(970/measure.width,108/measure.actualBoundingBoxAscent);
      ink.fillText(word,0,0);ink.restore();
    }
    const texture=new THREE.CanvasTexture(canvas);
    texture.anisotropy=8;
    return texture;
  }
  const laneBasis=data.sports?.laneBasis;
  function paintShader(material,track){
    material.customProgramCacheKey=()=>track?'athletics-lanes':'field-paint';
    material.onBeforeCompile=shader=>{
      if(track)shader.uniforms.endZoneInk={value:endZoneInk??=endZoneAtlas()};
      if(track&&laneBasis){
        shader.uniforms.turnCenters={value:new THREE.Vector4(...laneBasis.slice(0,4))};
        shader.uniforms.trackRadius={value:laneBasis[4]};
      }
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 mark,fieldPosition;')
        .replace('#include <begin_vertex>','#include <begin_vertex>\nmark=uv;fieldPosition=position.xz;');
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        varying vec2 mark,fieldPosition;uniform sampler2D endZoneInk;uniform vec4 turnCenters;uniform float trackRadius;
        float laneIntegral(float x){return floor(x)*(.064/1.22)+min(fract(x),.064/1.22);}`)
        .replace('#include <color_fragment>',`#include <color_fragment>
          float station=mark.x;
          ${track&&laneBasis?`vec2 axis=turnCenters.zw-turnCenters.xy;
          vec2 point=fieldPosition-turnCenters.xy;
          float along=clamp(dot(point,axis)/dot(axis,axis),0.,1.);
          station=(length(point-along*axis)-trackRadius)/1.22;`:''}
          float footprint=max(.0001,fwidth(station));
          float lo=station-footprint*.5,hi=lo+footprint;
          ${track?`if(mark.y>0.){
            float coverage=(laneIntegral(hi+.032/1.22)-laneIntegral(lo+.032/1.22))/footprint;
            ${laneBasis?'coverage*=smoothstep(-.12,-.04,station)*(1.-smoothstep(8.04,8.12,station));':''}
            diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.823,.723,.738),clamp(coverage,0.,1.));
          }else if(mark.y<=-2.){
            float ink=texture2D(endZoneInk,vec2(mark.x,mark.y+3.)).a;
            diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.81,.80,.73),ink);
          }`:`diffuseColor.a*=max(0.,min(hi,mark.y)-max(lo,-mark.y))/footprint;
          if(diffuseColor.a<.001)discard;`}`);
    };
  }
  paintShader(sportsMaterial,true);
  paintShader(paintMaterial,false);
  const wireMaterial=new THREE.MeshStandardMaterial({color:0x788481,side:THREE.DoubleSide,transparent:true,depthWrite:false,roughness:.87});
  wireMaterial.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 wireUV;').replace('#include <begin_vertex>','#include <begin_vertex>\nwireUV=uv;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 wireUV;').replace('#include <color_fragment>',`#include <color_fragment>
      vec2 lattice=vec2(wireUV.x+wireUV.y,wireUV.x-wireUV.y)*9.;
      vec2 span=clamp(fwidth(lattice),vec2(.015),vec2(1.));
      vec2 strand=1.-smoothstep(vec2(.035)-span*.5,vec2(.035)+span*.5,abs(fract(lattice+.5)-.5));
      vec2 filtered=mix(strand,vec2(.07),smoothstep(vec2(.45),vec2(1.),span));
      diffuseColor.a*=1.-(1.-filtered.x)*(1.-filtered.y);
      if(diffuseColor.a<.015)discard;`);
  };
  let wirePositions=[],wireUV=[];
  const batch=()=>({positions:[],colors:[],paint:[]});
  let field=batch(),markings=batch();
  function groundStrip(points,rise,hex,coordinate,target=field){
    if(register){if(target===field)network.addField?.(points);return;}
    const tint=new THREE.Color(hex);
    landscape.projectPolygon(points,(x,y,z)=>{
      target.positions.push(x,y+rise,z);
      target.colors.push(tint.r,tint.g,tint.b);
      target.paint.push(...(coordinate?coordinate(x,z):[0,0]));
    });
  }
  function rectOnGround(x,z,yaw,w,l,rise,color){
    const c=Math.cos(yaw),s=Math.sin(yaw);
    const width=Math.min(w,l),paint=width<.23&&Math.max(w,l)>width*4;
    const coordinate=paint?(px,pz)=>[w<l?(px-x)*c-(pz-z)*s:(px-x)*s+(pz-z)*c,width*.5]:null;
    if(paint){if(w<l)w+=1.6;else l+=1.6;}
    groundStrip([[-1,-1],[-1,1],[1,1],[1,-1]].map(([u,v])=>[x+c*u*w*.5+s*v*l*.5,z-s*u*w*.5+c*v*l*.5]),rise,color,coordinate,paint?markings:field);
  }
  function fieldMesh(){
    let result=null;
    for(const [source,material] of [[field,sportsMaterial],[markings,paintMaterial]]){
      if(!source.positions.length)continue;
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(source.positions,3));
      g.setAttribute('color',new THREE.Float32BufferAttribute(source.colors,3));
      g.setAttribute('uv',new THREE.Float32BufferAttribute(source.paint,2));
      g.computeVertexNormals();g.computeBoundingSphere();
      const mesh=new THREE.Mesh(g,material);
      mesh.name='Terrain-conforming field surfaces';
      mesh.receiveShadow=true;
      if(result)result.add(mesh);else result=mesh;
    }
    field=batch();markings=batch();
    return result;
  }
  function box(x,y,z,w,h,l,color,yaw=0,pitch=0,roll=0) {
    if(Math.min(w,h,l)<=0)return;
    if(register){
      network.addBox?.(boxMatrix(x,y,z,w,h,l,yaw,pitch,roll).elements,owner);
      return;
    }
    batches.push([x,y,z,w,h,l,color,yaw,pitch,roll]);
  }
  function local(x,y,z,yaw) {
    const c=Math.cos(yaw), s=Math.sin(yaw);
    return (u,v,t,w,h,l,color,rotation=0,pitch=0,roll=0) =>
      box(x+c*u+s*t,y+v,z-s*u+c*t,w,h,l,color,yaw+rotation,pitch,roll);
  }
  function beam(x,y,z,X,Y,Z,size,color,width=size) {
    const dx=X-x, dy=Y-y, dz=Z-z;
    box((x+X)/2,(y+Y)/2,(z+Z)/2,width,size,Math.hypot(dx,dy,dz),color,
      Math.atan2(dx,dz),-Math.atan2(dy,Math.hypot(dx,dz)));
  }
  function finish(name) {
    const sports=fieldMesh();
    if(!batches.length)return sports;
    const mesh=new THREE.InstancedMesh(geometry,material,batches.length);
    for (let i=0;i<batches.length;i++) {
      const [x,y,z,w,h,l,hex,yaw,pitch,roll]=batches[i];
      mesh.setMatrixAt(i,boxMatrix(x,y,z,w,h,l,yaw,pitch,roll));
      if (!palette.has(hex)) palette.set(hex,new THREE.Color(hex));
      mesh.setColorAt(i,palette.get(hex));
    }
    mesh.name=name;
    if(sports)mesh.add(sports);
    if(wirePositions.length){
      const net=new THREE.BufferGeometry();
      net.setAttribute('position',new THREE.Float32BufferAttribute(wirePositions,3));
      net.setAttribute('uv',new THREE.Float32BufferAttribute(wireUV,2));
      net.computeVertexNormals();
      mesh.add(new THREE.Mesh(net,wireMaterial));
      wirePositions=[];wireUV=[];
    }
    mesh.computeBoundingSphere();
    mesh.receiveShadow=true;
    return mesh;
  }
  function bench(at,u=0,t=0,length=1.8,style){
    campusSeat((x,y,z,...part)=>at(u+x,y,t+z,...part),length,style);
  }
  function prop([kind,id,x,y,z,yaw,width,side,count]) {
    if(network?.groundAt && kind!=='entrance')y=network.groundAt(x,z);
    const at=local(x,y,z,yaw);
    const finish=data.fixtureFinishes?.get(kind+','+x+','+z);
    const post=(height,thick=.115,color=steel)=>at(0,height/2,0,thick,height,thick,color);
    switch(kind) {
      case 'field_shed': case 'parking_enclosure': case 'park_enclosure': case 'green_enclosure': case 'shipping_container': {
        const length=side,height=count,container=kind==='shipping_container',shed=kind==='field_shed';
        const blue=container&&finish==='blue';
        const skin=container?(blue?0x608695:0x9c5541):kind==='green_enclosure'?0x537665:shed?0xbab39c:0xa69f8b,edge=container?(blue?0x455d69:0x744839):0x827e71;
        at(0,.065,0,width+.12,.13,length+.12,0x98968a);
        for(const sign of [-1,1]){
          at(sign*(width*.5-.048),height*.5,0,.065,height-.10,length-.07,skin);
          at(0,height*.5,sign*(length*.5-.048),width-.07,height-.10,.065,skin);
        }
        at(0,height-.055,0,width+.08,.11,length+.10,container?(blue?0x7395a3:0xa65e47):0xb7b3a1);
        for(const u of [-1,1]){
          at(u*(width*.5-.045),height*.50,length*.5-.055,.095,height,.10,edge);
          at(u*(width*.5-.045),height*.50,-length*.5+.055,.095,height,.10,edge);
          if(container)for(let t=-length*.5+.16;t<length*.5-.09;t+=.29)
            at(u*(width*.5-.008),height*.51,t,.048,height-.20,.096,blue?0x7193a2:0xa8614d);
        }
        const door=container?width*.88:Math.min(width*.73,1.86);
        for(const direction of [-1,1]){
          at(direction*door*.252,height*.44,-length*.5,door*.49,height*.84,.065,edge);
          at(direction*door*.252,height*.45,-length*.5-.035,door*.46,height*.79,.03,skin);
          at(direction*door*.15,container?height*.45:1.02,-length*.5-.072,.038,container?height*.80:.18,.035,iron);
        }
        break;
      }
      case 'parking_arm': {
        at(0,.075,0,.54,.15,.55,stone);
        at(0,.56,0,.34,.95,.35,0x626964);
        at(0,1.03,0,.37,.085,.38,0x9d9c8d);
        at(0,count,width*.50,.09,.115,width,white);
        for(let t=.32;t<width-.10;t+=.72)at(0,count,t,.104,.122,.29,0xb3473e);
        break;
      }
      case 'survey_goal': {
        const rise=count,depth=side;
        for(const sign of [-1,1]){
          at(sign*width*.5,rise*.5,0,.10,rise,.10,white);
          at(sign*width*.5,.045,depth*.5,.074,.08,depth,white);
          at(sign*width*.5,rise*.50,depth*.5,.06,Math.hypot(depth,rise),.06,steel,0,-Math.atan2(depth,rise));
        }
        at(0,rise,0,width+.1,.10,.10,white);
        at(0,.045,depth,width,.08,.08,steel);
        const netPitch=-Math.atan2(depth,rise);
        for(let u=-width*.5+.20;u<width*.5;u+=.22)at(u,rise*.5,depth*.5,.014,Math.hypot(depth,rise),.014,0xb4b6a6,0,netPitch);
        for(let j=1;j<12;j++)at(0,rise*j/12,depth*(1-j/12),width,.014,.014,0xb4b6a6);
        break;
      }
      case 'service_tank': {
        const radius=width*.5,rows=18;
        for(let row=0;row<rows;row++){
          const t=((row+.5)/rows*2-1)*radius;
          const chord=2*Math.sqrt(radius*radius-t*t);
          at(0,.08,t,chord+.12,.16,width/rows+.012,stone);
          at(0,count*.46,t,chord,count*.91,width/rows+.008,0xaeb3aa);
          at(0,count*.92,t,chord,.13,width/rows+.012,0xbec1b6);
        }
        at(0,count,.08,.37,.12,.34,0x808b80);
        break;
      }
      case 'stone_pier':
        at(0,.045,0,width+.09,.09,side+.09,stone);
        at(0,count*.49,0,width,count*.94,side,0x9d998c);
        at(0,count-.055,0,width+.095,.11,side+.095,0xb8b4a7);
        break;
      case 'round_planter': {
        const rows=12;
        for(let i=0;i<rows;i++){
          const t=2*(i+.5)/rows-1,chord=Math.sqrt(1-t*t);
          at(0,count*.43,t*side*.44,width*.88*chord,count*.86,side*.88/rows,0xaaa796);
          at(0,count-.055,t*side*.5,width*chord,.11,side/rows,0xbab3a4);
          at(0,count+.006,t*side*.41,width*.82*chord,.013,side*.82/rows,0x655843);
        }
        break;
      }
      case 'stone_planter':
        at(0,.08,0,width*.65,.16,side*.65,stone);
        at(0,count*.56,0,width*.91,count*.66,side*.91,0xaaa796);
        at(0,count-.06,0,width,.12,side,0xbcb7a4);
        at(0,count-.013,0,width*.74,.05,side*.74,0x655843);
        break;
      case 'pay_station':
        at(0,.055,0,width+.25,.11,side+.24,stone);
        at(0,count*.50,0,width,count,side,0x67716e);
        at(0,count*.76,-side*.5,.36,.29,.055,0x343e42);
        at(0,count*.54,-side*.5,.16,.065,.064,0xd2cbbd);
        break;
      case 'gate_island':
        at(0,.09,0,width,.18,side,stone);
        at(0,.56,0,1.24,.85,2.42,0xafa994);
        at(0,1.57,0,1.21,1.19,2.39,glass);
        for(const u of [-.60,.60])for(const t of [-1.19,0,1.19])at(u,1.57,t,.055,1.19,.055,iron);
        at(0,count-.06,0,1.54,.12,2.75,0x8a897f);
        break;
      case 'scoreboard':
        for(const u of [-width*.34,width*.34]){
          at(u,.12,0,.68,.24,.72,stone);
          at(u,count*.47,0,.26,count*.94,.28,iron);
        }
        at(0,count*.71,0,width,count*.43,.25,0x373c42);
        at(0,count*.72,-.14,width-.31,count*.37,.04,0x4b4850);
        for(const u of [-.39,-.13,.13,.39]){
          at(u*width,count-.31,0,.065,.61,.065,steel);
          at(u*width,count-.09,-.11,.40,.18,.26,0xbdbbaf);
        }
        break;
      case 'survey_bleachers':
        at(0,.075,0,width+.62,.15,side+.55,0xc8c5b7);
        for(let tier=0;tier<5;tier++){
          const level=.39+(count-.39)*tier/4,t=(tier/4-.5)*(side-.42);
          at(0,level,t,width,.088,.32,0xc1c5c2);
          at(0,level-.19,t-.31,width,.075,.37,0xa9adab);
          for(const u of [-.39,-.13,.13,.39])at(width*u,(level+.12)/2,t,.067,level-.12,.076,steel);
        }
        break;
      case 'seating_circle': {
        const radius=width*.48;
        for(let i=0;i<18;i++){
          const a=i*Math.PI/9,dx=Math.sin(a),dz=Math.cos(a);
          if(i%6!==0)at(dx*radius,.29,dz*radius,1.09,.53,.49,0xb8af97,a);
        }
        at(0,.14,0,1.32,.28,1.42,stone);
        for(const [u,h,t,lean] of [[-.28,1.18,.18,-.17],[.16,1.52,-.18,.22],[.39,.93,.24,-.27]])
          at(u,.26+h/2,t,.27,h,.30,0x76766a,0,0,lean);
        break;
      }
      case 'kerb':
        at(0,.06,0,.46,.1,1.05,stone); break;
      case 'traffic_signals':
        post(6.1,.19); at(-side*width*.22,5.89,0,width*.47,.13,.14,steel);
        for (const [u,h] of [[-side*width*.44,5.2],[0,3.55]]) {
          at(u,h,0,.41,1.04,.39,0xb99947);
          at(u,h,-.22,.34,.97,.13,iron);
          for(let i=0;i<3;i++) {
            at(u,h+.30-i*.29,-.30,.205,.20,.045,[0xcc4f44,0x725e34,0x38534a][i]);
            at(u,h+.42-i*.29,-.34,.26,.06,.21,iron);
          }
        }
        break;
      case 'stop':
        post(2.45,.08); break;
      case 'street_lamp':
        at(0,.07,0,.32,.14,.32,stone);
        at(0,.26,0,.19,.27,.19,steel);
        at(.082,.67,0,.035,.22,.093,iron);
        at(0,5.92,0,.178,.19,.18,steel);
        post(6.2,.145); at(-side*.51,6.12,0,1.16,.12,.12,iron);
        at(-side*.96,6.06,0,.58,.16,.28,iron); at(-side*.96,5.965,0,.49,.055,.22,cream); break;
      case 'bus_stop':
        post(2.68,.08);
        at(0,1.49,0,.24,.41,.09,cream); break;
      case 'shelter':
        for(const u of [-1.42,1.42]) for(const t of [-.74,.74]) at(u,1.15,t,.085,2.30,.085,iron);
        at(0,2.34,0,3.19,.18,1.8,iron);
        at(0,1.22,.74,2.9,1.77,.04,0xa6b6b4);
        if(count)bench(at,0,.37,2.25);
        break;
      case 'bicycle_parking': campusBikeRack(at,count,data.furnitureStyles?.[id]); break;
      case 'bench': bench(at,0,0,1.8,finish??data.furnitureStyles?.[id]); break;
      case 'bleachers':
        for(let row=0;row<4;row++){
          const level=.42+row*.34,depth=row*.70-1.05;
          at(0,level,depth,7.7,.10,.32,0xb8bebc);
          at(0,level-.24,depth-.26,7.7,.075,.43,0xa5aaa9);
          for(const side of [-3.1,-1.04,1.04,3.1])at(side,level*.50,depth,.08,level,.10,steel);
        }
        break;
      case 'picnic_table': {
        if(finish==='round'){
          at(0,.39,0,.16,.77,.16,iron);
          for(let j=-3;j<=3;j++){
            const t=j*.145;
            at(0,.78,t,2*Math.sqrt(.58*.58-t*t),.072,.14,0xacb2a8);
          }
          for(let i=0;i<4;i++){
            const a=i*Math.PI*.5,dx=Math.sin(a),dz=Math.cos(a);
            at(dx*.59,.24,dz*.59,.10,.48,.10,steel);
            at(dx*.42,.27,dz*.42,.072,.08,.83,steel,a);
            at(dx*.73,.47,dz*.73,.62,.075,.27,0x989f98,a);
          }
          break;
        }
        const board=finish==='plum'?0x805e75:finish==='vermilion'?0xaa6548:wood;
        for(const u of [-.58,.58]){
          const base=network?.groundAt?Math.min(0,network.groundAt(x+Math.cos(yaw)*u,z-Math.sin(yaw)*u)-y):0;
          at(u,(.72+base)*.5,0,.12,.72-base,.75,wood);
          at(u,.31,0,.12,.1,1.36,iron);
        }
        for(const t of [-.59,.59]) at(0,.46,t,1.73,.09,.26,board);
        for(const t of [-.25,0,.25]) at(0,.77,t,1.8,.085,.23,board);
        break;
      }
      case 'entrance':
        at(0,1.05,0,1.16,2.1,.26,iron); at(0,1.38,0,.93,.98,.29,glass);
        for(const u of [-.63,.63]) at(u,1.14,0,.12,2.28,.33,stone);
        at(0,2.28,0,1.44,.14,.49,cream); break;
      case 'parking_entrance':
        post(2.1,.08); at(0,1.85,0,.47,.57,.08,0x376489);
        at(0,1.9,.05,.21,.15,.02,white); break;
      case 'post_box':
        for(const u of [-.19,.19])at(u,.105,0,.105,.21,.31,iron);
        at(0,.66,0,.53,.92,.43,0xa74940);
        at(0,1.15,-.035,.56,.20,.45,0xaf5046,0,-.12);
        at(0,.94,-.223,.38,.11,.035,0x413d38);
        at(0,.57,-.223,.39,.48,.026,0xad5044);
        break;
      case 'phone':
        at(0,.065,0,.40,.13,.39,stone);
        at(0,1.06,0,.255,1.99,.22,0x36558a);
        at(0,1.32,-.117,.18,.40,.022,steel);
        at(0,1.37,-.133,.108,.092,.019,0x58635f);
        at(.035,1.23,-.140,.044,.042,.022,0xbcb49b);
        at(0,2.09,0,.18,.20,.16,0x79acc8);
        at(0,2.205,0,.23,.045,.20,steel);
        break;
      case 'fire_circle':
        for(let i=0;i<6;i++){
          const a=yaw+i*Math.PI/3,t=width*.40;
          at(Math.sin(a)*t,.21,Math.cos(a)*t,1.66,.33,.32,0x908268,a);
          const u=.57*Math.sin(a),v=.57*Math.cos(a);
          at(u,.115,v,.58,.21,.23,stone,a);
        }
        break;
      case 'recycling_bin':
        for(const u of [-.45,.45])for(const t of [-.35,.35])at(u,.10,t,.13,.20,.12,iron);
        at(0,.66,0,1.15,.98,.92,0x496072);
        for(const u of [-.51,.51])at(u,.68,-.47,.055,.87,.045,0x72808c);
        at(0,1.21,0,1.19,.13,1.01,0x405265);
        at(.18,1.29,-.30,.25,.035,.042,iron);
        break;
      case 'hoop':
        at(0,.075,0,.77,.15,.76,stone);
        at(0,1.70,0,.12,3.32,.12,steel);
        at(0,3.48,.46,.11,.13,.95,steel);
        at(0,3.44,.94,1.64,.95,.071,0xd7d5c9);
        for(let i=0;i<12;i++){
          const a=i*Math.PI/6;
          at(.226*Math.cos(a),3.05,1.24+.226*Math.sin(a),.035,.035,.125,0xbb643d,-a);
        }
        break;
      case 'fire_hydrant':
        post(.82,.29,0xba4439); at(0,.51,0,.62,.18,.20,0xbb883c); at(0,.82,0,.33,.13,.33,0xbd963d); break;
      case 'utility_cabinet':
        at(0,.07,0,1.10,.14,.74,0xb8b5a5);
        at(0,.71,0,.94,1.14,.56,0x747c70);
        at(0,1.30,0,1.01,.07,.64,0x59645a);
        for(const u of [-.22,.22])at(u,.73,-.29,.42,1.02,.035,0x828a7d);
        break;
      case 'gate_booth':
        at(0,.12,0,2.1,.24,3.2,0xb2b0a4);
        at(0,.68,0,1.72,.90,2.75,0xada699);
        at(0,1.60,0,1.68,.94,2.72,glass);
        for(const u of [-.84,.84])for(const t of [-1.36,0,1.36])at(u,1.60,t,.08,1.0,.08,iron);
        at(0,2.17,0,2.12,.20,3.15,0x777b76);
        break;
      case 'flagpole':
        at(0,.08,0,1.36,.16,1.36,0xbebdb4);
        post(8,.09); at(.55,7.25,0,1.03,.64,.065,purple); break;
      case 'lift_gate': {
        const hinge=side*width*.42,angle=-side*1.42,span=width*.86;
        at(hinge,.55,0,.32,1.1,.37,iron);
        const arm=(distance,w,h,l,tint)=>at(hinge-side*distance*Math.cos(angle),.95-side*distance*Math.sin(angle),0,w,h,l,tint,0,0,angle);
        arm(span*.5,span,.15,.1,white);
        for(let d=.35;d<span-.18;d+=.7)arm(d,.29,.16,.11,0xb84a41);
        break;
      }
      case 'gate': case 'swing_gate':
        at(side*width*.42,.55,0,.32,1.1,.37,iron);
        at(0,.95,0,width*.86,.15,.10,white);
        for(let u=-width*.36;u<width*.4;u+=.7) at(u,.95,0,.29,.16,.11,0xb84a41); break;
      case 'cycle_barrier':
        for(const u of [-.6,.6]) at(u,.41,0,.08,.82,.08,steel);
        at(0,.82,0,1.27,.08,.08,steel); break;
      case 'bollard': post(.92,.17,iron); at(0,.80,0,.18,.11,.18,cream); break;
      case 'block': at(0,.30,0,.85,.6,.61,stone); break;
    }
  }
  function line([kind,id,x,y,z,X,Y,Z]) {
    if(network?.groundAt){y=network.groundAt(x,z);Y=network.groundAt(X,Z);}
    const length=Math.hypot(X-x,Z-z);
    const yaw=Math.atan2(X-x,Z-z);
    const at=local(x,y,z,yaw);
    if(kind==='steps') {
      const n=Math.max(1,Math.round(length/.33)), run=length/n;
      for(let i=0;i<n;i++) at(0,(Y-y)*(i+.5)/n+.085,run*(i+.5),1.68,.17,run+.018,stone);
      for(const s of [-1,1]) {
        const u=.84*s, dx=Math.cos(yaw)*u,dz=-Math.sin(yaw)*u;
        at(u,.49,0,.055,.97,.055,steel);
        beam(x+dx,y+1,z+dz,X+dx,Y+1,Z+dz,.06,steel);
      }
    } else if(kind==='compound_wall'){
      beam(x,y+.68,z,X,Y+.68,Z,1.36,0xa69e89,.22);
      beam(x,y+1.39,z,X,Y+1.39,Z,.07,0xbab6a6,.28);
    } else if(kind==='survey_fence'){
      const n=Math.ceil(length/2.7);
      for(let i=0;i<n;i++)at(0,.79+(Y-y)*i/n,length*i/n,.065,1.58,.065,steel);
      beam(x,y+1.53,z,X,Y+1.53,Z,.048,steel);
      if(register){
        network.addBox?.(boxMatrix((x+X)/2,(y+Y)/2+.80,(z+Z)/2,.045,1.45,Math.hypot(length,Y-y),yaw,-Math.atan2(Y-y,length),0).elements,owner);
      }else{
        for(const [along,h] of [[0,.08],[1,.08],[1,1.52],[0,.08],[1,1.52],[0,1.52]]){
          wirePositions.push(x+(X-x)*along,y+(Y-y)*along+h,z+(Z-z)*along);
          wireUV.push(length*along,h);
        }
      }
    } else if(kind==='iron_fence'){
      const n=Math.ceil(length/2.45);
      for(let i=0;i<n;i++)at(0,.66+(Y-y)*i/n,length*i/n,.074,1.32,.074,iron);
      for(const h of [.21,1.08])beam(x,y+h,z,X,Y+h,Z,.045,iron);
      const bars=Math.ceil(length/.15);
      for(let k=0;k<bars;k++){
        const f=(k+.5)/bars;
        at(0,.69+(Y-y)*f,length*f,.028,1.10,.028,iron);
      }
    } else if (kind==='fence') {
      const n=Math.ceil(length/2.35);
      for(let i=0;i<n;i++) at(0,.80+(Y-y)*i/n,length*i/n,.075,1.6,.075,iron);
      for(const h of [.30,1.48]) beam(x,y+h,z,X,Y+h,Z,.055,steel);
      for(let u=.23;u<length;u+=.39) at(0,.88+(Y-y)*u/length,u,.028,1.12,.028,steel);
    } else if(kind==='platform_edge') {
      beam(x,y+.075,z,X,Y+.075,Z,.15,stone,1.25);
    } else if(kind==='field_edge') {
      if(landscape)rectOnGround((x+X)*.5,(z+Z)*.5,yaw,.11,length,.029,white);
      else beam(x,y+.072,z,X,Y+.072,Z,.035,white,.11);
    } else {
      beam(x,y+.12,z,X,Y+.12,Z,.09,purple,8.1);
      for(let lane=-4;lane<=4;lane++) {
        const dx=Math.cos(yaw)*lane,dz=-Math.sin(yaw)*lane;
        beam(x+dx,y+.183,z+dz,X+dx,Y+.183,Z+dz,.034,0xaa9bb3,.065);
      }
    }
  }
  const glyphs={
    W:['10001','10001','10101','10101','01010'], E:['111','100','110','100','111'],
    S:['111','100','111','001','111'], T:['111','010','010','010','010'],
    R:['110','101','110','101','101'], N:['1001','1101','1011','1001','1001'],
    M:['10001','11011','10101','10001','10001'], U:['101','101','101','101','111'],
    A:['010','101','111','101','101'], G:['111','100','101','101','111'],
    0:['111','101','101','101','111'], 1:['010','110','010','010','111'],
    2:['111','001','111','100','111'], 3:['111','001','111','001','111'],
    4:['101','101','111','001','001'], 5:['111','100','111','001','111']
  };
  function lettering(at,word,u,v,t,size,flip,color) {
    const columns=Array.from(word,ch=>glyphs[ch]);
    let x=-(columns.reduce((sum,letter)=>sum+letter[0].length+1,0)-1)/2;
    for(const letter of columns) {
      for(let row=0;row<letter.length;row++) for(let k=0;k<letter[row].length;k++) {
        if(letter[row][k]==='1') at(u+flip*(x+k+.5)*size,v,t+flip*(row-2)*size,size+.004,.035,size+.004,color);
      }
      x+=letter[0].length+1;
    }
  }
  function area([kind,id,x,y,z,yaw,width,length]) {
    if(landscape&&data.sports?.practice?.suppressed.includes(id))return;
    const structure=local(x,y,z,yaw);
    const at=(u,v,t,w,h,l,color,rotation=0,pitch=0,roll=0)=>{
      if(!landscape||kind==='grandstand')return structure(u,v,t,w,h,l,color,rotation,pitch,roll);
      const px=x+Math.cos(yaw)*u+Math.sin(yaw)*t,pz=z-Math.sin(yaw)*u+Math.cos(yaw)*t;
      if(v<.24&&h<=.14)return rectOnGround(px,pz,yaw+rotation,w,l,.003+v*.12,color);
      box(px,network.groundAt(px,pz)+v,pz,w,h,l,color,yaw+rotation,pitch,roll);
    };
    const w=id===570131733?71.9:width, l=length;
    const stripe=(u,t,W,L,c=white)=>at(u,.15,t,W,.045,L,c);
    function boundary() {
      for(const s of [-1,1]) {stripe(s*w*.49,0,.12,l*.98); stripe(0,s*l*.49,w*.98,.12);}
    }
    function goal(t,span,rise) {
      for(const s of [-1,1]) at(span*.5*s,rise*.5,t,.105,rise,.105,white);
      at(0,rise,t,span+.1,.11,.11,white);
    }
    switch(kind) {
      case 'canadian_football': {
        const field=l*.72, yards=field/110, end=(l-field)/2;
        for(let band=0;band<22;band++)at(0,.08,(band+.5)*5*yards-field/2,w,.10,5*yards,band%2?0x416f46:0x47764b);
        for (const s of [-1,1]) at(0,.14,s*(l/2-end/2),w*.985,.05,end,purple);
        for (let n=-55;n<=55;n+=5) {
          stripe(0,n*yards,w*.97,.15);
          if(n===55) break;
          for(let a=1;a<5;a++) for(const u of [-.28,.28]) stripe(u*w,(n+a)*yards,1,.10);
        }
        boundary();
        for (const s of [-1,1]) {
          const t=s*field*.5;
          at(0,1.53,t,.18,3.06,.18,0xe4bb43);
          at(0,3.08,t,5.65,.15,.15,0xe4bb43);
          for (const u of [-2.75,2.75]) at(u,5.5,t,.14,4.95,.14,0xe4bb43);
        }
        for(const [i,word] of ['WESTERN','MUSTANGS'].entries()){
          const flip=1-2*i,mid=-flip*(l-end)*.5;
          if(!landscape){lettering(at,word,0,.216,mid,1.53,flip,white);continue;}
          if(register)continue;
          const width=w*.79,height=8.40,c=Math.cos(yaw),s=Math.sin(yaw);
          const corners=[[-1,-1],[-1,1],[1,1],[1,-1]].map(([u,v])=>[x+c*u*width*.5+s*(mid+v*height*.5),z-s*u*width*.5+c*(mid+v*height*.5)]);
          groundStrip(corners,.032,purple,(px,pz)=>[.5+flip*((px-x)*c-(pz-z)*s)/width,-2.-.5*(i+.5+flip*((px-x)*s+(pz-z)*c-mid)/height)]);
        }
        lettering(at,'W',0,.221,0,1.37,1,purple);
        for(let n=-45;n<=45;n+=10) for(const side of [-1,1]) {
          const number=String(55-Math.abs(n));
          lettering(at,number,w*side*.345,.192,n*yards,.22,side,white);
        }
        for(const s of [-1,1]) for(const e of [-1,1]) {
          let u=s*(w/2+22);
          const t=e*l*.38;
          const px=x+Math.cos(yaw)*u+Math.sin(yaw)*t,pz=z-Math.sin(yaw)*u+Math.cos(yaw)*t;
          if(data.athleticMasts?.some(([X,Z,h])=>h>=18&&Math.hypot(px-X,pz-Z)<26))continue;
          for(let k=0;k<26;k++){
            const px=x+Math.cos(yaw)*u+Math.sin(yaw)*t,pz=z-Math.sin(yaw)*u+Math.cos(yaw)*t;
            if(!network.crownClear || network.crownClear(px,(network.groundAt?.(px,pz)??y)+10,pz,.5,11))break;
            u+=s;
          }
          at(u,11.1,t,.42,22.2,.42,steel);
          at(u,22,t,4.35,.25,.33,iron);
          for(let k=-2;k<=2;k++) at(u+k*.73,21.74,t,.48,.43,.49,cream);
        }
        break;
      }
      case 'grandstand': {
        const target=data.macro.find(f=>f[0]==='canadian_football');
        const facing=Math.sign((target[2]-x)*Math.cos(yaw)-(target[4]-z)*Math.sin(yaw));
        const rows=Math.max(6,Math.round(w/1.05)), depth=w/rows;
        for(let i=0;i<rows;i++) {
          const rise=.32+i*.39, u=facing*(w/2-depth*(i+.5));
          at(u,rise/2,0,depth+.04,rise,l,0x989792);
          for(let bay=-2;bay<=2;bay++) at(u,rise+.105,bay*l*.2,.32,.20,l*.173,i%4===0?purple:steel);
        }
        const back=-facing*(w*.5-.11), height=.32+rows*.39;
        for(const h of [.25,.88]) at(back,height+h,0,.07,.07,l,iron);
        for(let t=-l*.49;t<l*.5;t+=3) at(back,height+.4,t,.065,.86,.065,iron);
        if(w>20) {
          at(back+facing*1.1,height+1.12,0,2.85,2.24,l*.23,cream);
          at(back+facing*2.55,height+1.41,0,.13,1.01,l*.22,glass);
          for(let t=-l*.11;t<=l*.11;t+=2) at(back+facing*2.64,height+1.41,t,.12,1.08,.12,steel);
          at(back+facing*1.1,height+2.35,0,3.48,.22,l*.24,iron);
        }
        break;
      }
      case 'tennis':
        if(w>18||l>33) break;
        boundary(); for(const s of [-1,1]) {stripe(s*w*.36,0,.08,l*.98);stripe(0,s*l*.27,w*.73,.08);}
        stripe(0,0,.075,l*.55); at(0,.52,0,w+.55,.87,.048,0x5e706e); at(0,.97,0,w+.55,.07,.055,white); break;
      case 'soccer': case 'rugby_union':
        if(id===570131733){
          for(const s of [-1,1]){
            stripe(s*w*.458,0,.105,l*.85,0xe4cb61);stripe(0,s*l*.425,w*.916,.105,0xe4cb61);
            goal(s*l*.425,7.3,2.44);
          }
        }
        boundary(); stripe(0,0,w,.12);
        for(const s of [-1,1]) {
          if(kind==='soccer') {goal(s*l*.49,7.3,2.44); stripe(0,s*l*.36,w*.54,.11);
            for(const u of [-1,1]) stripe(u*w*.27,s*l*.425,.11,l*.13);}
          else {at(0,3,s*l*.46,5.6,.12,.12,white);
            for(const u of [-2.8,2.8]) at(u,3.8,s*l*.46,.13,7.6,.13,white);}
        }
        break;
      case 'volleyball':
        boundary();
        for(const side of [-1,1])at(side*w*.51,1.25,0,.09,2.5,.09,iron);
        {
          const net=local(x,network?.groundAt?.(x,z)??y,z,yaw);
          const cols=Math.max(2,Math.round(w/.102));
          for(let j=0;j<=cols;j++)net((j/cols-.5)*w,2.08,0,.009,.80,.009,0x4b504e);
          for(let j=0;j<=8;j++)net(0,1.68+j*.10,0,w,.009,.009,0x535754);
          net(0,2.49,0,w,.048,.026,white);
        }
        break;
      case 'basketball':
        boundary(); stripe(0,0,w,.1);
        for(const s of [-1,1]) {at(0,1.75,s*l*.47,.13,3.5,.13,steel); at(0,3.28,s*l*.46,1.8,.98,.09,white);
          at(0,3.05,s*(l*.46-.34),.46,.075,.44,0xc06535);} break;
      case 'baseball': {
        const base=Math.min(19,Math.min(w,l)*.17);
        for(const side of [-1,1]) {
          at(side*base*.5,.125,base*.5,.12,.035,base*Math.SQRT2,white,side*Math.PI/4);
          at(side*base,.15,base,.58,.08,.58,cream,Math.PI/4);
        }
        at(0,.15,2*base,.58,.08,.58,cream,Math.PI/4);
        at(0,.14,0,.52,.07,.53,white,Math.PI/4);
        at(0,.16,base,.62,.08,.18,white);
        break;
      }
      case 'runway': case 'sandpit':
        if(w<12) {at(0,.077,0,w*.94,.12,l*.94,kind==='sandpit'?0xc4b294:0xae7867);boundary();}
        break;
      case 'athletics':
        for(const side of [-1,1]) stripe(side*w*.38,0,.09,l*.82); break;
      case 'platform': at(0,.07,0,w*.88,.14,l*.94,stone); break;
      case 'fitness_station': case 'playground': {
        const span=Math.min(w*.36,l*.34,3.8);
        if(span<.6) break;
        for(const side of [-1,1]) {
          at(side*span/2,1.05,0,.13,2.1,.13,kind==='playground'?0x94734e:iron);
          at(side*span/2,1.05,.84,.13,2.1,.13,kind==='playground'?0x94734e:iron);
          at(side*span/2,2.11,.42,.10,.10,.94,steel);
        }
        for(let u=-span/2;u<=span/2;u+=.36) at(u,2.1,.42,.06,.065,.86,steel);
        for(const t of [0,.84]) at(0,2.1,t,span+.1,.095,.09,steel);
        break;
      }
      case 'pool':
        at(0,.09,0,w*.86,.10,l*.86,0x719caa); break;
    }
  }
  function roof([x,y,z,w,h,rgb]) {
    const color=(rgb[0]<<16)|(rgb[1]<<8)|rgb[2];
    box(x,y+h*.5,z,w,h,2,color);
  }
  function walls(index) {
    const [exterior,holes]=region.blocks[index];
    const segments=[];
    for(const ring of [exterior,...holes]) {
      let winding=0;
      for(let k=0;k<ring.length;k+=2) {
        const j=(k+2)%ring.length;
        winding+=ring[k]*ring[j+1]-ring[j]*ring[k+1];
      }
      for(let k=0;k<ring.length;k+=2) {
        const j=(k+2)%ring.length;
        const x=ring[k],z=ring[k+1],dx=ring[j]-x,dz=ring[j+1]-z;
        const length=Math.hypot(dx,dz);
        if(length<1.15) continue;
        if((dx===0 && (x===0||x===635)) || (dz===0 && (z===0||z===557))) continue;
        const out=(ring===exterior?1:-1)*Math.sign(winding);
        segments.push({x,z,dx:dx/length,dz:dz/length,length,nx:out*dz/length,nz:-out*dx/length,yaw:Math.atan2(-dz,dx)});
      }
    }
    return segments;
  }
  function wallFrame(edge,y) {
    return (u,v,t,w,h,l,c)=>box(edge.x+edge.dx*u+edge.nx*t,y+v,edge.z+edge.dz*u+edge.nz*t,w,h,l,c,edge.yaw);
  }
  function architecture(code,index) {
    const [, ,y,typicalHeight]=region.blocks[index];
    const bands=data.architecture.tiers?.[index];
    const edges=walls(index);
    const face=edges.reduce((best,e)=>!best||e.length>best.length?e:best,null);
    if(!face) return;
    for(const edge of edges) {
      const l=edge.length, at=wallFrame(edge,y), mid=l/2;
      let h=typicalHeight;
      if(bands){
        const along=[];
        for(const t of [.06,.25,.5,.75,.94]){
          const x=edge.x+edge.dx*l*t-edge.nx*.7, z=edge.z+edge.dz*l*t-edge.nz*.7;
          for(const [level,rings] of bands){
            let inside=false;
            for(const ring of rings) for(let n=0,k=ring.length-2;n<ring.length;k=n,n+=2){
              const ax=ring[n],az=ring[n+1],bx=ring[k],bz=ring[k+1];
              if((az>z)!==(bz>z) && x<(bx-ax)*(z-az)/(bz-az)+ax) inside=!inside;
            }
            if(inside){along.push(level);break;}
          }
        }
        if(along.length) h=Math.min(...along);
      }
      if(l<4) continue;
      switch(code) {
        case 'WIRB': case 'FNB': case 'PHFM': case 'WSSB': case 'CC': case 'SC': case 'AFAR': {
          if(edge!==face) break;
          const full=code==='WIRB'||code==='PHFM', span=full?l*.83:Math.min(l*.65,18);
          const high=code==='CC'?h*.72:h*.91;
          if(code==='WIRB') for(const side of [-1,1]) at(mid+side*(span/2+(l-span)/4),h*.5,.10,(l-span)*.47,h,.24,0xafafa7);
          for(let u=mid-span/2;u<=mid+span/2;u+=code==='PHFM'?1.35:2.32) at(u,high/2+.22,.50,.095,high,.13,steel);
          for(let v=1.45;v<high;v+=2.65) at(mid,v,.52,span,.12,.15,cream);
          for(const side of [-1,1]) at(mid+side*span*.5,high/2+.22,.26,.34,high+.3,.72,stone);
          if(code==='FNB'||code==='AFAR'||code==='SC') at(mid,high*.5,.4,span+.64,.36,1.19,cream);
          break;
        }
        case 'BIO': case 'SSB': case 'PHR': case 'EHR':
          if(l<12) break;
          for(let u=l*.15;u<l*.93;u+=code==='BIO'?4.1:7.3) {
            for(let v=2;v<h*.92;v+=3.1) at(u,v,.24,2.3,.68,.16,cream);
            for(const side of [-1,1]) at(u+side*1.17,h*.5,.22,.17,h*.92,.31,stone);
          }
          break;
        case 'BAHR':
          if(l<10) break;
          for(let v=3.1;v<h-.3;v+=3.1) for(let u=4;u<l-2;u+=8.4) {
            at(u,v,.51,4.04,.23,1.1,stone);
            at(u,v+.61,1.02,3.99,.84,.10,steel);
          }
          break;
        case 'TEB': case 'HSB': case 'PP':
          if(l<9) break;
          for(let u=3;u<l-2;u+=code==='PP'?5.2:6.9) {
            const rise=code==='PP'?Math.min(5.2,h*.68):h*.73;
            at(u,rise/2+.75,.29,.12,rise,.12,cream);
            for(let v=1.2;v<rise;v+=2.19) at(u,v,.29,code==='PP'?2.7:1.32,.13,.13,cream);
          }
          break;
        case 'WH': case 'UCC':
          if(edge===face) {
            const span=Math.min(l*.68,16), rise=Math.min(h*.69,8);
            at(mid,rise*.5,.15,span,rise,.3,glass);
            at(mid,rise+.18,.67,span+1.2,.48,1.65,cream);
            for(const ratio of [-.48,-.17,.17,.48]) at(mid+span*ratio,rise*.49,1.08,.28,rise,.31,stone);
          }
          break;
        case 'AH':
          at(mid,h-.32,.04,l,.65,.50,0x8d9e91);
          if(l<18) break;
          for(let u=4.5;u<l-2;u+=9.8) {
            at(u,h*.56,.12,2.45,h*.36,.19,purple);
            at(u,h*.47,.24,1.80,.22,.045,cream);
          }
          break;
        case 'TRAC': {
          const rx=edge.x+edge.dx*mid,rz=edge.z+edge.dz*mid;
          const rec=Math.hypot(rx-146,rz-885)<Math.hypot(rx-71,rz-943);
          at(mid,h-.16,.24,l,.38,rec?.92:1.5,rec?0x9eae9e:cream);
          if(rec&&l>7) {
            at(mid,h*.49,.12,l*.94,h*.72,.22,glass);
            for(let u=1;u<l-1;u+=3) at(u,h*.49,.30,.18,h*.76,.31,cream);
            for(let level=2;level<h*.85;level+=2.35) at(mid,level,.28,l*.94,.12,.24,cream);
          }
          break;
        }
        case 'OHR':
          if(l<11) break;
          for(let u=4;u<l-3;u+=11) {
            at(u,h*.52,.30,2.55,h*.90,.77,0x728b91);
            for(const s of [-1,1]) at(u+s*1.3,h*.52,.51,.19,h*.93,.61,cream);
            for(let v=3.3;v<h-.4;v+=3.3) at(u,v,.73,2.61,.14,.13,steel);
          }
          break;
        case 'SMHR':
          at(mid,h-.28,.08,l,.28,.35,cream);
          if(l>8) {
            at(mid,h*.54,.16,l*.97,1.55,.32,glass);
            for(let u=1;u<l-.5;u+=2.15) at(u,h*.54,.34,.12,1.68,.11,cream);
            at(mid,h*.54-.91,.16,l, .32,.55,cream);
          }
          break;
        case 'NCB':
          at(mid,h-.35,.18,l,.68,.83,0xbbb498);
          if(edge===face) {
            const span=Math.min(l*.65,16);
            at(mid,2.6,.22,span,5.2,.37,glass);
            at(mid,5.5,1.4,span+1.4,.34,3.1,stone);
            for(const s of [-1,0,1]) at(mid+s*(span/2-.65),2.7,2.67,.34,5.4,.34,cream);
          }
          break;
        case 'SEB':
          if(l>8) at(mid,h-.65,.11,l,.29,.36,stone);
          break;
      }
    }
    if(code==='CO') {
      const h=typicalHeight;
      const ring=region.blocks[index][0];
      const X=ring.filter((_,i)=>i%2===0), Z=ring.filter((_,i)=>i%2===1);
      const r=(Math.max(...X)-Math.min(...X))*.465;
      const x=(Math.max(...X)+Math.min(...X))/2,z=Math.min(...Z)+r+.45;
      for(let dy=.18;dy<r;dy+=.36) {
        const span=Math.sqrt(r*r-dy*dy);
        for(let dz=-span+.2;dz<span;dz+=.40) {
          const width=2*Math.sqrt(Math.max(0,span*span-dz*dz));
          box(x,y+h+dy,z+dz,width,.38,.41,Math.abs(dz)<.45?steel:0x9aa19c);
        }
      }
    }
    if(code==='SEB') {
      const rises=data.macro.filter(f=>f[0]==='lidar'&&f[1]===index);
      const summit=rises.reduce((highest,r)=>!highest||r[6]>highest[6]?r:highest,null);
      if(summit) {
        const [, ,x,base,z,,rise]=summit;
        const crown=rises.filter(r=>r[6]>=rise-1&&Math.hypot(r[2]-x,r[4]-z)<15);
        const minX=Math.min(...crown.map(r=>r[2]-r[5]/2)), maxX=Math.max(...crown.map(r=>r[2]+r[5]/2));
        const minZ=Math.min(...crown.map(r=>r[4]-1)), maxZ=Math.max(...crown.map(r=>r[4]+1));
        for(const X of [minX,maxX]) for(let Z=minZ;Z<=maxZ;Z+=1.8) box(X,base+rise+.31,Z,.45,.65,.92,stone);
        for(const Z of [minZ,maxZ]) for(let X=minX;X<=maxX;X+=1.8) box(X,base+rise+.31,Z,.92,.65,.45,stone);
        for(const Z of [minZ-.08,maxZ+.08]) for(const off of [-1.38,0,1.38]) {
          const X=(minX+maxX)/2+off, Y=base+rise-3.15;
          box(X,Y,Z,.86,3.6,.16,iron); box(X,Y+1.87,Z,.55,.32,.17,iron);
          box(X,Y,Z,.11,3.51,.22,stone);
        }
      }
    }
  }
  function facade([index,profile,,approach]) {
    const [, , y,h]=region.blocks[index];
    if(data.architecture.tiers?.[index]) return;
    const [form,ridge]=data.architecture.forms[index];
    const finish=data.architecture.atlas.forms[form];
    const edges=walls(index), home=['brickHome','sidingHome'].includes(finish.name);
    const garage=finish.name==='garageDoor';
    const hip=data.architecture.hips[index];
    const rise=ridge.length ? ridge[4] : hip ? hip[0] : 0;
    const eaves=h-rise*.5;
    const facadeHeight=Math.max(1,Math.round(eaves/finish.floor));
    const floor=eaves/facadeHeight;
    let front=null, best=-Infinity;
    for(const edge of edges){
      if(edge.length<4.6) continue;
      let score=edge.length;
      if(approach?.length){
        const dx=approach[0]-edge.x-edge.dx*edge.length/2,dz=approach[1]-edge.z-edge.dz*edge.length/2;
        const distance=Math.max(1,Math.hypot(dx,dz));
        score=35*(dx*edge.nx+dz*edge.nz)/distance-distance*.32+Math.min(edge.length,12)*.12;
      }
      if(score>best){best=score;front=edge;}
    }
    const trim=home||garage ? 0xd4d4c7 : surfaces[index%surfaces.length];
    for(const edge of edges) {
      const l=edge.length, at=wallFrame(edge,y),mid=l/2;
      if(!rise) {
        at(mid,eaves-.06,.055,l+.07,.17,home?.29:.34,trim);
        if(!home&&!garage) at(mid,eaves-.34,.04,l,.10,.17,iron);
      } else {
        at(mid,eaves-.10,.14,l+.07,.18,.32,trim);
        if(l>2.4) at(mid,eaves-.24,.20,l+.1,.085,.13,steel);
      }
      if(l<2.8) continue;
      at(mid,.25,.03,l,.50,.15,home||garage?0x9d9d90:0xa99f8f);
      if(edge===front && !garage && l>4.6){
        const width=home?1.0:Math.min(3.7,l*.18);
        at(mid,1.10,.135,width+.20,2.22,.32,trim);
        at(mid,1.08,.29,width,2.16,.08,home?0x534b46:iron);
        const n=home?1:2;
        for(let k=0;k<n;k++){
          const u=mid+(k+.5-n/2)*width/n;
          at(u,1.53,.35,width/n-.11,home?.68:1.06,.046,0x66808a);
          at(u+width/n*.31,1.0,.37,.045,.26,.06,cream);
        }
        const porch=home && l>6;
        const span=porch ? 2.35+(index%4)*.21 : width+.68;
        const depth=porch ? 1.42 : 1.16;
        at(mid,.12,depth*.46,span-.11,.24,depth,stone);
        at(mid,2.36,depth*.44,span,.18,depth,trim);
        if(porch) {
          at(mid,.07,depth+.1,span-.30,.14,.40,stone);
          for(const side of [-1,1]) at(mid+side*(span/2-.17),1.30,depth-.14,.10,2.12,.10,cream);
        }
      }
      if((home||garage) && l>4) {
        at(.16,eaves*.49,.13,.10,eaves-.2,.12,steel);
        at(.16,.19,.18,.12,.13,.21,steel);
      }
      if(garage || ['stone','brick','panel'].includes(finish.name)) continue;
      const n=Math.max(1,Math.round(l/finish.bay)),width=l/n;
      for(let j=0;j<n;j++){
        const u=(j+.5)*width;
        for(let story=0;story<facadeHeight;story++) {
          if(edge===front && Math.abs(u-mid)<1.4 && story===0) continue;
          if(!home && finish.name==='glass' && j%2===0) at(j*width,story*floor+floor/2,.11,.12,floor,.29,steel);
          if(home) at(u,story*floor+floor*.31,.08,width*.62,.10,.20,trim);
          else if(profile && l>8) at(u,story*floor+.17,.045,width,.11,.17,trim);
        }
      }
    }
  }
  batches=[];
  const trackJoins=new Map();
  for(const [kind,,x,,z,X,,Z] of data.macro){
    if(kind!=='track')continue;
    const len=Math.hypot(X-x,Z-z);
    for(const [ax,az] of [[x,z],[X,Z]]){
      const key=ax+','+az,join=trackJoins.get(key)??[0,0];
      join[0]+=(Z-z)/len;join[1]+=(x-X)/len;
      trackJoins.set(key,join);
    }
  }
  function runningTrack([,,x,,z,X,,Z]){
    const len=Math.hypot(X-x,Z-z),nx=(Z-z)/len,nz=(x-X)/len;
    function edge(ax,az,offset){
      const [dx,dz]=trackJoins.get(ax+','+az),ratio=offset/(dx*nx+dz*nz||1);
      return [ax+dx*ratio,az+dz*ratio];
    }
    const laneAt=(px,pz)=>[((px-x)*nx+(pz-z)*nz)/1.22,1];
    groundStrip([edge(x,z,-4.88),edge(X,Z,-4.88),edge(X,Z,4.88),edge(x,z,4.88)],.012,0x714672,laneAt);
  }
  function fieldSurfaces(){
    if(landscape)for(const garden of data.gardens??[]){
      const outline=[];
      for(let i=0;i<garden.apron.length;i+=2)outline.push(garden.apron.slice(i,i+2));
      groundStrip(outline,.017,0xc4c0b3);
    }
    if(!landscape||!data.sports)return;
    const lanes=laneBasis?()=>[0,1]:null;
    for(const triangle of data.sports.rubber)groundStrip(triangle,.004,0x714672,lanes);
    for(const ring of data.sports.synthetic)groundStrip(ring,.004,0x54694e);
    for(const patch of data.sports.practice?.surfaces??[])for(const face of patch.triangles)groundStrip(face,.006,patch.color);
  }
  fieldSurfaces();
  for(const item of data.macro) {
    if(item[0]==='track'){if(!landscape)line(item);else if(!laneBasis)runningTrack(item);}
    else if(item[0]==='lidar') {if(!data.architecture.tiers?.[item[1]]) roof(item.slice(2));}
    else area(item);
  }
  for(const [code,index] of data.landmarks) architecture(code,index);
  const regionalLandmarks=finish('Western Alumni Stadium and landmark exteriors');
  if(regionalLandmarks) {regionalLandmarks.castShadow=true; group.add(regionalLandmarks);}
  function detailGeometry(tile){
    for(const feature of tile.p??[]){owner=feature[0];prop(feature);}
    for(const segment of tile.l??[]){owner=segment[0];line(segment);}
    for(const field of tile.a??[]){owner=field[0];area(field);}
  }
  if(network?.addBox){
    register=true;
    fieldSurfaces();
    for(const feature of data.macro){
      owner=feature[0];
      if(owner==='track' && landscape && !laneBasis)runningTrack(feature);
      else if(owner!=='lidar' && owner!=='track')area(feature);
    }
    for(const tile of Object.values(data.tiles))detailGeometry(tile);
    register=false;
  }
  const active=new Map();
  let previous='';
  function update(x,z,distance=100) {
    const tx=Math.floor(x/data.tileSize), tz=Math.floor(z/data.tileSize);
    const radius=distance>650?-1:distance>330?0:1;
    const next=tx+':'+tz+':'+radius;
    if(next===previous) return;
    previous=next;
    const wanted=new Set();
    for(let i=-radius;i<=radius;i++) for(let j=-radius;j<=radius;j++) {
      const key=(tx+i)+':'+(tz+j);
      if(data.tiles[key]) wanted.add(key);
    }
    for(const [key,mesh] of active) if(!wanted.has(key)) {
      if(mesh) {group.remove(mesh);for(const child of mesh.children)child.geometry?.dispose();if(mesh.isInstancedMesh)mesh.dispose();else mesh.geometry.dispose();}
      active.delete(key);
    }
    for(const key of wanted) {
      if(active.has(key)) continue;
      const tile=data.tiles[key];
      batches=[];
      detailGeometry(tile);
      for(const run of tile.r||[]) if(!data.architecture.tiers?.[run[6]]) roof(run);
      for(const building of tile.b||[]) facade(building);
      const mesh=finish('Street details '+key);
      if(mesh){
        const signs=streetSignPanels(THREE,tile.p??[],data.signRecords,signMaterial);
        if(signs) mesh.add(signs);
        group.add(mesh);
      }
      active.set(key,mesh);
    }
    batches=[];
  }
  batches=[];
  return {group,update};
}
