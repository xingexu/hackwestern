export function gridPosition(samples, spot, sprint) {
  const setback = Math.floor(spot / 2) * (sprint ? 5.4 : 6.6)
  const side = spot % 2 ? 1.4 : -1.4
  let center = samples[0]
  let index = 0
  if (sprint) {
    center = {...center, x:center.x - Math.sin(center.heading) * setback, z:center.z - Math.cos(center.heading) * setback}
  } else if (setback) {
    const distance = samples.at(-1).distance - setback
    index = Math.max(0, samples.findLastIndex(p => p.distance <= distance))
    const a = samples[index], b = samples[index + 1]
    const t = (distance - a.distance) / (b.distance - a.distance)
    center = {x:a.x + (b.x - a.x) * t, y:a.y + (b.y - a.y) * t, z:a.z + (b.z - a.z) * t,
      heading:Math.atan2(b.x - a.x, b.z - a.z)}
  }
  return {index, x:center.x + Math.cos(center.heading) * side, y:center.y,
    z:center.z - Math.sin(center.heading) * side, heading:center.heading}
}

export function finishAlong(samples, point) {
  const end = samples.at(-1), before = samples.at(-2)
  const dx = end.x - before.x, dz = end.z - before.z
  return ((point.x - end.x) * dx + (point.z - end.z) * dz) / Math.hypot(dx, dz)
}

export const finishDuration = 2300
export const finishHold = 1000

export function finishPose(start, elapsed, spot, reducedMotion, sampleGround) {
  const t = Math.max(0, Math.min(1, elapsed / finishDuration))
  const forward = (1 - (1 - t) ** 3) * (reducedMotion ? 6 : 12)
  const side = spot % 2 ? 1 : -1
  const slide = reducedMotion || t===1 ? 0 : side * Math.sin(Math.PI * t) ** 2
  const sin = Math.sin(start.heading), cos = Math.cos(start.heading)
  const x = start.x + forward * sin + slide * cos
  const z = start.z + forward * cos - slide * sin
  const ground = sampleGround(x, z, start.y)
  return {x, y:ground.y, z, heading:start.heading + slide * .62, roll:-slide * .09,
    pitch:Math.atan(ground.grade * (sin * ground.tangentX + cos * ground.tangentZ)), lift:0, bodyPitch:0}
}

// Separating axes of both car footprints, with a small buffer for the bodywork.
export function carsOverlap(a, b) {
  if (Math.abs(a.y - b.y) > 1.6 || Math.hypot(a.x - b.x, a.z - b.z) > 5.5) return false
  const axes = pose => [[Math.sin(pose.heading), Math.cos(pose.heading)], [Math.cos(pose.heading), -Math.sin(pose.heading)]]
  const aa = axes(a), bb = axes(b)
  const dot = ([x,z],[u,v]) => x*u + z*v
  const radius = (axis, [forward, side]) => 2.45 * Math.abs(dot(axis, forward)) + 1.18 * Math.abs(dot(axis, side))
  return [...aa, ...bb].every(axis => Math.abs(dot(axis, [a.x - b.x, a.z - b.z])) < radius(axis, aa) + radius(axis, bb))
}
