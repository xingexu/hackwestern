const pi = Math.PI
const quarter = pi / 4
const half = pi / 2

export function sin(angle) {
  let x = angle - 2 * pi * Math.round(angle / (2 * pi))
  if (x > half) x = pi - x
  if (x < -half) x = -pi - x
  const z = x * x
  return x * (1 + z * (-1/6 + z * (1/120 + z * (-1/5040 + z * (1/362880 + z * (-1/39916800 + z / 6227020800))))))
}

export const cos = x => sin(x + half)
export const tan = x => sin(x) / cos(x)
export const hypot = (x, y) => Math.sqrt(x*x + y*y)

export function atan(value) {
  const abs = Math.abs(value)
  const inv = abs > 1
  let x = inv ? 1 / abs : abs
  const reduce = x > .414213562373095
  if (reduce) x = (x - 1) / (x + 1)
  const z = x*x
  const poly = x * (1 + z * (-1/3 + z * (1/5 + z * (-1/7 + z * (1/9 + z * (-1/11 + z * (1/13 - z/15)))))))
  const a = (reduce ? quarter : 0) + poly
  return Math.sign(value) * (inv ? half - a : a)
}

export function atan2(y, x) {
  if (x > 0) return atan(y / x)
  if (x < 0) return atan(y / x) + (y < 0 ? -pi : pi)
  return Math.sign(y) * half
}

export function tanh(x) {
  if (Math.abs(x) >= 5) return Math.sign(x)
  const z = x*x
  return x*(135135 + z*(17325 + z*(378 + z))) / (135135 + z*(62370 + z*(3150 + 28*z)))
}

function fractionalPower(x, exponent) {
  let root = x, product = 1
  for (let i = 0; i < 32; i++) {
    root = Math.sqrt(root)
    exponent *= 2
    if (exponent >= 1) {
      product *= root
      exponent--
    }
  }
  return product
}

function interpolateTable(count, density, sample) {
  const values = Float64Array.from({length: count}, (_, i) => sample(i/density))
  return x => {
    const index = x*density
    const low = Math.floor(index)
    if (low >= count-1) return sample(x)
    return values[low] + (values[low+1]-values[low])*(index-low)
  }
}

export const steeringPower = interpolateTable(4097, 32, speed => (speed/19)*fractionalPower(speed/19, .45))
export const loadSensitivity = interpolateTable(8193, .5, load => 1/fractionalPower(Math.max(1,load)/3800, .075))
