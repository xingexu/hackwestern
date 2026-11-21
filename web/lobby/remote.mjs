import {contact} from '../net/motion.mjs'

export function createFleet(THREE,scene,coupe){
  const cars=new Map(),localPaint=coupe.children[0].material,originalColor=localPaint.color.clone()
  let clearing=true
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
    respawn(){clearing=true},
    roster(players,me){
      for(const [id,row] of cars)if(!players.some(p=>p.id===id && p.connected)){row.dispose();cars.delete(id)}
      for(const p of players)if(p.connected && p.id!==me){
        if(!cars.has(p.id))add(p)
        else if(cars.get(p.id).nickname!==p.nickname)cars.get(p.id).rename(p.nickname)
      }
      localPaint.color.set(players.find(p=>p.id===me)?.color??originalColor)
    },
    update(session,car,collide,dt){
      const now=performance.now(),drawn=[]
      for(const row of cars.values()){
        const track=session.tracks.get(row.slot),pose=session.clock.synced && track?.draw(now)
        row.model.visible=!!pose
        if(!pose)continue
        row.model.position.set(pose.x,pose.y+.012,pose.z)
        row.model.quaternion.fromArray(pose.q)
        row.model.rotation.reorder('YXZ');row.model.rotation.y=pose.heading
        if(pose.ghost!==row.ghost){
          for(const [src,m] of row.materials){
            m.transparent=src.transparent || pose.ghost;m.opacity=src.opacity*(pose.ghost?.4:1)
            m.depthWrite=src.depthWrite && !pose.ghost;m.needsUpdate=true
          }
          row.ghost=pose.ghost
        }
        drawn.push({track,pose})
      }
      const poses=drawn.map(v=>v.pose)
      if(clearing && poses.length && poses.every(p=>Math.hypot(p.x-car.x,p.z-car.z)>2.3 || Math.abs(p.y-car.y)>1.5))clearing=false
      for(const {track,pose} of drawn){
        track.clearIfSeparated(pose,[car,...poses.filter(o=>o!==pose)])
        if(collide && !clearing)contact(car,pose,dt)
      }
    }
  }
}
