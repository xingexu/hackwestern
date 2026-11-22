import * as THREE from 'three';
import {kerbProfile} from './pavement-profile.mjs';
import {placePavementFinishes,pavementMaterial} from './pavement-finish.mjs';

const colors = Object.fromEntries(Object.entries({
  asphalt: 0x677077, service: 0x717777, path: 0xc3bfb1, gravel: 0xa29a84, dirt: 0x988568,
  curb: 0xbcb8ac, curbSide: 0x999789, yellow: 0xd3b26a, white: 0xe0dfcf,
  steel: 0x777f7d, dark: 0x555e5b, stone: 0x99958c, gutter: 0x999d99
}).map(([name, hex]) => [name, new THREE.Color(hex)]));

function quad(batch, a, b, c, d, color, paving, farColor=color) {
  const first = batch.positions.length / 3;
  for (const [i,p] of [a,b,c,d].entries()) {
    batch.positions.push(...p);
    const tint=i===1||i===2?farColor:color;
    batch.colors.push(tint.r,tint.g,tint.b);
    batch.paving.push(...(paving?.[i]??[0,0,0]));
  }
  batch.indices.push(first,first+1,first+2,first,first+2,first+3);
}

function roadMaterial(carriageway) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 });
  material.customProgramCacheKey = () => 'campus-road-grain';
  material.onBeforeCompile = shader => {
    if(carriageway) {
      shader.uniforms.streetCoverage={value:carriageway.texture};
      shader.uniforms.streetBounds={value:new THREE.Vector4(...carriageway.bounds)};
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 roadPoint; varying vec3 pavementUV; attribute vec3 paving;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nroadPoint = position; pavementUV=paving;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 roadPoint; varying vec3 pavementUV; uniform sampler2D streetCoverage; uniform vec4 streetBounds;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${carriageway ? 'if(pavementUV.z>0.5 && pavementUV.z<4. && texture2D(streetCoverage,(roadPoint.xz-streetBounds.xy)/(streetBounds.zw-streetBounds.xy)).r>.52) discard;' : ''}
        vec2 cell = floor(roadPoint.xz * 16.);
        float grain = fract(sin(dot(mod(cell, 317.),vec2(12.9898,78.233))) * 43758.54);
        float close=1.-smoothstep(.035,.21,length(fwidth(roadPoint.xz)));
        float coarse=fract(sin(dot(mod(floor(roadPoint.xz*2.),317.),vec2(33.7,12.1)))*14435.);
        diffuseColor.rgb*=1.+(grain-.5)*.27*close+(coarse-.5)*.030*close;
        if(pavementUV.z>1.5 && pavementUV.z<4.) {
          vec2 uv=pavementUV.xy/(pavementUV.z>2.5?vec2(.23,.46):vec2(1.75,2.18));
          if(pavementUV.z>2.5) uv.x+=.5*mod(floor(uv.y),2.);
          vec2 edge=min(fract(uv),1.-fract(uv));
          vec2 joints=1.-smoothstep(vec2(.002),max(fwidth(uv),vec2(.019)),edge);
          float joint=max(joints.x,joints.y);
          diffuseColor.rgb*=1.-.31*joint*(1.-smoothstep(.1,.7,max(fwidth(uv).x,fwidth(uv).y)));
        }`);
    pavementMaterial(shader);
  };
  return material;
}

function roadTint(way) {
  if(/dirt|earth|ground|grass/.test(way.material)) return colors.dirt;
  if(/gravel|compacted/.test(way.material)) return colors.gravel;
  if(way.kind==='road') return way.class==='service'?colors.service:colors.asphalt;
  return way.material==='asphalt'?colors.service:colors.path;
}

function streetJoins(ways,network) {
  const junctions=new Map(), joins=new Map();
  for(const way of ways) for(const index of way.junctions) {
    if(way.bridge || way.kind==='steps') continue;
    const [x,y,z]=way.points[index], key=x+','+z+','+way.level;
    if(!junctions.has(key)) junctions.set(key,[]);
    const arms=junctions.get(key);
    for(const neighbor of [index-1,index+1]){
      if(neighbor<0 || neighbor>=way.points.length) continue;
      const p=way.points[neighbor], length=Math.hypot(p[0]-x,p[2]-z);
      if(!length) continue;
      arms.push({way,index,x,y,z,dx:(p[0]-x)/length,dz:(p[2]-z)/length,sign:neighbor>index?1:-1});
    }
  }
  for(const arms of junctions.values()) {
    if(arms.length!==2 || arms[0].way===arms[1].way) continue;
    const [a,b]=arms;
    const alignment=-a.dx*b.dx-a.dz*b.dz;
    if(alignment<.18) continue;
    const span=Math.max(a.way.width,b.way.width)/2;
    const tint=roadTint(a.way.width>=b.way.width?a.way:b.way);
    const height=(a.y+b.y)*.5;
    for(const [from,to] of [[a,b],[b,a]]) {
      const nx=from.sign*(from.dz-to.dz)/(1+alignment);
      const nz=from.sign*(to.dx-from.dx)/(1+alignment);
      const half=from.way.width/2;
      const left=Math.max(height-.15,network.groundAt(from.x-span*nx,from.z-span*nz)+.045);
      const right=Math.max(height-.15,network.groundAt(from.x+span*nx,from.z+span*nz)+.045);
      if(!joins.has(from.way)) joins.set(from.way,new Map());
      joins.get(from.way).set(from.index,{tint,at(offset,rise=0){
        const t=offset/half;
        return [from.x+span*nx*t,height+Math.abs(t)*((t<0?left:right)-height)+rise,from.z+span*nz*t];
      }});
    }
  }
  return joins;
}

function roadSegment(batch, way, frames, i, distance, junction, groundAt, joins) {
  const firstJoin=joins?.get(i), nextJoin=joins?.get(i+1);
  const a=firstJoin?.at??frames[i], b=nextJoin?.at??frames[i+1], half=way.width/2;
  const p=way.points[i],q=way.points[i+1];
  const length=Math.hypot(q[0]-p[0],q[2]-p[2]);
  const strip=(left,right,rise,color) => quad(batch,a(left,rise),b(left,rise),b(right,rise),a(right,rise),color);
  const paved=way.kind==='road';
  const tint=roadTint(way);
  const paving=way.bridge ? 0 : way.kind==='path' && ![colors.service,colors.gravel,colors.dirt].includes(tint)?(way.material==='paving_stones'?3:2):1;
  for(const [l,r] of [[-half,0],[0,half]]) {
    quad(batch,a(l),b(l),b(r),a(r),firstJoin?.tint??tint,[[l,distance,paving],[l,distance+length,paving],
      [r,distance+length,paving],[r,distance,paving]],nextJoin?.tint??tint);
  }
  for (const side of [-1,1]) {
    const edge=side*half;
    if(!way.bridge) {
      const p=a(edge),q=b(edge);
      const dropP=p[1]-groundAt(p[0],p[2]), dropQ=q[1]-groundAt(q[0],q[2]);
      if(Math.max(dropP,dropQ)>.4){
        const footP=a(edge+side*Math.max(.25,dropP)), footQ=b(edge+side*Math.max(.25,dropQ));
        footP[1]=groundAt(footP[0],footP[2])-.06;
        footQ[1]=groundAt(footQ[0],footQ[2])-.06;
        quad(batch,p,q,footQ,footP,colors.gravel);
      }
    }
    if (way.bridge) {
      quad(batch,a(edge,-.44),b(edge,-.44),b(edge,0),a(edge,0),colors.stone);
      for(const h of [.58,1.02]) {
        quad(batch,a(edge,h),b(edge,h),b(edge,h+.09),a(edge,h+.09),colors.steel);
        strip(edge-.075,edge+.075,h+.09,colors.steel);
      }
      const p=a(edge), q=b(edge);
      const len=Math.hypot(q[0]-p[0],q[2]-p[2]);
      const r=p.map((n,k)=>n+(q[k]-n)*Math.min(1,.11/Math.max(.1,len)));
      quad(batch,p,r,[r[0],r[1]+1.11,r[2]],[p[0],p[1]+1.11,p[2]],colors.dark);
    } else if (paved && !junction && way.class!=='service' && way.class!=='living_street') {
      quad(batch,a(edge),b(edge),b(edge,.10),a(edge,.10),colors.curbSide);
      strip(edge,edge+side*.20,.10,colors.curb);
      strip(edge-side*.21,edge,.012,colors.gutter);
    }
  }
  if (!paved || junction || way.lanes<2 || way.class==='service' || way.class==='residential') return;
  strip(-.075,.075,.023,colors.yellow);
  if (way.lanes>=4 && Math.floor(distance/5)%2===0) {
    for(const s of [-1,1]) strip(s*half*.50-.07,s*half*.50+.07,.024,colors.white);
  }
}

function elevatedSegment(batch,way,frames,i,distance,groundAt,panel,network) {
  const a=frames[i],b=frames[i+1],half=way.width/2;
  const start=way.points[i],end=way.points[i+1],length=Math.hypot(end[0]-start[0],end[2]-start[2]);
  function band(al,bl,ar,br,rise,color){
    quad(batch,a(al,rise),b(bl,rise),b(br,rise),a(ar,rise),color);
  }
  const tint=roadTint(way);
  for(const {points,walk} of panel.faces){
    quad(batch,...points,walk?colors.path:tint);
    network.addFace?.([points[0],points[1],points[2]],'bridge deck');
    network.addFace?.([points[0],points[2],points[3]],'bridge deck');
  }
  for(const skirt of panel.skirts){
    quad(batch,...skirt,colors.gravel);
    network.addFace?.([skirt[0],skirt[1],skirt[2]],'bridge approach');
    network.addFace?.([skirt[0],skirt[2],skirt[3]],'bridge approach');
  }
  for(const wall of panel.abutments){
    quad(batch,...wall,colors.stone);
    network.addFace?.([wall[0],wall[1],wall[2]],'bridge abutment');
    network.addFace?.([wall[0],wall[2],wall[3]],'bridge abutment');
  }
  const railStart=batch.positions.length;
  if(way.bridge) band(-half,-half,half,half,-.56,colors.stone);
  const roadBounds=[[],[]];
  for(const [index,side] of [-1,1].entries()){
    const edge=side*half, sa=a.sides[index],sb=b.sides[index];
    const innerA=side*half*(1-sa.walk/sa.span),innerB=side*half*(1-sb.walk/sb.span);
    roadBounds[0][index]=innerA;roadBounds[1][index]=innerB;
    if(sa.walk>.01 || sb.walk>.01){
      quad(batch,a(innerA),b(innerB),b(innerB,.12*b.weight),a(innerA,.12*a.weight),colors.curbSide);
    }
    const rim=way.kind==='path' || sa.walk>.01 ? .12 : 0;
    if(way.bridge){
      quad(batch,a(edge,-.56),b(edge,-.56),b(edge,rim),a(edge,rim),colors.stone);
      if(way.kind==='road' && sa.walk<=.01){
        quad(batch,a(edge-side*.34),b(edge-side*.34),b(edge-side*.16,.75),a(edge-side*.16,.75),colors.stone);
        band(edge-side*.16,edge-side*.16,edge,edge,.75,colors.curb);
        quad(batch,a(edge),b(edge),b(edge,.75),a(edge,.75),colors.curbSide);
      }else{
        band(edge-side*.23,edge-side*.23,edge,edge,rim+.13,colors.curb);
        quad(batch,a(edge-side*.23,rim),b(edge-side*.23,rim),b(edge-side*.23,rim+.13),a(edge-side*.23,rim+.13),colors.curbSide);
        for(const h of [.60,1.06]){
          quad(batch,a(edge,h+rim),b(edge,h+rim),b(edge,h+.075+rim),a(edge,h+.075+rim),colors.steel);
          band(edge-side*.075,edge-side*.075,edge,edge,h+.075+rim,colors.steel);
        }
        const posts=Math.max(1,Math.round(length/2.6));
        for(let k=0;k<posts;k++){
          const t=k/posts,u=t+.115/length;
          const corners=[panel.at(t,edge,edge),panel.at(u,edge,edge),panel.at(u,edge-side*.11,edge-side*.11),panel.at(t,edge-side*.11,edge-side*.11)];
          for(let j=0;j<4;j++){
            const p=corners[j],q=corners[(j+1)%4];
            quad(batch,p,q,[q[0],q[1]+1.14+rim,q[2]],[p[0],p[1]+1.14+rim,p[2]],colors.steel);
          }
        }
      }
    }
  }
  if(network.addFace)for(let k=railStart;k<batch.positions.length;k+=12){
    const points=[0,3,6,9].map(d=>batch.positions.slice(k+d,k+d+3));
    network.addFace([points[0],points[1],points[2]],'bridge structure');
    network.addFace([points[0],points[2],points[3]],'bridge structure');
  }
  if(way.kind!=='road') return;
  const lanes=a.lanes??way.lanes;
  for(let lane=1;lane<lanes;lane++){
    const center=!way.oneway && lane===Math.floor(lanes/2);
    const ta=lane/lanes;
    const offsetA=roadBounds[0][0]+(roadBounds[0][1]-roadBounds[0][0])*ta;
    const offsetB=roadBounds[1][0]+(roadBounds[1][1]-roadBounds[1][0])*ta;
    const line=(t,offset)=>{
      return panel.at(t,offsetA+offset,offsetB+offset,.018);
    };
    for(let cursor=0;cursor<length-.0001;){
      const phase=(distance+cursor)%9;
      const stop=Math.min(length,cursor+1.1,center?length:cursor+(phase<3?3-phase:9-phase)+.00001);
      if(center||phase<3){
        const l=cursor/length,r=stop/length;
        quad(batch,line(l,-.068),line(r,-.068),line(r,.068),line(l,.068),center?colors.yellow:colors.white);
      }
      cursor=stop;
    }
  }
}

export function createCampusRoads(data, network, carriageway) {
  const group=new THREE.Group(), tiles=new Map(), size=112;
  const material=roadMaterial(carriageway);
  function tileAt(x,z) {
    const col=Math.floor(x/size), row=Math.floor(z/size), key=col+','+row;
    if (!tiles.has(key)) tiles.set(key,{col,row,parts:[],mesh:null});
    return tiles.get(key);
  }
  const joins=streetJoins(data.ways,network);
  for(const border of carriageway?.curbs??[]) {
    for(let i=0;i<border.length-2;i+=2) {
      const x=border[i],z=border[i+1],ex=border[i+2],ez=border[i+3];
      const len=Math.hypot(ex-x,ez-z);
      if(len<.04) continue;
      const step=network.nearOpening(x,z)||network.nearOpening(ex,ez)||len>20?1.1:3.2;
      const count=Math.max(1,Math.ceil(len/step));
      const nx=(ez-z)/len, nz=(x-ex)/len;
      for(let k=0;k<count;k++){
        const t=k/count,u=(k+1)/count, ax=x+(ex-x)*t,az=z+(ez-z)*t,bx=x+(ex-x)*u,bz=z+(ez-z)*u;
        const mx=(ax+bx)/2,mz=(az+bz)/2;
        if(network.isDeck(mx,mz)) continue;
        const leftPaved=carriageway.contains(mx+nx*.85,mz+nz*.85),rightPaved=carriageway.contains(mx-nx*.85,mz-nz*.85);
        if(leftPaved===rightPaved) continue;
        const inward=leftPaved?1:-1;
        const lo=network.kerbFactor(ax,az),hi=network.kerbFactor(bx,bz);
        network.addKerb(ax,az,bx,bz,nx*inward,nz*inward,lo,hi);
        tileAt(mx,mz).parts.push(batch=>{
          const edge=(px,pz,width,rise)=>{
            const vx=px+nx*width*inward,vz=pz+nz*width*inward;
            return [vx,network.groundAt(vx,vz)+rise,vz];
          };
          for(const [outer,inner,material] of [[-.16,.005,colors.curb],[.005,.031,colors.curb],[.031,.055,colors.curbSide],[.055,.26,colors.gutter]]){
            quad(batch,edge(ax,az,outer,kerbProfile(outer,lo)),edge(bx,bz,outer,kerbProfile(outer,hi)),
              edge(bx,bz,inner,kerbProfile(inner,hi)),edge(ax,az,inner,kerbProfile(inner,lo)),material);
          }
        });
      }
    }
  }
  placePavementFinishes(data.pavementSurvey,network,tileAt,quad,colors);
  const decks={positions:[],colors:[],indices:[],paving:[]};
  for(const way of data.ways) {
    if(way.onDeck) continue;
    const frames=network.frames(way);
    const junctions=new Set(way.junctions);
    let distance=0;
    for(let i=0;i<frames.length-1;i++) {
      const a=way.points[i], b=way.points[i+1];
      const nearJunction=junctions.has(i)||junctions.has(i+1);
      const at=distance;
      if(carriageway && !way.bridge && way.level===0 && !network.approach?.(way,i)) continue;
      const draw=batch=>roadSegment(batch,way,frames,i,at,nearJunction,network.groundAt,joins.get(way));
      if(way.bridge || network.approach(way,i)) elevatedSegment(decks,way,frames,i,at,network.groundAt,network.deckPanel(way,i),network);
      else tileAt((a[0]+b[0])/2,(a[2]+b[2])/2).parts.push(draw);
      distance+=Math.hypot(b[0]-a[0],b[2]-a[2]);
    }
  }
  for(const [kind, points] of data.barriers) {
    if(!['guard_rail','wall','retaining_wall'].includes(kind)) continue;
    for(let i=0;i+3<points.length;i+=2){
      const [x,z,ex,ez]=points.slice(i,i+4), length=Math.hypot(ex-x,ez-z);
      const count=Math.max(1,Math.ceil(length/3.5));
      for(let j=0;j<count;j++){
        const t=j/count, u=(j+1)/count;
        const ax=x+(ex-x)*t, az=z+(ez-z)*t, bx=x+(ex-x)*u, bz=z+(ez-z)*u;
        const h1=network.groundAt(ax,az), h2=network.groundAt(bx,bz);
        const rail=kind==='guard_rail', low=rail ? .55 : -.1, high=rail ? .84 : 1.1;
        tileAt(ax,az).parts.push(batch=>{
          quad(batch,[ax,h1+low,az],[bx,h2+low,bz],[bx,h2+high,bz],[ax,h1+high,az],rail?colors.steel:colors.stone);
          if(rail) quad(batch,[ax,h1,az],[ax+(bx-ax)*.04,h1,az+(bz-az)*.04],
            [ax+(bx-ax)*.04,h1+.80,az+(bz-az)*.04],[ax,h1+.80,az],colors.dark);
        });
      }
    }
  }
  function makeMesh(batch){
    const geom=new THREE.BufferGeometry();
    geom.setAttribute('position',new THREE.Float32BufferAttribute(batch.positions,3));
    geom.setAttribute('color',new THREE.Float32BufferAttribute(batch.colors,3));
    geom.setAttribute('paving',new THREE.Float32BufferAttribute(batch.paving,3));
    geom.setIndex(batch.indices);
    geom.computeVertexNormals();
    const mesh=new THREE.Mesh(geom,material);
    mesh.receiveShadow=true;
    return mesh;
  }
  const bridgeMesh=makeMesh(decks);
  bridgeMesh.name='Bridge decks and approaches';
  group.add(bridgeMesh);
  const resident=new Set();
  function update(x,z,distance) {
    const range=distance>750 ? 0 : distance>300 ? 195 : 250;
    let changed=false;
    const visible=new Set();
    if(range) {
      for(let col=Math.floor((x-range)/size); col<=Math.floor((x+range)/size); col++)
        for(let row=Math.floor((z-range)/size); row<=Math.floor((z+range)/size); row++){
          const tile=tiles.get(col+','+row);
          if(tile) visible.add(tile);
        }
    }
    for(const tile of resident) if(!visible.has(tile)){
      tile.mesh.geometry.dispose();
      group.remove(tile.mesh);
      tile.mesh=null;
      resident.delete(tile);
      changed=true;
    }
    for(const tile of visible) if(!tile.mesh){
      const batch={positions:[],colors:[],indices:[],paving:[]};
      for(const part of tile.parts) part(batch);
      tile.mesh=makeMesh(batch);
      group.add(tile.mesh);
      resident.add(tile);
      changed=true;
    }
    return changed;
  }
  return {group,update};
}
