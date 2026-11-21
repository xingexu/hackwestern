import {approach, clamp, gainNode, transients, voiceBank} from './voices.mjs'

export const defaults = {master:.8, engine:.82, effects:.78, ambient:.55, interface:.72, mute:false, muteHidden:true}
const surfaces = {
  asphalt:[780,.16], concrete:[1410,.18], grass:[465,.31], gravel:[2400,.34], kerb:[590,.33]
}

export function createMixer(ctx) {
  const master = gainNode(ctx, ctx.destination)
  const ceiling = ctx.createWaveShaper()
  ceiling.curve = Float32Array.from({length:2049}, (_,i) => .95 * Math.tanh((i-1024)/1024))
  ceiling.connect(master)
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -12
  compressor.ratio.value = 5
  compressor.attack.value = .006
  compressor.release.value = .15
  compressor.connect(ceiling)
  const buses = Object.fromEntries(['engine','effects','ambient','interface'].map(name => [name, gainNode(ctx, compressor)]))
  const bank = voiceBank(ctx), shots = transients(ctx, buses)
  const exhaust = bank.motor(buses.engine), intake = bank.motor(buses.engine, true)
  const combustion = bank.hiss(buses.engine, 'bandpass', .9)
  const rolling = bank.hiss(buses.effects,'lowpass'), tyre = bank.hiss(buses.effects,'bandpass', 8)
  const air = bank.hiss(buses.effects,'lowpass'), brakes = bank.hiss(buses.effects,'bandpass', 3)
  const scrape = bank.hiss(buses.effects,'highpass')
  const leaves = bank.hiss(buses.ambient,'bandpass'), traffic = bank.hiss(buses.ambient,'lowpass')
  const remotes = new Map()
  let nextBird = 4, nextAbs = 0, gear = 0, nextImpact = 0
  function settings(values, hidden = false, now = ctx.currentTime) {
    for (const [name,bus] of Object.entries(buses)) approach(bus.gain, values[name] ** 2, now, .01)
    master.gain.cancelScheduledValues(now)
    if (values.mute || (hidden && values.muteHidden)) master.gain.setValueAtTime(0, now)
    else approach(master.gain, values.master ** 2, now, .01)
  }
  function impact(material, impulse, now = ctx.currentTime) {
    if (now < nextImpact || impulse < .45) return
    nextImpact = now + .105
    shots.strike(material, clamp(Math.sqrt(impulse / 15),.1,1.15), now)
  }
  function drive(car, input, env, now = ctx.currentTime) {
    const speed = Math.abs(car.speed), pace = clamp(speed / 48)
    const load = clamp(car.throttlePlate), firing = clamp(car.rpm,550,8000)/30
    const flutter = Math.sin(now*29.9)*.003 + Math.sin(now*17.4)*.004
    const cut = car.shiftRemaining > 0 ? .28 : car.rpm >= 6720 && load > .35 && Math.sin(now*87) > 0 ? .34 : 1
    if (gear && gear !== car.gear && speed > 1) shots.strike('shift',.26,now)
    gear = car.gear
    approach(exhaust.source.frequency, firing*(1+flutter), now, .018)
    approach(intake.source.frequency, firing*.5*(1+flutter*.65), now, .027)
    exhaust.set(190 + firing*(1.4+4.2*load), (.21+.24*load)*cut, now)
    intake.set(300+firing*(2+5*load), (.075+.24*load)*cut, now)
    combustion.set(200+firing*2.8, (.04+.13*load)*cut, now)
    const [hz,roughness] = surfaces[env.surface] ?? surfaces.asphalt
    rolling.set(hz*(.5+pace), roughness*Math.sqrt(pace),now)
    const slip = clamp((env.slip-.075)*4)*clamp(speed/5)
    tyre.set(780 + 430*slip + 65*Math.sin(now*22), (.52+.08*Math.sin(now*39))*slip*(env.surface==='grass'?.19:1), now)
    const brake = (car.gear < 0 ? input.throttle : input.brake) || 0
    brakes.set(1750+850*(1-pace), .09*brake*clamp(speed/4), now)
    if (env.abs && now >= nextAbs) {
      shots.strike('abs', .22*brake, now)
      nextAbs = now+.083
    }
    air.set(370+pace*1030, pace**1.6*.37, now)
    scrape.set(760+pace*520, env.scraping ? Math.min(.36,speed*.018) : 0, now)
    leaves.set(1430+330*Math.sin(now*.52), (.028+.034*(1+Math.sin(now*.73)))*env.trees, now)
    traffic.set(375+110*Math.sin(now*.32), (.03+.085*(1+Math.sin(now*.47)))*env.traffic, now)
    if (now >= nextBird && env.trees > .15) {
      shots.bird(now, env.trees)
      nextBird = now + 3.8 + Math.random()*6
    }
  }
  function fleet(car, poses, now = ctx.currentTime) {
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading)
    for (const voice of remotes.values()) voice.active = false
    for (const pose of poses) {
      const dx=pose.x-car.x, dz=pose.z-car.z, dy=pose.y-car.y
      const distance=Math.hypot(dx,dy,dz)
      if (distance>120 || pose.age>.5) continue
      let voice = remotes.get(pose.slot)
      if (!voice) {
        if (remotes.size>=8) continue
        const pan=ctx.createPanner()
        pan.panningModel='equalpower'
        pan.refDistance=3.5
        pan.connect(buses.engine)
        voice={engine:bank.motor(pan),pan}
        remotes.set(pose.slot,voice)
      }
      voice.active=true
      const relative = ((pose.vx-car.speed*sin-car.lateralSpeed*cos)*dx +
        (pose.vz-car.speed*cos+car.lateralSpeed*sin)*dz)/Math.max(1,distance)
      approach(voice.engine.source.frequency,clamp(pose.rpm,750,7200)/30*343/(343+clamp(relative,-90,90)), now)
      voice.engine.set(390+pose.rpm*.13, .28+.17*pose.gas, now)
      approach(voice.pan.positionX, dz*sin-dx*cos, now)
      approach(voice.pan.positionY, dy, now)
      approach(voice.pan.positionZ, -dx*sin-dz*cos, now)
    }
    for (const voice of remotes.values()) if (!voice.active) approach(voice.engine.gain.gain,0,now)
  }
  settings(defaults)
  return {settings, drive, fleet, impact, cue:shots.cue, reset(){gear=0;nextImpact=0}}
}
