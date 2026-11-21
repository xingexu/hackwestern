import { driveInput } from './circuit_driver.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {campusFootprint} from '../campus-clip.js'
import { createRoadNetwork } from '../drive-network.mjs'
import { createDriveSim } from '../drive-sim.mjs'

function readData(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))
}

const roadData=readData('../drive-network.json')
roadData.campusBoundary=readData('../campus-boundary.json')
roadData.insideCampus=campusFootprint(roadData.campusBoundary).contains
const network = createRoadNetwork(roadData, readData('../campus-region.json'))
assert.deepEqual(new Set(network.circuits.map(circuit => circuit.id)), new Set(['college', 'stadium', 'campus']))

for (const { id, samples } of network.circuits) {
  assert.ok(samples.every(p=>roadData.insideCampus(p.x,p.z)),id+' leaves campus grounds')
  const sim = createDriveSim(samples, { mode: 'circuit', network })
  const car = sim.state
  const length = samples.at(-1).distance
  const maxFrames = Math.ceil(length / 5 * 120)
  let contacts = 0
  let passed = 0
  for (let tick = 0; tick < maxFrames && car.phase !== 'finished'; tick++) {
    sim.step(driveInput(samples,car))
    contacts += Number(car.contact)
    assert.ok(car.checkpointsPassed >= passed && car.checkpointsPassed <= passed + 1)
    assert.equal(car.offCourse, false, `${id} missed gate at ${car.distance.toFixed(1)} m`)
    passed = car.checkpointsPassed
  }
  assert.equal(car.phase, 'finished', `${id} stopped at ${car.distance.toFixed(1)} m`)
  assert.equal(passed, car.checkpointCount)
  assert.equal(car.distance, length)
  assert.ok(car.elapsed > length / 20)
  assert.ok(contacts < 120, `${id} spent ${contacts / 120} s in contact`)
  console.log(`${id}: ${length.toFixed(0)} m, ${passed}/${car.checkpointCount} gates in ${car.elapsed.toFixed(2)} s, ${contacts} collision ticks.`)
}
