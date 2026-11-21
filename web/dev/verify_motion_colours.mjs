import {drivingMenu} from './mobile_menu.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {chromium,devices} from 'playwright';

const {values}=parseArgs({options:{url:{type:'string'},shots:{type:'string'}}});
const matchesSwatch=(rgb,reference,tolerance)=>rgb.every((value,i)=>Math.abs(value-reference[i])<=tolerance);
const rearDeckRed=[199,76,67],checkpointAmber=[227,198,92];
const server=values.url?null:spawn(process.execPath,['serve.mjs','--port','0'],{stdio:['ignore','pipe','inherit']});
let browser;
try{
  const base=values.url??(await once(server.stdout,'data'))[0].toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  if(values.shots)await mkdir(values.shots,{recursive:true});
  const failures=[];
  for(const floatTargets of [true,false]){
    const page=await browser.newPage({...devices['Pixel 7'],viewport:{width:844,height:390}});
    if(!floatTargets)await page.addInitScript(()=>{
      const original=WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension=function(name){
        return name==='EXT_color_buffer_float'?null:original.call(this,name);
      };
    });
    await page.goto(base+'/?mode=drive&course=stadium&diagnostics');
    await page.waitForFunction(()=>window.driveMetrics?.frames>8,null,{timeout:120000});
    await page.waitForFunction(()=>driveMetrics.inspectLook().scene.getObjectByName('Next checkpoint arch')?.parent.visible);
    for(const enabled of [false,true]){
      await drivingMenu(page);
      await page.selectOption('#look-quality','high');
      await page.locator('#motion-blur').setChecked(enabled);
      for(const preset of floatTargets?['high','low','medium','auto']:['high']){
        await drivingMenu(page);
        await page.selectOption('#look-quality',preset);
        await drivingMenu(page,false);
        await page.evaluate(async()=>{for(let i=0;i<5;i++)await new Promise(requestAnimationFrame);});
        const points=await page.evaluate(()=>{
          const {THREE,scene,camera,renderer,graphics}=driveMetrics.inspectLook();
          const point=(object,x,y,z)=>{
            const v=object.localToWorld(new THREE.Vector3(x,y,z)).project(camera);
            return {x:(v.x+1)/2,y:(1-v.y)/2};
          };
          const car=scene.getObjectByName('Sports coupe');
          const post=scene.getObjectByName('Next checkpoint arch').children[1];
          const band=post.children.find((m,i)=>i>0 && m.material.color.getHex()===0xffc43f);
          const positions=[point(car,.52,.86,-1.56),point(band,0,0,0)];
          driveMetrics.renderCanvas();
          const gl=renderer.getContext();
          return {positions,quality:graphics.name,motion:graphics.motionBlur,floatColour:renderer.extensions.has('EXT_color_buffer_float'),alpha:positions.map(({x,y})=>{
            const rgba=new Uint8Array(4);gl.readPixels(Math.floor(x*gl.drawingBufferWidth),Math.floor((1-y)*gl.drawingBufferHeight),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);return rgba[3];
          })};
        });
        const label=(floatTargets?'':'no-float-')+preset+'-'+(enabled?'on':'off');
        const png=await page.screenshot({scale:'css',path:values.shots?values.shots+'/'+label+'.png':undefined});
        const [paint,amber]=await page.evaluate(async({png,positions})=>{
          const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,'+png)).blob());
          const ctx=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d');
          ctx.drawImage(bitmap,0,0);bitmap.close();
          return positions.map(({x,y})=>{
            const data=ctx.getImageData(Math.floor(x*ctx.canvas.width)-1,Math.floor(y*ctx.canvas.height)-1,3,3).data;
            return [0,1,2].map(k=>Array.from({length:9},(_,i)=>data[i*4+k]).sort((a,b)=>a-b)[4]);
          });
        },{png:png.toString('base64'),positions:points.positions});
        console.log(label,JSON.stringify({paint,amber,alpha:points.alpha}));
        assert.equal(points.quality,preset==='auto'?'low':preset);
        assert.equal(points.motion,preset==='high' && enabled);
        assert.equal(points.floatColour,floatTargets);
        if(!matchesSwatch(paint,rearDeckRed,40) || !matchesSwatch(amber,checkpointAmber,18) || points.alpha.some(a=>a!==255)){
          failures.push({label,paint,amber,alpha:points.alpha});
        }
      }
    }
    await page.close();
  }
  assert.deepEqual(failures,[],'Expected opaque red coupe paint and an amber checkpoint post in the composited phone screenshot');
}finally{await browser?.close();server?.kill();}
