export const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))

export function gainNode(ctx, destination, level = 0) {
  const node = ctx.createGain()
  node.gain.value = level
  node.connect(destination)
  return node
}

export function approach(param, value, now, seconds = .035) {
  param.setTargetAtTime(value, now, seconds)
}

function periodic(ctx, partials) {
  const imag = Float32Array.from([0, ...partials])
  return ctx.createPeriodicWave(new Float32Array(imag.length), imag)
}

export function voiceBank(ctx) {
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const exhaust = periodic(ctx, [1,.48,.37,.23,.28,.15,.12,.1,.08,.09,.055,.05])
  const induction = periodic(ctx, [.33,.87,.29,.57,.35,.14,.23,.18,.1,.07])
  function voice(bus, type, source, q) {
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.Q.value = q
    const gain = gainNode(ctx, bus)
    source.connect(filter).connect(gain)
    return {source, filter, gain, set(hz, level, now) {
      approach(filter.frequency, hz, now)
      approach(gain.gain, level, now)
    }}
  }
  function motor(bus, intake = false) {
    const source = ctx.createOscillator()
    source.setPeriodicWave(intake ? induction : exhaust)
    const engine = voice(bus, 'lowpass', source, .65)
    source.start()
    return engine
  }
  function hiss(bus, type, q = .7) {
    const source = ctx.createBufferSource()
    source.buffer = noise
    source.loop = true
    const band = voice(bus, type, source, q)
    source.start(0, Math.random() * noise.duration)
    return band
  }
  return {motor, hiss}
}

const bodies = {
  wall: [62, 119, 230, 850, .24],
  tree: [89, 171, 310, 460, .16],
  pole: [143, 477, 1123, 2400, .39],
  fence: [125, 731, 1823, 3400, .26],
  car: [81, 216, 539, 2300, .27],
  kerb: [67, 131, 266, 480, .13],
  landing: [45, 91, 167, 370, .29],
  shift: [93, 181, 382, 770, .1],
  click: [520, 1020, 1720, 3400, .036],
  abs: [126, 247, 460, 880, .033]
}

function resonances(ctx, [first, second, third, cutoff, decay]) {
  const buffer = ctx.createBuffer(1, Math.ceil(decay * 2.3 * ctx.sampleRate), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let grain = 0
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoff / ctx.sampleRate)
  for (let i = 0; i < data.length; i++) {
    const t = i / ctx.sampleRate, a = t * 2 * Math.PI
    grain += alpha * (Math.random() * 2 - 1 - grain)
    const skin = Math.sin(first * a + 2 * (1 - Math.exp(-42*t)))
    const shell = Math.sin(second * a) * .28 + Math.sin(third * a) * .17
    data[i] = Math.min(1, t * 750) * (.48 * skin * Math.exp(-5*t/decay)
      + shell * Math.exp(-3*t/decay) + .94 * grain * Math.exp(-7*t/decay))
  }
  return buffer
}

const melodies = {
  checkpoint: [[880,0,.095],[1174,.075,.16]],
  lap: [[659,0,.11],[880,.1,.14],[988,.23,.23]],
  finish: [[523,0,.19],[659,.12,.18],[784,.24,.21],[1046.5,.4,.34]],
  best: [[1174,.83,.13],[1568,.97,.27]],
  wrong: [[392,0,.12],[330,.2,.15]],
  tick: [[659.25,0,.09]],
  go: [[1046.5,0,.23]]
}

export function transients(ctx, buses) {
  const buffers = new Map()
  const slots = Array.from({length:16}, () => ({gain:ctx.createGain(), until:-1}))
  function play(bus, when, duration, volume, makeSource) {
    const slot = slots.find(voice => voice.until <= ctx.currentTime)
    if (!slot) return
    const source = makeSource()
    const end = when + duration
    slot.until = end + .002
    slot.gain.disconnect()
    slot.gain.connect(buses[bus])
    const env = slot.gain.gain
    env.cancelScheduledValues(when)
    env.setValueAtTime(0, when)
    env.linearRampToValueAtTime(volume, when + .004)
    env.exponentialRampToValueAtTime(.00001, end)
    source.connect(slot.gain)
    source.onended = () => source.disconnect()
    source.start(when)
    source.stop(end)
  }
  function strike(name, level = 1, now = ctx.currentTime) {
    if (!buffers.has(name)) buffers.set(name, resonances(ctx, bodies[name]))
    const buffer = buffers.get(name)
    const rate = .93 + Math.random() * .14
    const bus = name === 'click' ? 'interface' : name === 'shift' ? 'engine' : 'effects'
    play(bus, now, buffer.duration / rate, level, () => {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = rate
      return source
    })
  }
  function cue(name, now = ctx.currentTime) {
    if (name === 'click') return strike(name, .14, now)
    for (const [hz, offset, duration] of melodies[name]) {
      play('interface', now + offset, duration, name === 'wrong' ? .09 : .15, () => {
        const osc = ctx.createOscillator()
        osc.frequency.value = hz
        return osc
      })
    }
  }
  function bird(now, level) {
    const base = 1950 + Math.random() * 1050
    for (const offset of [0, .16]) {
      play('ambient', now + offset, .1, .065 * level, () => {
        const osc = ctx.createOscillator()
        osc.type='triangle'
        osc.frequency.setValueAtTime(base, now + offset)
        osc.frequency.exponentialRampToValueAtTime(base * 1.47, now + offset + .047)
        osc.frequency.exponentialRampToValueAtTime(base * 1.12, now + offset + .1)
        return osc
      })
    }
  }
  return {strike, cue, bird}
}
