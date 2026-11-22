import {drivingMenu} from './mobile_menu.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync,realpathSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {dirname,delimiter,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const cli=process.env.PATH.split(delimiter).map(dir=>join(dir,'playwright')).find(existsSync);
const {chromium}=await import(pathToFileURL(join(dirname(realpathSync(cli)),'index.mjs')));
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']});
const baseline=process.argv.includes('--baseline');
const out=join(root,'web/dev/shots/look',baseline?'before':'after');
let browser;
try {
  const [message]=await once(server.stdout,'data');
  const base=message.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  await mkdir(out,{recursive:true});
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const errors=[];
  for(const phone of [false,true]){
    const page=await browser.newPage({viewport:phone?{width:844,height:390}:{width:1440,height:900},hasTouch:phone,isMobile:phone});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error') errors.push(m.text().slice(0,1200));});
    await page.goto(base+'/?mode=drive&course=roam&diagnostics');
    const ready=()=>page.waitForFunction(()=>window.driveMetrics?.frames>15,undefined,{timeout:60000});
    await ready();
    if(!baseline){
      const pipeline=await page.evaluate(()=>{
        const {renderer,scene,sun,graphics,THREE}=driveMetrics.inspectLook();
        return {quality:graphics.name,ao:graphics.current.ao,ibl:scene.environment?.mapping===THREE.CubeUVReflectionMapping,
          srgb:renderer.outputColorSpace===THREE.SRGBColorSpace,aces:renderer.toneMapping===THREE.ACESFilmicToneMapping,
          shadow:sun.shadow.map?.width,exposure:renderer.toneMappingExposure,width:renderer.domElement.width};
      });
      assert.ok(pipeline.ibl && pipeline.srgb && pipeline.aces && pipeline.exposure>0);
      assert.equal(pipeline.quality,phone?'low':'high');
      assert.equal(pipeline.shadow,phone?1024:2048);
      assert.equal(pipeline.ao===0,phone);
      if(phone) assert.ok(pipeline.width<=Math.ceil(844*.8));
      await drivingMenu(page);
      for(const quality of ['medium','ultra','auto']){
        await page.selectOption('#look-quality',quality);
        await page.waitForFunction(size=>driveMetrics.inspectLook().sun.shadow.map?.width===size,
          quality==='medium'?1536:quality==='ultra'?4096:phone?1024:2048);
      }
    }
    if(!phone){
      for(const [name,place] of [['uc-hill','University Drive'],['middlesex','Middlesex College'],['thames','University Drive Bridge'],['stadium','Western Alumni Stadium']]){
        await page.selectOption('#spawn',place);
        await ready();
        await page.waitForLoadState('networkidle');
        await page.screenshot({path:join(out,name+'.png')});
        if(!baseline && name==='middlesex'){
          const shadow=await page.evaluate(()=>{
            const {renderer,scene,sun,THREE}=driveMetrics.inspectLook();
            const sample=new OffscreenCanvas(360,225);
            const ctx=sample.getContext('2d',{willReadFrequently:true});
            const read=(refresh=true)=>{
              if(refresh) renderer.shadowMap.needsUpdate=true;
              ctx.drawImage(driveMetrics.renderCanvas(),0,0,sample.width,sample.height);
              return ctx.getImageData(0,0,sample.width,sample.height).data;
            };
            const casters=[];
            scene.traverse(obj=>{if(obj.castShadow && obj.isMesh) casters.push(obj);});
            const cached=read(false),original=read();
            for(const obj of casters) obj.castShadow=false;
            const direct=read();
            for(const obj of casters) obj.castShadow=true;
            const restored=read();
            const {car,facades}=driveMetrics;
            const caster=new THREE.Mesh(new THREE.BoxGeometry(6,.6,6),new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false}));
            caster.position.copy(sun.position).sub(sun.target.position).normalize().multiplyScalar(9);
            caster.position.add(new THREE.Vector3(car.x+8*Math.sin(car.heading),car.y,car.z+8*Math.cos(car.heading)));
            caster.castShadow=true;
            facades.add(caster);
            const streamed=read(false),forced=read();
            facades.remove(caster);
            const removed=read(false);
            caster.geometry.dispose();
            caster.material.dispose();
            let shadowPixels=0,unstable=0,stale=0,streamedPixels=0;
            for(let y=84;y<204;y++)for(let x=10;x<350;x++){
              const i=(y*360+x)*4;
              if(Math.abs(cached[i+1]-original[i+1])>1 || Math.abs(streamed[i+1]-forced[i+1])>1 || Math.abs(removed[i+1]-original[i+1])>1) stale++;
              if(original[i+1]-forced[i+1]>14) streamedPixels++;
              if(direct[i+1]-original[i+1]>14) shadowPixels++;
              if(Math.abs(restored[i+1]-original[i+1])>1) unstable++;
            }
            return {shadowPixels,unstable,stale,streamedPixels};
          });
          console.log('Middlesex courtyard shadow pixels',shadow);
          assert.ok(shadow.shadowPixels>200);
          assert.equal(shadow.unstable,0);
          assert.equal(shadow.stale,0);
          assert.ok(shadow.streamedPixels>20);
        }
      }
      await page.selectOption('#spawn','University Drive');
      await ready();
    }
    await drivingMenu(page,false);
    await page.waitForTimeout(3500);
    await page.keyboard.down('ArrowUp');
    const perf=await page.evaluate(async()=>{
      const times=[];
      for(let i=0;i<150;i++){
        await new Promise(requestAnimationFrame);
        times.push(driveMetrics.frameMs);
      }
      const {renderScale,drawCalls,triangles,car}=driveMetrics;
      times.sort((a,b)=>a-b);
      return {p50:times[75],p95:times[142],worst:times.at(-1),fps:150000/times.reduce((a,b)=>a+b),renderScale,drawCalls,triangles,distance:car.distance};
    });
    await page.keyboard.up('ArrowUp');
    console.log(JSON.stringify({phone,baseline,...perf}));
    if(!baseline){
      assert.ok(perf.distance>5);
      assert.ok(perf.worst<68,'Drive frame stalled for '+perf.worst+' ms');
      assert.ok(perf.fps>=(phone?30:57) && perf.p95<=(phone?36:24),JSON.stringify(perf));
    }
    if(!phone){
      await page.goto(base+'/?mode=map&diagnostics&view=overview');
      await page.waitForFunction(()=>window.campusMetrics?.frameCount>3,undefined,{timeout:60000});
      await page.screenshot({path:join(out,'map.png')});
    }
    await page.close();
  }
  assert.deepEqual(errors,[]);
}finally{
  await browser?.close();
  server.kill();
}
