export const profiles=['gamepad','keyboard','tilt','buttons','wheel']
export const inputProfile=input=>profiles.includes(input.profile)?input.profile:input.digitalSteer?'keyboard':'gamepad'

export function changedInput(a,b){
  return ['steer','throttle','brake','handbrake'].some(k=>Math.abs((a?.[k]??0)-(b[k]??0))>.025)
}

export function speedKph(car){
  return 3.6*Math.sqrt(car.speed*car.speed+car.lateralSpeed*car.lateralSpeed)
}
