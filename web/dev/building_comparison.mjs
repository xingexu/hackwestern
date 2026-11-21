import {openBrowser} from './building_browser.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {parseArgs} from 'node:util';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=parseArgs({allowPositionals:true,options:{entry:{type:'string'},world:{type:'string'},html:{type:'string'},refinement:{type:'boolean'}}});
const out=join(root,'web/dev/shots/buildings',args.positionals[0]??'after');
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']});
let browser;
try{
  const [message]=await once(server.stdout,'data');
  const base=message.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  browser=await openBrowser();
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  if(args.values.entry||args.values.html)await page.route(/\/(\?diagnostics)?$/,async route=>{
    let html=await readFile(join(root,args.values.html??'web/dist/app/index.html'),'utf8');
    if(args.values.entry)html=html.replace(/(src="\.\/assets\/)index-[^"]+\.js/,(_,prefix)=>prefix+args.values.entry);
    if(args.values.world)html=html.replace(/("world.json":"\.\/assets\/)[^"]+/,(_,prefix)=>prefix+args.values.world);
    return route.fulfill({body:html,contentType:'text/html'});
  });
  await page.route(/\/drive-[A-Za-z0-9_-]+\.js$/,async route=>{
    const response=await route.fetch();
    const source=await response.text();
    const patched=source.replace(/renderCanvas\(\)\{return (\w+)\.render\((\w+),(\w+)\),\1\.domElement\}/,(_,renderer,scene,camera)=>
      'renderPhoto(p){const c='+camera+'.clone(),r='+renderer+',size=r.getSize(c.position.clone());const old=r.getPixelRatio();r.setPixelRatio(1);r.setSize(900,675,false);c.aspect=4/3;c.fov=2*Math.atan(Math.tan(p.hfov*Math.PI/360)/c.aspect)*180/Math.PI;c.position.set(p.x,p.y,p.z);c.up.set(0,1,0);c.lookAt(p.x+Math.sin(p.heading),p.y+Math.tan(p.pitch),p.z-Math.cos(p.heading));c.rotateZ(-p.roll);c.updateProjectionMatrix();r.render('+scene+',c);const image=r.domElement.toDataURL("image/jpeg",.94);r.setPixelRatio(old);r.setSize(size.x,size.y,false);return image;},'+_);
    await route.fulfill({body:patched,contentType:'text/javascript'});
  });
  const start=performance.now();
  await page.goto(base+'/?diagnostics');
  await page.waitForFunction(()=>window.driveMetrics?.frames>4,null,{timeout:90000});
  const readyMs=Math.round(performance.now()-start);
  const frames=JSON.parse(await readFile(join(root,'data/streetview/frames.json')));
  const ids=args.values.refinement?['79749217','62270873']:['131414491','138541401','126865219','79749217'];
  const calibrated=JSON.parse(execFileSync(join(root,'.venv/bin/python'),['build/building_camera.py',...ids],{cwd:root}));
  const poses=ids.map(id=>{
    const f={...frames.find(f=>f.id===id),...calibrated[id]};
    return {name:id,x:f.x,z:f.z,heading:Math.PI-f.heading*Math.PI/180,photo:{...calibrated[id],heading:f.heading*Math.PI/180}};
  });
  if(args.values.refinement){
    for(const [name,x,z,tx,tz,eye,pitch] of [
      ['west-stand',156,1266,180,1250,2.25,4],
      ['east-stand',325,1272,301,1266,2.1,4],
      ['western-road-porch',106.5,1581,119.9,1567,2.1,2.5],
      ['hospital-fascia',200,-128,190,-141,1.85,5],
      ['ivey-court',-107,764,-81,744,2.1,4]
    ]){
      const yaw=Math.atan2(tx-x,z-tz);
      poses.push({name,x,z,heading:Math.PI-yaw,photo:{heading:yaw,hfov:68,elevationAngle:pitch,roll:0,eye}});
    }
  }else poses.push({name:'uc-hill',x:347,z:325,heading:-1.85},{name:'engineering',x:236,z:749,heading:-1.3},{name:'uc-approach',x:437,z:370,heading:-2.0},{name:'spencer-approach',x:138,z:630,heading:-.25});
  await mkdir(out,{recursive:true});
  const measurements=[];
  for(const pose of poses){
    const result=await page.evaluate(async ({x,z,heading,photo})=>{
      const m=window.driveMetrics,grade=m.network.groundAt(x,z);
      m.surveyView({x,z,y:grade,heading,pitch:0,speed:0});
      const times=[];let frame=m.frames;
      for(let i=0;i<144;i++){
        await new Promise(requestAnimationFrame);
        if(m.frames!==frame && i>=60)times.push(m.frameMs);
        frame=m.frames;
      }
      times.sort((a,b)=>a-b);
      const arrays=new Set();
      m.facades?.traverse(mesh=>{
        if(mesh.geometry){
          for(const attribute of Object.values(mesh.geometry.attributes))arrays.add(attribute.array);
          if(mesh.geometry.index)arrays.add(mesh.geometry.index.array);
        }
        if(mesh.instanceMatrix)arrays.add(mesh.instanceMatrix.array);
        if(mesh.material?.userData.styles?.image.data)arrays.add(mesh.material.userData.styles.image.data);
      });
      const buildingBufferBytes=[...arrays].reduce((sum,a)=>sum+a.byteLength,0);
      const canvas=m.renderCanvas();
      const snapshot={image:canvas.toDataURL('image/jpeg',.93),median:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],renderScale:m.renderScale,calls:m.drawCalls,triangles:m.triangles,samples:times.length,buildingBufferBytes,raster:[canvas.width,canvas.height]};
      if(photo){
        const y=m.network.sample(x,z,grade).y+(photo.eye??1.7),pitch=photo.elevationAngle*Math.PI/180,roll=photo.roll*Math.PI/180;
        if(m.inspectLook){
          const {camera}=m.inspectLook(),saved=camera.clone();
          camera.position.set(x,y,z);camera.up.set(0,1,0);
          camera.lookAt(x+Math.sin(photo.heading),y+Math.tan(pitch),z-Math.cos(photo.heading));
          camera.rotateZ(-roll);
          camera.fov=2*Math.atan(Math.tan(photo.hfov*Math.PI/360)*.75)*180/Math.PI;
          camera.updateProjectionMatrix();
          const scene=m.renderCanvas(),crop=document.createElement('canvas');
          crop.width=900;crop.height=675;
          const width=scene.height*4/3;
          crop.getContext('2d').drawImage(scene,(scene.width-width)/2,0,width,scene.height,0,0,900,675);
          snapshot.eye=crop.toDataURL('image/jpeg',.94);
          camera.copy(saved);
        }else snapshot.eye=m.renderPhoto({x,z,y,heading:photo.heading,pitch,roll,hfov:photo.hfov});
      }
      return snapshot;
    },pose);
    for(const [key,suffix] of [['image',''],['eye','-eye']])if(result[key]){
      await writeFile(join(out,pose.name+suffix+'.jpg'),Buffer.from(result[key].split(',')[1],'base64'));
      delete result[key];
    }
    measurements.push({name:pose.name,...result});
    console.log(pose.name,JSON.stringify(result));
  }
  await writeFile(join(out,'measurements.json'),JSON.stringify({readyMs,measurements},null,2));
  if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser?.close();server.kill();}
