import {cameraGeometry} from './look/camera-collision.mjs';
import {createCameraPlacement,nearPlaneClearance} from './look/drive-camera.mjs';
import {carContact,daylight,followShadows} from 'campus-daylight';
import {driveFinish} from 'drive-finish';
import {qualityControl} from 'look-quality';
import {installPhoneControls} from './phone/controls.mjs';
import {installTrial} from './race/trial.mjs';
import {installLandmarkFlash} from './landmark-flash.mjs';
import {adaptiveResolution,createCameraRig,interpolatePose,snapshotPose} from 'frame-pacing';
import * as THREE from 'three';
import { createDriveSim, readGamepad } from 'drive-sim';
import { createCoupe, createRoadside, createDriverInterior } from 'drive-art';

const byId = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

function clockTime(seconds) {
  const hundredths = Math.floor(seconds * 100 + 1e-7);
  return Math.floor(hundredths / 6000) + ':' + String(Math.floor(hundredths / 100) % 60).padStart(2, '0') + '.' + String(hundredths % 100).padStart(2, '0');
}

function streetAtlas(data) {
  const [left,top,right,bottom]=data.campusBoundary?.bounds??data.bounds;
  const paper=document.createElement('canvas');
  const scale=.7;
  paper.width=Math.ceil((right-left)*scale);
  paper.height=Math.ceil((bottom-top)*scale);
  const pen=paper.getContext('2d');
  pen.scale(scale,scale);
  pen.translate(-left,-top);
  if(data.campusBoundary){
    pen.beginPath();
    for(const rings of data.campusBoundary.polygons) for(const ring of rings){
      pen.moveTo(ring[0],ring[1]);
      for(let i=2;i<ring.length;i+=2) pen.lineTo(ring[i],ring[i+1]);
      pen.closePath();
    }
    pen.clip('evenodd');
  }
  for(const [type,tint,width] of [['path','#54655b',2],['road','#95a49a',4]]) {
    pen.strokeStyle=tint;
    pen.lineWidth=width;
    pen.beginPath();
    for(const way of data.ways) {
      if(way.kind!==type) continue;
      way.points.forEach(([x,,z],i)=>i ? pen.lineTo(x,z) : pen.moveTo(x,z));
    }
    pen.stroke();
  }
  return {paper,left,top,scale};
}

function createRouteMap(samples, atlas, mode) {
  const chart=byId('route-plan'), ink=chart.getContext('2d');
  const width=chart.width,height=chart.height;
  const xs=samples.map(s=>s.x), zs=samples.map(s=>s.z);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minZ=Math.min(...zs), maxZ=Math.max(...zs);
  const roam=mode==='roam';
  const scale=roam ? .92 : Math.min((width-30)/Math.max(1,maxX-minX),(height-28)/Math.max(1,maxZ-minZ));
  const line=new Path2D();
  samples.forEach((s,i)=>i ? line.lineTo(s.x,s.z) : line.moveTo(s.x,s.z));
  return car=>{
    const cx=roam?car.x:(minX+maxX)/2, cz=roam?car.z:(minZ+maxZ)/2;
    ink.clearRect(0,0,width,height);
    ink.save();
    ink.translate(width/2,height/2);
    ink.scale(scale,scale);
    ink.translate(-cx,-cz);
    ink.globalAlpha=roam ? .95 : .40;
    ink.drawImage(atlas.paper,atlas.left,atlas.top,atlas.paper.width/atlas.scale,atlas.paper.height/atlas.scale);
    ink.globalAlpha=1;
    if(!roam){
      ink.strokeStyle='#eee1ba';
      ink.lineWidth=3.2/scale;
      ink.lineJoin='round';
      ink.stroke(line);
      const gate=car.nextGate??samples.at(-1);
      ink.fillStyle='#a2dfc2';
      ink.fillRect(gate.x-4/scale,gate.z-4/scale,8/scale,8/scale);
    }
    ink.translate(car.x,car.z);
    ink.rotate(-car.heading);
    ink.scale(1/scale,1/scale);
    ink.beginPath();
    ink.moveTo(0,9);ink.lineTo(6,-6);ink.lineTo(0,-3);ink.lineTo(-6,-6);ink.closePath();
    ink.fillStyle='#f9c35c';ink.strokeStyle='#182b23';ink.lineWidth=2;ink.fill();ink.stroke();
    ink.restore();
  };
}

function photoSpawn(frame,campus){
  const heading=Math.PI-frame.heading*Math.PI/180;
  const faceX=Math.sin(heading),faceZ=Math.cos(heading);
  let best=Infinity,location;
  for(const way of campus.roadData.ways){
    if(way.kind!=='road' || way.onDeck) continue;
    for(let i=1;i<way.points.length;i++){
      const [ax,ay,az]=way.points[i-1],[bx,by,bz]=way.points[i];
      const dx=bx-ax,dz=bz-az,sq=dx*dx+dz*dz;
      if(!sq) continue;
      const t=THREE.MathUtils.clamp(((frame.x-ax)*dx+(frame.z-az)*dz)/sq,0,1);
      const cx=ax+t*dx,cz=az+t*dz,offset=Math.hypot(frame.x-cx,frame.z-cz);
      if(offset>65) continue;
      const reach=Math.min(1,Math.max(0,way.width*.5-1.4)/Math.max(.01,offset));
      const x=cx+(frame.x-cx)*reach,z=cz+(frame.z-cz)*reach;
      const alignment=Math.abs(dx*faceX+dz*faceZ)/Math.sqrt(sq);
      const score=Math.hypot(frame.x-x,frame.z-z)+3*(1-alignment);
      if(score>=best) continue;
      const surface=campus.network.sample(x,z,ay+t*(by-ay));
      if(surface.surface!=='road' || [-1.5,0,1.5,4].some(d=>
        campus.network.blocked(x+d*faceX,z+d*faceZ,surface.y,1.05))) continue;
      best=score;location={x,y:surface.y,z,distance:0,heading};
    }
  }
  return location;
}

function landmarkSpawns(campus,coreLabels) {
  const choices=new Map([['University Drive',campus.samples[0]]]);
  const streets=campus.roadData.ways.filter(w=>w.kind==='road' && w.width>=4);
  const destinations=[...new Map([...coreLabels,...campus.labels].map(label=>[label.name,label])).values()];
  const pin=params.has('east') && params.has('south') ? {x:Number(params.get('east')),z:Number(params.get('south')),name:'Map location'} : null;
  if(pin && Number.isFinite(pin.x) && Number.isFinite(pin.z) && campus.network.withinCampus(pin.x,pin.z)) destinations.push(pin);
  for(const label of destinations){
    if(!campus.network.withinCampus(label.x,label.z)) continue;
    let closest=Infinity, location;
    for(const way of streets){
      for(let i=0;i<way.points.length-1;i++){
        const [x,y,z]=way.points[i], [ex,,ez]=way.points[i+1];
        const dx=label.x-x, dz=label.z-z;
        const range=Math.hypot(dx,dz);
        if(label!==pin && range>240) continue;
        const length=Math.hypot(ex-x,ez-z)||1;
        const cosine=((ex-x)*dx+(ez-z)*dz)/Math.max(1,length*range);
        const d=label===pin?range:Math.abs(range-68)+95*(1-Math.abs(cosine));
        if(d>=closest || campus.network.blocked(x,z,y,1.25)) continue;
        let heading=Math.atan2(ex-x,ez-z)+(cosine<0?Math.PI:0);
        if(label===pin){
          const clearDistance=angle=>{
            let length=0;
            for(let step=3;step<=30;step+=3){
              const px=x+step*Math.sin(angle), pz=z+step*Math.cos(angle);
              const surface=campus.network.sample(px,pz,y);
              if(surface.surface!=='road' || campus.network.blocked(px,pz,surface.y,1)) break;
              length=step;
            }
            return length;
          };
          if(clearDistance(heading+Math.PI)>clearDistance(heading)) heading+=Math.PI;
        }
        if([-1.4,1.4].some(offset=>campus.network.blocked(x+offset*Math.sin(heading),z+offset*Math.cos(heading),y,.93))) continue;
        location={x,y,z,distance:0,heading};
        closest=d;
      }
    }
    if(location) choices.set(label.name,location);
  }
  const id=params.get('capture');
  if(Object.hasOwn(campus.photoFrames,id)){
    const pose=photoSpawn(campus.photoFrames[id],campus);
    if(pose) choices.set('Street photograph',pose);
  }
  return choices;
}

function circuitGuidance() {
  const group=new THREE.Group();
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([
    -1.35,0,-.7, 0,0,.36, 0,0,1, -1.35,0,-.7, 0,0,1, -1.35,0,-.05,
    0,0,.36, 1.35,0,-.7, 1.35,0,-.05, 0,0,.36, 1.35,0,-.05, 0,0,1
  ],3));
  const material=new THREE.MeshBasicMaterial({color:0xffcf71,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-3});
  for(let i=0;i<6;i++) group.add(new THREE.Mesh(geometry,material));
  function update(samples,gate,network) {
    group.visible=Boolean(gate);
    if(!gate) return;
    const spacing=samples.at(-1).distance/(samples.length-1);
    const index=Math.min(samples.length-1,Math.round(gate.distance/spacing));
    group.children.forEach((marker,i)=>{
      const s=samples[Math.min(samples.length-1,index+Math.round(i*7/spacing))];
      const contact=network.sample(s.x,s.z,s.y);
      marker.position.set(s.x,s.y+.115,s.z);
      marker.rotation.set(-Math.atan(contact.grade*(Math.sin(s.heading)*contact.tangentX+Math.cos(s.heading)*contact.tangentZ)),s.heading,0,'YXZ');
    });
  }
  return {group,update};
}

export async function startDrive(world, volume, collectMeshes, campus, onlineMenu) {
  document.title = 'UC Hill Sprint · Western University';
  byId('view').setAttribute('aria-label', 'Chase camera on the UC Hill Sprint course');
  byId('status').textContent = 'Preparing University Drive…';
  const {scenery,network}=campus;
  const courses=[{id:'sprint',name:'UC Hill Sprint',samples:campus.samples},...network.circuits,{id:'roam',name:'Free roam'}];
  const starts=landmarkSpawns(campus,world.labels);
  const select=byId('drive-course'), spawn=byId('spawn');
  const atlas=streetAtlas(campus.roadData);
  select.replaceChildren(...courses.map(course=>new Option(course.name,course.id)));
  for(const name of starts.keys()) spawn.add(new Option(name,name));
  const photoStart=starts.has('Street photograph');
  const requestedPlace=params.get('place') || (photoStart?'Street photograph':params.has('east')?'Map location':'University Drive');
  if(starts.has(requestedPlace)) spawn.value=requestedPlace;
  let samples,length,sim,car,mode,routeMap;
  const { geometries } = await collectMeshes(world, volume);
  const scene = new THREE.Scene();
  const terrain = campus.buildingMaterial;
  for (const geometry of geometries) {
    const mesh = new THREE.Mesh(geometry, terrain);
    mesh.castShadow = mesh.receiveShadow = true;
    campus.boundary.attach(mesh);
    scene.add(mesh);
  }
  const sprintProps=createRoadside(THREE,campus.samples);
  const guidance=circuitGuidance();
  campus.boundary.attach(sprintProps);campus.boundary.attach(guidance.group);
  scene.add(scenery,sprintProps,guidance.group);
  if(campus.context)scene.add(campus.context);
  if(campus.backdrop)scene.add(campus.backdrop);
  const coupe = createCoupe(THREE);
  coupe.traverse(part => {
    part.castShadow = false;
    if (part.isMesh) part.receiveShadow = true;
  });
  coupe.add(carContact());
  coupe.rotation.order = 'YXZ';
  const { interior, instruments } = createDriverInterior(THREE, coupe.children[0]);
  scene.add(coupe, interior);
  byId('drive-graphics').append(byId('graphics-control'));
  const graphics=qualityControl();
  const renderer=new THREE.WebGLRenderer({canvas:byId('view'),antialias:true,powerPreference:'high-performance'});
  const sun=daylight(renderer,scene,true);
  const camera=new THREE.PerspectiveCamera(55,1,.12,870);
  camera.layers.enable(1);
  const updateShadow=followShadows(renderer,sun,graphics);
  const renderView=driveFinish(renderer,scene,camera,graphics);
  graphics.onChange(()=>{lastWidth=0;});

  const meters = byId('meters'), speed = byId('speed'), time = byId('time'), surface = byId('surface');
  const progress = byId('progress'), message = byId('drive-message'), finish = byId('finish');
  const hint=byId('input-hint');
  const keys = new Set();
  const commands = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
  let remaining = 0, previous = null, lastHud = -Infinity, finished = false, paused = false;
  const previousPose={},visiblePose={},quality=adaptiveResolution(),rig=createCameraRig();
  const sceneryRoots=[scenery,sprintProps,...scene.children.filter(mesh=>mesh.isMesh && mesh.material===terrain)];
  const collision=cameraGeometry(sceneryRoots,()=>{renderer.shadowMap.needsUpdate=true;});
  const placement=createCameraPlacement(collision,network,rig);
  let lastWidth = 0, lastHeight = 0,lastScale=1;
  let padConnected = false, padRestartDown = false;
  const phone=installPhoneControls(byId('touch-drive'));
  const landmarks=installLandmarkFlash({parent:byId('drive-ui'),labels:[...world.labels,...campus.labels],ways:campus.roadData.ways});
  let online;
  const visualHeight=pose=>network.sample(pose.x,pose.z,pose.y).y;
  const trial=installTrial({scene,reset,visualHeight,vibrate:phone.vibrate,ghostModel(){
    const ghost=createCoupe(THREE);
    ghost.name='Time trial ghost';
    const material=new THREE.MeshBasicMaterial({color:0x96eadd,transparent:true,opacity:.31,depthWrite:false});
    ghost.traverse(part=>{if (part.isMesh) {part.material=material;part.castShadow=false;part.receiveShadow=false;}});
    return ghost;
  }});
  function reset() {
    sim.reset();
    trial.begin();
    phone.driving(false);
    snapshotPose(previousPose,car);
    keys.clear();
    remaining = 0;
    previous = null;
    rig.reset(car);placement.reset();
    finished = false;
    finish.hidden = true;
    lastHud = -Infinity;
    paused = false;
    landmarks.hide();
    document.activeElement?.blur();
  }
  function changeCourse(id) {
    const course=courses.find(c=>c.id===id)??courses[0];
    mode=course.id==='sprint'?'sprint':course.id==='roam'?'roam':'circuit';
    trial.course(course.id);
    samples=trial.context?.samples??course.samples??[starts.get(spawn.value)];
    length=samples.at(-1).distance;
    sim=createDriveSim(samples,{mode,network:trial.context?.network??network});
    car=sim.state;
    routeMap=createRouteMap(samples,atlas,mode);
    byId('length').textContent=mode==='roam'?'Travelled':Math.round(length)+' m';
    byId('roam-start').hidden=mode!=='roam';
    byId('recover').hidden=mode!=='circuit';
    progress.hidden=mode==='roam';
    progress.max=length||1;
    select.value=course.id;
    document.title=course.name+' · Western University';
    byId('finish').querySelector('small').textContent=course.name.toUpperCase();
    byId('view').setAttribute('aria-label',course.name+' driving view');
    campus.sprintRoad.visible=sprintProps.visible=mode==='sprint';
    if(params.has('diagnostics')) window.driveMetrics={
      get net(){return online?.details()??[];},
      get opponents(){return scene.children.filter(child=>child.name.startsWith('Racer ') && child.visible).map(({name,position})=>({name,x:position.x,z:position.z}));},
      get ghostVisible(){return Boolean(scene.getObjectByName('Time trial ghost')?.visible);},
      car,sim,network,facades:campus.facades.group,buildingRecords:campus.buildingRecords,frames:0,length,mode,course:course.id,
      surveyView(position){
        Object.assign(car,position);
        snapshotPose(previousPose,car);
        rig.reset(car);placement.reset();
        remaining=0;
      },
      inspectLook:()=>({THREE,renderer,scene,camera,sun,graphics}),
      renderCanvas(){
        renderView();
        return renderer.domElement;
      }
    };
    campus.updateDetail(car.x,car.z,100,true);
    renderer.shadowMap.needsUpdate=true;
    reset();
  }
  select.onchange=()=>changeCourse(select.value);
  spawn.onchange=()=>changeCourse('roam');
  byId('recover').onclick=()=>{
    const spot=online?.recoverySpot(car),elapsed=car.elapsed;
    if(sim.recover)sim.recover();else sim.reset();
    if(spot)Object.assign(car,spot,{elapsed});
    snapshotPose(previousPose,car);remaining=0;rig.reset(car);placement.reset();
  };
  for(const button of document.querySelectorAll('[data-key]')){
    button.onpointerdown=e=>{e.preventDefault();button.setPointerCapture(e.pointerId);keys.add(button.dataset.key);};
    button.onlostpointercapture=()=>keys.delete(button.dataset.key);
  }
  let driverView = false;
  const viewToggle = byId('view-toggle');
  viewToggle.onclick = () => {
    driverView = !driverView;
    placement.reset();
    viewToggle.textContent = driverView ? 'Chase view' : 'Driver view';
    viewToggle.setAttribute('aria-pressed', String(driverView));
    viewToggle.setAttribute('aria-label', viewToggle.textContent);
    byId('view').setAttribute('aria-label', (driverView ? 'Driver eye view · ' : 'Chase camera · ')+select.selectedOptions[0].text);
  };
  byId('restart').onclick = byId('again').onclick = () => { if (online?.active) byId('recover').click(); else reset(); };
  window.addEventListener('keydown', event => {
    if (event.target.closest?.('select,input,dialog,textarea') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'KeyR' && !event.repeat) byId('restart').click();
    if (!commands.has(event.code)) return;
    event.preventDefault();
    keys.add(event.code);
  });
  window.addEventListener('keyup', event => keys.delete(event.code));
  function suspend() {
    phone.clear();
    phone.driving(false);
    keys.clear();
    previous = null;
    remaining = 0;
    snapshotPose(previousPose,car);
    paused = true;
  }
  window.addEventListener('blur', suspend);
  window.addEventListener('focus', () => { paused = false; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else paused = !document.hasFocus();
  });
  let gamepadsAvailable = typeof navigator.getGamepads === 'function';
  function connectedPad() {
    if (!gamepadsAvailable) return null;
    try {
      return Array.from(navigator.getGamepads()).find(p => p?.connected && p.mapping === 'standard');
    } catch (error) {
      if (error.name !== 'SecurityError') throw error;
      gamepadsAvailable = false;
      return null;
    }
  }
  function controls(dt) {
    const pad = connectedPad();
    padConnected = Boolean(pad);
    const restart = Boolean(pad?.buttons[9]?.pressed);
    if (restart && !padRestartDown) byId('restart').click();
    padRestartDown = restart;
    const input = readGamepad(pad);
    const down = (a, b) => keys.has(a) || keys.has(b);
    return {
      handbrake: Number(keys.has('Space') || pad?.buttons[0]?.pressed || false),
      digitalSteer: down('KeyA', 'ArrowLeft') || down('KeyD', 'ArrowRight'),
      throttle: Math.max(input.throttle, Number(down('KeyW', 'ArrowUp'))),
      brake: Math.max(input.brake, Number(down('KeyS', 'ArrowDown'))),
      steer: THREE.MathUtils.clamp(input.steer + phone.steer(dt) + Number(down('KeyA', 'ArrowLeft')) - Number(down('KeyD', 'ArrowRight')), -1, 1)
    };
  }
  function updateHud(timestamp) {
    if (timestamp - lastHud < 60) return;
    lastHud = timestamp;
    speed.textContent = Math.round(Math.abs(car.speed) * 3.6);
    byId('powertrain').textContent = (car.gear === -1 ? 'R' : 'D' + car.gear) + ' · ' + Math.round(car.rpm / 50) * 50 + ' RPM';
    time.textContent = clockTime(car.elapsed);
    meters.textContent = Math.round(car.distance) + ' m';
    progress.value = car.distance;
    surface.textContent = car.phase === 'ready' ? 'On grid' : car.speed < -.1 ? 'Reverse' : car.surface === 'grass' ? 'Grass' : 'Asphalt';
    if(mode!=='sprint' && car.speed>=-.1){
      const ground=network.sample(car.x,car.z,car.y);
      surface.textContent=ground.street || ({road:'Asphalt',path:'Campus path',grass:'Grass'}[ground.surface]);
    }
    if (paused && !online?.active && !online?.padConnected && car.phase === 'driving') message.textContent = 'Paused';
    else if (car.phase === 'ready') message.textContent = padConnected ? 'RT to start' : matchMedia('(pointer:coarse)').matches ? 'Touch Gas to start' : '↑ or W to start';
    else if(car.offCourse) message.textContent='Return to the marked route';
    else if(mode==='circuit' && car.nextGate) message.textContent='Checkpoint '+(car.checkpointsPassed+1)+' / '+car.checkpointCount;
    else message.textContent = '';
    hint.textContent = padConnected ? 'RT gas · LT brake / reverse · Left stick steer · Menu restart' : '↑ Gas · ↓ Brake / reverse · ← → Steer · WASD';
    guidance.update(samples,car.nextGate,network);
    routeMap(car);
    phone.driving(!paused && car.phase==='driving');
    if (car.phase === 'finished' && !finished && !online?.racing) {
      finished = true;
      finish.hidden = false;
      byId('result').textContent = clockTime(car.elapsed);
      byId('again').focus();
    }
    trial.hud(car);
    landmarks.update(car,{quiet:paused || !finish.hidden || car.phase==='finished' || Boolean(online?.waiting) || byId('pixel-countdown')?.hidden===false});
  }
  changeCourse(params.get('course')||(photoStart?'roam':document.querySelector('meta[name=campus-course]')?.content));
  online=await onlineMenu;
  online?.attach({THREE,scene,coupe,changeCourse,reset,carState:()=>car});
  const look = new THREE.Vector3();
  function frame(timestamp) {
    const elapsed = previous === null ? 0 : Math.min(.12, (timestamp - previous) / 1000);
    const interval=previous===null?0:(timestamp-previous)/1000;
    previous = timestamp;
    let input={};
    if ((!paused || ((online?.active || online?.padConnected) && !document.hidden)) && !online?.waiting) {
      const localInput = controls(elapsed);
      input = online?.controls(localInput) ?? localInput;
      remaining += elapsed;
      while (remaining >= 1 / 120) {
        snapshotPose(previousPose,car);
        trial.step(sim,input);
        remaining -= 1 / 120;
      }
    }
    online?.update(timestamp,elapsed,input,padConnected);
    const width = renderer.domElement.clientWidth, height = renderer.domElement.clientHeight;
    const renderScale=paused ? lastScale : quality.sample(interval);
    if (width !== lastWidth || height !== lastHeight || renderScale!==lastScale) {
      lastScale=renderScale;
      lastWidth = width;
      lastHeight = height;
      const downsample = Math.max(1, width / 1680)/(renderScale*Math.min(graphics.current.pixelRatio,devicePixelRatio));
      renderer.setSize(Math.max(1, Math.round(width / downsample)), Math.max(1, Math.round(height / downsample)), false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    const pose=interpolatePose(visiblePose,previousPose,car,remaining*120);
    if (trial.context) pose.y=visualHeight(pose);
    trial.render(remaining*120);
    const view=rig.update(pose,elapsed);
    const sin=Math.sin(view.chaseYaw),cos=Math.cos(view.chaseYaw);
    const slope=Math.tan(view.pitch*.65);
    coupe.position.set(pose.x, pose.y + .012, pose.z);
    coupe.rotation.set(-pose.pitch - pose.bodyPitch, pose.heading, pose.roll, 'YXZ');
    const detailChanged=campus.updateDetail(car.x,car.z,100);
    if(detailChanged) collision.invalidate();
    const radius=nearPlaneClearance(camera);
    if(!driverView) placement.chase(camera.position,pose,view,elapsed,radius);
    look.set(camera.position.x+sin*14,camera.position.y+14*(slope-.131),camera.position.z+cos*14);
    coupe.visible = !driverView;
    interior.visible = driverView;
    if (driverView) {
      interior.position.set(pose.x,view.height+.012,pose.z);
      interior.rotation.set(-view.pitch*.60-view.bodyPitch*.3,view.eyeYaw,view.roll*.25,'YXZ');
      instruments(car);
      const dx = Math.sin(view.eyeYaw), dz = Math.cos(view.eyeYaw);
      camera.position.set(.34, 1.17, -.19);
      interior.localToWorld(camera.position);
      placement.driver(camera.position,pose,view,radius);
      look.copy(camera.position);
      look.x += dx * 14;
      look.y += (Math.tan(view.pitch*.60)+.20*view.bodyPitch-.035)*14;
      look.z += dz * 14;
    }
    camera.lookAt(look);
    updateShadow(pose,detailChanged);
    renderView();
    updateHud(timestamp);
    if (window.driveMetrics) {
      const metrics=window.driveMetrics;
      metrics.frames++;
      metrics.frameMs=interval*1000;
      metrics.renderScale=renderScale;
      metrics.drawCalls=renderer.info.render.calls;
      metrics.triangles=renderer.info.render.triangles;
    }
    requestAnimationFrame(frame);
  }
  if(params.has('audit')) {
    const {install}=await import('./dev/audit/browser.mjs');
    await install({scene,campus,renderer,camera,renderView,updateShadow,coupe,interior,sprintProps,collision});
  } else frame(performance.now());
  byId('status').hidden = true;
}
