import {carsOverlap,finishDuration,finishHold,finishPose} from '../race/online-race.mjs'
import {contact} from '../net/motion.mjs'

export function createFleet(THREE,scene,coupe,audio,sampleGround){
  const cars=new Map(),localPaint=coupe.children[0].material,originalColor=localPaint.color.clone()
  let clearing=true, poses=[]
  function add(p){
    const model=new THREE.Group(),materials=new Map()
    const clone=m=>{
      if(!materials.has(m)){const copy=m.clone();if(m===localPaint)copy.color.set(p.color);materials.set(m,copy)}
      return materials.get(m)
    }
    for(const part of coupe.children)model.add(part.clone())
    model.traverse(mesh=>{
      if(mesh.material)mesh.material=Array.isArray(mesh.material)?mesh.material.map(clone):clone(mesh.material)
    })
    const canvas=document.createElement('canvas')
    canvas.width=320;canvas.height=64
    const ctx=canvas.getContext('2d'),texture=new THREE.CanvasTexture(canvas)
    const tag=new THREE.Sprite(new THREE.SpriteMaterial({map:texture}))
    tag.position.y=2.4;tag.scale.set(3,.6,1);model.add(tag);model.visible=false;scene.add(model)
    const row={model,materials,slot:p.slot,id:p.id,rename(name){
      model.name='Racer '+name;ctx.fillStyle='#1c2534';ctx.fillRect(0,0,320,64)
      ctx.fillStyle='white';ctx.font='600 26px system-ui';ctx.textAlign='center';ctx.fillText(name,160,41,304)
      texture.needsUpdate=true;row.nickname=name
    },dispose(){
      scene.remove(model);for(const m of materials.values())m.dispose()
      texture.dispose();tag.material.dispose();for(const mesh of model.children)if(mesh.isInstancedMesh)mesh.dispose()
    }}
    row.rename(p.nickname);cars.set(p.id,row)
  }
  return {
    get poses(){return poses},
    respawn(){clearing=true},
    roster(players,me){
      for(const [id,row] of cars)if(!players.some(p=>p.id===id && p.connected)){row.dispose();cars.delete(id)}
      for(const p of players)if(p.connected && p.id!==me){
        if(!cars.has(p.id))add(p)
        const row=cars.get(p.id)
        if(row.nickname!==p.nickname)row.rename(p.nickname)
        row.finished=Boolean(p.finish || p.dnf)
        row.finishStart=p.finishStart
        row.grid=p.grid??p.slot
      }
      localPaint.color.set(players.find(p=>p.id===me)?.color??originalColor)
    },
    separate(local,finishing){
      const visible=[{pose:local,finishing}]
      // Give active racers the road. Occlude a conflicting finish model until footprints separate.
      const painted=[...cars.values()].filter(row=>row.model.visible).sort((a,b)=>Number(!!a.finishStart)-Number(!!b.finishStart)
        || (a.finishStart?.at??0)-(b.finishStart?.at??0) || a.slot-b.slot)
      for(const row of painted){
        const finishing=Boolean(row.finishStart)
        if(visible.some(other=>(finishing || other.finishing) && carsOverlap(row.pose,other.pose)))row.model.visible=false
        else visible.push({pose:row.pose,finishing})
      }
    },
    update(session,car,collide,dt,serverNow,reducedMotion){
      const now=performance.now(),drawn=[]
      for(const row of cars.values()){
        const track=session.tracks.get(row.slot)
        const finishAge=serverNow-row.finishStart?.at
        const pose=row.finishStart
          ? finishAge<=finishDuration+finishHold && finishPose(row.finishStart,finishAge,row.grid,reducedMotion,sampleGround)
          : session.clock.synced && track?.draw(now)
        row.pose=pose
        row.model.visible=!!pose
        if(!pose)continue
        row.model.position.set(pose.x,pose.y+.012,pose.z)
        if(row.finishStart)row.model.rotation.set(-pose.pitch,pose.heading,pose.roll,'YXZ')
        else{
          row.model.quaternion.fromArray(pose.q)
          row.model.rotation.reorder('YXZ');row.model.rotation.y=pose.heading
        }
        if(pose.ghost!==row.ghost){
          for(const [src,m] of row.materials){
            m.transparent=src.transparent || pose.ghost;m.opacity=src.opacity*(pose.ghost?.4:1)
            m.depthWrite=src.depthWrite && !pose.ghost;m.needsUpdate=true
          }
          row.ghost=pose.ghost
        }
        if(!row.finishStart)drawn.push({track,pose,finished:row.finished})
      }
      poses=drawn.map(v=>v.pose)
      if(clearing && poses.length && poses.every(p=>Math.hypot(p.x-car.x,p.z-car.z)>2.3 || Math.abs(p.y-car.y)>1.5))clearing=false
      for(const {track,pose,finished} of drawn){
        track.clearIfSeparated(pose,[car,...poses.filter(o=>o!==pose)])
        if(collide && !clearing && !finished){
          const speed=car.speed
          if(contact(car,pose,dt)){
            const sin=Math.sin(car.heading),cos=Math.cos(car.heading)
            const dx=pose.x-car.x,dz=pose.z-car.z
            const closing=((speed*sin+car.lateralSpeed*cos-pose.vx)*dx+(speed*cos-car.lateralSpeed*sin-pose.vz)*dz)/Math.max(.01,Math.hypot(dx,dz))
            audio.mix?.impact('car',closing)
          }
        }
      }
    }
  }
}
