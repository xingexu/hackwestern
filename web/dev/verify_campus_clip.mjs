import assert from 'node:assert/strict';
import {realpathSync,existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname,delimiter} from 'node:path';
import {campusFootprint} from '../campus-clip.js';

const root=fileURLToPath(new URL('../',import.meta.url)),raw=JSON.parse(await readFile(resolve(root,'campus-boundary.json')));
const cli=process.env.PATH.split(delimiter).map(p=>resolve(p,'playwright')).find(existsSync);
const {chromium}=await import(pathToFileURL(resolve(realpathSync(cli),'../index.mjs')));
const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('http://campus.test/**',async route=>{
    const file=new URL(route.request().url()).pathname.slice(1);
    if(!file)return route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'});
    if(['three.module.js','campus-clip.js'].includes(file))return route.fulfill({contentType:'text/javascript',body:await readFile(resolve(root,file))});
    return route.abort();
  });
  await page.goto('http://campus.test');
  const results=await page.evaluate(async data=>{
    const [THREE,{campusClip}]=await Promise.all([import('/three.module.js'),import('/campus-clip.js')]);
    const [l,t,r,b]=data.bounds,pad=40,w=419,h=521;
    const renderer=new THREE.WebGLRenderer({antialias:false});
    renderer.setSize(w,h,false);
    const target=new THREE.WebGLRenderTarget(w,h);
    renderer.setRenderTarget(target);renderer.setClearColor(0x000000,1);
    const layer=campusClip(THREE,data),scene=new THREE.Scene(),group=new THREE.Group();
    scene.add(group);layer.attach(group);
    const plane=new THREE.PlaneGeometry(r-l+pad*4,b-t+pad*4).rotateX(-Math.PI/2);
    const mesh=new THREE.InstancedMesh(plane,new THREE.MeshBasicMaterial({color:0xffffff}),1);
    const middle=new THREE.Vector3((l+r)/2,0,(t+b)/2);
    mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(middle.x,0,middle.z));
    group.add(mesh);
    const sets=[];
    for(const offset of [[0,0],[270,176]]){
      layer.setOrigin(...offset);group.position.set(-offset[0],0,-offset[1]);
      const camera=new THREE.OrthographicCamera(-(r-l)/2-pad,(r-l)/2+pad,(b-t)/2+pad,-(b-t)/2-pad,1,600);
      camera.up.set(0,0,-1);camera.position.set(middle.x-offset[0],400,middle.z-offset[1]);camera.lookAt(camera.position.x,0,camera.position.z);
      mesh.material=new THREE.MeshBasicMaterial({color:0xffffff});
      renderer.render(scene,camera);
      const pixels=new Uint8Array(w*h*4);
      renderer.readRenderTargetPixels(target,0,0,w,h,pixels);
      const hits=[];
      for(let row=1;row<h;row+=4)for(let col=1;col<w;col+=4){
        const x=l-pad+(col+.5)/w*(r-l+pad*2),z=b+pad-(row+.5)/h*(b-t+pad*2);
        hits.push([x,z,pixels[4*(row*w+col)]>127]);
      }
      sets.push(hits);
    }
    return sets;
  },raw);
  const footprint=campusFootprint(raw);
  let total=0;
  for(const points of results)for(const [x,z,visible] of points){
    const inside=footprint.contains(x,z);
    assert.equal(visible,inside,'Actual WebGL fragment disagrees with the campus boundary at '+[x,z]);total++;
  }
  assert.deepEqual(errors,[]);
  console.log(total+' WebGL fragments across the entire Western parcel verified in drive and translated overview coordinates.');
}finally{await browser.close();}
