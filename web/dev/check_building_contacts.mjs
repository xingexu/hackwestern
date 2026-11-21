import assert from 'node:assert/strict';
import {createDriveSim} from '../drive-sim.mjs';
import {buildArchitecture} from 'building-kernel';
import {architectureMesh} from 'campus-buildings';
import {spatialIndex} from './audit/spatial.mjs';
import {support} from './audit/contacts.mjs';

export function checkBuildingContacts(records,network,buildingContact){
  const models=new Map();
  function indexAt(id,x,z){
    if(!models.has(id)){
      const b=records.find(v=>v.id===id),model=architectureMesh(buildArchitecture([b],2,true));
      model.updateMatrixWorld(true);models.set(id,model);
    }
    return spatialIndex([models.get(id)],{x:Math.floor(x/50)*50,z:Math.floor(z/50)*50},()=>'building',()=>false);
  }
  for(const [id,x,z] of [['w142216972',295.5,1299.5],['w119875060',94.5,1192.5]]){
    const hits=indexAt(id,x,z).column(x,z).filter(h=>h.face.normal.y>.8 && !h.item.mesh.material.transparent);
    assert.ok(hits.length,id+' missing roof');
    assert.ok(hits.every(h=>h===hits[0] || h.item.mesh===hits[0].item.mesh || Math.abs(h.y-hits[0].y)>.0005),id+' coincident roof and trim');
  }
  for(const [id,x,z] of [['w116779543',490.5,412.5],['w1264685790',486.5,513.5],['w562894113',173.5,124.5]]){
    assert.equal(indexAt(id,x,z).column(x,z).length,0,id+' geometry projects beyond the supporting wall or roof');
  }
  for(const [id,x,y,z] of [['w141710483',246.5,12.065,-117.5],['r7379137',-37.5,22.882,716.5]]){
    const model=indexAt(id,x,z);
    assert.ok(model.solid(x,y+.16,z,.78,1.3,true),id+' has no glazed room at the surveyed contact');
    assert.ok(buildingContact(x,z,y+.16,y+1.46,.9),id+' room surface has no collision at '+[x,y,z]);
  }
  const x=-69.467,z=698.868,y=network.groundAt(x,z);
  assert.ok(indexAt('r7379137',x,z).base(x,z,y,'building',.28)<y+.3,'Ivey glazing has no footing');
  for(const [id,name] of [['w142216971','Yard concrete slab'],['w778714475','Raised rectangular pad']]){
    const owner=records.find(row=>row.id===id),part=owner.parts.find(row=>row.name===name);
    const [vertices,indices]=part.surface;
    for(let i=0;i<indices.length;i+=3){
      const tri=indices.slice(i,i+3).map(k=>vertices[k]),mean=axis=>tri.reduce((sum,p)=>sum+p[axis]/3,0);
      const x=mean(0),z=mean(2),y=owner.ground+part.high+mean(1);
      assert.ok(tri.every(([x,h,z])=>Math.abs(owner.ground+h-network.groundAt(x,z))<.015),id+' slab follows the surveyed driveway grade');
      assert.ok(indexAt(id,x,z).column(x,z).some(hit=>Math.abs(hit.y-y)<.015),id+' concrete pad has a single rendered and surveyed elevation');
    }
  }
  const shelter=records.find(b=>b.id==='c3705'),[l,t,r,b]=shelter.bounds;
  let shelterHits=0,shelterAir=0;
  for(let x=l+.23;x<r;x+=.49)for(let z=t+.19;z<b;z+=.57){
    const model=indexAt(shelter.id,x,z);
    for(let offset=.24;offset<3.5;offset+=.31){
      const y=shelter.ground+offset;
      const rendered=Boolean(model.solid(x,y,z,.065,.23));
      assert.equal(buildingContact(x,z,y,y+.23,.065),rendered,'Shelter post, glazing or roof contact '+[x,y,z]);
      if(rendered)shelterHits++;else shelterAir++;
    }
  }
  assert.ok(shelterHits>40 && shelterAir>700);
  console.log(shelterHits+' structural contacts and '+shelterAir+' clear shelter volumes');
  const arena=records.find(b=>b.id==='w118764094');
  assert.equal(arena.parts.filter(p=>p.roof.suspension?.masts?.length).length,1);
  assert.ok(arena.parts.filter(p=>/faceted end/i.test(p.name)).length>=2);
  const id='w142286181';
  for(const [x,z] of [[100.5,-287.5],[114.5,-275.5],[105,-243],[92,-281],[108,-246],[86,-287]]){
    const y=network.sample(x,z).y;
    assert.equal(Boolean(indexAt(id,x,z).solid(x,y+.16,z,.9,1.3)),false,'Blocked rendered aisle at '+[x,z]);
    assert.equal(network.blocked(x,z,y,.9),false,'Invisible garage blocker at '+[x,z]);
    const overhead=indexAt(id,x,z).column(x,z).some(h=>h.face.normal.y>.8 && h.y>y+1.5 && h.item.mesh.userData.parkingFloors?.has(h.item.mesh.geometry.attributes.finishId.getX(h.face.a)));
    assert.equal(network.isDeck(x,z),overhead,'Parking deck outline diverged from the rendered floor at '+[x,z]);
    assert.ok(Math.abs(y-network.groundAt(x,z))<.035,'Garage aisle diverged from the ground layer');
  }
  const entry=records.find(b=>b.id===id).spec.entrances[0];
  const [px,pz]=entry.gradePoint;
  assert.equal(network.blocked(px,pz,network.sample(px,pz).y,.9),false,'Garage door closed to vehicles');
  const scenes=new Map();
  let columns=0;
  for(let z=-312;z< -223;z+=.65)for(let x=78;x<165;x+=.65){
    const key=Math.floor(x/50)+','+Math.floor(z/50);
    if(!scenes.has(key))scenes.set(key,indexAt(id,x,z));
    const scene=scenes.get(key);
    const y=network.sample(x,z).y;
    if(!scene.solid(x,y+.19,z,.65,1.18))continue;
    assert.ok(network.blocked(x,z,y,.9),'Car passed visible garage structure at '+[x,z]);columns++;
  }
  assert.ok(columns>150,'Only '+columns+' visible structural probes');
  const toe=[134.29,-241.251],crest=[112.679,-296.891],angle=Math.atan2(crest[0]-toe[0],crest[1]-toe[1]);
  const start=network.sample(toe[0]-2*Math.sin(angle),toe[1]-2*Math.cos(angle));
  const sim=createDriveSim([{...start,heading:angle,distance:0}],{mode:'roam',network});
  sim.state.speed=5;
  for(let i=0;i<1150;i++)sim.step({throttle:.25});
  const car=sim.state,distance=Math.hypot(car.x-start.x,car.z-start.z);
  assert.ok(distance>70 && distance<73 && car.contact,'Car must climb P4 and stop against its exterior rail');
  assert.ok(car.y-start.y>3.5 && car.y-start.y<5.5,'Car failed to reach the first elevated parking deck');
  const deck=indexAt(id,car.x,car.z).column(car.x,car.z).find(h=>Math.abs(h.y-car.y)<.035);
  assert.ok(deck,'Parking physics diverged from rendered deck');
  const ground={kind:'grass',y:10,item:{kind:'terrain'}},upper={kind:'building',y:13,item:{kind:'building'},parkingFloor:true};
  assert.equal(support([upper,ground],13).kind,'road');
  assert.equal(support([upper,ground],10),ground);
  assert.equal(support([{...upper,parkingFloor:false},ground],13),ground);
  console.log(columns+' visible garage obstructions, six open aisles, '+distance.toFixed(1)+' m driven up P4, two coplanar-roof regressions, three unsupported projections, Ivey footing');
}
