import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {engines,serve} from './race_browser.mjs'
import {campusSeat,campusBikeRack} from '../street-detail.js'

const {furniture,woodlots,tiles}=JSON.parse(await readFile(new URL('../municipal-detail.json',import.meta.url)))
assert.ok(woodlots.understory.length>3000)
assert.ok(woodlots.recruits.length>100)
for(const form of [0,1,8,10])assert.ok(furniture.datedTrees.some(p=>p[4]===form))
assert.ok(furniture.datedShrubs.length>25)
assert.ok(furniture.bedRows.some(([line,h,w,finish])=>line[0]<-375&&line[0]>-385&&w>2&&h<1&&finish==='evergreen'))
const floods=furniture.lamps.filter(p=>p[4]===3||p[4]===4)
assert.ok(floods.length>=4&&floods.every(p=>p[2]>12))
assert.equal(furniture.siteStructures.filter(p=>p[0]==='stone_pier').length,4)
const masts=Object.values(tiles).flatMap(t=>t.lamps??[])
for(const [x,z] of [[21.56,-358.06],[-34.75,-57.74],[25.57,889.55],[.25,-214.16]]){
  const mast=masts.find(p=>Math.hypot(p[0]-x,p[1]-z)<.25)
  assert.ok(mast&&Math.sin(mast[3])<-.65,JSON.stringify(mast))
}
const feet=draw=>{
  const points=new Set()
  draw((u,y,t,w,h)=>{if(y-h*.5<.006)points.add(u.toFixed(2)+','+t.toFixed(2))})
  return points.size
}
assert.equal(feet(at=>campusBikeRack(at,5,'stands')),10)
assert.equal(feet(at=>campusSeat(at,1.8,'black-metal')),4)
assert.equal(feet(at=>campusSeat(at,1.8,'stone')),2)
const sites=furniture.siteStructures.filter(p=>['field_shed','parking_enclosure','park_enclosure','green_enclosure','shipping_container','parking_arm'].includes(p[0]))
for(const [kind,x,z] of [['field_shed',158.5,1463.5],['parking_enclosure',229,1752],['parking_enclosure',234,1751],['park_enclosure',261.5,1767.5],['shipping_container',216,1800]]){
  assert.ok(sites.some(p=>p[0]===kind&&Math.hypot(p[1]-x,p[2]-z)<1.5))
}
assert.equal(sites.filter(p=>p[0]==='parking_arm').length,4)
const server=await serve()
const browser=await engines.chromium.launch({args:['--use-angle=metal']})
try{
  const page=await browser.newPage()
  await page.goto(server.base+'/?audit&diagnostics')
  await page.waitForFunction(()=>globalThis.campusAudit&&globalThis.driveMetrics?.network)
  const results=await page.evaluate(async sites=>{
    const net=driveMetrics.network,reports=[]
    for(const [kind,x,z,yaw,w,l,h] of sites){
      const cell={id:'x'+Math.floor(x/50)+'z'+Math.floor(z/50),x:Math.floor(x/50)*50,z:Math.floor(z/50)*50}
      await campusAudit.focus(cell)
      const y=net.groundAt(x,z),arm=kind==='parking_arm'
      const u=arm?0:w*.5-.048,t=arm?w*.64:0
      const X=x+Math.cos(yaw)*u+Math.sin(yaw)*t,Z=z-Math.sin(yaw)*u+Math.cos(yaw)*t
      const source=net.solidSource(X,Z,y+.05,.035)?.owner
      const column=campusAudit.inspect(cell,arm?X:x,y,arm?Z:z).hits
      reports.push({kind,x,z,h,source,heights:column.filter(p=>p.kind==='prop').map(p=>Math.round((p.y-y)*100)/100)})
    }
    return reports
  },sites)
  for(const r of results){
    assert.equal(r.source,r.kind,JSON.stringify(r))
    assert.ok(r.heights.some(h=>Math.abs(h-r.h)<.09),JSON.stringify(r))
  }
  const goals=furniture.siteStructures.filter(p=>p[0]==='survey_goal')
  assert.ok(goals.length>=6)
  const frames=await page.evaluate(async goals=>{
    const n=driveMetrics.network,frames=[]
    for(const [kind,x,z,yaw,width,depth,height] of goals){
      const cell={id:'x'+Math.floor(x/50)+'z'+Math.floor(z/50),x:Math.floor(x/50)*50,z:Math.floor(z/50)*50}
      await campusAudit.focus(cell)
      const ground=n.groundAt(x,z)
      const uprights=[-1,1].map(side=>n.solidSource(x+side*Math.cos(yaw)*width*.5,z-side*Math.sin(yaw)*width*.5,ground+.52,.05)?.owner)
      const crossbar=campusAudit.inspect(cell,x,ground,z).hits.some(p=>p.kind==='prop'&&Math.abs(p.y-ground-height)<.1)
      frames.push({kind,x,z,uprights,crossbar})
    }
    return frames
  },goals)
  for(const frame of frames){
    assert.ok(frame.crossbar,JSON.stringify(frame))
    assert.deepEqual(frame.uprights,[frame.kind,frame.kind],JSON.stringify(frame))
  }
  const heads=await page.evaluate(async floods=>{
    const n=driveMetrics.network,parts=[]
    for(const [x,z,h,a,form] of floods){
      const cell={id:'x'+Math.floor(x/50)+'z'+Math.floor(z/50),x:Math.floor(x/50)*50,z:Math.floor(z/50)*50}
      await campusAudit.focus(cell)
      const g=n.groundAt(x,z)
      for(const sign of form===4?[-1,0,1]:[-1,1]){
        const X=x+Math.cos(a)*sign*1.15+Math.sin(a)*.24,Z=z-Math.sin(a)*sign*1.15+Math.cos(a)*.24
        parts.push(campusAudit.inspect(cell,X,g,Z).hits.some(p=>Math.abs(p.y-g-h)<.45))
      }
    }
    return parts
  },floods)
  assert.ok(heads.every(Boolean),JSON.stringify(heads))
  const stadiumMasts=await page.evaluate(async()=>{
    const n=driveMetrics.network,cell={id:'x6z24',x:300,z:1200}
    await campusAudit.focus(cell)
    return [[304.8,1216.5],[323.7,1223.8]].map(([x,z])=>{
      const ground=n.groundAt(x,z)
      return campusAudit.inspect(cell,x,ground,z).hits.some(p=>p.y-ground>15&&p.y-ground<24)
    })
  })
  assert.deepEqual(stadiumMasts,[false,true])
  const bedTop=await page.evaluate(async()=>{
    const cell={id:'x3z5',x:150,z:250},x=159.3,z=287.0,n=driveMetrics.network
    await campusAudit.focus(cell)
    const grade=n.groundAt(x,z)
    return {hits:campusAudit.inspect(cell,x,grade,z).hits.map(v=>v.y-grade),solid:n.solidSource(x,z,grade,.08)?.owner,top:n.solidAt(x,z,grade+.24,.06,.12)?.owner}
  })
  assert.equal(bedTop.solid,'planter bed',JSON.stringify(bedTop))
  assert.equal(bedTop.top,'planter bed',JSON.stringify(bedTop))
  assert.ok(bedTop.hits.some(h=>h>.13&&h<.45),JSON.stringify(bedTop))
  const courtyard=await page.evaluate(async()=>{
    const n=driveMetrics.network,x=-130.1,z=265.5,a=.23,g=n.groundAt(x,z);
    await campusAudit.focus({id:'x-3z5',x:-150,z:250});
    const at=(u,t)=>n.solidAt(x+Math.cos(a)*u+Math.sin(a)*t,z-Math.sin(a)*u+Math.cos(a)*t,g+.37,.012,.05)?.owner;
    return [at(0,0),at(.37,0),at(.36,.36),campusAudit.inspect({id:'x-3z5',x:-150,z:250},x+.04,g,z+.04).hits.some(h=>h.kind==='prop'&&h.y-g>.69&&h.y-g<.78)];
  });
  assert.deepEqual(courtyard.slice(0,2),['round_planter','round_planter']);
  assert.notEqual(courtyard[2],'round_planter');
  assert.ok(courtyard[3],JSON.stringify(courtyard));
  const courtNet=await page.evaluate(async()=>{
    const n=driveMetrics.network,x=-276.594,z=11.995,a=.339,w=11.866,cols=Math.round(w/.102);
    const g=n.groundAt(x,z),i=Math.floor(cols*.56),u=(i/cols-.5)*w;
    const hit=(offset,height)=>n.solidAt(x+Math.cos(a)*(u+offset),z-Math.sin(a)*(u+offset),g+height,.001,.002)?.owner;
    return [hit(0,2.015),hit(.5*w/cols,2.015),hit(.5*w/cols,2.08)];
  });
  assert.deepEqual([courtNet[0],courtNet[2]],['volleyball','volleyball']);
  assert.notEqual(courtNet[1],'volleyball');
  const aprons=await page.evaluate(()=>{
    const n=driveMetrics.network;
    return [[-16.8,1684],[170.1,369.3],[564.2,562.9]].map(([x,z])=>n.solidAt(x,z,n.groundAt(x,z)+.04,.018,.06)?.owner);
  });
  assert.deepEqual(aprons,['equipment apron','equipment apron','equipment apron']);
  const equipment=await page.evaluate(async()=>{
    const cell={id:'x4z19',x:200,z:950},n=driveMetrics.network
    await campusAudit.focus(cell)
    const x=217.66,z=963.9,y=n.groundAt(x,z)
    const tank=campusAudit.inspect(cell,x,y,z).hits.filter(h=>h.kind==='prop').map(h=>h.y-y)
    const rim=n.solidSource(x-1.29,z,y+.72,.045)?.owner
    const beyond=n.solidSource(x-1.92,z,y+.72,.045)?.owner
    return {tank,rim,beyond}
  })
  assert.ok(equipment.tank.some(h=>Math.abs(h-1.42)<.10),JSON.stringify(equipment))
  assert.equal(equipment.rim,'service_tank')
  assert.notEqual(equipment.beyond,'service_tank')
  const overhead=await page.evaluate(async()=>{
    const n=driveMetrics.network,points=[[59.29,1397.60],[63.43,1442.36]]
    const [a,b]=points,X=(a[0]+b[0])/2,Z=(a[1]+b[1])/2
    const cell={id:'x1z28',x:50,z:1400}
    await campusAudit.focus(cell)
    const g=n.groundAt(X,Z)
    return campusAudit.inspect(cell,X,g,Z).hits.filter(p=>p.y-g>8&&p.y-g<14).map(p=>p.y-g)
  })
  assert.ok(overhead.length,JSON.stringify(overhead))
  const streetTree=await page.evaluate(()=>{
    const n=driveMetrics.network
    return campusAudit.vegetation().stems.filter(([kind,x,z])=>kind==='municipal'&&Math.hypot(x-315,z-123)<1.6).some(([,x,z])=>n.plantable(x,z)&&n.solidSource(x,z,n.groundAt(x,z)+.02,.10)?.owner==='municipal wood or mast')
  })
  assert.ok(streetTree)
  const thicket=await page.evaluate(()=>{
    const {stems,understory}=campusAudit.vegetation(),n=driveMetrics.network
    const plants=understory.filter(([x,z,,form])=>form===3&&Math.hypot(x+335.2,z-1005.4)<4.3)
    return {plants:plants.length,contacts:plants.filter(([x,z])=>n.solidSource(x,z,n.groundAt(x,z)+.04,.11)?.owner==='municipal wood or mast').length,trees:stems.filter(([,x,z])=>Math.hypot(x+335.2,z-1005.4)<4.1).length}
  })
  assert.equal(thicket.trees,0,JSON.stringify(thicket))
  assert.ok(thicket.contacts>=10&&thicket.contacts===thicket.plants,JSON.stringify(thicket))
  const vergeClear=await page.evaluate(()=>{
    const n=driveMetrics.network
    return !n.blocked(300,501,n.groundAt(300,501),.90)
  })
  assert.ok(vergeClear,'Mown verge between the roadside trees must remain clear of fallen timber')
  const woodlandRoot=await page.evaluate(()=>{
    const x=-219.7,z=289.36,n=driveMetrics.network;
    const roots=campusAudit.vegetation().stems.filter(t=>Math.hypot(t[1]-x,t[2]-z)<.3);
    return {count:roots.length,height:roots[0]?.[3],owner:n.solidSource(x,z,n.groundAt(x,z)+.28,.09)?.owner};
  });
  assert.equal(woodlandRoot.count,1);
  assert.ok(woodlandRoot.height>25);
  assert.equal(woodlandRoot.owner,'municipal wood or mast');
  const fringe=await page.evaluate(()=>{
    const n=driveMetrics.network
    return [[-108.5,-320.5],[-126.5,-314.5]].map(([x,z])=>n.solidSource(x,z,n.groundAt(x,z)+.04,.13)?.owner)
  })
  assert.ok(fringe.every(owner=>owner==='municipal wood or mast'),JSON.stringify(fringe))
  const retired=await page.evaluate(()=>[[-14.718,307.722],[396.326,210.706]].map(([x,z])=>driveMetrics.network.solidSource(x,z,driveMetrics.network.groundAt(x,z)+1,.07)?.owner))
  assert.ok(retired.every(r=>!['gate','lift_gate','parking_arm'].includes(r)),JSON.stringify(retired))
  console.log('Verified independent survey positions, barrier arms, enclosure roofs and walls in the driving scene.',results)
}finally{await browser.close();server.close()}
