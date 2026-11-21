import './building_test_imports.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Raycaster,Vector3} from 'three';
import {buildArchitecture} from '../building-kernel.mjs';
const {fitArchitecture,architectureMesh,addBoundaryHousing}=await import('campus-buildings');

const read=file=>JSON.parse(readFileSync(new URL(file,import.meta.url)));
const records=read('../campus-buildings.json');
const measured=read('../../build/specs/survey-footprints.json');
const region=read('../campus-region.json');
const byId=new Map(records.map(b=>[b.id,b]));
const ground=()=>10;
const model=id=>{
  const b=structuredClone(byId.get(id));fitArchitecture([b],ground);
  const object=architectureMesh(buildArchitecture([b],2));object.updateMatrixWorld(true);
  return object;
};
const ray=new Raycaster();
function top(object,x,z){
  ray.set(new Vector3(x,100,z),new Vector3(0,-1,0));
  return ray.intersectObject(object)[0]?.point.y??-Infinity;
}
for(const entry of measured)assert.ok(byId.get(entry.id)?.parts.length,entry.name+' has no compiled geometry');
const housing=structuredClone(records);addBoundaryHousing(housing,region);
assert.equal(housing.filter(b=>b.id==='w123525237').length,1);
assert.equal(byId.get('w123525237').parts.filter(p=>p.roof.form==='gable').length,5);
const rowhouse=model('w123525237'),rowCenter=byId.get('w123525237').parts[0].center;
const [cx,cz]=rowCenter,crest=top(rowhouse,cx,cz);
assert.ok(Math.abs(crest-top(rowhouse,cx+2.8,cz-1.1))<.20 && crest-top(rowhouse,cx-1.1,cz-2.8)>.65,'Townhouse ridge must follow the row');
const tennis=model('survey-north-tennis');
assert.ok(top(tennis,583,505)>19 && top(tennis,583,523)<12,'Northern court crown and south verge');
assert.ok(top(model('survey-practice-wall'),-130.55,-96)>12.8,'Rebound wall height');
assert.ok(top(model('w119875065'),-80.2,1273.3)>13.5,'Gathering shelter crown');
const abbey=structuredClone(byId.get('w147379378')),hillside=(x,z)=>12+(-x-470)*.24;
fitArchitecture([abbey],hillside);
const approach=abbey.spec.attachments.find(a=>a.type==='exterior-stair');
assert.ok(Math.abs(approach.stairLevels[0]-hillside(...approach.path[0]))<.05);
assert.ok(Math.abs(approach.stairLevels.at(-1)-abbey.entryGround[0]-.19)<.01);
const abbeyMesh=architectureMesh(buildArchitecture([abbey],2));abbeyMesh.updateMatrixWorld(true);
assert.equal(top(abbeyMesh,-466.5,766.5),-Infinity,'Entrance stair extends into lawn');
assert.ok(top(model('w147379380'),-432,911)>19,'West plant room has no supporting building');
const arena=model('w118764094');
assert.ok(top(arena,138,864)>15,'Arena north plant annex');
const glasshouse=byId.get('r7932251'),glassPart=glasshouse.parts.find(p=>p.name==='Glazed east growing range');
assert.ok(glassPart?.roof.material==='glass');
const glassPacket=buildArchitecture([glasshouse],2);
assert.ok(glassPacket.palette.some(m=>m.kind==='glass-curtain' && m.roofSurface));
const athletic=buildArchitecture([byId.get('w310132539')],2);
const floorBehindGlass=athletic.styles.some((style,i)=>{
  const x=athletic.positions[i*3],z=athletic.positions[i*3+2];
  return athletic.palette[style].kind==='interior' && athletic.normals[i*3+1]>100 && x>200 && x<240 && z>859 && z<869;
});
assert.ok(floorBehindGlass,'Recreation centre north windows look straight into turf');
for(const id of ['survey-glasshouse','survey-hoophouse']){
  const growingRoom=buildArchitecture([byId.get(id)],2);
  assert.ok(growingRoom.styles.every(style=>growingRoom.palette[style].kind!=='interior'),'Opaque wall inside '+id);
}
const condo=structuredClone(byId.get('w123525238'));
const grade=(x,z)=>8+.05*x+.035*z;
const solids=fitArchitecture([condo],grade);
const patios=condo.spec.attachments.filter(a=>a.type==='terrace');
assert.ok(patios.length>=8);
for(const terrace of patios)for(const row of terrace.paving){
  const a=row[0][0],c=row.at(-1)[1],x=(a[0]+c[0])/2,z=(a[2]+c[2])/2,y=grade(x,z)+terrace.height;
  assert.ok(solids.parkingSurface.covers(x,z),'Terrace has no drive surface');
  assert.ok(solids.surfaceContact(x,z,y-.018,y+.018,.01),'Missing visible terrace contact');
}
const iv=structuredClone(byId.get('r7379137'));
fitArchitecture([iv],ground);
const hall=iv.parts.find(p=>p.name==='Eastern hall');
assert.ok(hall.wallIds[0].some(id=>id>=9 && id<=11));
const glass=iv.spec.materials.glass;
for(const lod of [0,1,2]){
  const m=buildArchitecture([iv],lod),ids=new Set(m.palette.flatMap((v,i)=>v.kind===glass.kind && v.color===glass.color?[i]:[]));
  assert.ok(m.styles.some(style=>ids.has(style)),'Hall bay glass at LOD '+lod);
}
const supportCentre=model('w237299189');
const coolingUnit=byId.get('w237299189').spec.roof.features.find(row=>row.fanGrid);
const [x,z]=coolingUnit.center,[short,long]=coolingUnit.size;
const angle=(coolingUnit.rotation+90)*Math.PI/180;
const capHeight=(along,across)=>top(supportCentre,x+along*Math.cos(angle)-across*Math.sin(angle),z+along*Math.sin(angle)+across*Math.cos(angle));
const housingLid=capHeight(long*.46,short*.45);
for(const along of [-1,0,1])for(const across of [-1,1]){
  assert.ok(capHeight(along*long/3,across*short/4)>housingLid+.06,'Missing cooling fan on the Support Services roof');
}
const finished=records.flatMap(b=>b.parts.flatMap(p=>p.roof.features??[])).filter(f=>f.at && ['sheet metal duct','packaged air handler'].includes(f.style));
assert.ok(finished.length>=8 && finished.every(f=>f.size.length===3 && f.size.every(v=>v>0)),'Missing measured, raised roof equipment');
console.log(measured.length+' traced footprints, five gabled townhouse pairs, '+patios.length+' graded patios and '+finished.length+' shadow-confirmed roof units');
