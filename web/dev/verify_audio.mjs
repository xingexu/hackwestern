import assert from 'node:assert/strict'
import {engines,serve} from './race_browser.mjs'

const server=await serve(true)
const browser=await engines.chromium.launch()
try {
  const page=await browser.newPage()
  await page.goto(server.base+'/audio/mixer.mjs')
  const proof=await page.evaluate(async()=>{
    const {createMixer,defaults}=await import('/audio/mixer.mjs')
    const {drivingSounds}=await import('/audio/world.mjs')
    const {installAudio}=await import('/audio/settings.mjs')
    const {createDriveSim}=await import('/drive-sim.mjs')
    const rate=24000
    const campus={
      ambience:()=>({trees:.8,traffic:.9}),
      network:{
        sample:(x,z)=>({x,z,y:0,surface:'road',material:'asphalt',grade:0,tangentX:0,tangentZ:1,lateral:x,halfWidth:5}),
        blocked:(x,z,y,r)=>z+r>=18,
        solidNormal:()=>[0,-1],
        solidSource:()=>({owner:'architecture'}),
        blockerKind:()=> 'solid'
      }
    }
    const sim=createDriveSim([{x:0,y:0,z:0,distance:0,heading:0}],{mode:'roam',network:campus.network})
    const input={throttle:1,brake:0,steer:0}
    const idle={...sim.state}, ctx=new OfflineAudioContext(2,rate,rate)
    const mix=createMixer(ctx)
    let impact=0, material, fastest=idle
    const drive=drivingSounds({...mix,impact(kind,impulse){material=kind;impact=Math.max(impact,impulse);mix.impact(kind,impulse)}},campus)
    for(let i=0;i<850 && !impact;i++){
      const {speed,lateralSpeed}=sim.state
      sim.step(input)
      if(!sim.state.contact && sim.state.rpm>fastest.rpm)fastest={...sim.state}
      drive.collision(sim.state,speed,lateralSpeed,i/120)
    }
    const energy=data=>Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length)
    const impactRms=energy((await ctx.startRendering()).getChannelData(0))
    const environment={trees:1,traffic:1,surface:'asphalt',slip:0,abs:false,scraping:false}
    const unit={master:1,engine:0,effects:0,ambient:0,interface:0,mute:false,muteHidden:true}
    async function render(bus,car,slip=0) {
      const context=new OfflineAudioContext(2,rate,rate)
      const mixer=createMixer(context)
      mixer.settings({...unit,[bus]:1})
      mixer.drive(car,input,{...environment,slip},0)
      return (await context.startRendering()).getChannelData(0).slice(rate*.5)
    }
    function strongest(data,expected) {
      let best=0,peak=0
      for(let hz=Math.floor(expected*.65);hz<=expected*1.35;hz++){
        let re=0,im=0
        for(let i=0;i<data.length;i++){
          const angle=2*Math.PI*i*hz/rate
          re+=Math.cos(angle)*data[i];im+=Math.sin(angle)*data[i]
        }
        if(re*re+im*im>peak){peak=re*re+im*im;best=hz}
      }
      return best
    }
    const engine=[]
    for(const car of [idle,fastest]){
      const expected=car.rpm/30
      engine.push({rpm:car.rpm,expected,hz:strongest(await render('engine',car),expected)})
    }
    const skidNetwork={...campus.network,blocked:()=>false}
    const skid=createDriveSim([{x:0,y:0,z:0,distance:0,heading:0}],{mode:'roam',network:skidNetwork})
    let slip=0
    const tyres=drivingSounds({drive:(car,input,env)=>{slip=Math.max(slip,env.slip)},impact(){},cue(){}},campus)
    for(let i=0;i<560;i++){
      const controls=i<500?input:{...input,throttle:0,handbrake:1,steer:1}
      skid.step(controls)
      if(i>=500)tyres.update(skid.state,skid.wheels,controls,i/120,1/120,false,'roam')
    }
    const [quietTyres,sliding]=await Promise.all([0,slip].map(amount=>render('effects',fastest,amount).then(energy)))
    async function passBy(vx) {
      const context=new OfflineAudioContext(2,rate,rate)
      const mixer=createMixer(context)
      mixer.settings({...unit,engine:1})
      mixer.fleet(idle,[{slot:1,x:9,y:0,z:2,rpm:3000,gas:.7,vx,vz:0,age:0}])
      const sound=await context.startRendering()
      const left=sound.getChannelData(0).slice(rate*.5)
      return {hz:strongest(left,100),left:energy(left),right:energy(sound.getChannelData(1).slice(rate*.5))}
    }
    const approaching=await passBy(-40),receding=await passBy(40)
    const panel=document.createElement('details')
    document.body.append(panel)
    let offline
    window.AudioContext=class {
      constructor(){offline=new OfflineAudioContext(2,rate*2,rate);return offline}
    }
    const audio=installAudio(panel,campus)
    const asleep=!offline
    document.dispatchEvent(new Event('pointerup'))
    const sliders={}
    function set(key,value) {
      const e=document.querySelector('#audio-'+key)
      if(typeof value==='boolean')e.checked=value
      else e.value=value
      e.dispatchEvent(new Event('input'))
    }
    for(const key of Object.keys(defaults)) {
      if(typeof defaults[key]!=='number')continue
      set(key,50)
      sliders[key]=JSON.parse(localStorage.getItem('western.audio.v1'))[key]
      set(key,100)
    }
    audio.mix.drive(fastest,input,{...environment,slip:1})
    for(const name of ['tick','go','checkpoint','lap','finish','best','wrong','click'])audio.cue(name)
    for(const name of ['wall','tree','pole','fence','car','kerb','landing'])audio.mix.impact(name,40)
    const rms={}
    const sources=['master','engine','effects','ambient','interface']
    const frames=[]
    for(let i=0;i<sources.length;i++) for(const value of [100,50]){
      const key=sources[i]
      frames.push({at:.1+frames.length*.14,key,value})
    }
    for(const frame of frames) {
      offline.suspend(frame.at).then(()=>{
        for(const key of sources)set(key,key==='master'||key===frame.key||frame.key==='master'?100:0)
        set(frame.key,frame.value)
        if(frame.key==='interface')audio.cue('go')
        offline.resume()
      })
    }
    offline.suspend(1.52).then(()=>{
      for(const key of sources)set(key,100)
      Object.defineProperty(document,'hidden',{value:true,configurable:true})
      document.dispatchEvent(new Event('visibilitychange'))
      offline.resume()
    })
    offline.suspend(1.66).then(()=>{set('muteHidden',false);offline.resume()})
    offline.suspend(1.8).then(()=>{set('mute',true);offline.resume()})
    const output=(await offline.startRendering()).getChannelData(0)
    for(const {at,key,value} of frames) {
      const start=Math.round((at+.073)*rate)
      rms[key]??={}
      rms[key][value]=energy(output.slice(start,start+rate*.044))
    }
    const peak=output.reduce((m,x)=>Math.max(m,Math.abs(x)),0)
    return {asleep,engine,impact,material,impactRms,slip,approaching,receding,quietTyres,sliding,sliders,rms,peak,hidden:energy(output.slice(rate*1.55,rate*1.65)),hiddenEnabled:energy(output.slice(rate*1.7,rate*1.78)),muted:energy(output.slice(rate*1.85))}
  })
  assert.ok(proof.asleep)
  assert.ok(proof.engine[1].rpm>proof.engine[0].rpm*2)
  for(const {hz,expected} of proof.engine) assert.ok(Math.abs(hz-expected)<expected*.04,JSON.stringify(proof.engine))
  assert.ok(proof.sliding>proof.quietTyres*1.7,JSON.stringify(proof))
  assert.ok(proof.material==='wall' && proof.impact>2 && proof.impactRms>.001)
  for(const [name,rms] of Object.entries(proof.rms)) {
    assert.equal(proof.sliders[name],.5)
    assert.ok(rms[100]>.0001 && rms[50]/rms[100]>.08 && rms[50]/rms[100]<.55,name+' '+JSON.stringify(rms))
  }
  assert.ok(proof.approaching.hz>proof.receding.hz*1.17 && proof.approaching.left>proof.approaching.right*2)
  assert.equal(proof.hidden,0)
  assert.ok(proof.hiddenEnabled>.005)
  assert.equal(proof.muted,0)
  assert.ok(proof.peak>0 && proof.peak<1)
  console.log(JSON.stringify(proof,null,2))
} finally {
  await browser.close()
  server.close()
}
