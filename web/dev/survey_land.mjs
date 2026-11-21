import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,realpath,readFile} from 'node:fs/promises';
import {dirname,join,delimiter} from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {auditStreetViews} from './audit_street_views.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const output=join(root,'web/dev/shots',process.argv[2]??'land');
await mkdir(output,{recursive:true});
const binary=process.env.PATH.split(delimiter).map(p=>join(p,'playwright')).find(existsSync);
const {chromium}=await import(pathToFileURL(join(dirname(await realpath(binary)),'index.mjs')));
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']});
let browser;
try{
  const [startup]=await once(server.stdout,'data');
  const base=startup.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,1300));});
  await page.goto(base+'/?diagnostics');
  await page.waitForFunction(()=>window.driveMetrics?.frames>=5,null,{timeout:90000});
  async function verifyTreeSupports(name){
    const rooted=await page.evaluate(()=>{
      const {network,facades}=window.driveMetrics;
      const canopy=facades.parent.getObjectByName('Rooted LiDAR canopy');
      let samples=0,stems=0;
      for(const mesh of canopy.children){
        const branches=mesh.children[0],points=mesh.geometry.attributes.crownCenter;
        const matrix=branches.instanceMatrix.array,links=new Map(),connected=new Set();
        const vertices=new Map();
        function key(p){
          const home=p.map(v=>Math.floor(v*100));
          for(const dx of [-1,0,1])for(const dy of [-1,0,1])for(const dz of [-1,0,1]){
            const bucket=vertices.get([home[0]+dx,home[1]+dy,home[2]+dz].join(','));
            const match=bucket?.find(q=>Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2])<.0005);
            if(match)return match;
          }
          const id=home.join(',');
          if(!vertices.has(id))vertices.set(id,[]);
          vertices.get(id).push(p);
          return p;
        }
        const roots=[];
        for(let i=0;i<branches.count;i++){
          const start=[0,1,2].map(k=>matrix[16*i+12+k]-matrix[16*i+4+k]*.5);
          const end=[0,1,2].map(k=>matrix[16*i+12+k]+matrix[16*i+4+k]*.5);
          const a=key(start),b=key(end);
          if(!links.has(a))links.set(a,[]);
          links.get(a).push(b);
          if(Math.abs(network.groundAt(start[0],start[2])-start[1]-.08)<.003)roots.push(a);
        }
        stems+=roots.length;
        while(roots.length){
          const k=roots.pop();
          if(connected.has(k))continue;
          connected.add(k);
          roots.push(...(links.get(k)??[]));
        }
        for(let i=0;i<mesh.geometry.instanceCount;i++){
          const center=[points.getX(i),points.getY(i),points.getZ(i)];
          if(!connected.has(key(center)))throw new Error('Detached rendered crown at '+center);
          samples++;
        }
      }
      return {samples,stems};
    });
    assert.ok(rooted.samples>100&&rooted.stems>10);
    console.log(name,'rendered rooted survey canopy',rooted);
  }
  for(const [name,pose] of [
    ['university-hill','University College'],['middlesex-quad','Middlesex College'],['stadium-track','Western Alumni Stadium'],
    ['river-bank',[369.76,-174.68,1.9197]],['river-approach',[669,378.94,Math.atan2(88.84,16.77)]],['parking-estates',[-59.11,1810.50,1.7]],['university-junction','University Drive']
  ]){
    if(typeof pose==='string')await page.selectOption('#spawn',pose);
    else await page.evaluate(([x,z,heading])=>{const m=window.driveMetrics;m.surveyView({x,z,y:m.network.sample(x,z).y,heading,pitch:0});},pose);
    await page.waitForLoadState('networkidle');
    const report=await page.evaluate(async()=>{
      const dt=[];
      let prev;
      for(let i=0;i<75;i++){
        const now=await new Promise(requestAnimationFrame);
        if(i>15)dt.push(now-prev);
        prev=now;
      }
      dt.sort((a,b)=>a-b);
      const m=window.driveMetrics;
      return {medianMs:dt[29],p95Ms:dt[56],x:m.car.x,z:m.car.z,heading:m.car.heading,drawCalls:m.drawCalls,triangles:m.triangles,scale:m.renderScale};
    });
    await page.screenshot({path:join(output,name+'.png')});
    console.log(name,JSON.stringify(report));
    if(process.argv.includes('--prove')&&['river-approach','university-junction'].includes(name))await verifyTreeSupports(name);
  }
  if(process.argv.includes('--prove')){
    const terrain=await page.evaluate(()=>{
      const {facades,network}=window.driveMetrics;
      const root=facades.parent,region=root.getObjectByName('Western campus region');
      const ground=[...region.children.filter(m=>m.name.startsWith('Terrain ')),root.getObjectByName('Platt’s Lane Estates campus grounds')];
      let contacts=0,estate=0,maximum=0;
      for(const mesh of ground){
        const g=mesh.geometry,p=g.getAttribute('position'),count=g.index?.count??p.count;
        for(let k=0;k<count;k+=3){
          const a=g.index?.getX(k)??k,b=g.index?.getX(k+1)??k+1,c=g.index?.getX(k+2)??k+2;
          const x=(p.getX(a)+p.getX(b)+p.getX(c))/3,z=(p.getZ(a)+p.getZ(b)+p.getZ(c))/3;
          if(!network.withinCampus(x,z)||network.isDeck(x,z))continue;
          const y=(p.getY(a)+p.getY(b)+p.getY(c))/3;
          const sample=network.sample(x,z,y);
          const delta=Math.abs(sample.y-sample.curb-y);
          if(delta>.002)throw new Error('Rendered terrain and tires diverge at '+[x,z,delta]);
          maximum=Math.max(maximum,delta);
          contacts++;
          if(!g.index)estate++;
        }
      }
      return {contacts,estate,maximum};
    });
    assert.ok(terrain.contacts>200000&&terrain.estate>100);
    console.log('Rendered terrain and tire agreement',terrain);
    const driver='data:text/javascript;base64,'+(await readFile(new URL('circuit_driver.mjs',import.meta.url))).toString('base64');
    for(const id of ['college','stadium','campus']){
      await page.selectOption('#drive-course',id);
      const report=await page.evaluate(async({id,driver})=>{
        const {driveInput}=await import(driver);
        const {sim,car,network}=window.driveMetrics;
        const {samples}=network.circuits.find(c=>c.id===id);
        let contacts=0;
        for(let i=0;i<samples.at(-1).distance*24&&car.phase!=='finished';i++){
          sim.step(driveInput(samples,car));
          contacts+=Number(car.contact);
        }
        return {id,phase:car.phase,passed:car.checkpointsPassed,required:car.checkpointCount,contacts,x:car.x,z:car.z,distance:car.distance};
      },{id,driver});
      console.log('Rendered course drive',report);
      assert.equal(report.phase,'finished');
      assert.equal(report.passed,report.required);
      assert.ok(report.contacts<120);
    }
  }
  if(process.argv.includes('--prove')){
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      await page.selectOption('#drive-course','roam');
      await page.selectOption('#spawn','University Drive');
      await page.getByRole('button',{name:'Restart'}).click();
      await page.keyboard.down('ArrowUp');
      try{
        const measurement=await page.evaluate(async()=>{
          const m=window.driveMetrics,start=m.car.distance,samples=[];
          let last=await new Promise(requestAnimationFrame);
          for(let i=0;i<200;i++){
            const now=await new Promise(requestAnimationFrame);
            if(i>35)samples.push(now-last);
            last=now;
          }
          samples.sort((a,b)=>a-b);
          return {metres:m.car.distance-start,medianMs:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)],scale:m.renderScale};
        });
        assert.ok(measurement.metres>8);
        console.log('Moving viewport',viewport,measurement);
      }finally{await page.keyboard.up('ArrowUp');}
    }
  }
  if(process.argv.includes('--sweep')) await auditStreetViews(page,output);
  assert.deepEqual(errors,[]);
}finally{
  await browser?.close();
  server.kill();
}
