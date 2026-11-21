import {clamp} from './voices.mjs'

export function campusAmbience(regionTrees, localTrees, municipal, roads) {
  const cell = 24
  const cells = new Map()
  function add(x,z,kind) {
    const key=Math.floor(x/cell)+','+Math.floor(z/cell)
    if (!cells.has(key)) cells.set(key,[[],[]])
    cells.get(key)[kind].push(x,z)
  }
  for (const group of [regionTrees,localTrees]) for (const [x,,z] of group) add(x,z,0)
  for (const tile of Object.values(municipal.tiles)) for (const [x,z] of tile.trees??[]) add(x,z,0)
  for (const way of roads.ways) if (way.kind==='road') {
    for (let i=0;i<way.points.length;i+=2) add(way.points[i][0],way.points[i][2],1)
  }
  return (x,z) => {
    const distances=[32**2,48**2]
    const cx=Math.floor(x/cell),cz=Math.floor(z/cell)
    for (let i=cx-2;i<=cx+2;i++) for (let j=cz-2;j<=cz+2;j++) {
      const bucket=cells.get(i+','+j)
      if (!bucket) continue
      for (let k=0;k<2;k++) for (let p=0;p<bucket[k].length;p+=2) {
        distances[k]=Math.min(distances[k],(x-bucket[k][p])**2+(z-bucket[k][p+1])**2)
      }
    }
    return {trees:1-Math.sqrt(distances[0])/32, traffic:1-Math.sqrt(distances[1])/48}
  }
}

export function rollingSurface(ground) {
  if (ground.curb > .023) return 'kerb'
  if (ground.surface==='grass') return 'grass'
  if (/gravel|compacted|dirt|ground|unpaved/.test(ground.material)) return 'gravel'
  if (/concrete|paving/.test(ground.material) || ground.surface==='path' || ground.street==='Parking deck') return 'concrete'
  return 'asphalt'
}

function obstacle(network, car) {
  for (const arm of [1.34,-1.34,0]) {
    const x=car.x+Math.sin(car.heading)*arm,z=car.z+Math.cos(car.heading)*arm
    const owner=network.solidSource(x,z,car.y,1.22)?.owner??''
    if (/tree|trunk|branch|canopy/i.test(owner)) return 'tree'
    if (/fence|rail|mesh/i.test(owner) || network.blockerKind(x,z,car.y,1.22)==='barrier') return 'fence'
    if (/pole|post|mast|lamp|signal|sign|bollard|hydrant/i.test(owner)) return 'pole'
  }
  return 'wall'
}

export function drivingSounds(mix, campus) {
  const env={slip:0,abs:false,scraping:false,surface:'asphalt',trees:0,traffic:0}
  let nextGround=0,nextArea=0,contactUntil=-1, gates=0, finished=false
  let previousY=null, vertical=0, wrongTime=0, nextWrong=0, nextBump=0
  function reset() {
    previousY=null
    nextGround=nextArea=wrongTime=nextWrong=nextBump=gates=0
    contactUntil=-1
    finished=false
    mix.reset()
  }
  function collision(car, previousSpeed, previousSide, now) {
    if (!car.contact) return
    const impulse=Math.hypot(car.speed-previousSpeed,car.lateralSpeed-previousSide)
    if (now>contactUntil || impulse>2.5) {
      if (impulse>.45) mix.impact(obstacle(campus.network,car),impulse)
    }
    contactUntil=now+.09
  }
  function update(car, wheels, input, now, dt, onlineRace, mode) {
    const speed=Math.abs(car.speed)
    if (now>=nextArea) {
      Object.assign(env,campus.ambience(car.x,car.z))
      nextArea=now+.4
    }
    if (now>=nextGround) {
      const surface=rollingSurface(campus.network.sample(car.x,car.z,car.y))
      if (previousY!==null && (surface==='kerb')!==(env.surface==='kerb') && speed>2 && now>nextBump) {
        mix.impact('kerb',clamp(speed*.22,.8,5))
        nextBump=now+.14
      }
      env.surface=surface
      nextGround=now+.05
    }
    if (dt>0 && previousY!==null) {
      const vy=(car.y-previousY)/dt
      if (speed>2 && vy-vertical>1.9 && now>nextBump) {
        mix.impact('kerb',clamp((vy-vertical)*.5,.8,6))
        nextBump=now+.16
      }
      vertical=clamp(vy,-14,14)
    } else vertical=0
    previousY=car.y
    const denom=Math.max(4,speed)
    const lateral=Math.abs(car.lateralSpeed+1.3*car.yawRate-car.speed*Math.tan(car.steer))/denom
    let longitudinal=0
    if (wheels) for (const wheel of wheels) longitudinal=Math.max(longitudinal,Math.abs(wheel*.337-car.speed)/denom)
    env.slip=Math.max(lateral,longitudinal)
    env.abs=car.assists && input.brake>.65 && speed>3 && longitudinal>.08
    env.scraping=now<=contactUntil && speed>1.8
    mix.drive(car,input,env)
    if (car.phase==='finished' && !finished && !onlineRace) mix.cue('finish')
    else if (car.checkpointsPassed>gates && car.phase!=='finished') mix.cue('checkpoint')
    finished=car.phase==='finished'
    gates=car.checkpointsPassed??0
    const gate=car.nextGate
    const facing=gate ? Math.cos(car.heading-gate.heading)*car.speed : car.speed
    wrongTime=mode!=='roam' && car.phase==='driving' && facing < -3 ? wrongTime+dt : 0
    if (wrongTime>1.2 && now>=nextWrong) {
      mix.cue('wrong')
      nextWrong=now+5
    }
  }
  return {collision,update,reset}
}
