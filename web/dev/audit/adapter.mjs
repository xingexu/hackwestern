import {createCameraPlacement,nearPlaneClearance} from '../../look/drive-camera.mjs'
import * as THREE from 'three'
import {createCameraRig} from '../../frame-pacing.mjs'
import {createDriveSim} from '../../drive-sim.mjs'
import {buildingSurvey} from './buildings.mjs'
import {campusSeat,campusBikeRack} from '../../street-detail.js'
import {spatialIndex} from './spatial.mjs'

const materials=new WeakMap(), images=new WeakMap()

function uniforms(material) {
  if (!materials.has(material)) {
    const shader={uniforms:{},vertexShader:'',fragmentShader:''}
    material.onBeforeCompile(shader)
    materials.set(material,Object.fromEntries(Object.entries(shader.uniforms).map(([name,u])=>[name,u.value])))
  }
  return materials.get(material)
}

function textureAt(texture,u,v,channel=0,linear=false) {
  const image=texture.image
  let pixels=image.data
  if (!pixels) {
    if(!images.has(image)) {
      const ctx=new OffscreenCanvas(image.width,image.height).getContext('2d')
      ctx.drawImage(image,0,0)
      images.set(image,ctx.getImageData(0,0,image.width,image.height).data)
    }
    pixels=images.get(image)
  }
  const {width,height}=image,channels=pixels.length/(width*height)
  const get=(x,y)=>pixels[(Math.max(0,Math.min(height-1,y))*width+Math.max(0,Math.min(width-1,x)))*channels+channel]
  if(!linear) return get(Math.floor(u*width),Math.floor(v*height))
  const x=u*width-.5,y=v*height-.5,i=Math.floor(x),j=Math.floor(y),a=x-i,b=y-j
  return (get(i,j)*(1-a)+get(i+1,j)*a)*(1-b)+(get(i,j+1)*(1-a)+get(i+1,j+1)*a)*b
}

function sample(texture,bounds,x,z,linear=false) {
  return textureAt(texture,(x-bounds.x)/(bounds.z-bounds.x),(z-bounds.y)/(bounds.w-bounds.y),0,linear)
}

function classify(mesh,campus) {
  if(mesh.userData.buildingRanges) return 'building'
  if(mesh.name==='Terrain-conforming field surfaces') return 'field'
  if(mesh.userData.auditKind) return mesh.userData.auditKind
  if(mesh.parent.name.startsWith('Municipal ') && !mesh.isInstancedMesh) return 'municipal'
  if(mesh===campus.sprintRoad || mesh.name.includes('lane markings')) return 'paint'
  if(mesh.name.startsWith('Terrain ')) return 'terrain'
  if(mesh.name.includes('campus grounds')) return 'estate'
  if(mesh.name.includes('North Thames')) return 'water'
  if(mesh.geometry.attributes.leaf) return 'tree'
  if(mesh.isInstancedMesh && mesh.material.alphaTest>0) return 'leaves'
  if(mesh.parent.userData.updateLevels) return mesh.geometry.type==='CylinderGeometry'?'limb':'leaves'
  if(mesh.geometry.attributes.paving) return 'deck'
  if(mesh.material===campus.buildingMaterial) return 'building'
  for(let parent=mesh;parent;parent=parent.parent) {
    if(/Surveyed roofs|Street reference architecture/.test(parent.name)) return 'building'
    if(/grass verges/.test(parent.name)) return 'leaves'
    if(parent.name.includes('canopy clusters')) return parent===mesh?'leaves':'branch'
    if(parent.name==='Western campus region' && mesh.isInstancedMesh) return 'tree'
  }
  return 'prop'
}

const deckSwatches=new Map(Object.entries({road:[0x677077,0x717777],path:[0xc3bfb1,0xa29a84,0x988568],kerb:[0xbcb8ac],gutter:[0x999d99],paint:[0xd3b26a,0xe0dfcf],prop:[0x777f7d,0x555e5b,0x99958c,0x999789]}).flatMap(([name,colors])=>colors.map(color=>[color,name])))
export function traversableKerb(item,tri,vertex,groundAt) {
  if(item.kind!=='deck' || item.mesh.name) return false
  const rgb=new THREE.Color().fromBufferAttribute(item.geometry.attributes.color,vertex).getHex()
  if(![0xbcb8ac,0x999789,0x999d99].includes(rgb)) return false
  return tri.every(p=>p.y-groundAt(p.x,p.z)<=.16)
}

function surface(hit,x,z) {
  const {mesh,kind}=hit.item
  if(kind==='field' && mesh.material.transparent && hit.uv && Math.abs(hit.uv.x)>hit.uv.y)return 'discard'
  if(kind==='tree' && mesh.geometry.attributes.leaf?.getX(hit.face.a)>.5)return 'leaves'
  if(kind==='deck') {
    const color=new THREE.Color().fromBufferAttribute(mesh.geometry.attributes.color,hit.face.a)
    const hex=color.getHex(),paint=deckSwatches.get(hex)??'road'
    if(hex===0xa29a84 && mesh.name==='Bridge decks and approaches' && Math.abs(hit.face.normal.y)<.96) return 'bank'
    if(paint==='kerb' && mesh.name==='Bridge decks and approaches') return 'rail'
    if(mesh.geometry.attributes.paving.getZ(hit.face.a)>.5) {
      const u=uniforms(mesh.material)
      if(u.streetCoverage && sample(u.streetCoverage,u.streetBounds,x,z,true)>.52*255) return 'discard'
    }
    return paint
  }
  if(kind==='estate') {
    const {parcelClasses,parcelBounds:b}=uniforms(mesh.material)
    const u=(x-b.x)/(b.z-b.x),v=(z-b.y)/(b.w-b.y)
    return textureAt(parcelClasses,u,v,2,true)>=127.5?'path':textureAt(parcelClasses,u,v,1,true)>=127.5?'road':'grass'
  }
  if(kind!=='terrain') return kind
  const u=uniforms(mesh.material)
  const code=sample(u.coverMap,u.coverBounds,x,z)
  
  if(code===6) return 'water'
  if(sample(u.pavementMap,u.surveyBounds,x,z,true)>=127.5) return 'road'
  const finish=u.finishMap
  if(finish && hit.uv && textureAt(finish,hit.uv.x*finish.repeat.x+finish.offset.x,hit.uv.y*finish.repeat.y+finish.offset.y,2,true)>127.5) return 'path'
  const b=u.coverBounds
  if(textureAt(u.landTransitions,(x-b.x)/(b.z-b.x),(z-b.y)/(b.w-b.y),3,true)>=127.5) return 'road'
  const tex=u.landTransitions,cu=(x-b.x)/(b.z-b.x),cv=(z-b.y)/(b.w-b.y)
  const {width,height}=tex.image,tx=cu*width-.5,tz=cv*height-.5
  const ix=Math.floor(tx),iz=Math.floor(tz),weights=new Map()
  const className=n=>({3:'path',6:'water',7:'field',8:'field',9:'field',5:'road'})[n]??'grass'
  for(let dz=0;dz<2;dz++) for(let dx=0;dx<2;dx++){
    const px=(ix+dx+.5)/width,pz=(iz+dz+.5)/height
    const first=textureAt(tex,px,pz,0),second=textureAt(tex,px,pz,1),mix=textureAt(tex,px,pz,2)/255
    const weight=(dx?tx-ix:1-tx+ix)*(dz?tz-iz:1-tz+iz)
    for(const [id,w] of [[first===5?second:first,mix],[second===5?first:second,1-mix]]){
      const k=className(id)
      weights.set(k,(weights.get(k)??0)+w*weight)
    }
  }
  return [...weights].sort((a,b)=>b[1]-a[1])[0][0]
}

export async function adapter({scene,campus,renderer,camera:gameCamera,renderView,updateShadow,coupe,interior,sprintProps,collision}) {
  coupe.visible=interior.visible=false
  const roots=[campus.scenery,sprintProps,...scene.children.filter(m=>m.isMesh && m.material===campus.buildingMaterial)]
  const network=campus.network
  const starts=new Map()
  for(const way of campus.roadData.ways) {
    let offset=0
    for(let i=1;i<way.points.length;i++) {
      const [x,,z]=way.points[i-1],[ex,,ez]=way.points[i]
      const length=Math.hypot(ex-x,ez-z)
      if(!length) continue
      for(;offset<length;offset+=10) {
        const px=x+(ex-x)*offset/length,pz=z+(ez-z)*offset/length
        const id='x'+Math.floor(px/50)+'z'+Math.floor(pz/50)
        if(!starts.has(id)) starts.set(id,[])
        starts.get(id).push([px,pz])
      }
      offset-=length
    }
  }
  const anchors=new Map()
  function anchor(x,z,kind,type,r) {
    const key='x'+Math.floor(x/50)+'z'+Math.floor(z/50)
    if(!anchors.has(key)) anchors.set(key,[])
    anchors.get(key).push({x,z,kind,type,r})
  }
  const {region,survey,trees,municipalData,features}=campus.auditSources
  for(const tile of Object.values(municipalData.tiles)) for(const type of ['lamps','trees']) {
    for(const [x,z,,,dbh] of tile[type]??[]) anchor(x,z,'municipal',type,type==='trees'?Math.max(.12,dbh+.035):.27)
  }
  for(const tile of Object.values(survey.tiles)) for(const [x,z] of tile.stems??[]) anchor(x,z,'branch','LiDAR trunk',.30)
  for(const [x,,z] of trees.trees) anchor(x,z,'limb','core trunk',.30)
  for(const tile of Object.values(features.tiles)) for(const [type,id,x,,z,yaw,,,count] of tile.p??[]) {
    const foot=(u,t)=>anchor(x+Math.cos(yaw)*u+Math.sin(yaw)*t,z-Math.sin(yaw)*u+Math.cos(yaw)*t,'prop',type,.18)
    if(['traffic_signals','stop','bus_stop','street_lamp','phone','flagpole','fire_hydrant','parking_entrance','post_box'].includes(type))foot(0,0)
    const fixtureFoot=(u,y,t,w,h)=>{if(y-h*.5<.006)foot(u,t)}
    if(type==='bench')campusSeat(fixtureFoot,1.8,features.furnitureStyles?.[id])
    if(type==='picnic_table')for(const u of [-.59,.59])foot(u,0)
    if(type==='shelter')for(const u of [-1.42,1.42])for(const t of [-.74,.74])foot(u,t)
    if(type==='bicycle_parking')campusBikeRack(fixtureFoot,count,features.furnitureStyles?.[id])
  }
  const tieCamera=new THREE.OrthographicCamera(-.5,.5,.5,-.5,.05,80)
  tieCamera.up.set(0,0,-1)
  function layerConflict(pair,x,z) {
    const [a,b]=pair.map(h=>h.item.mesh),saved=[a.renderOrder,b.renderOrder]
    const gl=renderer.getContext(),colors=[]
    tieCamera.position.set(x,pair[0].y+30,z)
    tieCamera.lookAt(x,pair[0].y,z)
    renderer.setSize(32,32,false)
    try {
      for(const sign of [-1,1]){
        a.renderOrder=sign*500;b.renderOrder=-a.renderOrder
        renderView(tieCamera)
        const pixels=new Uint8Array(36)
        gl.readPixels(Math.floor(gl.drawingBufferWidth/2)-1,Math.floor(gl.drawingBufferHeight/2)-1,3,3,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
        colors.push(pixels)
      }
    } finally {[a.renderOrder,b.renderOrder]=saved}
    const diffs=Array.from({length:9},(_,i)=>Math.max(...[0,1,2].map(c=>Math.abs(colors[0][i*4+c]-colors[1][i*4+c])))).sort((a,b)=>a-b)
    if(diffs[4]>=3) return {medianRgbChange:diffs[4],maxRgbChange:diffs[8],pixels:9}
  }
  return {
    layerConflict,
    vegetation(){
      const stems=[],lamps=[],props=[],understory=[];
      for(const entry of Object.values(municipalData.tiles)){
        for(const [x,z,h,r,,form] of entry.trees??[])stems.push(['municipal',x,z,h,r,form]);
        lamps.push(...(entry.lamps??[]).map(p=>p.slice(0,5)));
        understory.push(...(entry.understory??[]));
      }
      for(const [x,y,z,r,height,,,,form] of trees.trees)stems.push(['core',x,z,height-y+.8*r,r,form]);
      for(const [x,,z,h,,diam] of region.trees)stems.push(['regional',x,z,h,diam*.5]);
      for(const entry of Object.values(survey.tiles))for(const [x,z,h] of entry.stems??[])stems.push(['survey',x,z,h,h*.30]);
      for(const entry of Object.values(features.tiles))for(const [kind,id,x,,z,yaw] of entry.p??[]){
        props.push([kind,x,z,yaw,id]);
        if(kind==='street_lamp')lamps.push([x,z,6.2,yaw,1]);
      }
      return {stems,lamps,props,understory};
    },
    anchors:cell=>anchors.get(cell.id)??[],
    roadStarts:cell=>starts.get(cell.id)??[],
    buildings:buildingSurvey(campus.buildingRecords),
    async focus(cell) {
      collision.invalidate()
      campus.updateDetail(cell.x+25,cell.z+25,95,true)
      const deadline=performance.now()+60000
      while(!campus.facades.settledNear(120)){
        if(performance.now()>deadline) throw new Error('Building LOD did not settle in '+cell.id)
        await new Promise(resolve=>setTimeout(resolve,20))
      }
    },
    index(cell) {
      scene.updateMatrixWorld(true)
      return spatialIndex(roots,cell,m=>classify(m,campus),(item,tri,vertex)=>traversableKerb(item,tri,vertex,network.groundAt))
    },
    column(index,x,z) {
      const hits=index.column(x,z)
      for(const hit of hits) {
        hit.kind=surface(hit,x,z)
        if(hit.kind==='building'){
          const data=hit.item.mesh.userData,index=data.boxIds?.[hit.item.instance]??hit.face.a
          hit.parkingFloor=hit.face.normal.y>.85 && data.parkingFloors?.has(hit.item.mesh.geometry.attributes.finishId.getX(hit.face.a))
          hit.owner=data.buildingRanges?.find(row=>index<row[data.boxIds?2:1])?.[0]
        }
      }
      return hits.filter(h=>h.kind!=='discard')
    },
    sample:(x,z,y)=>network.sample(x,z,y),
    blockerKind:(x,z,y,r)=>network.blockerKind(x,z,y,r),
    solidSource:(x,z,y,r)=>network.solidSource(x,z,y,r),
    blocked:(x,z,y,r)=>network.blocked(x,z,y,r),
    inside:(x,z)=>network.withinCampus(x,z),
    simulate(point,heading,onBlock){
      const watched=onBlock?{...network,blocked(x,z,y,r){
        const reason=network.blockerKind(x,z,y,r)
        if(reason)onBlock(x,z,y,r,reason)
        return Boolean(reason)
      }}:network
      return createDriveSim([{...point,heading,distance:0}],{mode:'roam',network:watched})
    },
    cameraRig(start) {
      const rig=createCameraRig()
      rig.reset(start)
      const placement=createCameraPlacement(collision,network,rig),eye=new THREE.Vector3()
      const radius=nearPlaneClearance({fov:55,zoom:1,near:gameCamera.near,aspect:renderer.domElement.clientWidth/renderer.domElement.clientHeight})
      return car=>{
        const dt=9/120,view=rig.update(car,dt)
        return placement.chase(eye,car,view,dt,radius).toArray()
      }
    },
    cameraPose(anchor,heading,kind,width,height) {
      const car={...anchor,heading,bodyPitch:0,roll:0,pitch:anchor.pitch??0}
      const rig=createCameraRig()
      rig.reset(car)
      const view=rig.update(car,0),placement=createCameraPlacement(collision,network,rig)
      const radius=nearPlaneClearance({fov:55,zoom:1,near:gameCamera.near,aspect:width/height})
      const sin=Math.sin(heading),cos=Math.cos(heading),eye=new THREE.Vector3()
      const driver=kind==='eye'
      if(driver){
        eye.set(.34,1.17,-.19).applyEuler(new THREE.Euler(-view.pitch*.60,heading,0,'YXZ'))
        eye.add(new THREE.Vector3(car.x,car.y+.012,car.z))
        placement.driver(eye,car,view,radius)
      }else placement.chase(eye,car,view,0,radius)
      const pitch=driver?Math.tan(view.pitch*.6)-.035:Math.tan(view.pitch*.65)-.131
      return {eye:eye.toArray(),at:[eye.x+sin*14,eye.y+14*pitch,eye.z+cos*14],fov:55,width,height}
    },
    render(pose) {
      const {width,height,at,eye,up}=pose
      const camera=pose.span?new THREE.OrthographicCamera(-pose.span/2,pose.span/2,pose.span/2,-pose.span/2,.1,900):gameCamera
      if(pose.span && pose.layer!=='ground')camera.layers.mask=gameCamera.layers.mask
      if(!pose.span){camera.fov=pose.fov;camera.aspect=width/height;camera.updateProjectionMatrix()}
      camera.position.fromArray(eye)
      camera.up.fromArray(up??[0,1,0])
      camera.lookAt(...at)
      updateShadow({x:at[0],y:at[1],z:at[2]},true)
      renderer.setSize(width,height,false)
      const hidden=[]
      if(pose.layer==='ground') {
        for(const root of roots) root.traverseVisible(mesh=>{
          if(mesh.isMesh && !['terrain','estate','water','paint','deck','field'].includes(classify(mesh,campus))) hidden.push(mesh)
        })
        for(const exterior of [campus.context,campus.backdrop]) exterior?.traverseVisible(mesh=>{
          if(mesh.isInstancedMesh)hidden.push(mesh)
        })
        for(const mesh of hidden) mesh.visible=false
      }
      const background=scene.background
      if(pose.span)scene.background=new THREE.Color(0xe2e2e2)
      try {
        renderView(camera)
        return renderer.domElement.toDataURL('image/png').split(',')[1]
      } finally {
        scene.background=background
        for(const mesh of hidden) mesh.visible=true
      }
    }
  }
}
