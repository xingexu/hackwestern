import assert from 'node:assert/strict';
import {driveCampusBridge} from './drive_campus_bridge.mjs';
import {auditStreetViews} from './audit_street_views.mjs';
import {verifyGroundMaterials,verifyStadiumVerge} from './verify_ground_materials.mjs';
import {verifyFacilitiesPhotos,verifyPhotoStart,verifyStreetPhotos} from './verify_street_photos.mjs';
import {auditGroundPixels} from './audit_ground_pixels.mjs';
import {spawn} from 'node:child_process';
import {dirname,delimiter,join} from 'node:path';
import {existsSync,realpathSync} from 'node:fs';
import {mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {campusFootprint} from '../campus-clip.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const executable=process.env.PATH.split(delimiter).map(path=>join(path,'playwright')).find(existsSync);
const {chromium}=await import(pathToFileURL(join(dirname(realpathSync(executable)),'index.mjs')));
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']});
let browser;
try {
  const [startup]=await once(server.stdout,'data');
  const base=startup.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const html=await (await fetch(base)).text();
  assert.ok(html.length<20000 && !html.includes('base64,') && !html.includes('cdn.jsdelivr.net'));
  const resources=JSON.parse(html.match(/<script type="application\/json" id="campus-assets">(.*?)<\/script>/)[1]);
  const asset=name=>new URL(resources[name],base).href;
  const manifest=await (await fetch(asset('surface-tiles.json'))).json();
  const canopy=await (await fetch(asset('canopy-survey.json'))).json();
  const tileUrls=new Set(Object.values(manifest.finishes).map(p=>new URL(p,base).href));
  const region=await (await fetch(asset('campus-region.json'))).json();
  const boundary=campusFootprint(await (await fetch(asset('campus-boundary.json'))).json());
  const requiredTiles=[];
  for(let j=0;j<region.zs.length-1;j+=24)for(let i=0;i<region.xs.length-1;i+=24){
    if(boundary.intersects(region.xs[i],region.zs[j],region.xs[Math.min(i+24,region.xs.length-1)],region.zs[Math.min(j+24,region.zs.length-1)]))requiredTiles.push(i+','+j);
  }
  assert.deepEqual(Object.keys(manifest.tiles).sort(),requiredTiles.sort());
  assert.deepEqual(Object.keys(manifest.finishes).sort(),requiredTiles);
  assert.ok(Object.keys(canopy.tiles).every(key=>{const [i,j]=key.split(',').map(Number),s=canopy.tileSize;return boundary.intersects(i*s,j*s,(i+1)*s,(j+1)*s);}));

  const tileUrl=[...tileUrls][0];
  const head=await fetch(tileUrl,{method:'HEAD'});
  assert.match(head.headers.get('cache-control'),/immutable/);
  assert.equal((await fetch(tileUrl,{headers:{'If-None-Match':head.headers.get('etag')}})).status,304);
  assert.equal((await fetch(asset('drive-network.json'),{method:'HEAD',headers:{'Accept-Encoding':'br'}})).headers.get('content-encoding'),'br');
  assert.equal((await fetch(base+'/unknown-tile.webp')).status,404);
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage({viewport:{width:1100,height:680}});
  const errors=[],foreign=new Set(),traffic=new Set();
  page.on('console',m=>{if(m.type()==='error'||/INVALID_OPERATION|program not valid/.test(m.text())) errors.push(m.text().slice(0,850));});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{
    if(r.url().startsWith(base+'/')) traffic.add(r.url());
    else if(/^https?:/.test(r.url())) foreign.add(r.url());
  });
  page.on('response',r=>{if(r.status()>=400) errors.push(r.status()+' '+r.url());});
  const out=join(root,'web/dev/shots/world');
  await mkdir(out,{recursive:true});
  async function ready(){
    await page.waitForFunction(()=>window.driveMetrics?.frames>=5 || document.querySelector('#status[role=alert]'),{},{timeout:45000});
    assert.equal(await page.locator('#status').isHidden(),true,await page.locator('#status').textContent());
    await page.waitForLoadState('networkidle');
  }
  await page.goto(base+'/?diagnostics');
  await ready();
  assert.equal(await page.locator('#drive-course').inputValue(),'roam');
  const firstTiles=[...traffic].filter(url=>tileUrls.has(url)).length;
  const orthoUrls=new Set(Object.values(manifest.tiles).map(p=>new URL(p,base).href));
  assert.ok(![...traffic].some(url=>orthoUrls.has(url)),'Driving must sample only game materials for terrain color');
  assert.ok(firstTiles>0 && firstTiles<tileUrls.size,'Initial view should stream only nearby imagery: '+firstTiles);
  const report=[];
  async function capture(name){
    const shot=await page.screenshot({path:join(out,name+'.png')});
    assert.ok(shot.length>85000,'A street view should have resolved scenery at '+name);
    const entry=await page.evaluate(()=>{const {car,drawCalls,triangles,renderScale}=window.driveMetrics;return {x:Math.round(car.x),z:Math.round(car.z),drawCalls,triangles,renderScale};});
    assert.ok(entry.triangles>15000 && entry.drawCalls>5);
    if(name==='stadium') await verifyStadiumVerge(page);
    if(name==='university-drive'){
      const sky=await page.evaluate(async encoded=>{
        const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
        const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
        const canvas=new OffscreenCanvas(24,8);
        const ctx=canvas.getContext('2d');
        ctx.drawImage(image,image.width*.39,image.height*.03,image.width*.21,image.height*.10,0,0,24,8);
        const pixels=ctx.getImageData(0,0,24,8).data;
        let daylight=0;
        for(let i=0;i<pixels.length;i+=4)
          if(pixels[i+2]>170 && pixels[i+2]>pixels[i]+30 && pixels[i+1]>pixels[i]+10) daylight++;
        return daylight/(24*8);
      },shot.toString('base64'));
      assert.ok(sky>.55,'The opening street view should show a bright blue daylight sky.');
      assert.ok(entry.triangles<3500000,'Opening scene should use distance-based canopy models.');
    }
    if(name==='north-join'){
      const clearance=await page.evaluate(()=>{
        const {network,car}=window.driveMetrics;
        return [3,6,9].every(step=>{
          const x=car.x+step*Math.sin(car.heading),z=car.z+step*Math.cos(car.heading);
          return !network.blocked(x,z,network.sample(x,z,car.y).y,1);
        });
      });
      assert.ok(clearance,'The northern campus spawn should face a clear exit.');
    }
    report.push({name,...entry});
  }
  await capture('university-drive');
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(()=>window.driveMetrics.car.distance>7);
  await page.keyboard.up('ArrowUp');
  assert.ok(await page.locator('#speed').innerText()!=='0');
  for(const [name,place] of [['university-college','University College'],['middlesex','Middlesex College'],['stadium','Western Alumni Stadium'],['bridge','University Drive Bridge'],['brescia','Brescia University College'],['residences','Ontario Hall']]){
    await page.selectOption('#spawn',place);
    await ready();
    await capture(name);
  }
  for(const [name,east,south] of [['huron',-146,281],['engineering',47,720],['phys-ed',185,590],['thompson',130,905],['north-join',145,0]]){
    await page.goto(base+'/?diagnostics&east='+east+'&south='+south);
    await ready();
    assert.equal(await page.locator('#spawn').inputValue(),'Map location');
    const {x,z}=await page.evaluate(()=>window.driveMetrics.car);
    assert.ok(Math.hypot(x-east,z-south)<260,'Street start should be near '+name);
    await capture(name);
  }
  await page.goto(base+'/?diagnostics&east=1304&south=306');
  await ready();
  assert.equal(await page.locator('#spawn').inputValue(),'University Drive');
  assert.ok(await page.evaluate(()=>window.driveMetrics.network.blocked(1304,306,12,1)));
  const photographs=await (await fetch(asset('streetview-facades.json'))).json();
  await verifyPhotoStart(page,base,photographs);
  await verifyGroundMaterials(page,await (await fetch(asset('ground-materials.json'))).json(),out);
  await verifyStreetPhotos(page,photographs,out);
  await verifyFacilitiesPhotos(page,photographs,out);
  await driveCampusBridge(page,out);
  await auditStreetViews(page,out);
  await page.setViewportSize({width:1100,height:680});
  await page.goto(base+'/?mode=map&diagnostics');
  await page.waitForFunction(()=>window.campusMetrics?.frameCount>3,{},{timeout:45000});
  await page.getByRole('button',{name:'Entire campus'}).click();
  await page.waitForFunction(()=>!document.querySelector('.tag:not([hidden])'));
  await page.screenshot({path:join(out,'whole-region.png')});
  await auditGroundPixels(page);
  assert.ok(![...traffic].some(url=>url.endsWith('/world.bin')||url.endsWith('/mesh-worker.js')));
  assert.ok([...traffic].some(url=>url.includes('/assets/core-')));
  assert.deepEqual([...foreign],[]);
  assert.deepEqual([...new Set(errors)],[]);
  const count=[...traffic].filter(url=>tileUrls.has(url)).length;
  assert.ok(count>firstTiles);
  console.log(JSON.stringify({initialTiles:firstTiles,totalTiles:tileUrls.size,tilesSeen:count,views:report}));
}finally{
  if(browser) await browser.close();
  server.kill();
}
