import assert from 'node:assert/strict'
import {advanceZones,circuitGates,zoneProgress} from '../race/zones.mjs'
import {command,newRoundRoom,observeRacePose} from '../../server/referee.mjs'
import courses from '../race/courses.mjs'
import {createRaceContext} from '../race/context.mjs'
import {createDriveSim} from '../drive-sim.mjs'

const samples=Array.from({length:73},(_,z)=>({x:0,y:0,z,distance:z,heading:0,halfWidth:5}))
const gates=circuitGates(samples)
assert.deepEqual(gates,[24,48,72])
function path(points){
  const progress=zoneProgress()
  let from={x:0,y:0,z:0},credits=[]
  for(const [x,z,y=0] of points){
    const to={x,y,z}
    const n=advanceZones(samples,gates,progress,from,to)
    if(n)credits.push([z,n])
    from=to
  }
  return credits
}
assert.deepEqual(path([[5,8],[7,17],[7,21]]),[[21,1]])
const brush=[[3,7],[8,16],[9,23],[9,30],[6,38],[4,46]]
assert.deepEqual(path(brush),[[46,2]])
assert.deepEqual(path([...brush.slice(0,4),[15,33],[8,39],[4,46]]),[])
assert.deepEqual(path([[0,32],[0,22],[0,11]]),[])
assert.deepEqual(path([[0,8,5],[0,17,5],[0,25,5]]),[])
assert.deepEqual(path([[0,40],[0,46],[0,55],[0,65],[0,72]]),[])
const r=newRoundRoom('TEST'),p={id:1,lap:0,connected:true}
Object.assign(r,{race:'race',phase:'playing',start:1,deadline:300000,players:[p]})
const lap={type:'lap',race:'race',lap:1}
assert.equal(command(r,p,lap,100),false)
const route=courses.college.samples
for(const point of route.slice(-20))observeRacePose(r,p,{...point,epoch:0})
assert.equal(command(r,p,lap,200),false)
for(const point of route)observeRacePose(r,p,{...point,epoch:1})
assert.equal(command(r,p,lap,120000),true)
assert.equal(r.results[0].finish,119999)
for(const id of Object.keys(courses)){
  const {samples,network}=createRaceContext(id)
  for(let slot=1;slot<8;slot++){
    const sim=createDriveSim(samples,{mode:'circuit',network})
    sim.placeOnGrid(slot)
    sim.step({})
    assert.equal(sim.state.phase,'ready')
    const i=samples.findLastIndex(s=>s.distance<=samples.at(-1).distance-slot*5)
    for(const point of [...samples.slice(i+1,-1),...samples.slice(0,4)]){
      Object.assign(sim.state,{x:point.x,z:point.z,y:point.y,heading:point.heading})
      sim.step({})
      assert.ok(!sim.state.offCourse && sim.state.distance<10 && !sim.state.checkpointsPassed,id+' grid slot '+slot)
    }
  }
}
console.log('Off-centre entry, seven-metre zone depth, one close miss, off-course detour, reverse, wrong elevation, out-of-order entry and server-observed finish verified.')
