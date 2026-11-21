import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import {createArchitecture} from '../architecture.js'
import {createRoadNetwork} from '../drive-network.mjs'
import {campusFootprint} from '../campus-clip.js'

const load=name=>JSON.parse(fs.readFileSync(new URL('../'+name+'.json',import.meta.url)))
const region=load('campus-region'),data=load('drive-network')
region.buildingBases=data.buildingBases
const network=createRoadNetwork(data,region)
const structure=createArchitecture(THREE,region,{data:load('region-detail').architecture,material:new THREE.MeshBasicMaterial({side:THREE.DoubleSide})},load('world'),network.groundAt)
structure.updateMatrixWorld(true)
const ray=new THREE.Raycaster(),origin=new THREE.Vector3(),direction=new THREE.Vector3()
const covered=data.ways.filter(w=>w.covered && w.kind==='road')
const openingIds=new Set([144650295,153275339,562334870,562334877,1554621133,778714473])
const seen=new Set()
let tests=0
for(const way of covered.filter(w=>openingIds.has(w.id))){
  let hitsRoof=false
  for(let i=1;i<way.points.length;i++){
    const [a,ay,c]=way.points[i-1],[b,by,d]=way.points[i],length=Math.hypot(b-a,d-c)
    direction.set((b-a)/length,0,(d-c)/length)
    for(const offset of [-.7,0,.7]){
      const dx=direction.z*offset,dz=-direction.x*offset
      for(const height of [.42,1.45,2.25]){
        origin.set(a+dx,Math.min(ay,by)+height,c+dz)
        ray.set(origin,direction);ray.far=length
        assert.equal(ray.intersectObject(structure).length,0,`Wall crossing drive ${way.id}, segment ${i}, offset ${offset}, height ${height}`)
        tests++
      }
    }
    const x=(a+b)/2,z=(c+d)/2,y=network.groundAt(x,z)
    assert.equal(network.blocked(x,z,y,.92),false,`Vehicle blocked in ${way.id}`)
    ray.set(origin.set(x,y+1.4,z),direction.set(0,1,0));ray.far=10
    hitsRoof ||= ray.intersectObject(structure).length>0
  }
  assert.ok(hitsRoof,`Missing roof over ${way.id}`)
  seen.add(way.id)
}
assert.deepEqual(seen,openingIds)
console.log(`${seen.size} roofed accesses clear to vehicle width at three heights, ${tests} production facade raycasts`)

const official=load('campus-boundary'),site=campusFootprint(official)
const campusNetwork=createRoadNetwork({...data,campusBoundary:official,insideCampus:site.contains},region)
for(const house of region.southernHousing){
  const [ring,,base,height]=house.block,[,v,triangles]=house.hip
  const probes=[]
  for(let i=0;i<triangles.length;i+=3){
    const q=triangles.slice(i,i+3).map(idx=>v.slice(3*idx,3*idx+3))
    const x=q.reduce((sum,t)=>sum+t[0],0)/3,z=q.reduce((sum,t)=>sum+t[1],0)/3
    if(z>region.bounds[3]+1 && site.containsDisc(x,z,.5))probes.push([x,z])
  }
  assert.ok(probes.length>5,'Mapped roof triangles inside the southern campus boundary')
  for(const [x,z] of probes){
    assert.ok(campusNetwork.blocked(x,z,base+.10,.1),'The extended municipal housing footprint must be solid')
    ray.set(origin.set(x,base+height+9,z),direction.set(0,-1,0));ray.far=16
    assert.ok(ray.intersectObject(structure).some(hit=>hit.point.y>base+2),'Missing southern housing roof beyond regional grid')
  }
  const x=ring[0],z=ring[1]
  assert.ok([-8,-4,0,4,8].some(dx=>[-8,-4,0,4,8].some(dz=>site.containsDisc(x+dx,z+dz,.5)&&!campusNetwork.blocked(x+dx,z+dz,base+.1,.1))),'Approach outside the house stays accessible')
  console.log('Southern campus building',house.way,probes.length,'street-side roof and collision samples')
}
