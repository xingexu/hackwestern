import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import {createServer,createConnection} from 'node:net';
import {createServer as httpServer} from 'node:http';
import {readFile,writeFile,mkdir,unlink,mkdtemp,rm,readdir,stat} from 'node:fs/promises';
import {createReadStream,existsSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openBrowser} from './building_browser.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),local=fileURLToPath(import.meta.url);
const options=parseArgs({options:{id:{type:'string'},spec:{type:'string'},out:{type:'string'},'shadow-reference':{type:'boolean'},daemon:{type:'boolean'}}}).values;
const output=resolve(options.out??join(root,'web/dev/shots/buildings',options.id??'preview'));
const override=options.spec?resolve(options.spec):null;
process.chdir(root);
const recipeFiles=readdirSync('build').filter(f=>f.startsWith('building_') && f.endsWith('.py') || ['compile_buildings.py','validate_specs.py','geo.py','campus_region.py'].includes(f)).map(f=>join('build',f));
const recipeInputs=[...recipeFiles,'data/buildings/inventory.json','data/buildings/lidar/roof-grid.npz','web/drive-network.json','build/specs/building-spec-v1.schema.json'];
const revision=createHash('sha1').update(['web/dev/building_preview.mjs','web/dev/building_preview_scene.mjs','web/dev/building_sightlines.mjs','web/campus-buildings.mjs','web/building-materials.mjs','web/building-kernel.mjs','web/building-contacts.mjs','web/parking-decks.mjs','web/campus-scene.js'].concat(['data/buildings/inventory.json']).map(p=>statSync(p).mtimeMs).join(',')).digest('hex').slice(0,8);
const socket='.agent/building-preview-'+revision+'.sock';
const json=async p=>JSON.parse(await readFile(join(root,p)));
async function load(){
  const [inventory,frames]=await Promise.all(['data/buildings/inventory.json','data/streetview/frames.json'].map(json));
  const pageSource=await readFile(join(root,'web/index.html'),'utf8');
  const imports=JSON.parse(pageSource.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  for(const key of Object.keys(imports))imports[key]='/web/'+imports[key].slice(2);
  const types={'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg'};
  const page='<link rel="icon" href="data:,"><script type="importmap">'+JSON.stringify({imports})+'</script>';
  const assets=httpServer(async(req,res)=>{
    try{
      const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(path==='/'){res.writeHead(200,{'Content-Type':'text/html'}).end(page);return;}
      const type=types[extname(path)];
      const dataset=/^\/[\w-]+\.json$/.test(path);
      const file=dataset?resolve(root,'web',path.slice(1)):resolve(root,'.'+path);
      const web=file.startsWith(join(root,'web')+'/');
      const photo=(type==='image/png'||type==='image/jpeg') && ['data/buildings','data/streetview'].some(dir=>file.startsWith(join(root,dir)+'/'));
      if(!type || !(web || photo)){res.writeHead(404).end();return;}
      const info=await stat(file),etag='"'+info.mtimeMs+'-'+info.size+'"';
      if(req.headers['if-none-match']===etag){res.writeHead(304).end();return;}
      res.writeHead(200,{'Content-Type':type,'Content-Length':info.size,'ETag':etag,'Cache-Control':'no-cache'});
      const stream=createReadStream(file);
      res.once('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch{if(!res.headersSent)res.writeHead(404);res.end();}
  });
  const browser=await openBrowser();
  await new Promise((accept,reject)=>{assets.once('error',reject);assets.listen(0,'127.0.0.1',accept);});
  return {inventory:inventory.buildingsList,frames:new Map(frames.map(f=>[f.id,f])),browser,context:await browser.newContext(),url:'http://127.0.0.1:'+assets.address().port,assets};
}
const compilationSlots=Array.from({length:3},()=>Promise.resolve());
let nextCompiler=0,calibrationBatch,compiled;
function compileOne(args){
  const slot=nextCompiler++%compilationSlots.length;
  const run=compilationSlots[slot].then(()=>promisify(execFile)(join(root,'.venv/bin/python'),args,{cwd:root}));
  compilationSlots[slot]=run.catch(()=>{});
  return run;
}
async function readCalibration(keys){
  const result=await promisify(execFile)(join(root,'.venv/bin/python'),['build/building_camera.py',...keys]);
  return JSON.parse(result.stdout);
}
function calibrate(frames){
  if(!frames.length)return Promise.resolve({});
  if(!calibrationBatch){
    const keys=new Set();
    const poses=new Promise((accept,reject)=>setTimeout(()=>{
      calibrationBatch=null;
      readCalibration(keys).then(accept,reject);
    },24));
    calibrationBatch={keys,poses};
  }
  const batch=calibrationBatch,ids=frames.map(frame=>frame.id);
  for(const id of ids)batch.keys.add(id);
  return batch.poses.catch(error=>{
    if(batch.keys.size===ids.length)throw error;
    return readCalibration(ids);
  });
}
async function prepare(state,job){
  const {id,spec}=job;
  const inv=state.inventory.find(b=>b.id===id);
  if(!inv)throw new Error('Unknown inventory building '+id);
  const compiledTime=statSync('web/campus-buildings.json').mtimeMs;
  if(compiled?.mtime!==compiledTime)compiled={mtime:compiledTime,records:json('web/campus-buildings.json')};
  const data=await compiled.records;
  let building=data.find(b=>b.id===id);
  const source=spec??join(root,'build/specs/buildings',id+'.json');
  const inputs=[...recipeInputs,join('data/buildings/evidence',id,'aerial-source.jpg'),join('build/specs/auto',id+'.json')];
  const changed=existsSync(source) && createHash('sha256').update(await readFile(source)).digest('hex')!==building?.sourceDigest;
  if(spec || !building || changed || inputs.some(p=>existsSync(p) && statSync(p).mtimeMs>compiledTime)){
    const scratch=await mkdtemp(join(root,'.agent/building-'));
    try{
      const file=join(scratch,'one.json');
      await compileOne(['build/compile_buildings.py','--id',id,'--spec',source,'--out',file]);
      building=JSON.parse(await readFile(file))[0];
    }finally{await rm(scratch,{recursive:true,force:true});}
  }
  const [l,t,r,b]=building.bounds,x=(l+r)/2,z=(t+b)/2,range=Math.max(175,(r-l)*1.85,(b-t)*1.85);
  const neighbors=data.filter(v=>v.id!==id && Math.hypot(x-v.center[0],z-v.center[1])<range*1.55);
  const pinned={w118764095:'131414491',w237299189:'138541401',w118764110:'126865219',w310132539:'79749217'};
  const ids=[...new Set([pinned[id],...inv.sheetFrames.map(f=>f.frame),...(building.sources??[]),...inv.walls.flatMap(w=>w.frames.map(f=>f.frame))])];
  const frames=ids.map(k=>state.frames.get(k)).filter(f=>f&&existsSync(join(root,'data/streetview',f.path))).slice(0,32).map(f=>({...f,path:'data/streetview/'+f.path}));
  const calibrated=await calibrate(frames);
  for(const f of frames)Object.assign(f,calibrated[f.id]);
  const obliqueReference=existsSync('data/buildings/preview-poses.json')?(await json('data/buildings/preview-poses.json'))[id]:undefined;
  return {building,neighbors,frames,obliqueReference,aerial:inv.aerial,surveyBounds:[Math.min(...inv.footprint.map(p=>p[0])),Math.min(...inv.footprint.map(p=>p[1])),Math.max(...inv.footprint.map(p=>p[0])),Math.max(...inv.footprint.map(p=>p[1]))],shadowReference:job.shadowReference};
}
async function render(state,job,config){
  const {id,out}=job;
  const page=state.page??await state.context.newPage();
  try{
    if(!state.page){
    state.errors=[];page.on('console',m=>{if(m.type()==='error')state.errors.push(m.text());});
    await page.goto(state.url);
    state.page=page;
    }
    const calibrated=JSON.parse((await promisify(execFile)(join(root,'.venv/bin/python'),['build/building_camera.py',...frames.map(f=>f.id)])).stdout);
    for(const f of frames)Object.assign(f,calibrated[f.id]);
    const obliqueReference=existsSync('data/buildings/preview-poses.json')?(await json('data/buildings/preview-poses.json'))[id]:undefined;
    const config={building,neighbors,frames,obliqueReference,aerial:inv.aerial,surveyBounds:[Math.min(...inv.footprint.map(p=>p[0])),Math.min(...inv.footprint.map(p=>p[1])),Math.max(...inv.footprint.map(p=>p[0])),Math.max(...inv.footprint.map(p=>p[1]))],shadowReference:job.shadowReference};
    const result=await page.evaluate(async encoded=>(await import('/web/dev/building_preview_scene.mjs')).renderBuilding(JSON.parse(encoded)),JSON.stringify(config));
    if(state.errors.length)throw new Error(state.errors.splice(0).join('\n').slice(0,7000));
    await mkdir(out,{recursive:true});
    const paths=[];
    for(const [name,encoded] of result.pictures){const path=join(out,id+'-'+name+'.jpg');await writeFile(path,Buffer.from(encoded,'base64'));paths.push(path);}
    const emitted=new Set(result.pictures.map(([name])=>id+'-'+name+'.jpg'));
    for(const file of await readdir(out))if(file.startsWith(id+'-street-') && /^.+-street-[0-9]+\.jpg$/.test(file) && !emitted.has(file))await unlink(join(out,file));
    const cameraFile=join(out,id+'-camera-poses.json');
    await writeFile(cameraFile,JSON.stringify(result.poses,null,2)+'\n');
    paths.push(cameraFile);
    const obliqueFile=join(out,id+'-obliques.json');
    await writeFile(obliqueFile,JSON.stringify(result.obliques,null,2)+'\n');paths.push(obliqueFile);
    return {paths,...result.stats};
  }catch(error){await page.close();state.page=null;throw error;}
}
async function daemon(){
  let init,timer,outstanding=0;
  const slots=Array.from({length:3},()=>({queue:Promise.resolve(),count:0,state:null}));
  const server=createServer(peer=>{
    clearTimeout(timer);
    let msg='';
    peer.on('error',()=>{});
    peer.on('data',chunk=>{
      msg+=chunk;
      if(!msg.includes('\n'))return;
      const job=JSON.parse(msg);msg='';
      const slot=slots.reduce((a,b)=>a.count<=b.count?a:b);
      slot.count++;outstanding++;
      init??=load();
      const prepared=init.then(state=>prepare(state,job));
      slot.queue=Promise.allSettled([slot.queue,prepared]).then(async ([,ready])=>{
        try{
          if(ready.status==='rejected')throw ready.reason;
          slot.state??={...await init};
          peer.end(JSON.stringify(await render(slot.state,job,ready.value)));
        }catch(e){peer.end(JSON.stringify({error:e.message}));}
        finally{
          slot.count--;outstanding--;
          if(!outstanding)timer=setTimeout(async()=>{server.close();const state=await init;state.assets.close();await state.browser.close();},55000);
        }
      });
    });
  });
  server.on('error',e=>{if(e.code!=='EADDRINUSE')throw e;});
  server.listen(socket);
}
function submit(job){
  return new Promise((done,fail)=>{
    const client=createConnection(socket),chunks=[];
    client.on('error',fail);client.on('connect',()=>client.write(JSON.stringify(job)+'\n'));
    client.on('data',chunk=>chunks.push(chunk));
    client.on('end',()=>{try{done(JSON.parse(Buffer.concat(chunks)));}catch(e){fail(e);}});
  });
}
if(options.daemon)await daemon();
else{
  if(!options.id)throw new Error('Usage: node web/dev/building_preview.mjs --id <id> [--spec <path>] [--out <dir>]');
  const start=performance.now(),job={id:options.id,spec:override,out:output,shadowReference:options['shadow-reference']};
  let result;
  for(let attempt=0;attempt<80;attempt++){
    try{result=await submit(job);break;}catch(error){
      if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;
      if(attempt===0){
        if(error.code==='ECONNREFUSED')await unlink(socket).catch(()=>{});
        const child=fork(local,['--daemon'],{cwd:root,detached:true,stdio:'ignore',execArgv:[]});
        child.disconnect();child.unref();
      }
      await new Promise(r=>setTimeout(r,100));
    }
  }
  if(!result||result.error)throw new Error(result?.error??'Preview daemon did not start');
  console.log(result.paths.join('\n'));
  console.log(`${((performance.now()-start)/1000).toFixed(2)} s, ${result.calls} draw calls, ${result.triangles} triangles`);
}
