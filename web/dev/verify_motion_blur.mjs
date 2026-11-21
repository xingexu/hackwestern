import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../../',import.meta.url));
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']});
let browser;
try{
  const [message]=await once(server.stdout,'data');
  const url=message.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url+'/?mode=drive&course=roam&diagnostics');
  await page.waitForFunction(()=>window.driveMetrics?.frames>20,null,{timeout:90000});
  const blur=page.locator('#motion-blur');
  assert.ok(await blur.isChecked());
  await page.selectOption('#look-quality','low');
  assert.ok(await blur.isDisabled() && !await blur.isChecked());
  await page.selectOption('#look-quality','high');
  assert.ok(await blur.isEnabled() && await blur.isChecked());
  await page.waitForLoadState('networkidle');
  const capture=()=>page.evaluate(()=>{
    const {scene}=driveMetrics.inspectLook(),car=scene.getObjectByName('Sports coupe');
    const checkbox=document.querySelector('#motion-blur');
    function read(){
      const source=driveMetrics.renderCanvas();
      const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      context.drawImage(source,0,0);
      return {pixels:context.getImageData(0,0,canvas.width,canvas.height).data,canvas};
    }
    checkbox.click();
    const before=read();
    checkbox.click();
    const after=read();
    checkbox.click();
    const materials=new Map();
    car.traverse(mesh=>{
      if(mesh.isMesh)for(const m of [].concat(mesh.material)){
        if(!m.color || m.transparent || materials.has(m))continue;
        materials.set(m,m.color.clone());m.color.set(0x00ff00);
      }
    });
    const mask=read().pixels;
    for(const [m,color] of materials)m.color.copy(color);
    checkbox.click();
    const {width,height}=before.canvas;
    let carPixels=0,carChanged=0,edgePixels=0,edgeChanged=0,sharpDetail=0,blurDetail=0;
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
      const i=4*(y*width+x),a=before.pixels,b=after.pixels;
      const delta=Math.max(...[0,1,2].map(k=>Math.abs(a[i+k]-b[i+k])));
      if(Math.abs(a[i+1]-mask[i+1])>55){
        carPixels++;if(delta>2)carChanged++;
      }else if(y>height*.46 && (x<width*.31 || x>width*.69)){
        edgePixels++;if(delta>2)edgeChanged++;
        sharpDetail+=Math.abs(a[i+1]-a[i+5])+Math.abs(a[i+1]-a[i+1+width*4]);
        blurDetail+=Math.abs(b[i+1]-b[i+5])+Math.abs(b[i+1]-b[i+1+width*4]);
      }
    }
    return {speed:driveMetrics.car.speed,carPixels,carChanged,edgePixels,edgeChanged,detailRatio:blurDetail/sharpDetail,
      before:before.canvas.toDataURL().split(',')[1],after:after.canvas.toDataURL().split(',')[1]};
  });
  const parked=await capture();
  assert.equal(parked.edgeChanged,0);
  await page.evaluate(async()=>{
    driveMetrics.car.speed=32;
    for(let i=0;i<7;i++)await new Promise(requestAnimationFrame);
  });
  const {before,after,...result}=await capture();
  console.log(result);
  assert.deepEqual(errors,[]);
  assert.ok(result.speed>20 && result.edgeChanged>result.edgePixels*.015 && result.detailRatio<.96);
  assert.ok(result.carPixels>3000 && result.carChanged/result.carPixels<.015);
  if(process.argv[2]){
    await mkdir(process.argv[2],{recursive:true});
    for(const [name,image] of Object.entries({before,after}))await writeFile(process.argv[2]+'/'+name+'.png',Buffer.from(image,'base64'));
  }
  await blur.uncheck();
  await page.reload();
  await page.waitForFunction(()=>window.driveMetrics?.frames>1);
  assert.equal(await blur.isChecked(),false);
}finally{await browser?.close();server.kill();}
