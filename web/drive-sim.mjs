import {advanceZones,circuitGates,zoneProgress} from './race/zones.mjs'
import {inputProfile} from './race/input.mjs'
import * as dm from './race/math.mjs'
const DT = 1 / 120
const MASS = 1515
const WHEELBASE = 2.46
const FRONT_ARM = WHEELBASE * 0.60
const REAR_ARM = WHEELBASE - FRONT_ARM
const TRACK = 1.57
const CG_HEIGHT = 0.46
const YAW_INERTIA = 2240
const WHEEL_RADIUS = 0.337
const WHEEL_INERTIA = 1.85
const GRAVITY = 9.81
const FINAL_DRIVE = 3.94
const RATIOS = [3.72, 2.16, 1.50, 1.15, .92, .76]
const WHEELS = [
  { arm: FRONT_ARM, left: TRACK / 2, front: true },
  { arm: FRONT_ARM, left: -TRACK / 2, front: true },
  { arm: -REAR_ARM, left: TRACK / 2, front: false },
  { arm: -REAR_ARM, left: -TRACK / 2, front: false },
]
export const ROAD_HALF_WIDTH = 4.3
export const COURSE_HALF_WIDTH = 6.2
const CHECKPOINT_SPACING = 6
const START_DISTANCE = 0.25

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function control(value, min, max) {
  return Number.isFinite(value) ? clamp(value, min, max) : 0
}

export function readGamepad(pad) {
  if (!pad?.connected || pad.mapping !== 'standard') {
    return { throttle: 0, brake: 0, steer: 0 }
  }
  const axis = control(pad.axes[0], -1, 1)
  const deadzone = 0.12
  const steer = Math.abs(axis) <= deadzone
    ? 0
    : -Math.sign(axis) * (Math.abs(axis) - deadzone) / (1 - deadzone)
  return {
    throttle: control(pad.buttons[7]?.value, 0, 1),
    brake: control(pad.buttons[6]?.value, 0, 1),
    steer,
  }
}

function approach(value, target, amount) {
  return value + clamp(target - value, -amount, amount)
}

const square = n => n*n

function project(samples, index, x, z) {
  const start = samples[index]
  const end = samples[index + 1]
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = dm.hypot(dx, dz)
  const along = ((x - start.x) * dx + (z - start.z) * dz) / length
  const weight = clamp(along / length, 0, 1)
  const centerX = start.x + dx * weight
  const centerZ = start.z + dz * weight
  const lateral = ((x - centerX) * dz - (z - centerZ) * dx) / length
  return {
    index,
    distance: start.distance + (end.distance - start.distance) * weight,
    error: square(x - centerX) + square(z - centerZ),
    y: start.y + (end.y - start.y) * weight,
    tangentX: dx / length,
    tangentZ: dz / length,
    grade: (end.y - start.y) / length,
    lateral,
  }
}

function engineTorque(rpm) {
  if (rpm < 2000) return 155 + 125 * (rpm - 850) / 1150
  if (rpm < 4400) return 280
  return Math.max(0, 280 - (rpm - 4400) * .031)
}

function tyreCurve(slip) {
  return dm.sin(1.44 * dm.atan(1.55 * slip))
}

const handling={
  keyboard:{digital:true,turnIn:1.85,unwind:4,stability:1.15,pedal:6.5,brake:10,curve:0},
  buttons:{digital:true,turnIn:1.65,unwind:3.6,stability:1.08,pedal:7.5,brake:11,curve:0},
  tilt:{digital:false,turnIn:3.4,unwind:3.4,stability:.90,pedal:8,brake:12,curve:.28},
  wheel:{digital:false,turnIn:3.4,unwind:3.4,stability:.90,pedal:8,brake:12,curve:0},
  gamepad:{digital:false,turnIn:3.4,unwind:3.4,stability:.72,pedal:10,brake:15,curve:.12}
}

function integrateCar(car, wheels, input, road, contacts) {
  const assisted = car.assists
  const profile=car.profile=inputProfile(input), tune=handling[profile]
  const throttleTarget = control(input.throttle, 0, 1)
  const brakeTarget = control(input.brake, 0, 1)
  const throttle = car.gasPedal = assisted ? approach(car.gasPedal, throttleTarget, DT*(throttleTarget>car.gasPedal?tune.pedal:18)) : throttleTarget
  const brake = car.brakePedal = assisted ? approach(car.brakePedal, brakeTarget, DT*(brakeTarget>car.brakePedal?tune.brake:18)) : brakeTarget
  const raw = control(input.steer, -1, 1)
  const curve=assisted?tune.curve:0
  const response=raw*(1-curve+curve*Math.abs(raw))
  car.filteredSteer=assisted && profile==='tilt' ? car.filteredSteer+(response-car.filteredSteer)*.34 : response
  const command=car.filteredSteer
  const speed = Math.abs(car.speed)
  const mechanicalRange = .55 / (1 + dm.steeringPower(speed))
  const gripAngle = dm.atan(WHEELBASE * 11.7 / Math.max(1, speed * speed)) + .06
  const digital = assisted && tune.digital
  const range = digital ? Math.min(mechanicalRange, gripAngle) : assisted ? Math.min(mechanicalRange,gripAngle+.035) : .55
  const slipAngle = dm.atan2(car.lateralSpeed,Math.max(4,speed))
  const countersteer = assisted ? clamp(Math.sign(slipAngle)*Math.max(0,Math.abs(slipAngle)-.018)*.36,-.08,.08)*tune.stability*clamp((speed-9)/6,0,1) : 0
  const targetSteer = clamp(command*range+countersteer,-range,range)
  const unwind = Math.sign(command) !== Math.sign(car.steer) || Math.abs(command * range) < Math.abs(car.steer)
  const rackRate = digital ? (unwind?tune.unwind:tune.turnIn)/(1+speed/(unwind?42:18)) : 3.4
  car.steer = approach(car.steer, targetSteer, rackRate * DT)

  if (speed < 0.22 && Math.abs(car.lateralSpeed) < 0.3) {
    if (throttle > 0.01) car.gear = Math.max(1, car.gear)
    else if (brake > 0.01) car.gear = -1
  }
  const reverse = car.gear === -1
  const gas = reverse ? brake * (1 - throttle) * clamp((11 - speed) / 1.5, 0, 1) : throttle * (1 - brake)
  const braking = reverse ? throttle : brake
  const parked = !gas && speed < 0.006 && Math.abs(car.lateralSpeed) < 0.006 && Math.abs(car.yawRate) < 0.006
  if (parked) {
    car.speed = car.lateralSpeed = car.yawRate = car.ax = car.ay = car.bodyPitch = car.roll = 0
    car.rpm = 850
    car.throttlePlate = 0
    wheels.fill(0)
    return
  }

  const rearWheelSpeed = Math.abs((wheels[2] + wheels[3]) / 2)
  const shiftRpm=3100+3400*gas
  const shaftRpm = rearWheelSpeed * FINAL_DRIVE * 60 / (2 * Math.PI)
  if (!reverse && car.shiftRemaining <= 0) {
    if (car.gear < RATIOS.length && shaftRpm * RATIOS[car.gear - 1] > shiftRpm) {
      car.gear++
      car.shiftRemaining = .095
    } else if (car.gear > 1 && shaftRpm * RATIOS[car.gear - 2] < shiftRpm*.65) {
      car.gear--
      car.shiftRemaining = .085
    }
  }
  car.shiftRemaining = Math.max(0, car.shiftRemaining - DT)
  const ratio = reverse ? 3.35 : RATIOS[car.gear - 1]
  car.rpm = Math.min(6750,Math.max(850 + gas * (reverse ? 1100 : 950), shaftRpm * ratio))
  const engineBrake = Math.min(1, speed / 3) * (1 - gas) * (12 + .004 * car.rpm)
  const requestedPlate=gas+.12*gas*(1-gas)
  car.throttlePlate = approach(car.throttlePlate, requestedPlate, DT * (requestedPlate > car.throttlePlate && !reverse ? 2 : 12))
  const combustion = (braking > 0.05 ? 0 : car.throttlePlate) * engineTorque(car.rpm) * (car.shiftRemaining > 0 || car.rpm >= 6750 ? 0 : 1) * clamp((54.2-speed)/2.2,0,1)
  const torque = (combustion * (reverse ? -.62 : 1) - Math.sign(car.speed) * engineBrake) * ratio * FINAL_DRIVE * .9 / 2
  const sin = dm.sin(car.heading), cos = dm.cos(car.heading)
  const roadNormalForward = sin * road.tangentZ - cos * road.tangentX
  const roadNormalLeft = cos * road.tangentZ + sin * road.tangentX
  const gradeForce = -MASS * GRAVITY * dm.sin(dm.atan(road.grade))
  const weight = MASS * GRAVITY * dm.cos(dm.atan(road.grade))
  const substep = DT / 6
  for (let sub = 0; sub < 6; sub++) {
    const frontLoad = clamp(weight * REAR_ARM / WHEELBASE - MASS * car.ax * CG_HEIGHT / WHEELBASE, weight * .15, weight * .80)
    let fx = -.5 * 1.225 * .62 * car.speed * Math.abs(car.speed)
    let fy = 0, moment = 0
    for (let i = 0; i < WHEELS.length; i++) {
      const { arm, left, front } = WHEELS[i]
      const axleLoad = front ? frontLoad : weight - frontLoad
      const fraction = front ? .45 : .55
      const transfer = MASS * car.ay * CG_HEIGHT * fraction / TRACK
      const load = clamp(axleLoad / 2 - Math.sign(left) * transfer, axleLoad * .06, axleLoad * .94)
      const lateralPosition = road.lateral + arm * roadNormalForward + left * roadNormalLeft
      const surface = contacts ? contacts[i] : Math.abs(lateralPosition) <= ROAD_HALF_WIDTH ? 'road' : 'grass'
      const paved = surface !== 'grass'
      const peak = (surface === 'road' ? 1.12 : surface === 'path' ? .91 : .50) * load * dm.loadSensitivity(load)
      const steer = front ? dm.atan2(WHEELBASE * dm.tan(car.steer), WHEELBASE - left * dm.tan(car.steer)) : 0
      const c = dm.cos(steer), s = dm.sin(steer)
      const u = car.speed - car.yawRate * left, v = car.lateralSpeed + car.yawRate * arm
      const forward = u * c + v * s, side = v * c - u * s
      const slipSpeed = Math.max(3, Math.abs(forward))
      const slipRatio = (wheels[i] * WHEEL_RADIUS - forward) / slipSpeed
      const longitudinal = slipRatio / (paved ? .12 : .20)
      const lateral = -dm.atan2(side, slipSpeed) / (paved ? .089 : .16)
      const slip = dm.hypot(longitudinal, lateral)
      const scale = slip > 1e-6 ? peak * tyreCurve(slip) / slip : peak * 1.44 * 1.55
      const traction = longitudinal * scale
      const gripReserve = clamp((Math.abs(lateral) - .55) / .68, 0, 1)
      const cornering = lateral * scale * (front ? 1.075 + .004 * gripReserve : 1.14 + .115 * gripReserve)
      const rolling = (paved ? .013 : .078) * load * dm.tanh(forward * 2)
      const wheelFx = (traction - rolling) * c - cornering * s
      const wheelFy = (traction - rolling) * s + cornering * c
      fx += wheelFx
      fy += wheelFy
      moment += arm * wheelFy - left * wheelFx
      const tractionControl = !assisted ? 1 : clamp(1 - (Math.sign(torque) * slipRatio - .09) * 10, .05, 1)
      const cornerThrottle = assisted && car.speed > 7 && torque > 0 ? 1 - .65 * clamp((Math.abs(lateral) - .65) / 1.10, 0, 1) : 1
      const driveTorque = front ? 0 : torque * tractionControl * cornerThrottle
      const abs = !assisted ? 1 : clamp(1 + (Math.sign(forward) * slipRatio + .09) * 12, .05, 1)
      const brakeTorque = braking * (front ? 2090 : 1390) * abs + (front ? 0 : control(input.handbrake, 0, 1) * 1850)
      wheels[i] = approach(wheels[i] + (driveTorque - traction * WHEEL_RADIUS) * substep / WHEEL_INERTIA, 0, brakeTorque * substep / WHEEL_INERTIA)
    }
    if (assisted && car.speed > 8) {
      const sideslip = dm.atan2(car.lateralSpeed, car.speed)
      const yawDemand = clamp(car.speed * dm.tan(car.steer) / WHEELBASE, -11.3 / car.speed, 11.3 / car.speed)
      const excessYaw = car.yawRate - yawDemand
      const counterYaw = excessYaw * car.yawRate > 0 ? Math.sign(excessYaw) * Math.max(0, Math.abs(excessYaw) - .075) : 0
      const slide = Math.sign(sideslip) * Math.max(0, Math.abs(sideslip) - .024)
      const authority = clamp((car.speed - 8) / 8, 0, 1) * clamp((Math.abs(sideslip) - .018) / .035, 0, 1)
      const stabilityMoment = YAW_INERTIA * tune.stability * authority * clamp(9.5 * slide - 3.5 * counterYaw, -1.85, 1.85)
      moment += stabilityMoment
      fx -= Math.abs(stabilityMoment) / (TRACK * .5)
    }
    car.ax += (fx / MASS - car.ax) * substep * 13
    car.ay += (fy / MASS - car.ay) * substep * 13
    const speedBefore = car.speed
    car.speed += ((fx + gradeForce * roadNormalLeft) / MASS + car.yawRate * car.lateralSpeed) * substep
    car.lateralSpeed += ((fy - gradeForce * roadNormalForward) / MASS - car.yawRate * speedBefore) * substep
    car.yawRate += moment * substep / YAW_INERTIA
  }
  car.bodyPitch = car.ax * .004
  const lean = car.ay*.007
  car.roll = assisted ? approach(car.roll,clamp(lean,-.16,.16),DT*.9) : lean
}

function resetCar(state, start, grade, assisted) {
  Object.assign(state, {
    x: start.x, y: start.y, z: start.z, heading: start.heading, speed: 0,
    distance: start.distance, elapsed: 0, phase: 'ready', surface: 'road', steer: 0,
    pitch: dm.atan(grade), lateralSpeed: 0, yawRate: 0, ax: 0, ay: 0,
    assists: assisted, profile:'gamepad', filteredSteer:0, gasPedal: 0, brakePedal: 0, lift: 0, liftSpeed: 0, roadX:start.x, roadZ:start.z, vergeTime:0,
    bodyPitch: 0, roll: 0, gear: 1, rpm: 850, shiftRemaining: 0, throttlePlate: 0,
  })
}

function stopAtFinish(state, wheels) {
  state.phase = 'finished'
  state.speed = state.lateralSpeed = state.yawRate = state.ax = state.ay = 0
  state.bodyPitch = state.roll = state.throttlePlate = 0
  state.rpm = 850
  wheels.fill(0)
}

const BODY_OFFSETS = [-1.34, 0, 1.34]
const BODY_RADIUS = .90
const CONTACT_DIRECTIONS = Array.from({ length: 12 }, (_, i) => {
  const angle = Math.PI * i / 6
  return [dm.cos(angle), dm.sin(angle)]
})

function wheelSurfaces(network, car) {
  const sin = dm.sin(car.heading), cos = dm.cos(car.heading)
  return WHEELS.map(({ arm, left }) => network.sample(
    car.x + sin * arm + cos * left, car.z + cos * arm - sin * left, car.y
  ).surface)
}

function moveThroughWorld(network, state) {
  const oldHeading = state.heading
  const turn = state.yawRate * DT
  const mid = oldHeading + turn * .5
  let vx = dm.sin(mid) * state.speed + dm.cos(mid) * state.lateralSpeed
  let vz = dm.cos(mid) * state.speed - dm.sin(mid) * state.lateralSpeed
  const steps = Math.max(1, Math.ceil((dm.hypot(vx, vz) * DT + Math.abs(turn) * 2.24) / .32))
  function blocked(x, z, y = state.y) {
    if (network.blocked) return network.blocked(x, z, y, BODY_RADIUS)
    if (network.sample(x, z, y).blocked) return true
    return CONTACT_DIRECTIONS.some(([a, b]) => network.sample(x + a * BODY_RADIUS, z + b * BODY_RADIUS, y).blocked)
  }
  function contact(x, z, heading) {
    const y = network.sample(x, z, state.y).y
    for (const offset of BODY_OFFSETS) {
      const bx = x + dm.sin(heading) * offset
      const bz = z + dm.cos(heading) * offset
      if (blocked(bx, bz, y)) return [bx, bz]
    }
    return null
  }
  let hit = false
  for (let k = 0; k < steps; k++) {
    const heading = state.heading + state.yawRate * DT / steps
    const dx = vx * DT / steps, dz = vz * DT / steps
    const collision = contact(state.x + dx, state.z + dz, heading)
    if (!collision) {
      state.x += dx
      state.z += dz
      state.heading = heading
      continue
    }
    hit = true
    const normal=network.solidNormal?.(collision[0],collision[1],state.y,BODY_RADIUS)
    let nx=normal?.[0]??0, nz=normal?.[1]??0
    if(!normal) for (const [a, b] of CONTACT_DIRECTIONS) {
      if (blocked(collision[0] + a * .4, collision[1] + b * .4)) continue
      nx += a
      nz += b
    }
    const length = dm.hypot(nx, nz)
    if (length > .1) {
      nx /= length
      nz /= length
      const inward = Math.min(0, vx * nx + vz * nz)
      vx -= inward * nx
      vz -= inward * nz
    }
    state.yawRate *= .72
    const sx = vx * DT / steps, sz = vz * DT / steps
    if (length > .1 && !contact(state.x + sx, state.z + sz, state.heading)) {
      state.x += sx
      state.z += sz
    } else if (!contact(state.x + dx, state.z + dz, state.heading)) {
      state.x += dx
      state.z += dz
    } else {
      vx = vz = 0
      state.yawRate = 0
      break
    }
  }
  if (hit) {
    const sin = dm.sin(state.heading), cos = dm.cos(state.heading)
    state.speed = vx * sin + vz * cos
    state.lateralSpeed = vx * cos - vz * sin
  }
  return hit
}

function settleBody(car,rise) {
  const previous=car.lift
  const damper=car.assists?9:3
  car.liftSpeed-=(GRAVITY+damper*Math.max(0,car.liftSpeed))*DT
  car.lift=Math.max(0,previous+car.liftSpeed*DT-rise)
  if (!car.lift) car.liftSpeed=clamp(rise/DT,-6,car.assists?1.4:2.2)
  if (car.lift>.06 && car.assists) {
    car.roll*=.96
    car.bodyPitch*=.96
    car.yawRate*=.995
  }
}

function guideFromVerge(car) {
  if (car.surface==='road') {
    car.roadX=car.x
    car.roadZ=car.z
    car.vergeTime=0
    return
  }
  car.vergeTime+=DT
  if (!car.assists || car.vergeTime>.55 || car.speed<3 || car.contact) return
  const side=(car.roadX-car.x)*dm.cos(car.heading)-(car.roadZ-car.z)*dm.sin(car.heading)
  car.lateralSpeed+=clamp(side*2,-1.9,1.9)*(1-car.vergeTime/.55)*DT
}

function createNetworkDrive(samples, network, mode, assisted) {
  const racing = mode === 'circuit'
  const last = samples.length - 1
  const gates = racing ? circuitGates(samples) : []
  let progress
  const state = {}
  const wheels = new Float64Array(4)
  let ground
  function spawn(sample) {
    ground = network.sample(sample.x, sample.z, sample.y)
    resetCar(state, sample, ground.grade, state.assists??assisted)
    state.y = ground.y
    state.surface = ground.surface
    state.offCourse = false
    state.contact = false
    wheels.fill(0)
  }
  function reset() {
    spawn(samples[0])
    progress = zoneProgress()
    state.checkpointsPassed = 0
    state.lastGateDistance = 0
    state.checkpointCount = gates.length
    state.nextGate = racing ? samples[gates[0]] : null
  }
  function recover() {
    if (!racing || state.phase !== 'driving') {
      if (state.phase !== 'finished') reset()
      return
    }
    const elapsed = state.elapsed
    const checkpoint = state.checkpointsPassed > 0 ? gates[state.checkpointsPassed - 1] : 0
    spawn(samples[checkpoint])
    progress=zoneProgress(state.checkpointsPassed)
    state.elapsed = elapsed
    state.phase = 'driving'
  }
  function sectorPosition() {
    const start = Math.max(0,(gates[state.checkpointsPassed-1] ?? 0)-5)
    const end = gates[state.checkpointsPassed + Number(progress.missed)] ?? last
    let nearest = project(samples, start, state.x, state.z)
    for (let i = start + 1; i < end; i++) {
      const candidate = project(samples, i, state.x, state.z)
      if (candidate.error < nearest.error) nearest = candidate
    }
    state.distance = nearest.distance
    const lane = samples[nearest.index]
    state.offCourse = nearest.error > square(Math.max(2, lane.halfWidth ?? ground.halfWidth) + 3)
  }
  function step(input = {}) {
    if (state.phase === 'finished') return
    const oldX = state.x, oldZ = state.z, oldY = state.y, oldLift = state.lift
    integrateCar(state, wheels, input, ground, wheelSurfaces(network, state))
    state.contact = moveThroughWorld(network, state)
    ground = network.sample(state.x, state.z, state.y)
    settleBody(state,ground.y-oldY)
    state.y = ground.y
    state.surface = ground.surface
    guideFromVerge(state)
    const forwardGrade = ground.grade * (dm.sin(state.heading) * ground.tangentX + dm.cos(state.heading) * ground.tangentZ)
    state.pitch = approach(state.pitch, dm.atan(forwardGrade), 1.5 * DT)
    if (state.phase === 'ready' && dm.hypot(state.x - samples[0].x, state.z - samples[0].z) >= START_DISTANCE) {
      state.phase = 'driving'
    }
    if (!racing) {
      state.distance += dm.hypot(state.x - oldX, state.z - oldZ)
    }
    if (state.phase !== 'driving') return
    state.elapsed += DT
    if (!racing) return
    if (advanceZones(samples,gates,progress,{x:oldX,y:oldY+oldLift,z:oldZ},{x:state.x,y:state.y+state.lift,z:state.z})) {
      state.checkpointsPassed=progress.passed
      state.lastGateDistance=samples[gates[progress.passed-1]].distance
      if (state.checkpointsPassed === gates.length) {
        state.nextGate = null
        state.distance = samples[last].distance
        state.offCourse = false
        stopAtFinish(state, wheels)
        return
      }
      state.nextGate = samples[gates[state.checkpointsPassed]]
    }
    sectorPosition()
  }
  reset()
  return { state, wheels, step, reset, recover }
}

export function createDriveSim(samples, options = {}) {
  if (options.mode === 'roam' || options.mode === 'circuit') {
    return createNetworkDrive(samples, options.network, options.mode, options.assists !== false)
  }
  const start = samples[0]
  const finish = samples.at(-1)
  const trackLength = finish.distance - start.distance
  const startGate = start.distance + Math.min(START_DISTANCE, trackLength / 3)
  const finishIndex = samples.length - 2
  const state = {}
  let segmentIndex
  let nextCheckpoint
  const terrain=options.network
  const wheels = new Float64Array(4)
  let road

  function reset() {
    segmentIndex = 0
    nextCheckpoint = start.distance + CHECKPOINT_SPACING
    wheels.fill(0)
    road = project(samples, 0, start.x, start.z)
    road=terrain?.sample(start.x,start.z,start.y) ?? road
    const grade=road.grade*(dm.sin(start.heading)*road.tangentX+dm.cos(start.heading)*road.tangentZ)
    resetCar(state,start,grade,options.assists !== false)
    state.y=road.y
    state.surface=road.surface ?? 'road'
  }

  function nearest(x, z) {
    let best = project(samples, segmentIndex, x, z)
    const window = 8
    const previousDistance = state.distance
    for (let i = Math.max(0, segmentIndex - window); i <= Math.min(finishIndex, segmentIndex + window); i++) {
      if (i === segmentIndex) continue
      const candidate = project(samples, i, x, z)
      const continuityCost = square(candidate.distance - previousDistance) * 0.008
      const currentCost = square(best.distance - previousDistance) * 0.008
      if (candidate.error + continuityCost < best.error + currentCost) best = candidate
    }
    return best
  }

  function step(input = {}) {
    if (state.phase === 'finished') return

    const oldHeading = state.heading
    integrateCar(state,wheels,input,road,terrain ? wheelSurfaces(terrain,state) : null)
    state.heading += state.yawRate * DT
    const midHeading = (oldHeading + state.heading) / 2
    let nextX = state.x + (dm.sin(midHeading) * state.speed + dm.cos(midHeading) * state.lateralSpeed) * DT
    let nextZ = state.z + (dm.cos(midHeading) * state.speed - dm.sin(midHeading) * state.lateralSpeed) * DT

    const route = nearest(nextX, nextZ)
    const bounded = clamp(route.lateral, -COURSE_HALF_WIDTH, COURSE_HALF_WIDTH)
    if (bounded !== route.lateral) {
      const correction = bounded - route.lateral
      nextX += route.tangentZ * correction
      nextZ -= route.tangentX * correction
      const forwardNormal = dm.sin(midHeading) * route.tangentZ - dm.cos(midHeading) * route.tangentX
      const leftNormal = dm.cos(midHeading) * route.tangentZ + dm.sin(midHeading) * route.tangentX
      const outward = forwardNormal * state.speed + leftNormal * state.lateralSpeed
      if (outward * route.lateral > 0) {
        state.speed -= forwardNormal * outward
        state.lateralSpeed -= leftNormal * outward
        state.yawRate *= .94
      }
    }

    const endAlong = (nextX - finish.x) * route.tangentX + (nextZ - finish.z) * route.tangentZ
    const startAlong = (nextX - start.x) * route.tangentX + (nextZ - start.z) * route.tangentZ
    if (route.index === 0 && startAlong < -4) {
      nextX -= (startAlong + 4) * route.tangentX
      nextZ -= (startAlong + 4) * route.tangentZ
    }
    if (route.index === finishIndex && endAlong > 4) {
      nextX -= (endAlong - 4) * route.tangentX
      nextZ -= (endAlong - 4) * route.tangentZ
    }

    if (state.phase === 'ready' && route.distance >= startGate && Math.abs(bounded) <= ROAD_HALF_WIDTH) {
      state.phase = 'driving'
    }
    if (state.phase === 'driving') {
      state.elapsed += DT
      if (route.distance >= nextCheckpoint && state.distance < nextCheckpoint) {
        nextCheckpoint += CHECKPOINT_SPACING
      }
      const finishAlongBefore = (state.x - finish.x) * route.tangentX + (state.z - finish.z) * route.tangentZ
      if (route.index === finishIndex && endAlong >= 0 && finishAlongBefore < 0
        && Math.abs(bounded) <= ROAD_HALF_WIDTH && nextCheckpoint >= finish.distance) {
        stopAtFinish(state, wheels)
      }
    }

    route.lateral=bounded
    road=terrain?.sample(nextX,nextZ,state.y) ?? route
    segmentIndex = route.index
    state.x = nextX
    settleBody(state,road.y-state.y)
    state.y = road.y
    state.z = nextZ
    state.distance = route.distance
    state.surface = road.surface ?? (Math.abs(bounded)<=ROAD_HALF_WIDTH ? 'road' : 'grass')
    guideFromVerge(state)
    const pitch = dm.atan(road.grade * (dm.sin(state.heading) * road.tangentX + dm.cos(state.heading) * road.tangentZ))
    state.pitch = approach(state.pitch, pitch, 1.5 * DT)
  }

  reset()
  return { state, step, reset }
}
