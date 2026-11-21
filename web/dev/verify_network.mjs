import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRoadNetwork } from '../drive-network.mjs'

const read = name => JSON.parse(fs.readFileSync(new URL('../'+name+'.json',import.meta.url)))
const data = read('drive-network')
const region = read('campus-region')
region.coreFrontages=read('region-detail').architecture.core
region.modeledFrontages=read('streetview-facades').tiles
const network = createRoadNetwork(data,region)
const {blocked,sample,groundAt} = network

assert.equal(sample(301.025,72.77).blocked,true,'Core campus wall')
assert.equal(sample(1027.46,369.3).blocked,true,'Regional building wall')
assert.equal(sample(1061.11,365.9).blocked,false,'Open building courtyard')
assert.equal(sample(1061.11,365.9).surface,'grass')
assert.equal(blocked(data.bounds[0]+.8,220,18,.9),true,'Car body outside west map boundary')
assert.equal(sample(700,410).blocked,true,'North Thames River')
assert.equal(sample(560.76,270.84).blocked,true,'Steps')
for (const [x,z,surface,name] of [
  [276.23,1040.12,'road','Huron Flats Parking Lot'],
  [505.02,-10.18,'road','VIsual Arts Parking Lot'],
  [106.73,295.67,'path','Concrete Beach (UCC)']
]) {
  const contact = sample(x,z)
  assert.equal(contact.street,name)
  assert.equal(contact.surface,surface)
  assert.equal(contact.blocked,false)
  assert.equal(contact.y,groundAt(x,z))
  assert.ok(contact.halfWidth>4 && Math.abs(1-Math.hypot(contact.tangentX,contact.tangentZ))<1e-8)
}
assert.equal(sample(500.56,4.57).surface,'grass','Landscaped island inside Visual Arts parking lot')
for (const [x,z] of [[260.61,-1023.05],[1519.11,1424.24]]) {
  assert.equal(sample(x,z).surface,'grass','Garage interior excluded from surface parking')
  assert.equal(sample(x,z).blocked,true)
}

assert.equal(sample(543.651,355.067).blocked,false)
assert.equal(sample(543.651,355.067).curb,.1,'Mountable Middlesex curb')

const bridge = data.ways.find(w => w.name==='University Drive' && w.bridge)
assert.ok(bridge)
const bridgeProfile = network.frames(bridge)
for (let i = 0; i<bridge.points.length; i++) {
  const [x,y,z] = bridge.points[i]
  const drive = sample(x,z,y)
  assert.equal(drive.blocked,false,'Continuous bridge and ramps')
  assert.equal(drive.surface,'road')
  assert.ok(Math.abs(drive.y-y)<.3,'Bridge deck height')
}
const mid = Math.floor(bridgeProfile.length/2)
const [x,y,z] = bridgeProfile[mid](0)
assert.ok(y>11 && y<11.8 && y-groundAt(x,z)>5,'Lidar roadway elevation above North Thames River')
for (const side of [-1,1]) {
  const [rx,ry,rz] = bridgeProfile[mid](side*bridge.width/2)
  assert.equal(blocked(rx,rz,ry,.15),true,'Physical bridge rail')
  assert.equal(blocked(rx,rz,ry-4,.15),true,'River below bridge rail')
}
const wetUnderDeck = blocked(x,z,groundAt(x,z)-1,.9)
assert.equal(wetUnderDeck,true,'Submerged position cannot snap to elevated deck')

const skywalk = data.ways.find(w=>w.id===126668417)
const [skyX,skyY,skyZ] = skywalk.points[Math.floor(skywalk.points.length/2)]
const underpass = sample(skyX,skyZ,groundAt(skyX,skyZ))
assert.equal(underpass.blocked,false)
assert.ok(skyY-underpass.y>5 && Math.abs(sample(skyX,skyZ,skyY).y-skyY)<.1,'Ground clearance beneath an elevated skywalk')

const crossroads = [559.97,356.61]
const streetNames = new Set()
for (const way of data.ways) {
  for (const i of way.junctions) {
    const p = way.points[i]
    if (Math.hypot(p[0]-crossroads[0],p[2]-crossroads[1])>.05 || !way.name) continue
    streetNames.add(way.name)
    for (let j = Math.max(0,i-3); j<=Math.min(i+3,way.points.length-1); j++) {
      const [sx,sy,sz] = way.points[j]
      assert.equal(blocked(sx,sz,sy,.9),false,'Open junction approach on '+way.name)
    }
  }
}
assert.deepEqual([...streetNames].sort(),['Lambton Drive','Middlesex Drive','Perth Drive','University Drive'])
assert.equal(sample(...crossroads).curb,0)
const path = data.ways.find(w=>w.id===119868836)
const [px,py,pz] = path.points[Math.floor(path.points.length/2)]
assert.equal(sample(px,pz,py).surface,'path')
assert.equal(blocked(px,pz,py,.9),false,'Open shared path crossing')
for (const [kind,line] of data.barriers) {
  if (kind!=='fence') continue
  const mx = (line[0]+line[2])/2, mz = (line[1]+line[3])/2
  assert.equal(blocked(mx,mz,groundAt(mx,mz),.1),true,'Mapped fence')
}
const tree = region.trees.find(([tx,,tz])=>groundAt(tx,tz)>5 && sample(tx,tz).surface==='grass')
assert.equal(blocked(tree[0],tree[2],tree[1],.6),true,'Tree trunk')
network.addPost(1061.11,365.9,groundAt(1061.11,365.9),.12,2)
assert.equal(blocked(1061.85,365.9,groundAt(1061.11,365.9),.8),true,'Offset vehicle body hitting a placed post')

for (const circuit of network.circuits) {
  const pts = circuit.samples
  assert.ok(pts.length>700 && pts.at(-1).distance>1400)
  assert.equal(pts[0].x,pts.at(-1).x)
  assert.equal(pts[0].z,pts.at(-1).z)
  for (let i=0;i<pts.length;i++) {
    const p = pts[i], road = sample(p.x,p.z,p.y)
    assert.equal(road.surface,'road',circuit.name+' road coverage')
    assert.equal(blocked(p.x,p.z,p.y,.96),false,circuit.name+' car clearance at '+p.distance)
    assert.ok(Number.isFinite(p.heading) && Number.isFinite(p.y))
    if (i>0) assert.ok(p.distance>pts[i-1].distance && p.distance-pts[i-1].distance<1.65)
  }
}
console.log(network.circuits.map(c=>c.name+' '+Math.round(c.samples.at(-1).distance)+' m').join(', '))
console.log('Traversable four-way junction, parking lots, plaza, landscaped parking island, surfaced paths, continuous raised deck, rails, river, courtyard, curbs, trunks, fences and map boundary verified.')

const cameraX=276.23,cameraZ=1040.12,cameraY=groundAt(cameraX,cameraZ)+1
assert.equal(network.chaseDistance(cameraX,cameraY,cameraZ+3,0,1,0),6.45)
network.addPost(cameraX,cameraZ,cameraY,.85,10)
let previousArm
for(let i=0;i<=50;i++){
  const separation=3+i*.02
  const arm=network.chaseDistance(cameraX,cameraY,cameraZ+separation,0,1,0)
  assert.ok(arm<=separation-1.13 && arm>separation-1.20,'Chase camera must stop just before the post')
  if(previousArm!==undefined) assert.ok(arm-previousArm<.04,'A 2 cm movement must never cause a half-metre camera jump')
  previousArm=arm
}

assert.ok(blocked(229,305,groundAt(229,305),.95),'The core stone wall must stop a car at the edge of its visible facade')
const sx=240.57,sz=472.525,sy=groundAt(sx,sz),yaw=Math.atan2(4.5,-.25)
const corrected=network.chaseDistance(sx,sy,sz,Math.sin(yaw),Math.cos(yaw),0)
assert.ok(corrected>3.8 && corrected<5.45,'The chase camera should retract before the modeled wall near Thames Hall')
console.log('Thames Hall camera arm clears the visible wall at '+corrected.toFixed(2)+' m; University College wall blocks chassis intrusion.')

const hallNormal=network.solidNormal(164.31,564.63,21.28,.90)
assert.ok(hallNormal && (hallNormal[0]*-8.1+hallNormal[1]*-7.4)/Math.hypot(8.1,7.4)>.99999,'The Alumni Hall wall must return its exact diagonal contact normal')
