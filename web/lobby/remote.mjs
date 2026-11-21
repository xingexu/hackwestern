import {Snapshots} from '../net/session.mjs'

export function createFleet(THREE, scene, coupe) {
  const fleet = new Map()
  const localPaint = coupe.children[0].material
  const originalColor = localPaint.color.clone()
  function add(player) {
    const model = new THREE.Group()
    for(const part of coupe.children) model.add(part.clone())
    const paint = localPaint.clone()
    paint.color.set(player.color)
    model.traverse(mesh=>{
      if(mesh.material===localPaint) mesh.material=paint
      else if(Array.isArray(mesh.material)) mesh.material=mesh.material.map(m=>m===localPaint?paint:m)
    })
    const canvas = document.createElement('canvas')
    canvas.width=320
    canvas.height=64
    const ctx=canvas.getContext('2d')
    ctx.fillStyle='#1c2534'
    ctx.fillRect(0,0,320,64)
    ctx.fillStyle='#fff'
    ctx.font='600 26px system-ui'
    ctx.textAlign='center'
    ctx.fillText(player.nickname,160,41,304)
    const texture=new THREE.CanvasTexture(canvas)
    const tag=new THREE.Sprite(new THREE.SpriteMaterial({map:texture}))
    tag.position.y=2.4
    tag.scale.set(3,.6,1)
    model.add(tag)
    model.visible=false
    model.name='Racer '+player.nickname
    scene.add(model)
    fleet.set(player.id,{model,states:new Snapshots(),dispose(){
      scene.remove(model)
      paint.dispose()
      texture.dispose()
      tag.material.dispose()
      for (const mesh of model.children) if (mesh.isInstancedMesh) mesh.dispose()
    }})
  }
  return {
    roster(players,me) {
      for(const [id,slot] of fleet) if(!players.some(p=>p.id===id && p.connected)){
        slot.dispose()
        fleet.delete(id)
      }
      for(const player of players) if(player.connected && player.id!==me && !fleet.has(player.id)) add(player)
      localPaint.color.set(players.find(p=>p.id===me)?.color ?? originalColor)
    },
    push(snapshot){fleet.get(snapshot.id)?.states.push(snapshot)},
    update(now,car,collide,dt) {
      for(const {model,states} of fleet.values()) {
        const remote=states.at(now)
        model.visible=Boolean(remote)
        if(!remote) continue
        model.position.set(remote.x,remote.y+.012,remote.z)
        model.rotation.y=remote.heading
        const dx=car.x-remote.x,dz=car.z-remote.z,d=Math.hypot(dx,dz)
        if(collide && d<1.9 && Math.abs(car.y-remote.y)<1.4 && d>.001){
          const push=Math.min(1.9-d,dt*4)
          car.x+=dx/d*push
          car.z+=dz/d*push
          car.speed*=Math.exp(-dt*2)
        }
      }
    }
  }
}
