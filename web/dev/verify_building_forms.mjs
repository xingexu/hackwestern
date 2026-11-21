import './building_test_imports.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';

const {fitArchitecture,architectureMesh,retireSurveyedArchitecture}=await import('campus-buildings');
const {buildArchitecture}=await import('building-kernel');
const read=name=>JSON.parse(readFileSync(new URL('../'+name+'.json',import.meta.url)));
const records=read('campus-buildings'),features=read('region-detail'),byId=new Map(records.map(r=>[r.id,r]));
const ray=new THREE.Raycaster(),up=new THREE.Vector3(0,1,0);
function mesh(records,level=2){
  const result=architectureMesh(buildArchitecture(records,level));
  result.updateMatrixWorld(true);
  return result;
}
function hit(model,x,y,z,dx,dy,dz){
  ray.set(new THREE.Vector3(x,y,z),new THREE.Vector3(dx,dy,dz));ray.far=90;
  return ray.intersectObject(model,true)[0]?.distance??Infinity;
}
function covers(ring,x,z){
  let inside=false;
  for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
    if((ring[i+1]>z)!==(ring[j+1]>z) && x<(ring[j]-ring[i])*(z-ring[i+1])/(ring[j+1]-ring[i+1])+ring[i])inside=!inside;
  }
  return inside;
}
const oldStands=features.macro.filter(([kind])=>kind==='grandstand');
assert.deepEqual(oldStands.map(row=>row[1]).sort(),[142216970,142216972]);
retireSurveyedArchitecture(features,records);
assert.equal(features.landmarks.length,0);
assert.ok(!features.macro.some(([kind,id])=>kind==='lidar'||kind==='grandstand'&&byId.has('w'+id)));
assert.ok(!Object.values(features.tiles).some(t=>t.b||t.r));
assert.ok(features.macro.some(([kind])=>kind==='canadian_football'));
for(const [,id] of oldStands){
  const stand=byId.get('w'+id),solids=fitArchitecture([stand],()=>0);
  const model=mesh([stand]),rows=stand.parts.filter(p=>/^seating row/i.test(p.name)).slice(-5);
  let clear=0,total=0;
  for(const row of rows){
    const ring=row.rings[0],ends=ring.map((a,i)=>[a,ring[(i+1)%ring.length]]).sort(([a,b],[c,d])=>Math.hypot(c[0]-d[0],c[1]-d[1])-Math.hypot(a[0]-b[0],a[1]-b[1]))[0];
    const mid=ends[0].map((v,k)=>(v+ends[1][k])*.5);
    for(let i=1;i<=23;i++){
      const x=row.center[0]+(ends[1][0]-mid[0])*(i/12-1),z=row.center[1]+(ends[1][1]-mid[1])*(i/12-1);
      if(!covers(row.rings[0].flat(),x,z))continue;
      const blocked=solids.some(([lo,hi,loops])=>lo<1.7 && hi>.28 && covers(loops[0],x,z) && !loops.slice(1).some(r=>covers(r,x,z)));
      const headroom=hit(model,x,.28,z,0,1,0);
      total++;
      if(!blocked && headroom>2.1 && headroom<row.high+.4)clear++;
    }
  }
  assert.ok(total>=45 && clear/total>.78,`Stand ${id}: ${clear}/${total} open, roofed undercroft probes`);
  for(const aisle of stand.spec.attachments.filter(a=>a.type==='exterior-stair')){
    const [a,c]=aisle.path;
    let clear=0;
    for(const t of [.70,.74,.78,.82,.86,.90]){
      const x=a[0]*(1-t)+c[0]*t,z=a[1]*(1-t)+c[1]*t;
      const blocked=solids.some(([lo,hi,loops])=>lo<1.8 && hi>1.2 && covers(loops[0],x,z));
      if(!blocked && hit(model,x,.45,z,0,1,0)>2.2)clear++;
    }
    assert.ok(clear>=4,`Stand ${id} aisle at ${a} has only ${clear}/6 clear undercroft probes`);
  }
  console.log(id,clear+'/'+total,'open grandstand probes');
}
const porch=byId.get('w778714502'),entry=porch.spec.entrances[0];
const grade=(x,z)=>12+(z-entry.gradePoint[1])*.29;
fitArchitecture([porch],grade);
const canopy=porch.parts.find(p=>/open porch gable/i.test(p.name)),deck=porch.spec.attachments.find(a=>a.type==='terrace');
const target=mesh([porch]),center=canopy.center,x=center[0],z=center[1],surface=grade(x,z);
const clearance=hit(target,x,surface+.55,z,...up.toArray());
assert.ok(clearance>1.15 && clearance<3.6,`Porch soffit above grade ${clearance}`);
assert.ok(deck.gradeEntry===0 && Math.abs(porch.ground-grade(...entry.gradePoint))<.02);
const b=byId.get('w310132539'),gym=b.parts.find(p=>p.name==='Upper gym');
const colored=mesh([{...b,parts:[gym]}]);
assert.ok(colored.children.length>=2);
const packet=buildArchitecture([{...b,parts:[gym]}],2);
const styles=new Set(packet.styles);
assert.ok([...styles].some(i=>packet.palette[i].kind==='corrugated-metal') && [...styles].some(i=>packet.palette[i].color===b.spec.materials.southMasonry.color));
const hospital=byId.get('r21319536-0'),fascia=hospital.parts.find(p=>p.facade.fasciaBeam);
const beams=buildArchitecture([{...hospital,parts:[fascia],spec:{...hospital.spec,towers:[],attachments:[],entrances:[],roof:{}}}],2).boxes;
let deep=0;
for(let i=0;i<beams.length;i+=8)if(beams[i+3]>1 && beams[i+3]<3.5 && Math.abs(beams[i+4]-(fascia.high-fascia.low))<.01 && beams[i+5]>.45)deep++;
assert.ok(deep>=8,'Hospital segmented concrete beam fascia');
console.log(deep,'deep fascia segments, roofed porch clearance',clearance.toFixed(2));
const fixture={
  id:'shop',ground:0,walls:[{a:[0,0],b:[12,0],normal:[0,-1]}],entranceEdges:['0:0:0'],entryGround:[0],
  spec:{floors:{count:1},entrances:[{wall:0,position:.5,boundAlong:6,width:1.8,height:2.2,type:'doors-double'}],walls:{default:{bays:{count:1,edgeMargin:.2},windows:{type:'storefront'}}},materials:{wall:{kind:'brick',color:'#a99880'},trim:{kind:'painted-metal',color:'#d1c1a8'}},roof:{form:'flat'}},
  parts:[{name:'Storefront',low:0,high:4.2,floors:1,rings:[[[0,0],[12,0],[12,6],[0,6]]],wallIds:[[0,-1,-1,-1]],surface:[[[0,0,0],[12,0,0],[12,0,6],[0,0,6]],[0,1,2,0,2,3]],roof:{form:'flat'},facade:{}}]
};
const shop=buildArchitecture([fixture],2);
function panels(packet,kind){
  const panels=[];
  for(let i=0;i<packet.index.length;i+=3){
    const t=packet.index.slice(i,i+3);
    if(packet.palette[packet.styles[t[0]]].kind!==kind)continue;
    panels.push(Array.from(t,j=>Array.from(packet.positions.slice(j*3,j*3+3))));
  }
  return panels;
}
const front=panels(shop,'glazing').filter(t=>t.every(([x,y,z])=>Math.abs(z)<.5));
for(const x of [3,9])assert.ok(front.some(t=>Math.min(...t.map(p=>p[0]))<x && x<Math.max(...t.map(p=>p[0]))),'Storefront sidelights survive the doorway');
const doorFaces=panels(shop,'door');
assert.ok(doorFaces.some(t=>t.some(([x])=>x>5.8 && x<7.1)));
fixture.spec.entrances=[];
fixture.spec.walls.default.windows={type:'oriel',width:4,height:2.4,projection:.72};
assert.ok(panels(buildArchitecture([fixture],2),'glazing').some(t=>t.every(p=>p[2]<-.70)),'Oriel has a projected glazed face');
fixture.spec.walls.default.windows={type:'curtain-wall',width:4,rake:-.76};
assert.ok(panels(buildArchitecture([fixture],2),'glazing').some(t=>Math.max(...t.map(p=>p[2]))-Math.min(...t.map(p=>p[2]))>.65),'Raked glass changes depth over its height');
const court=byId.get('r7379137');
assert.ok(court.parts.reduce((n,p)=>n+(p.courtyardEdges?.length??0),0)>25,'Split massing bounds the Ivey court');
const london=byId.get('w119875060'),londonMesh=buildArchitecture([london],2);
assert.ok(londonMesh.palette.some(m=>m.color===london.spec.materials.spandrel.color));
console.log('Storefront sidelights, projecting and raked glass, split courtyard edges and spandrel finishes');
const somerville=byId.get('w142216964'),tower=somerville.spec.towers[0];
const turret=mesh([{...somerville,parts:[],spec:{...somerville.spec,attachments:[],entrances:[]}}]);
const angle=tower.rotation*Math.PI/180,tx=Math.cos(angle),tz=Math.sin(angle),nx=-tz,nz=tx;
function parapetRay(offset){
  const distance=tower.size[1]/2+1;
  return hit(turret,tower.at[0]+tx*offset+nx*distance,somerville.ground+tower.height-.48,tower.at[1]+tz*offset+nz*distance,-nx,0,-nz);
}
for(const t of [-1/3,0,1/3])assert.ok(parapetRay(tower.size[0]*t)>tower.size[1],'Somerville parapet opening');
for(const t of [-1/6,1/6])assert.ok(parapetRay(tower.size[0]*t)<1.7,'Somerville parapet pier');
const cross=porch.parts.find(p=>p.name.includes('Central pointed cross gable'));
const lancet=panels(buildArchitecture([{...porch,parts:[cross],spec:{...porch.spec,entrances:[],attachments:[],towers:[],roof:{}}}],2),'glazing');
assert.ok(lancet.some(t=>t.every(p=>p[1]>porch.ground+cross.high+.28) && t.some(p=>p[1]>porch.ground+cross.high+1.22)),'Cross-gable has a glazed upper sash above the eaves');
const ends=byId.get('w123525190').parts.filter(p=>p.name.startsWith('Townhouse pair'));
assert.ok(ends.length>=4);
for(const part of ends){
  const angle=(part.roof.ridge-90)*Math.PI/180,tx=Math.cos(angle),tz=Math.sin(angle);
  const bounds=(points,dx,dz)=>Math.max(...points.map(([x,z])=>x*dx+z*dz));
  const walls=part.rings[0],roof=part.surface[0].map(([x,y,z])=>[x,z]);
  for(const sign of [-1,1]){
    const rake=bounds(roof,sign*tx,sign*tz)-bounds(walls,sign*tx,sign*tz);
    const eave=bounds(roof,-sign*tz,sign*tx)-bounds(walls,-sign*tz,sign*tx);
    assert.ok(rake<.055 && eave>.30,'Shingles clear the capped townhouse crosswalls and shelter the eaves');
  }
}
console.log('Glazed cross-gable sash and measured capped rake/eave clearances');
const cottage=porch.parts[0],id=cottage.wallIds[0].indexOf(1),a=cottage.rings[0][id],c=cottage.rings[0][(id+1)%cottage.rings[0].length];
const length=Math.hypot(c[0]-a[0],c[1]-a[1]),dx=(c[0]-a[0])/length,dz=(c[1]-a[1])/length;
const groundWindows=panels(buildArchitecture([{...porch,parts:[cottage],spec:{...porch.spec,attachments:[],towers:[],roof:{}}}],2),'glazing').filter(t=>t.every(([x,y,z])=>Math.abs((x-a[0])*dz-(z-a[1])*dx)<.3 && y>porch.ground+.4 && y<porch.ground+2.8));
for(const along of [.175,.825])assert.ok(groundWindows.some(t=>{
  const positions=t.map(([x,y,z])=>((x-a[0])*dx+(z-a[1])*dz)/length);
  return Math.min(...positions)<along && Math.max(...positions)>along;
}),'Each flanking ground-floor sash uses the full measured house front');
