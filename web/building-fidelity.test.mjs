import './dev/building_test_imports.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Raycaster,Vector3} from 'three';

const {buildArchitecture}=await import('building-kernel');

const {fitArchitecture,architectureMesh,retireSurveyedArchitecture}=await import('campus-buildings');
const buildings=JSON.parse(readFileSync(new URL('./campus-buildings.json',import.meta.url)));
const byId=new Map(buildings.map(b=>[b.id,b]));
const solids=b=>fitArchitecture([b],()=>0);
function faces(packet,match){
  const triangles=[];
  for(let j=0;j<packet.index.length;j+=3){
    const a=packet.index[j];
    if(!match(packet.palette[packet.styles[a]]))continue;
    triangles.push(Array.from(packet.index.slice(j,j+3),i=>Array.from(packet.positions.slice(i*3,i*3+3))));
  }
  return triangles;
}
const preview=structuredClone(byId.get('w147379460')),driving=structuredClone(preview);
const slope=(x,z)=>(x+z)*.006;
fitArchitecture([preview],slope,[],false);
fitArchitecture([driving],slope);
assert.deepEqual(buildArchitecture([preview],2),buildArchitecture([driving],2),'Preview geometry must match driving geometry at the same grade');
const portal=byId.get('w141710486');
solids(portal);
const plaza=buildArchitecture([portal],2);
const copperGlass=portal.spec.walls.byWall[18].windows.glassColor;
const arch=faces(plaza,m=>m.kind==='glazing' && m.color===copperGlass).flat();
assert.ok(arch.length>20,'Plaza arch missing');
const elevation=arch.map(v=>v[1]);
const perimeter=portal.walls[18],axis=perimeter.normal;
const span=arch.map(([x,,z])=>x*axis[1]-z*axis[0]);
assert.ok(Math.max(...span)-Math.min(...span)>7.8 && Math.max(...elevation)-Math.min(...elevation)>6.8,'One tall arch must span both survey edges');
const pressure=architectureMesh(plaza).children.filter(m=>m.isInstancedMesh && m.geometry.getAttribute('instanceProfile'));
assert.ok(pressure.some(m=>m.geometry.getAttribute('instanceProfile').array.includes(1)) && pressure.some(m=>m.geometry.getAttribute('instanceProfile').array.includes(2)),'Mullions and transoms require separate profiled axes');
const garage=byId.get('w142286181'),contacts=solids(garage),deck=garage.parts.find(p=>p.deckStructure?.posts.length>4);
assert.ok(deck && deck.deckStructure.spans.length>2);
const [x,z]=deck.deckStructure.posts[0];
assert.ok(contacts.surfaceContact(x+.27,z,.55,1.4,.2),'Visible interior column must block the car');
const [bx,bz]=deck.deckStructure.spans[0];
assert.ok(!contacts.surfaceContact(bx,bz,.55,1.4,.1),'Beam bay must have clear driving space');
const steel=buildArchitecture([garage],2);
assert.ok(faces(steel,m=>m.surface==='picket').some(t=>Math.max(...t.map(v=>v[1]))-Math.min(...t.map(v=>v[1]))>.4),'Curved upper picket fence missing');
const concretePiers=garage.parts.filter(p=>/concrete pier/i.test(p.name));
assert.equal(concretePiers.length,3);
const pierMesh=architectureMesh(steel);
pierMesh.updateMatrixWorld(true);
for(const pier of concretePiers){
  const [x,z]=pier.center;
  const probe=new Raycaster(new Vector3(x,-1,z),new Vector3(0,1,0),0,1.2);
  assert.ok(probe.intersectObject(pierMesh,true).some(hit=>Math.abs(hit.point.y+.1)<.01),'Concrete stair pier lacks its footing at grade');
}
const hospital=byId.get('r21319537-0');
const contact=solids(hospital),front=hospital.parts.find(p=>p.openSoffit),door=hospital.spec.entrances.find(e=>e.type==='garage' && e.boundEdge.startsWith(hospital.parts.indexOf(front)+':'));
assert.ok(front && door);
const [gx,gz]=door.gradePoint;
assert.ok(!contact.surfaceContact(gx,gz,.45,1.55,.22),'Drive-in opening has solid geometry at car height');
const [nx,nz]=hospital.walls[door.wall].normal;
const ray=new Raycaster(new Vector3(gx-1.35*nx,1.5,gz-1.35*nz),new Vector3(0,1,0));
const garageModel=architectureMesh(buildArchitecture([hospital],2));
garageModel.updateMatrixWorld(true);
assert.ok(ray.intersectObject(garageModel,true).some(h=>h.distance>.5 && h.distance<4),'Drive-in opening lacks its overhead slab');
const gym=byId.get('w310132539');
solids(gym);
assert.ok(buildArchitecture([gym],2).palette.some(m=>m.surface==='drain-grate'),'Surveyed roof strainers must have their own roof finish');
const upper=gym.parts.find(p=>p.name==='Upper gym'),other=gym.parts.find(p=>p.name==='Set-back eastern upper gym');
const edge=upper.rings[0].filter(p=>other.rings[0].some(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<.02));
assert.equal(edge.length,2);
const middle=edge[0].map((v,i)=>(v+edge[1][i])/2);
const roof=architectureMesh(buildArchitecture([gym],2));roof.updateMatrixWorld(true);
ray.set(new Vector3(middle[0],upper.high+2,middle[1]),new Vector3(0,-1,0));
assert.ok(ray.intersectObject(roof,true)[0].distance>1.96,'Raised parapet divides the two equal-height gym roofs');
const gallery=byId.get('r7379137'),court=gallery.parts.find(p=>p.name==='Low courtyard rooflight bay');
assert.ok(court.roof.features.some(f=>f.type==='skylight'));
const part={...court,roof:{...court.roof,material:'glass'}};
const single={...gallery,parts:[part],spec:{...gallery.spec,towers:[],entrances:[],attachments:[]}};
const glazed=buildArchitecture([single],2);
assert.ok(faces(glazed,m=>m.kind==='glass-curtain' && m.roofSurface).length>=2);
assert.ok(glazed.boxes.length>0);
const budget=72;
const rectangle=(x,w=9)=>{
  const ring=[[x,0],[x+w,0],[x+w,6],[x,6]];
  return {name:'Wing',center:[x+w/2,3],rings:[ring],wallIds:[[-1,-1,-1,-1]],low:0,high:6,floors:2,facade:{blank:true},roof:{form:'flat',features:[]},surface:[ring.map(([x,z])=>[x,0,z]),[0,1,2,0,2,3]]};
};
const wings=[rectangle(0),rectangle(9)],test={...single,ground:0,foundation:-.5,bounds:[0,0,18,6],farBudget:budget,parts:wings};
const stack=rectangle(0);
stack.facade={material:'wall',bays:{count:3},windows:{type:'punched',width:1.4,height:1.5,sill:.78,perBay:1,recess:.3},verticalSpandrels:{material:'#695c50',every:1,width:1.4,recess:.24}};
const stackRecord={...test,parts:[stack],spec:{...test.spec,walls:{default:stack.facade},floors:{count:2,floorHeight:3,groundFloorHeight:3}}};
const stackMesh=architectureMesh(buildArchitecture([stackRecord],2));
stackMesh.updateMatrixWorld(true);
const intoFacade=(x,y)=>new Raycaster(new Vector3(x,y,-1),new Vector3(0,0,1),0,3).intersectObject(stackMesh,true)[0]?.distance;
assert.ok(Math.abs(intoFacade(4.15,.45)-1.24)<.005,'Spandrel must sit 24 cm inside the masonry opening');
assert.ok(Math.abs(intoFacade(3.25,.45)-1)<.005,'Masonry pier must remain at the surveyed face');
const narrow=rectangle(0);
narrow.rings[0]=[[0,0],[9,0],[9,1.1],[0,1.1]];
narrow.facade={...stack.facade,verticalSpandrels:undefined,windows:{...stack.facade.windows,recess:.33}};
const narrowModel=architectureMesh(buildArchitecture([{...stackRecord,parts:[narrow]}],2));
narrowModel.updateMatrixWorld(true);
for(const [z,direction] of [[-1,1],[2.1,-1]]){
  const sight=new Raycaster(new Vector3(4.27,1.54,z),new Vector3(0,0,direction));
  const hits=sight.intersectObject(narrowModel,true).filter(h=>!h.object.isInstancedMesh);
  assert.ok(hits.length>1 && hits[0].object.material.transparent && !hits[1].object.material.transparent,'A thin projecting bay must present glazing before its interior lining on both elevations');
}
const upperGalleries=gallery.parts.filter(p=>p.name.includes('standing-seam slope'));
assert.ok(upperGalleries.filter(p=>p.courtyardEdges?.length).length>=2,'Terraced courtyard must expose glazing on both upper galleries');
const supply=rectangle(0,21);
supply.roof.features=[{type:'hvac',center:[10,3],style:'exhaust duct',size:[12,.9,.8],rotation:0}];
const supplyMesh=architectureMesh(buildArchitecture([{...stackRecord,parts:[supply]}],2));
supplyMesh.updateMatrixWorld(true);
for(const x of [4.3,15.7]){
  const end=new Raycaster(new Vector3(x,8,3),new Vector3(0,-1,0)).intersectObject(supplyMesh,true)[0];
  assert.ok(end && end.point.y>6.74,'Both ends of the measured 12 m exhaust duct must rise above the roof');
}
supply.roof.features=[{type:'hvac',pipePath:[[3,1],[7,1],[7,4]],diameter:.48,height:1,material:'trim'}];
const pipes=architectureMesh(buildArchitecture([{...stackRecord,parts:[supply]}],2));
pipes.updateMatrixWorld(true);
for(const [x,z] of [[4,1],[7,1],[7,3]]){
  ray.set(new Vector3(x,9,z),new Vector3(0,-1,0));
  const hit=ray.intersectObject(pipes,true)[0];
  assert.ok(hit && Math.abs(hit.point.y-7.24)<.04,'Exposed laboratory duct must remain continuous around its elbow');
}
ray.set(new Vector3(5.5,9,2.8),new Vector3(0,-1,0));
assert.ok(ray.intersectObject(pipes,true)[0].point.y<6.1,'Pipework must leave the service aisle open');
let far=buildArchitecture([test],0);
const roofTriangles=faces(far,m=>m.roofSurface);
assert.equal(roofTriangles.length,2,'Two adjacent flat roofs with a shared edge should form one plane');
assert.ok(roofTriangles.flat().every(v=>v[1]===6));
const allPoints=roofTriangles.flat();
assert.equal(Math.max(...allPoints.map(v=>v[0]))-Math.min(...allPoints.map(v=>v[0])),18);
wings[0].roof.features=Array.from({length:1200},(_,i)=>({type:'hvac',count:64,at:[.01*i%8+.2,1+i%4],size:i%2?[.45,.6,1.2]:[2.8,2.25,1.3]}));
far=buildArchitecture([test],0);
assert.ok(far.index.length/3+far.boxes.length*1.5<=budget,'Survey equipment overflowed the assigned far budget');
assert.ok(faces(far,m=>m.roofSurface).flat().some(v=>v[0]===18),'Equipment displaced the massing at the far LOD');
const audited=new Map(buildings.map(b=>[b.id,b]));
const gazebo=audited.get('c2729'),site={landmarks:[],macro:[],tiles:{a:{p:[['shelter',0,239.845,0,-204.751],['entrance',0,233.821,0,-232.336],['entrance',0,240.325,0,-215.426],['shelter',0,99999,0,99999]]}}};
retireSurveyedArchitecture(site,buildings);
assert.equal(site.tiles.a.p.length,1);
assert.equal(site.tiles.a.p[0][2],99999);
assert.ok(gazebo);
const library=audited.get('w118764108');
assert.ok(library.parts.reduce((count,p)=>count+(p.soffitRibs?.length??0),0)>15,'Cantilever must cast individual coffer shadows');
const socialScience=audited.get('w141710484');
fitArchitecture([socialScience],(x,z)=>.004*x+.008*z);
const roofGlazing=faces(buildArchitecture([socialScience],2),m=>m.kind==='glass-block' && m.color===socialScience.spec.materials.roofglass.color);
assert.ok(roofGlazing.some(t=>t.every(([x,,z])=>x>138 && x<151 && z>190 && z<202)),'SSC rooflight must retain its surveyed opal block finish');
const ramp=socialScience.spec.attachments.find(a=>a.type==='ramp');
const toeGrade=.004*ramp.path[0][0]+.008*ramp.path[0][1];
assert.ok(Math.abs(ramp.stairLevels[0]-toeGrade-.035)<.001);
assert.ok(Math.abs(ramp.stairLevels.at(-1)-ramp.stairLevels[0]-ramp.height)<.001);
const bikeShelter=byId.get('w778714547'),canopy=bikeShelter.parts[0];
const stations=canopy.roof.ribStations;
assert.ok(stations.length>=5);
for(const [i,[left,right]] of stations.entries()){
  const [x,h,z]=canopy.surface[0][i*9+4];
  assert.ok(Math.hypot(x-(left[0]+right[0])/2,z-(left[1]+right[1])/2)<.01 && Math.abs(h-canopy.roof.rise)<.005,'Each shelter rib must follow the curved centreline');
}
const power=byId.get('w213344476');
solids(power);
const fans=architectureMesh(buildArchitecture([power],2));fans.updateMatrixWorld(true);
for(const [x,z] of [[246.0,559.3],[250.0,558.2],[257.7,556.4],[261.6,555.35]]){
  ray.set(new Vector3(x,25,z),new Vector3(0,-1,0));
  assert.ok(ray.intersectObject(fans,true)[0]?.point.y>14.32,'Northern cooling fan bank missing from its surveyed roof');
}
const lodge=byId.get('w119875065'),teal=lodge.spec.materials.coping.color;
const mansard=lodge.parts.find(p=>p.roof.form==='mansard');
for(const level of [0,2]){
  const roof=buildArchitecture([{...lodge,parts:[mansard]}],level);
  assert.ok(faces(roof,m=>m.kind==='standing-seam-metal' && m.color===teal).length>2,'Mansard skirt must carry its metal perimeter finish');
}
for(const [id,x,z] of [['w126668339',-232.5,-99.5],['w126668340',-285.5,-94.5]]){
  const residence=byId.get(id);
  solids(residence);
  for(const level of [1,2]){
    const balcony=architectureMesh(buildArchitecture([residence],level));
    balcony.updateMatrixWorld(true);
    ray.set(new Vector3(x,12,z),new Vector3(0,-1,0));
    assert.ok(ray.intersectObject(balcony,true).every(hit=>hit.point.y<7.4 || hit.point.y>8.5),'Storey cornice projects beyond the surveyed balcony cover');
  }
}
const gambrel=byId.get('w119875057');
const overhangs=fitArchitecture([gambrel],()=>0,[{bridge:true,points:[[-95,15,1100]]}]);
const apartments=architectureMesh(buildArchitecture([gambrel],2));apartments.updateMatrixWorld(true);
for(const [ex,ez] of [[-78.388,1103.043],[-59.9127,1088.555]]){
  ray.set(new Vector3(ex,27,ez),new Vector3(0,-1,0));
  const eave=ray.intersectObject(apartments,true)[0]?.point.y;
  assert.ok(eave>9 && eave<14);
  assert.equal(overhangs.surfaceContact(ex,ez,.2,1.5,.03),false,'Clear car path under the gambrel roof blocked at road height');
  assert.ok(overhangs.surfaceContact(ex,ez,eave-.2,eave+.2,.03),'Projected roof cannot be driven through at its own height');
}
console.log('Facade relief, physical glazing bars, both rooflight types, garage clearance, merged far shells, hard budget, duplicated shelter retirement, coffer beams and ramp gradient verified');
