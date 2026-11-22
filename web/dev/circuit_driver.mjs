function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

function sampleAhead(samples, distance, closed) {
  const length = samples.at(-1).distance
  const position = closed ? distance % length : Math.min(distance,length)
  let low = 0, high = samples.length - 1
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    if (samples[mid].distance <= position) low = mid
    else high = mid
  }
  const start = samples[low], end = samples[high]
  const t = (position - start.distance) / (end.distance - start.distance)
  return {
    x: start.x + (end.x - start.x) * t,
    z: start.z + (end.z - start.z) * t,
    heading: start.heading + wrapAngle(end.heading - start.heading) * t,
  }
}

export function driveInput(samples, car, closed=true) {
  const target = sampleAhead(samples, car.distance + 5 + car.speed * .25, closed)
  const dx = target.x - car.x, dz = target.z - car.z
  const turn = wrapAngle(Math.atan2(dx, dz) - car.heading)
  const pursuitCurvature = 2 * Math.abs(Math.sin(turn)) / Math.max(.1, Math.hypot(dx, dz))
  const here = sampleAhead(samples, car.distance, closed)
  const ahead = sampleAhead(samples, car.distance + 12, closed)
  const roadCurvature = Math.abs(wrapAngle(ahead.heading - here.heading)) / 12
  const desiredSpeed = Math.min(15, Math.sqrt(2.5 / Math.max(.002, roadCurvature, pursuitCurvature)))
  return {
    throttle: car.speed < desiredSpeed ? .8 : 0,
    brake: car.speed > desiredSpeed + .9 ? .7 : 0,
    steer: 4.9 * turn,
  }
}
