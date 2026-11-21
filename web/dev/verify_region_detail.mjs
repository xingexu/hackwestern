import assert from 'node:assert/strict';
import {existsSync,realpathSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {delimiter,dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cli=process.env.PATH.split(delimiter).map(p=>join(p,'playwright')).find(existsSync);
assert(cli,'Run through npm exec --package=playwright@1.65.1');
const {chromium}=await import(pathToFileURL(resolve(realpathSync(cli),'../index.mjs')));
const html=await readFile(resolve(root,'dist/campus.html'),'utf8');
const three=Buffer.from(html.match(/"three":\s*"data:text\/javascript;base64,([^"]+)"/)[1],'base64');
const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const page=await browser.newPage({viewport:{width:900,height:540}});
  await page.route('http://campus.test/**',async route=>{
    const name=new URL(route.request().url()).pathname.slice(1);
    if(!name) return route.fulfill({contentType:'text/html',body:'<script type="importmap">{"imports":{"campus-terrain":"/campus-terrain.mjs","campus-architecture":"/architecture.js","three":"/three.js","leaf-sprays":"/leaf-sprays.js"}}</script><body style="margin:0"></body>'});
    if(name==='three.js') return route.fulfill({contentType:'text/javascript',body:three});
    if(['campus-terrain.mjs','look/water.mjs','look/surface-response.mjs','region-detail.js','street-detail.js','architecture.js','leaf-sprays.js','campus-region.js','region-detail.json','campus-region.json'].includes(name)) {
      return route.fulfill({contentType:/\.m?js$/.test(name)?'text/javascript':'application/json',body:await readFile(resolve(root,name))});
    }
    await route.abort();
  });
  await page.goto('http://campus.test');
  const result=await page.evaluate(async()=>{
    const [THREE,{createRegionDetail,pruneStadiumTrees},{createCampusRegion},detail,region]=await Promise.all([
      import('/three.js'),import('/region-detail.js'),import('/campus-region.js'),
      fetch('/region-detail.json').then(r=>r.json()),fetch('/campus-region.json').then(r=>r.json())
    ]);
    const renderer=new THREE.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
    renderer.setSize(900,540);
    document.body.appendChild(renderer.domElement);
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(65,900/540,.2,650);
    scene.background=new THREE.Color(0xb4cbd3);
    scene.add(new THREE.HemisphereLight(0xf7f2e5,0x8c8473,2.15));
    const sunlight=new THREE.DirectionalLight(0xfff5df,1.3);
    sunlight.position.set(-100,130,20);scene.add(sunlight);
    let posts=0;
    const world=createRegionDetail(THREE,detail,region,{addBox(matrix,owner){if(matrix.length===16 && owner)posts++},sample(x,z,y){return {y}}});
    const originalTreeCount=region.trees.length;
    pruneStadiumTrees(region,detail);
    const removed=originalTreeCount-region.trees.length;
    const {loadArchitecture}=await import('campus-architecture');
    const model=await loadArchitecture(THREE,detail.architecture);
    const base=createCampusRegion(THREE,region,{width:635,depth:557},{tiles:{}},null,model);
    const shells=base.getObjectByName('Surveyed roofs and street facades');
    if(!shells || shells.children.length<100 || !shells.children.every(c=>c.geometry.hasAttribute('buildingUv'))) throw Error('Surveyed facades and roof UVs must be present across the region');
    scene.add(base,world.group);
    const field=detail.macro.find(f=>f[0]==='canadian_football');
    const stand=detail.macro.filter(f=>f[0]==='grandstand').sort((a,b)=>a[2]-b[2])[0];
    const cameraX=field[2]+8,cameraZ=field[4]-24;
    camera.position.set(cameraX,field[3]+1.78,cameraZ);
    camera.lookAt(stand[2],stand[3]+3.7,stand[4]);
    world.update(cameraX,cameraZ,55);
    function render() {
      renderer.render(scene,camera);
      const gl=renderer.getContext();
      const bytes=new Uint8Array(900*540*4);
      gl.readPixels(0,0,900,540,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      return bytes;
    }
    world.group.visible=false;
    const before=render();
    world.group.visible=true;
    const after=render();
    let changed=0;
    for(let i=0;i<before.length;i+=4) if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>55) changed++;
    const views=[];
    for (const [x,z] of [[cameraX,cameraZ],[-180,1180],[45,621],[-1000,-900]]) {
      world.update(x,z,75);
      for(const mesh of world.group.children) if(!mesh.boundingSphere || ![...mesh.instanceMatrix.array].every(Number.isFinite)) throw Error('Invalid tile transforms');
      views.push(world.group.children.reduce((sum,m)=>sum+m.count,0));
    }
    world.update(0,0,900);
    const farMeshes=world.group.children.length;
    world.update(cameraX,cameraZ,55);
    renderer.render(scene,camera);
    return {changed,posts,views,farMeshes,removed};
  });
  assert.ok(result.changed>40000,'Stadium field and stands must occupy the ground-level view');
  assert.ok(result.posts>260);
  assert.ok(result.views.every(count=>count>2000));
  assert.equal(result.farMeshes,1);
  assert.equal(result.removed,7);
  if(process.env.CAMPUS_STADIUM_SHOT) await page.screenshot({path:process.env.CAMPUS_STADIUM_SHOT});
  console.log('Stadium ground view and regional tile streaming',JSON.stringify(result));
} finally {
  await browser.close();
}
