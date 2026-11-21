import assert from 'node:assert/strict';
import { existsSync,realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter,dirname,join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli=process.env.PATH.split(delimiter).map(dir=>join(dir,'playwright')).find(existsSync);
const {chromium}=await import(pathToFileURL(join(dirname(realpathSync(cli)),'index.mjs')));
const url=new URL('../dist/uc-hill-sprint.html',import.meta.url);
const driver=await readFile(new URL('./circuit_driver.mjs',import.meta.url),'utf8');
const driverModule='data:text/javascript;base64,'+Buffer.from(driver).toString('base64');
const browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
try{
  const page=await browser.newPage({offline:true,hasTouch:true,isMobile:true,viewport:{width:844,height:390}});
  await page.context().grantPermissions(['accelerometer','gyroscope']);
  const errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
  page.on('request',request=>{if(/^https?:/.test(request.url())) requests.push(request.url());});
  await page.goto(url.href+'?mode=map');
  await page.getByRole('link',{name:'Free roam'}).click();
  await page.waitForFunction(()=>document.querySelector('#status')?.hidden === true && document.querySelector('#drive-course').value==='roam');
  url.search='?course=roam&diagnostics';
  await page.goto(url.href);
  await page.waitForFunction(()=>window.driveMetrics?.frames>3);
  assert.equal(await page.locator('#drive-course option').count(),5);
  assert.ok(await page.locator('#spawn option').count()>=10);
  await page.selectOption('#spawn','Western Alumni Stadium');
  await page.waitForFunction(()=>window.driveMetrics.car.z>1000);
  await page.screenshot({path:new URL('./shots/drive-stadium-roam.png',import.meta.url).pathname});
  const gas=page.getByRole('button',{name:'Gas',exact:true});
  const box=await gas.boundingBox();
  assert.ok(box);
  const cdp=await page.context().newCDPSession(page);
  await page.getByRole('button',{name:'Tilt steering'}).tap();
  await page.waitForFunction(()=>document.getElementById('tilt').getAttribute('aria-pressed')==='true');
  await page.evaluate(()=>window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{beta:0,gamma:0})));
  const tilt=await page.locator('#tilt').getAttribute('aria-pressed');
  assert.equal(tilt,'true');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
  await page.waitForFunction(()=>window.driveMetrics.car.distance>4);
  await page.evaluate(()=>window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{beta:15,gamma:15})));
  await page.waitForFunction(()=>Math.abs(window.driveMetrics.car.steer)>.025);
  const heldUntil=await page.evaluate(()=>performance.now()+750);
  await page.waitForFunction(deadline=>performance.now()>deadline,heldUntil);
  assert.ok(await page.evaluate(()=>Math.abs(window.driveMetrics.car.steer)>.025),'Holding the phone at the same angle must keep steering.');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.getByRole('button',{name:'Tilt on'}).tap();
  for(const name of ['University Drive Bridge','North Campus Building','Brescia University College']){
    await page.selectOption('#spawn',name);
    await page.waitForFunction(()=>window.driveMetrics.frames>3);
    assert.equal(await page.evaluate(()=>window.driveMetrics.car.distance),0);
    assert.ok(await page.evaluate(()=>{const {network,car}=window.driveMetrics;return !network.blocked(car.x,car.z,car.y,.9);}));
  }
  for(const id of ['college','stadium','campus']){
    await page.selectOption('#drive-course',id);
    await page.waitForFunction(id=>window.driveMetrics.course===id && window.driveMetrics.frames>2,id);
    assert.equal(await page.locator('#recover').isVisible(),true);
    assert.equal(await page.locator('#progress').isVisible(),true);
    assert.ok(await page.evaluate(()=>window.driveMetrics.car.nextGate.distance>20));
    const lap=await page.evaluate(async ({id,driverModule})=>{
      const {createDriveSim}=await import('drive-sim'),{driveInput}=await import(driverModule);
      const {network}=window.driveMetrics;
      const {samples}=network.circuits.find(c=>c.id===id);
      const sim=createDriveSim(samples,{mode:'circuit',network}), car=sim.state;
      const limit=Math.ceil(samples.at(-1).distance/5*120);
      for(let i=0;i<limit && car.phase!=='finished';i++) sim.step(driveInput(samples,car));
      return {phase:car.phase,gates:car.checkpointsPassed,expected:car.checkpointCount,distance:car.distance,at:[car.x,car.y,car.z]};
    },{id,driverModule});
    assert.equal(lap.phase,'finished',id+' '+JSON.stringify(lap));
    assert.equal(lap.gates,lap.expected);
    console.log(id+' passed all '+lap.gates+' gates with rendered world collisions.');
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests,[]);
  console.log('Offline phone viewport passed free roam from the map, landmark starts, touch acceleration, simulated tilt and all course selections.');
}finally{await browser.close();}
