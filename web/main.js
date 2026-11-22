import {daylight,sunDirection} from 'campus-daylight';
import {qualityControl} from 'look-quality';
import * as THREE from 'three';

const canvas = document.querySelector('#view');
const status = document.querySelector('#status');
const scaleControl = document.querySelector('#pixel-scale');
const scaleValue = document.querySelector('#scale-value');
const fpsDisplay = document.querySelector('#fps');
const labelLayer = document.querySelector('#labels');
const header = document.querySelector('header');
const north = document.querySelector('#north');
const resetButton = document.querySelector('#reset');

const initialYaw = Math.PI * 0.79;
const initialPitch = Math.PI * 0.245;
const minPitch = THREE.MathUtils.degToRad(25);
const maxPitch = THREE.MathUtils.degToRad(70);
const radiansPerTurn = Math.PI / 4;
const overview = new URLSearchParams(location.search).get('view') === 'overview';
const initialZoom = overview ? 1 : 2.3;
const initialFocusEast = overview ? 0 : 95;
const initialFocusSouth = overview ? 0 : -25;

const screenVertexShader = `
  varying vec2 screenUv;

  void main() {
    screenUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const screenFragmentShader = `
  uniform sampler2D sceneColor;
  uniform sampler2D sceneNormal;
  uniform sampler2D sceneDepth;
  uniform vec2 texel;
  uniform vec2 cameraPlanes;
  uniform float unitsPerPixel;
  uniform bool coverageMask;
  varying vec2 screenUv;

  vec3 normalAt(vec2 uv) {
    return texture2D(sceneNormal, uv).xyz * 2.0 - 1.0;
  }

  vec2 edgeAt(vec2 uv, vec2 offset, float centerDepth, vec3 centerNormal) {
    vec2 neighborUv = uv + offset * texel;
    float neighborDepth = texture2D(sceneDepth, neighborUv).x;
    if (neighborDepth >= 0.999999) return vec2(1.0, 0.0);

    float depthDelta = (neighborDepth - centerDepth) * (cameraPlanes.y - cameraPlanes.x);
    vec3 neighborNormal = normalAt(neighborUv);
    float crease = max(0.0, 1.0 - dot(centerNormal, neighborNormal));
    float planarDelta = dot(centerNormal.xy, offset) * unitsPerPixel / max(0.08, centerNormal.z);
    float silhouette = smoothstep(1.1, 2.3, (depthDelta - planarDelta) / unitsPerPixel);
    float convex = dot(neighborNormal.xy - centerNormal.xy, offset);
    float highlight = smoothstep(0.18, 0.65, convex) * crease;
    return vec2(silhouette, highlight);
  }

  void main() {
    vec2 uv = (floor(screenUv / texel) + 0.5) * texel;
    float depth = texture2D(sceneDepth, uv).x;
    if(coverageMask) {
      gl_FragColor=vec4(vec3(depth>=.999999 ? 1. : 0.),1.);
      return;
    }
    vec3 color;
    if (depth >= 0.999999) {
      vec3 horizon = vec3(0.80, 0.88, 0.93);
      vec3 sky = vec3(0.40, 0.64, 0.86);
      color = mix(horizon, sky, smoothstep(0.0, 1.0, uv.y));
    } else {
      vec3 normal = normalize(normalAt(uv));
      vec2 edges = max(
        max(edgeAt(uv, vec2(1, 0), depth, normal), edgeAt(uv, vec2(-1, 0), depth, normal)),
        max(edgeAt(uv, vec2(0, 1), depth, normal), edgeAt(uv, vec2(0, -1), depth, normal))
      );
      color = texture2D(sceneColor, uv).rgb;
      color = color * (1.0 - 0.29 * edges.x) + color * 0.13 * edges.y * (1.0 - edges.x);
    }
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const capturedMaterials=new WeakSet();
function captureNormals(material) {
  if(capturedMaterials.has(material)) return material;
  capturedMaterials.add(material);
  material.shadowSide = THREE.FrontSide;
  const original = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.customProgramCacheKey = () => key + '-campus-normals';
  material.onBeforeCompile = (shader, renderer) => {
    original(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 campusView;')
      .replace('#include <project_vertex>', '#include <project_vertex>\ncampusView = mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 campusView;\nlayout(location = 1) out vec4 normalOutput;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nnormalOutput = vec4(normalize(cross(dFdx(campusView), dFdy(campusView))) * 0.5 + 0.5, 1.0);');
  };
  material.needsUpdate=true;
  return material;
}

function mapMaterials(root){
  const attached=new WeakSet();
  function attach(object){
    if(attached.has(object))return;
    attached.add(object);
    if(object.isMesh){
      for(const material of [object.material].flat())captureNormals(material);
      const before=object.onBeforeRender;
      object.onBeforeRender=function(renderer,scene,camera,geometry,material,group){
        before.call(this,renderer,scene,camera,geometry,material,group);
        captureNormals(material);
      };
    }
    object.addEventListener('childadded',event=>attach(event.child));
    for(const child of object.children)attach(child);
  }
  attach(root);
}

async function getWorld() {
  const embedded = document.querySelector('#embedded-world');
  if (embedded) {
    const compressed = document.querySelector('#embedded-voxels').textContent.trim();
    return [JSON.parse(embedded.textContent), new Blob([decodeBase64(compressed)]).stream()];
  }

  const metadata=await fetch(globalThis.campusAssetUrls?.['world.json']??'./world.json');
  if(!metadata.ok) throw new Error('Campus data could not be loaded.');
  const world=await metadata.json();
  if(world.coreMesh) return [world,null];
  const volume=await fetch('./world.bin');
  if(volume.ok&&volume.body) return [world,volume.body];
  const encoded = await fetch('./world.b64.txt');
  if (!encoded.ok) throw new Error('Campus data could not be loaded.');
  return [world, new Blob([decodeBase64((await encoded.text()).trim())]).stream()];
}

function decodeBase64(content) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(content);
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function validateWorld(world, buffer) {
  const { width, height, depth, palette, labels } = world;
  if (![width, height, depth].every(value => Number.isInteger(value) && value > 0 && value <= 32767) ||
      (buffer ? buffer.byteLength !== width * height * depth : !world.coreMesh)) {
    throw new Error('The campus volume does not match its dimensions.');
  }
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 256 ||
      !palette.slice(1).every(color => Array.isArray(color) && color.length === 3 &&
        color.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) ||
      !Array.isArray(labels)) {
    throw new Error('The campus palette or labels are invalid.');
  }
}

function openMeshWorker() {
  const embedded = document.querySelector('#embedded-worker');
  if (!embedded) return new Worker(new URL('./mesh-worker.js', location.href));
  const url = URL.createObjectURL(new Blob([decodeBase64(embedded.textContent.trim())], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}

function chunkGeometry(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3, true));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3, true));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function collectMeshes(world, buffer) {
  return new Promise((resolve, reject) => {
    const worker = openMeshWorker();
    const geometries = [];
    const fail = message => {
      worker.terminate();
      reject(new Error(message));
    };
    worker.onerror = event => fail(event.message || 'The campus mesh worker could not run.');
    worker.onmessage = ({ data }) => {
      if (data.type === 'error') {
        fail(data.message);
        return;
      }
      if (data.type === 'done') {
        worker.terminate();
        resolve({ geometries, triangles: data.triangles });
        return;
      }

      geometries.push(chunkGeometry(data));
    };
    worker.postMessage({ world, buffer }, [buffer]);
  });
}

function labelBitmap(name) {
  const bitmap = document.createElement('canvas');
  bitmap.textContent = name;
  const paint = bitmap.getContext('2d', { willReadFrequently: true });
  const font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
  paint.font = font;
  bitmap.width = Math.ceil(paint.measureText(name).width) + 2;
  bitmap.height = 13;
  paint.font = font;
  paint.fillStyle = '#eff3e9';
  paint.fillText(name, 1, 10);
  const ink = paint.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let alpha = 3; alpha < ink.data.length; alpha += 4) {
    ink.data[alpha] = ink.data[alpha] >= 113 ? 255 : 0;
  }
  paint.putImageData(ink, 0, 0);
  return bitmap;
}

function createViewer(world, campus) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, powerPreference: 'high-performance'
  });
  const graphics=qualityControl();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000);
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera();
  const bounds = campus?.bounds ?? [0, 0, world.width, world.depth];
  const wide = bounds[2] - bounds[0], deep = bounds[3] - bounds[1];
  const diameter = Math.hypot(wide, deep, world.height);
  const cameraDistance = diameter * 1.10;
  camera.near = Math.max(0.1, cameraDistance - diameter * 0.74);
  camera.far = cameraDistance + diameter * 0.85;
  scene.fog = new THREE.Fog(0xbdd9ec, cameraDistance - diameter * 0.22, cameraDistance + diameter * 1.20);
  const sunlight=daylight(renderer,scene,false);
  const sunOffset=sunDirection.clone().multiplyScalar(diameter*1.5);
  sunlight.shadow.mapSize.setScalar(Math.min(renderer.capabilities.maxTextureSize,graphics.current.mapSize));
  sunlight.shadow.camera.near=diameter*.35;
  sunlight.shadow.camera.far=diameter*2.6;
  graphics.onChange(({mapSize})=>{
    sunlight.shadow.map?.dispose();
    sunlight.shadow.map=null;
    sunlight.shadow.mapSize.setScalar(Math.min(renderer.capabilities.maxTextureSize,mapSize));
    renderer.shadowMap.needsUpdate=true;
    cameraDirty=true;
  });

  const target = new THREE.WebGLRenderTarget(1, 1, {
    count: 2,
    type:renderer.extensions.has('EXT_color_buffer_float')?THREE.HalfFloatType:THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
  });
  const postMaterial = new THREE.ShaderMaterial({
    uniforms: {
      sceneColor: { value: target.textures[0] },
      sceneNormal: { value: target.textures[1] },
      sceneDepth: { value: target.depthTexture },
      texel: { value: new THREE.Vector2() },
      cameraPlanes: { value: new THREE.Vector2(camera.near, camera.far) },
      coverageMask:{value:false},
      unitsPerPixel: { value: 1 }
    },
    vertexShader: screenVertexShader,
    fragmentShader: screenFragmentShader,
    depthTest: false,
    depthWrite: false
  });
  const screenTriangle = new THREE.BufferGeometry();
  screenTriangle.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const screen = new THREE.Scene();
  const screenMesh = new THREE.Mesh(screenTriangle, postMaterial);
  screenMesh.frustumCulled = false;
  screen.add(screenMesh);
  const screenCamera = new THREE.Camera();

  const centerX = world.width / 2;
  const centerZ = world.depth / 2;
  const focusHeight = Math.min(world.height * 0.23, diameter * 0.055);
  const lookAt = new THREE.Vector3(initialFocusEast, focusHeight, initialFocusSouth);
  const snappedFocus = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const shadowFocus = new THREE.Vector3();
  const pointers = new Map();
  const labelBoxes = [];

  let yaw = initialYaw;
  let pitch = initialPitch;
  let zoom = initialZoom;
  let aspect = 1;
  let viewHeight = 1;
  let viewWidth = 1;
  let screenWidth = 0;
  let screenHeight = 0;
  let pixelScale = Number(scaleControl.value);
  let shadowWidth = 0;
  let cameraDirty = true;

  const labels = [...world.labels, ...(campus?.labels ?? [])].flatMap(({ name, x, y, z }) => {
    if (typeof name !== 'string' || !name.trim() || ![x, y, z].every(Number.isFinite)) return [];
    if(campus?.boundary && !campus.boundary.contains(x,z))return [];
    const tag = document.createElement('span');
    tag.className = 'tag';
    const bitmap = labelBitmap(name);
    tag.append(bitmap);
    tag.hidden = true;
    labelLayer.append(tag);
    return [{ tag, position: new THREE.Vector3(x - centerX, y + 2, z - centerZ), width: bitmap.width + 10 }];
  });

  function fitShadow() {
    const fullMap = Math.max(wide, deep) * 0.73 + world.height * 0.35;
    const footprint = Math.hypot(viewWidth * 0.5, viewHeight * 0.5 / Math.sin(pitch));
    const shadowReach = Math.min(world.height, diameter * 0.18) * 0.85 + 10;
    const halfSize = Math.min(fullMap, Math.max(shadowReach * 1.7, (footprint + shadowReach) * 1.20));
    const centered = halfSize === fullMap;
    const x = centered ? 0 : lookAt.x;
    const z = centered ? 0 : lookAt.z;
    const coverage = centered ? fullMap : footprint + shadowReach;
    const centerDelta = Math.hypot(x - shadowFocus.x, z - shadowFocus.z);
    if (shadowWidth === halfSize && centerDelta === 0) return;
    if (!centered && coverage + centerDelta < shadowWidth && halfSize > shadowWidth * 0.72) return;

    shadowWidth = halfSize;
    shadowFocus.set(x, focusHeight, z);
    sunlight.target.position.copy(shadowFocus);
    sunlight.position.copy(shadowFocus).add(sunOffset);
    const shadowCamera = sunlight.shadow.camera;
    shadowCamera.left = -halfSize;
    shadowCamera.right = halfSize;
    shadowCamera.bottom = -halfSize;
    shadowCamera.top = halfSize;
    shadowCamera.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
  }

  function updateCamera() {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    if (width !== screenWidth || height !== screenHeight) {
      screenWidth = width;
      screenHeight = height;
      renderer.setSize(width, height, false);
      cameraDirty = true;
    }
    if (!cameraDirty) return;
    cameraDirty = false;

    const targetWidth = Math.max(1, Math.round(width / pixelScale));
    const targetHeight = Math.max(1, Math.round(height / pixelScale));
    target.setSize(targetWidth, targetHeight);
    postMaterial.uniforms.texel.value.set(1 / targetWidth, 1 / targetHeight);
    aspect = targetWidth / targetHeight;

    const fullWidth = Math.abs(Math.cos(initialYaw)) * world.width + Math.abs(Math.sin(initialYaw)) * world.depth;
    const fullHeight = (Math.abs(Math.sin(initialYaw)) * world.width + Math.abs(Math.cos(initialYaw)) * world.depth) *
      Math.sin(initialPitch) + Math.max(0, world.height - 2 * focusHeight) * Math.cos(initialPitch);
    viewHeight = Math.max(fullHeight * 1.13, fullWidth * 1.13 / aspect) / zoom;
    viewWidth = viewHeight * aspect;
    const unitsPerPixel = viewHeight / targetHeight;
    postMaterial.uniforms.unitsPerPixel.value = unitsPerPixel;

    const flat = Math.cos(pitch);
    cameraOffset.set(Math.sin(yaw) * flat, Math.sin(pitch), Math.cos(yaw) * flat).multiplyScalar(cameraDistance);
    camera.position.copy(cameraOffset).add(lookAt);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    const pixelRight = right.dot(lookAt) / unitsPerPixel;
    const pixelUp = up.dot(lookAt) / unitsPerPixel;
    snappedFocus.copy(lookAt)
      .addScaledVector(right, (Math.round(pixelRight) - pixelRight) * unitsPerPixel)
      .addScaledVector(up, (Math.round(pixelUp) - pixelUp) * unitsPerPixel);
    camera.position.copy(cameraOffset).add(snappedFocus);
    camera.lookAt(snappedFocus);
    camera.left = -viewWidth / 2;
    camera.right = viewWidth / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    north.style.transform = `rotate(${Math.atan2(Math.sin(yaw), Math.cos(yaw) * Math.sin(pitch))}rad)`;
    fitShadow();
    updateLabels();
    if(campus) document.querySelector('#roam-link').href='?mode=drive&course=roam&east='+Math.round(lookAt.x+centerX)+'&south='+Math.round(lookAt.z+centerZ);
  }

  function updateLabels() {
    labelBoxes.length = 0;
    const visible = zoom >= 1.60 && viewHeight < diameter * 0.66;
    header.classList.toggle('detail', visible);
    const heading = visible ? header.getBoundingClientRect() : null;
    for (const label of labels) {
      if (!visible) {
        label.tag.hidden = true;
        continue;
      }

      projected.copy(label.position).project(camera);
      const x = Math.round((projected.x + 1) * screenWidth * 0.5);
      const y = Math.round((1 - projected.y) * screenHeight * 0.5) - 8;
      if (projected.z < -1 || projected.z > 1 || x < 0 || x > screenWidth || y < 55 || y > screenHeight - 70) {
        label.tag.hidden = true;
        continue;
      }
      const left = x - Math.round(label.width / 2);
      const right = left + label.width;
      const top = y - 20;
      if (left < 5 || right > screenWidth - 5 || (top < heading.bottom + 10 && left < heading.right + 10) ||
          labelBoxes.some(box => left < box.right + 6 && right > box.left - 6 && top < box.bottom + 4 && y > box.top - 4)) {
        label.tag.hidden = true;
        continue;
      }
      label.tag.hidden = false;
      label.tag.style.transform = `translate(${left}px, ${top}px)`;
      labelBoxes.push({ left, right, top, bottom: y });
    }
  }

  function pan(dx, dy) {
    const unitsPerScreenPixel = viewHeight / screenHeight;
    lookAt.x += (-dx * Math.cos(yaw) - dy * Math.sin(yaw) / Math.sin(pitch)) * unitsPerScreenPixel;
    lookAt.z += (dx * Math.sin(yaw) - dy * Math.cos(yaw) / Math.sin(pitch)) * unitsPerScreenPixel;
    lookAt.x = THREE.MathUtils.clamp(lookAt.x, bounds[0] - centerX, bounds[2] - centerX);
    lookAt.z = THREE.MathUtils.clamp(lookAt.z, bounds[1] - centerZ, bounds[3] - centerZ);
  }

  function changeZoom(multiplier) {
    zoom = THREE.MathUtils.clamp(zoom * multiplier, campus ? .12 : .58, 24);
    cameraDirty = true;
  }

  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    if (event.button > 2) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  canvas.addEventListener('pointermove', event => {
    const earlier = pointers.get(event.pointerId);
    if (!earlier) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    const dx = next.x - earlier.x;
    const dy = next.y - earlier.y;

    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      const previousSpan = Math.hypot(earlier.x - other.x, earlier.y - other.y);
      const currentSpan = Math.hypot(next.x - other.x, next.y - other.y);
      pan(dx * 0.5, dy * 0.5);
      if (previousSpan > 8 && currentSpan > 8) changeZoom(currentSpan / previousSpan);
    } else if (pointers.size === 1) {
      if (event.shiftKey || (event.buttons & 6)) {
        pan(dx, dy);
      } else {
        yaw -= dx * 0.006;
        pitch = THREE.MathUtils.clamp(pitch + dy * 0.005, minPitch, maxPitch);
      }
    }
    cameraDirty = true;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, event => pointers.delete(event.pointerId));
  }
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const amount = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? screenHeight : 1);
    changeZoom(Math.exp(-THREE.MathUtils.clamp(amount, -650, 650) * 0.0016));
  }, { passive: false });
  window.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const key = event.key.toLowerCase();
    if (key !== 'q' && key !== 'e') return;
    yaw += key === 'q' ? -radiansPerTurn : radiansPerTurn;
    cameraDirty = true;
  });
  const regionButton = document.getElementById('region-view');
  regionButton.hidden = !campus;
  regionButton.addEventListener('click', () => {
    yaw = initialYaw;
    pitch = initialPitch;
    const diagonal = Math.hypot(wide, deep);
    const required = Math.max(diagonal / aspect, diagonal * Math.sin(pitch) + world.height) * 1.09;
    zoom = THREE.MathUtils.clamp(zoom * viewHeight / required, .12, 1);
    lookAt.set((bounds[0] + bounds[2]) / 2 - centerX, focusHeight, (bounds[1] + bounds[3]) / 2 - centerZ);
    cameraDirty = true;
  });
  resetButton.addEventListener('click', () => {
    yaw = initialYaw;
    pitch = initialPitch;
    zoom = initialZoom;
    lookAt.set(initialFocusEast, focusHeight, initialFocusSouth);
    cameraDirty = true;
  });
  scaleControl.addEventListener('input', () => {
    pixelScale = Number(scaleControl.value);
    scaleValue.value = `${pixelScale}×`;
    cameraDirty = true;
  });

  function render() {
    updateCamera();
    if(campus?.updateDetail(lookAt.x+centerX,lookAt.z+centerZ,viewHeight)) {
      renderer.shadowMap.needsUpdate=true;
    }
    renderer.info.reset();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(screen, screenCamera);
  }

  function load({ geometries, triangles }) {
    const material = captureNormals(campus?.buildingMaterial ?? new THREE.MeshLambertMaterial({ vertexColors: true }));
    if (campus) {
      campus.boundary.setOrigin(centerX,centerZ);
      campus.scenery.position.set(-centerX, 0, -centerZ);
      mapMaterials(campus.scenery);
      scene.add(campus.scenery);
      campus.onTextureReady(()=>{cameraDirty=true;});
    }
    for (const geometry of geometries) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(-centerX, 0, -centerZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      campus?.boundary.attach(mesh);
      scene.add(mesh);
    }

    if(campus && new URLSearchParams(location.search).get('view')==='campus'){
      updateCamera();
      regionButton.click();
    }
    renderer.shadowMap.needsUpdate = true;
    render();
    renderer.getContext().finish();
    const metrics = {
      bounds,
      loadMs: Math.round(performance.now()),
      chunks: geometries.length+(campus?.facades.group.children.length??0),
      triangles:triangles+(campus?.facades.group.children.reduce((n,t)=>n+t.children.reduce((s,m)=>s+m.geometry.index.count/3*(m.count??1),0),0)??0),
      drawCalls: renderer.info.render.calls,
      drawnTriangles: renderer.info.render.triangles,
      fps: 0,
      frameCount: 0,
      steadyDrawCalls: 0
    };
    if (new URLSearchParams(location.search).has('diagnostics')) {
      metrics.paintReady=()=>campus?.paintReady()??true;
      metrics.inspectScene=()=>({THREE,scene,renderer});
      metrics.countUncovered=(left,top,width,height)=>{
        const gl=renderer.getContext();
        const scaleX=gl.drawingBufferWidth/canvas.clientWidth,scaleY=gl.drawingBufferHeight/canvas.clientHeight;
        const x=Math.round(left*scaleX),y=gl.drawingBufferHeight-Math.round((top+height)*scaleY);
        const w=Math.round(width*scaleX),h=Math.round(height*scaleY);
        const mask=new Uint8Array(w*h*4);
        postMaterial.uniforms.coverageMask.value=true;
        renderer.render(screen,screenCamera);
        gl.readPixels(x,y,w,h,gl.RGBA,gl.UNSIGNED_BYTE,mask);
        postMaterial.uniforms.coverageMask.value=false;
        renderer.render(screen,screenCamera);
        let missing=0;
        for(let i=0;i<mask.length;i+=4) if(mask[i]) missing++;
        return missing;
      };
      window.campusMetrics=metrics;
    }
    status.dataset.ready = '';

    let start = performance.now();
    let frames = 0;
    function frame(timestamp) {
      render();
      metrics.steadyDrawCalls = renderer.info.render.calls;
      metrics.frameCount++;
      frames++;
      if (timestamp - start >= 1000) {
        metrics.fps = Math.round(frames * 1000 / (timestamp - start));
        fpsDisplay.value = `${metrics.fps} FPS`;
        start = timestamp;
        frames = 0;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  render();
  return { load };
}

async function loadCoreMesh(asset) {
  const [response,{decodeChunks}]=await Promise.all([fetch(asset.url),import('scene-pack')]);
  if(!response.ok) throw new Error('The campus building mesh could not be loaded.');
  const stream=response.body.pipeThrough(new DecompressionStream('deflate'));
  const chunks=decodeChunks(await new Response(stream).arrayBuffer());
  const triangles=chunks.reduce((n,c)=>n+c.indices.length/3,0);
  if(chunks.length!==asset.chunks||triangles!==asset.triangles) throw new Error('The building mesh does not match this campus.');
  return {geometries:chunks.map(chunkGeometry),triangles};
}

async function onlineMenu() {
  if (document.documentElement.dataset.mode!=='drive' || !/^https?:$/.test(location.protocol) || document.getElementById('embedded-world')) return null;
  const timing=performance.getEntriesByType('navigation')[0]?.serverTiming;
  if (!timing?.some(entry=>entry.name==='western-online') && (await fetch(location.href,{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(2500)}))?.headers.get('X-Western-Online')!=='1') return null;
  document.documentElement.dataset.westernOnline='true';
  const [health,{mountOnline}]=await Promise.all([fetch('/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).catch(()=>({})),import('./lobby/online.mjs')]);
  return mountOnline(health);
}

async function start() {
  const online=onlineMenu().catch(()=>null);
  const drive=document.documentElement.dataset.mode==='drive' ? import('campus-drive') : null;
  const [world, compressed] = await getWorld();
  const volume = compressed ? await new Response(compressed.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer() : null;
  const packedScene=world.coreMesh ? loadCoreMesh(world.coreMesh) : null;
  validateWorld(world, volume);
  if (!world.driveCourse) {
    document.querySelector('#drive-link').hidden = true;
    document.querySelector('#roam-link').hidden = true;
    document.documentElement.dataset.mode = 'map';
  }
  const racing = document.documentElement.dataset.mode === 'drive';
  const campus = world.driveCourse ? await (await import('campus-scene')).prepareCampus(world, volume, racing) : null;
  if (racing) {
    const { startDrive } = await drive;
    await startDrive(world,volume,packedScene ? ()=>packedScene : collectMeshes,campus,online);
    return;
  }
  const viewer = createViewer(world, campus);
  viewer.load(await (packedScene??collectMeshes(world,volume)));
}

start().catch(error => {
  status.textContent = error.message;
  status.setAttribute('role', 'alert');
  console.error(error);
});
