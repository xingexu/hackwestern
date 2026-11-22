import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COURSE_HALF_WIDTH, ROAD_HALF_WIDTH, createDriveSim, readGamepad } from '../drive-sim.mjs'

const flat = Array.from({ length: 101 }, (_, i) => ({ x: 0, y: 0, z: i, heading: 0, distance: i }))
const bend = Array.from({ length: 161 }, (_, distance) => {
  const heading = Math.min(Math.PI / 2, Math.max(0, distance - 25) / 27)
  const straight = Math.max(0, distance - 25 - Math.PI * 27 / 2)
  return {
    distance,
    heading,
    x: 27 * (1 - Math.cos(heading)) + straight,
    y: distance * 0.045,
    z: Math.min(distance, 25) + 27 * Math.sin(heading),
  }
})

function repeat(sim, input, frames) {
  for (let i = 0; i < frames; i++) sim.step(input)
}

const sim = createDriveSim(flat)
const initial = { ...sim.state }
repeat(sim, {}, 120)
assert.deepEqual(sim.state, initial)
repeat(sim, { throttle: 1 }, 240)
assert.equal(sim.state.phase, 'driving')
assert.ok(sim.state.speed > 10)
assert.ok(sim.state.elapsed > 1.5)
const moving = { ...sim.state }
sim.reset()
assert.deepEqual(sim.state, initial)
repeat(sim, { throttle: 1 }, 240)
assert.deepEqual(sim.state, moving)
repeat(sim, { brake: 1 }, 300)
assert.ok(sim.state.speed < 0)
assert.ok(sim.state.z < moving.z + 5)

sim.reset()
repeat(sim, { throttle: 1, steer: 1 }, 120)
assert.ok(sim.state.x > 0)
assert.ok(sim.state.heading > 0)
sim.reset()
repeat(sim, { throttle: 1, steer: -1 }, 120)
assert.ok(sim.state.x < 0)
assert.ok(sim.state.heading < 0)

sim.reset()
for (let i = 0; i < 600 && sim.state.heading < Math.PI / 2; i++) {
  sim.step({ throttle: 1, steer: 1 })
}
repeat(sim, { throttle: 1 }, 240)
assert.ok(sim.state.x > ROAD_HALF_WIDTH)
assert.ok(sim.state.x <= COURSE_HALF_WIDTH + 1e-8)
assert.equal(sim.state.surface, 'grass')
const edge = sim.state.x
repeat(sim, { brake: 1 }, 300)
assert.ok(sim.state.x < edge - 2)

sim.reset()
repeat(sim, { throttle: 1 }, 1600)
assert.equal(sim.state.phase, 'finished')
assert.equal(sim.state.distance, 100)
assert.ok(sim.state.elapsed < 8)
const completed = { ...sim.state }
repeat(sim, { brake: 1, steer: 1 }, 120)
assert.deepEqual(sim.state, completed)

const curved = createDriveSim(bend)
for (let i = 0; i < 4000 && curved.state.phase !== 'finished'; i++) {
  const { x, z, heading, distance, speed } = curved.state
  const target = bend[Math.min(bend.length - 1, Math.floor(distance) + Math.ceil(4 + speed * 0.27))]
  const goal = Math.atan2(target.x - x, target.z - z)
  const delta = Math.atan2(Math.sin(goal - heading), Math.cos(goal - heading))
  curved.step({ throttle: speed < 14 ? 1 : 0, steer: delta * 4 })
}
assert.equal(curved.state.phase, 'finished', JSON.stringify(curved.state))
assert.ok(curved.state.y > 7)
assert.ok(curved.state.pitch > 0.035)
assert.ok(curved.state.elapsed < 16)

const folded = Array.from({ length: 135 }, (_, distance) => {
  const heading = Math.min(Math.PI, Math.max(0, distance - 60) / 4)
  const straight = Math.max(0, distance - 60 - Math.PI * 4)
  return {
    distance,
    heading,
    x: 4 * (1 - Math.cos(heading)),
    y: 0,
    z: Math.min(distance, 60) + 4 * Math.sin(heading) - straight,
  }
})
const shortcut = createDriveSim(folded)
repeat(shortcut, { throttle: 1, steer: 1 }, 125)
repeat(shortcut, { throttle: 1 }, 360)
assert.notEqual(shortcut.state.phase, 'finished')
assert.ok(shortcut.state.distance < 60)

const course = JSON.parse(readFileSync(new URL('../drive-route.json', import.meta.url), 'utf8'))
const campus = createDriveSim(course)
const sampleSpacing = course[1].distance - course[0].distance
function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}
for (let i = 0; i < 120 * 90 && campus.state.phase !== 'finished'; i++) {
  const { x, z, heading, distance, speed } = campus.state
  const index = Math.min(course.length - 1, Math.floor(distance / sampleSpacing))
  const target = course[Math.min(course.length - 1, index + Math.ceil(3 + speed * 0.29))]
  const ahead = course[Math.min(course.length - 1, index + 12)]
  const curvature = Math.abs(wrapAngle(ahead.heading - course[index].heading)) / (12 * sampleSpacing)
  const targetSpeed = Math.min(15, Math.sqrt(7 / Math.max(0.003, curvature)))
  campus.step({
    throttle: speed < targetSpeed ? 1 : 0,
    brake: speed > targetSpeed + 1.5 ? 0.5 : 0,
    steer: 4.9 * wrapAngle(Math.atan2(target.x - x, target.z - z) - heading),
  })
  assert.equal(campus.state.surface, 'road', JSON.stringify(campus.state))
}
assert.equal(campus.state.phase, 'finished', JSON.stringify(campus.state))
assert.equal(campus.state.distance, course.at(-1).distance)

const analog = {
  connected: true,
  mapping: 'standard',
  axes: [-0.56],
  buttons: Array.from({ length: 8 }, (_, index) => ({ value: index / 10 })),
}
const gamepadInput = readGamepad(analog)
assert.equal(gamepadInput.throttle, 0.7)
assert.equal(gamepadInput.brake, 0.6)
assert.ok(Math.abs(gamepadInput.steer - 0.5) < 1e-8)
assert.deepEqual(readGamepad({ ...analog, axes: [0.1] }), { throttle: 0.7, brake: 0.6, steer: 0 })
assert.deepEqual(readGamepad({ ...analog, mapping: '' }), { throttle: 0, brake: 0, steer: 0 })
assert.deepEqual(readGamepad(null), { throttle: 0, brake: 0, steer: 0 })
console.log(`Drive simulation verified on synthetic routes and the ${course.at(-1).distance.toFixed(1)} m campus course (${campus.state.elapsed.toFixed(2)} s)`)

const provingGround = Array.from({ length: 2001 }, (_, z) => ({ x: 0, y: 0, z, heading: 0, distance: z }))
function reachSpeed(car, kph, steerToOffset = 0) {
  let frames = 0
  while (car.state.speed < kph / 3.6 && frames < 3600) {
    const steer = (steerToOffset - car.state.x) * .22 - car.state.heading * 3.2
    car.step({ throttle: 1, steer })
    frames++
  }
  assert.ok(car.state.speed >= kph / 3.6)
  return frames / 120
}

function stopDistance(car, offset = 0) {
  const z = car.state.z
  for (let frame = 0; car.state.speed > .22 && frame < 1000; frame++) {
    car.step({ brake: 1, steer: (offset - car.state.x) * .22 - car.state.heading * 3.2 })
  }
  assert.ok(car.state.speed <= .22)
  return car.state.z - z
}

const launch = createDriveSim(provingGround)
const zeroToHundred = reachSpeed(launch, 100)
assert.ok(zeroToHundred >= 6 && zeroToHundred <= 8)
assert.ok(launch.state.gear > 1 && launch.state.rpm > 4500 && launch.state.rpm < 7000)
const dryStop = stopDistance(launch)
assert.ok(dryStop > 32 && dryStop < 39)
assert.ok(launch.state.bodyPitch < 0)

function brakeOnSurface(offset) {
  const car = createDriveSim(provingGround)
  for (let i = 0; i < 900; i++) {
    const steer = (offset - car.state.x) * .22 - car.state.heading * 3.2
    car.step({ throttle: car.state.speed < 10 ? .7 : 0, steer })
  }
  reachSpeed(car, 60, offset)
  assert.ok(Math.abs(car.state.x - offset) < .1)
  return stopDistance(car, offset)
}

const pavedStop = brakeOnSurface(0)
const grassStop = brakeOnSurface(5.4)
assert.ok(pavedStop > 10 && pavedStop < 16)
assert.ok(grassStop > pavedStop * 1.65 && grassStop < pavedStop * 3)

function cornerUnderBrakes(brake) {
  const car = createDriveSim(provingGround)
  reachSpeed(car, 76)
  repeat(car, { steer: .52 }, 40)
  repeat(car, { steer: .52, brake }, 28)
  assert.ok(car.state.surface === 'road' && car.state.x < 2)
  return car.state
}

const coastingTurn = cornerUnderBrakes(0)
const trailBrake = cornerUnderBrakes(1)
assert.ok(coastingTurn.ay > 8 && coastingTurn.ay < 12)
assert.ok(trailBrake.ay < coastingTurn.ay - 1)
assert.ok(trailBrake.ax < -6)
assert.ok(coastingTurn.yawRate > 0 && coastingTurn.roll > 0)
assert.ok(Math.abs(coastingTurn.lateralSpeed) > .4)

const keys = createDriveSim(provingGround), analogRack = createDriveSim(provingGround)
reachSpeed(keys, 60)
reachSpeed(analogRack, 60)
repeat(keys, { steer: 1, digitalSteer: true }, 6)
repeat(analogRack, { steer: 1 }, 6)
assert.ok(keys.state.steer > 0 && keys.state.steer < analogRack.state.steer / 2)
repeat(keys, { steer: 0 }, 12)
assert.equal(keys.state.steer, 0)
console.log(`Flat dry asphalt: 0–100 km/h ${zeroToHundred.toFixed(2)} s, 100–0 km/h ${dryStop.toFixed(1)} m; 60–0 km/h road ${pavedStop.toFixed(1)} m, grass ${grassStop.toFixed(1)} m.`)

const keyboardTurn = createDriveSim(provingGround)
reachSpeed(keyboardTurn, 60)
repeat(keyboardTurn, { steer: 1, digitalSteer: true }, 24)
const turnIn = keyboardTurn.state.ay
assert.ok(turnIn > 5.8 && turnIn < 7)
repeat(keyboardTurn, { steer: 1, digitalSteer: true }, 36)
const rearSlide = Math.abs(keyboardTurn.state.lateralSpeed)
assert.ok(rearSlide < .45 && keyboardTurn.state.ay > 10.5)
console.log(`60 km/h keyboard turn: lateral acceleration at 0.2 s ${turnIn.toFixed(2)} m/s², sideways speed at 0.5 s ${rearSlide.toFixed(2)} m/s.`)

function testNetwork({ surfaceAt = () => 'road', heightAt = () => 0, blocked = () => false } = {}) {
  return {
    blocked,
    sample(x, z, previousY) {
      return {
        x, z, y: heightAt(x, z, previousY), grade: 0, tangentX: 0, tangentZ: 1,
        halfWidth: ROAD_HALF_WIDTH, lateral: 0, surface: surfaceAt(x, z), blocked: blocked(x, z, previousY, 0),
      }
    },
  }
}

function networkStoppingDistance(surfaceAt) {
  const car = createDriveSim(provingGround, { mode: 'roam', network: testNetwork({ surfaceAt }) })
  reachSpeed(car, 60)
  return stopDistance(car)
}

const mappedRoadStop = networkStoppingDistance(() => 'road')
const mappedPathStop = networkStoppingDistance(() => 'path')
const mappedGrassStop = networkStoppingDistance(() => 'grass')
const splitGripStop = networkStoppingDistance(x => x < 0 ? 'grass' : 'road')
assert.ok(mappedRoadStop < mappedPathStop && mappedPathStop < mappedGrassStop)
assert.ok(splitGripStop > mappedRoadStop * 1.1 && splitGripStop < mappedGrassStop * .9)

const risingRoad = testNetwork({
  surfaceAt: (x, z) => z < 8 ? 'road' : z < 15 ? 'path' : 'grass',
  heightAt: (x, z) => z >= 7 && z <= 8 ? .08 : 0,
})
const roam = createDriveSim(flat.slice(0, 8), { mode: 'roam', network: risingRoad })
const seenSurfaces = new Set()
let highestCurb = 0
for (let i = 0; i < 550; i++) {
  roam.step({ throttle: 1 })
  seenSurfaces.add(roam.state.surface)
  highestCurb = Math.max(highestCurb, roam.state.y)
}
assert.deepEqual([...seenSurfaces], ['road', 'path', 'grass'])
assert.equal(highestCurb, .08)
assert.equal(roam.state.phase, 'driving')
assert.ok(roam.state.distance > 25 && Math.abs(roam.state.z - roam.state.distance) < .001)

const intersection = createDriveSim(flat, { mode: 'roam', network: testNetwork() })
for (let i = 0; i < 800 && intersection.state.heading < Math.PI / 2; i++) intersection.step({ steer: 1, throttle: .6 })
repeat(intersection, { throttle: .7 }, 180)
assert.ok(intersection.state.x > 20 && intersection.state.phase === 'driving')

const splitLevel = testNetwork({
  heightAt: (x, z, y) => y > 2 ? 5 : 0,
  blocked: (x, z, y, r) => y < 2 && Math.abs(z - 40) <= .02 + r,
})
const bridgeStart = flat.map(point => ({ ...point, y: 5 }))
const overpass = createDriveSim(bridgeStart, { mode: 'roam', network: splitLevel })
repeat(overpass, { throttle: 1 }, 600)
assert.ok(overpass.state.z > 50 && overpass.state.y === 5)

const underpass = createDriveSim(flat, { mode: 'roam', network: splitLevel })
let collided = false
for (let tick = 0; tick < 700; tick++) {
  underpass.step({ throttle: 1 })
  collided ||= underpass.state.contact
  assert.ok(underpass.state.z <= 37.78)
}
assert.ok(collided && underpass.state.z > 37 && underpass.state.speed < .05)
repeat(underpass, { brake: 1 }, 240)
assert.ok(underpass.state.z < 35 && underpass.state.speed < -2)

const railing = testNetwork({ blocked: (x, z, y, r) => Math.abs(x - 7) <= r + .04 })
const glancingCar = createDriveSim([{ ...flat[0], heading: .15 }], { mode: 'roam', network: railing })
let firstContactZ
for (let tick = 0; tick < 600; tick++) {
  glancingCar.step({ throttle: 1 })
  if (glancingCar.state.contact) firstContactZ ??= glancingCar.state.z
  assert.ok(glancingCar.state.x + 1.34 * Math.abs(Math.sin(glancingCar.state.heading)) + .9 < 6.97)
}
assert.ok(glancingCar.state.z - firstContactZ > 20 && glancingCar.state.speed > 10)

const radius = 30
const ring = Array.from({ length: 241 }, (_, i) => {
  const heading = i * Math.PI / 120
  return { x: radius * (1 - Math.cos(heading)), z: radius * Math.sin(heading), y: 0, heading, distance: radius * heading }
})
const circuit = createDriveSim(ring, { mode: 'circuit', network: testNetwork() })
const circuitSpawn = { ...circuit.state }
repeat(circuit, { brake: 1 }, 240)
assert.ok(circuit.state.z < -5 && circuit.state.phase === 'driving' && circuit.state.checkpointsPassed === 0)
circuit.reset()
repeat(circuit, { throttle: 1 }, 650)
assert.ok(circuit.state.z > 45 && circuit.state.offCourse)
assert.equal(circuit.state.checkpointsPassed, 0)
const lostTime = circuit.state.elapsed
circuit.recover()
assert.equal(circuit.state.phase, 'driving')
assert.deepEqual([circuit.state.x, circuit.state.z, circuit.state.elapsed], [0, 0, lostTime])
assert.equal(circuit.state.nextGate, circuitSpawn.nextGate)
let passed = 0
let recoveredMidLap = false
for (let tick = 0; tick < 6000 && circuit.state.phase !== 'finished'; tick++) {
  const { x, z, distance, heading, speed } = circuit.state
  const aim = (distance + 4 + .27 * speed) / radius
  const turn = wrapAngle(Math.atan2(radius * (1 - Math.cos(aim)) - x, radius * Math.sin(aim) - z) - heading)
  circuit.step({ throttle: speed < 10 ? .7 : 0, steer: turn * 4 })
  assert.equal(circuit.state.offCourse, false)
  assert.ok(circuit.state.checkpointsPassed === passed || circuit.state.checkpointsPassed === passed + 1)
  passed = circuit.state.checkpointsPassed
  if (passed === 2 && circuit.state.elapsed > lostTime + 6 && circuit.state.speed > 3 && !recoveredMidLap) {
    const elapsed = circuit.state.elapsed
    const nextGate = circuit.state.nextGate
    circuit.recover()
    assert.equal(circuit.state.elapsed, elapsed)
    assert.equal(circuit.state.nextGate, nextGate)
    assert.equal(circuit.state.checkpointsPassed, passed)
    recoveredMidLap = true
  }
}
assert.equal(circuit.state.phase, 'finished', JSON.stringify(circuit.state))
assert.ok(recoveredMidLap && passed > 5 && passed === circuit.state.checkpointCount)
assert.equal(circuit.state.nextGate, null)
assert.equal(circuit.state.distance, ring.at(-1).distance)
circuit.reset()
assert.deepEqual(circuit.state, circuitSpawn)

const fenceOnCircuit = createDriveSim(ring, { mode: 'circuit', network: testNetwork({ blocked: (x, z, y, r) => Math.abs(z - 8) <= r + .02 }) })
repeat(fenceOnCircuit, { throttle: 1 }, 360)
assert.ok(fenceOnCircuit.state.z <= 5.78 && fenceOnCircuit.state.contact)
console.log('Free driving verified across intersecting streets, grass, paths, curb elevations, stacked bridge levels and thin barriers. Closed circuit verified with ordered gates, off-course recovery and finish.')

function highSpeedRecovery(kph,turnTime,brake,digitalSteer,direction,throttle=0){
  const sim=createDriveSim([flat[0]],{mode:'roam',network:testNetwork()})
  reachSpeed(sim,kph)
  let peakSlip=0,peakAcceleration=0,releaseHeading,followThrough=0
  for(let i=0;i<Math.round(turnTime*120)+180;i++){
    const turning=i<Math.round(turnTime*120),car=sim.state
    sim.step({steer:turning?direction:0,brake:turning?brake:0,digitalSteer,throttle})
    peakSlip=Math.max(peakSlip,Math.abs(Math.atan2(car.lateralSpeed,car.speed)))
    peakAcceleration=Math.max(peakAcceleration,car.ay*direction)
    if(turning) releaseHeading=car.heading
    else followThrough=Math.max(followThrough,Math.abs(car.heading-releaseHeading))
  }
  assert.ok(releaseHeading*direction>.20 && peakAcceleration>8,'Full steering should produce a real corner')
  assert.ok(peakSlip<.1 && followThrough<.11,'Tires should regain a stable heading after release')
  return [peakSlip,followThrough].map(x=>(x*180/Math.PI).toFixed(1))
}
for(const direction of [-1,1]){
  const [slip,rotation]=highSpeedRecovery(85,.8,0,true,direction)
  highSpeedRecovery(95,1,.75,true,direction)
  highSpeedRecovery(100,.7,0,false,direction)
  highSpeedRecovery(85,.8,0,true,direction,1)
  if(direction===1) console.log(`85 km/h dry keyboard corner: peak sideslip ${slip}°, post-release rotation ${rotation}°.`)
}

const sprintTerrain=testNetwork({heightAt:(x,z)=>3+z*.04})
function driftCorner(direction,handbrake) {
  const sim=createDriveSim([flat[0]],{mode:'roam',network:testNetwork()})
  reachSpeed(sim,58)
  let peak=0, slidingTicks=0
  for(let i=0;i<330;i++){
    sim.step({profile:'keyboard',steer:direction*(i<90?1:i<115?-.55:0),
      throttle:.5,handbrake:Number(handbrake && i>=12 && i<90)})
    peak=Math.max(peak,sim.state.slipDegrees)
    slidingTicks+=Number(sim.state.drifting)
  }
  assert.ok(sim.state.slipDegrees<1 && !sim.state.drifting && sim.state.speed>8,'Recover moving forward')
  if(handbrake) assert.ok(peak>10 && peak<28 && slidingTicks>30,'Sustained, recoverable slide')
  else assert.ok(!slidingTicks && peak<7,'Normal turns keep grip')
  return peak
}
for(const direction of [-1,1]){
  driftCorner(direction,false)
  assert.equal(driftCorner(direction,true),driftCorner(direction,true))
}
for(const profile of ['wheel','buttons']){
  for(const pulse of [false,true]){
    const sim=createDriveSim([flat[0]],{mode:'roam',network:testNetwork()})
    reachSpeed(sim,58)
    let peak=0, sliding=0
    for(let i=0;i<330;i++){
      sim.step({profile,steer:i<90?.84:i<115?-.55:0,throttle:1,
        brake:Number(i>=12 && i<18 || i>=30 && i<36),handbrake:Number(pulse && i>=36 && i<85)})
      peak=Math.max(peak,sim.state.slipDegrees)
      sliding+=Number(sim.state.drifting)
    }
    assert.ok(pulse ? peak>10 && peak<28 && sliding>30 : peak<7 && !sliding,profile+' brake versus drift')
    assert.ok(!sim.state.drifting && sim.state.slipDegrees<1 && sim.state.speed>8)
  }
}
for(const [assists,handbrake,expected] of [[true,0,true],[false,0,false],[true,1,false]]){
  const sim=createDriveSim(bend,{assists})
  Object.assign(sim.state,{distance:25,speed:22})
  sim.step({throttle:1,handbrake})
  assert.equal(sim.state.cornerAssist,expected)
  assert.equal(sim.state.brakePedal>0,expected)
}
const surveyedSprint=createDriveSim(flat,{network:sprintTerrain})
assert.equal(surveyedSprint.state.y,3)
repeat(surveyedSprint,{throttle:1},240)
assert.ok(surveyedSprint.state.distance>9)
assert.equal(surveyedSprint.state.y,sprintTerrain.sample(surveyedSprint.state.x,surveyedSprint.state.z).y)
