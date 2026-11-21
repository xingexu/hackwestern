import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';

export async function verifyStreetPhotos(page,manifest,out){
  const candidates=manifest.tiles.flatMap(tile=>tile.panels.map(panel=>({panel,frame:manifest.frames[panel[9]]})))
    .sort((a,b)=>b.panel[10].length-a.panel[10].length);
  const result=await page.evaluate(async candidates=>{
    const {network,facades,surveyView,renderCanvas}=window.driveMetrics;
    const frame=()=>new Promise(requestAnimationFrame);
    async function waitUntil(test){
      for(let i=0;i<180;i++){
        if(test()) return;
        await frame();
      }
      throw new Error('Architectural detail tile failed to follow the camera');
    }
    const sample=document.createElement('canvas');
    sample.width=240;sample.height=144;
    const ctx=sample.getContext('2d',{willReadFrequently:true});
    function capture(){ctx.drawImage(renderCanvas(),0,0,240,144);return ctx.getImageData(0,0,240,144).data;}
    let best=null;
    const tested=new Set();
    for(const {panel,frame:source} of candidates){
      const [ax,az,bx,bz,base,top,nx,nz]=panel,midX=(ax+bx)*.5,midZ=(az+bz)*.5;
      if(tested.has(source.url)) continue;
      const x=source.x,z=source.z,y=network.groundAt(x,z);
      if(network.blocked(x,z,y,.9)) continue;
      tested.add(source.url);
      const pose={x,y,z,heading:Math.atan2(midX-x,midZ-z),pitch:0};
      surveyView(pose);
      await waitUntil(()=>facades.children.length && !document.getElementById('facade-credit').hidden);
      for(let k=0;k<8;k++) await frame();
      const before=capture();
      facades.visible=false;
      const after=capture();
      facades.visible=true;
      let changed=0,center=0;
      for(let i=0;i<before.length;i+=4){
        if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])<=18) continue;
        changed++;
        const col=i/4%240,row=Math.floor(i/960);
        if(col>38 && col<199 && row>28 && row<102) center++;
      }
      if(!best || center>best.center) best={pose,midX,midZ,center,changed,source:source.url};
      if(center>1700 || tested.size>=12) break;
    }
    if(!best || best.changed<140 || best.center<65) throw new Error('No reconstructed facade contributed visible pixels to the street-level view');
    const {pose,midX,midZ,changed,center,source}=best;
    surveyView(pose);
    const close=tile=>{
      const [l,t,r,b]=tile.userData.bounds;
      return Math.hypot(Math.max(0,l-midX,midX-r),Math.max(0,t-midZ,midZ-b))<8;
    };
    await waitUntil(()=>facades.children.some(tile=>close(tile)&&tile.userData.level===2));
    const shown=facades.children.find(tile=>close(tile)&&tile.userData.level===2),sampleMesh=shown.children[0];
    const farX=Math.abs(network.bounds[0]-pose.x)>Math.abs(network.bounds[2]-pose.x)?network.bounds[0]+5:network.bounds[2]-5;
    const farZ=Math.abs(network.bounds[1]-pose.z)>Math.abs(network.bounds[3]-pose.z)?network.bounds[1]+5:network.bounds[3]-5;
    let released=0;
    for(const item of [sampleMesh.material,sampleMesh.geometry])item.addEventListener('dispose',()=>released++);
    surveyView({x:farX,y:network.groundAt(farX,farZ),z:farZ,heading:0,pitch:0});
    await waitUntil(()=>!facades.children.includes(shown));
    surveyView(pose);
    await waitUntil(()=>facades.children.some(mesh=>mesh.userData.tile===shown.userData.tile && mesh.userData.level===2 && mesh!==shown));
    for(let k=0;k<12;k++)await frame();
    const adapted=capture(),restore=[];
    facades.traverse(m=>{
      const texture=m.material?.userData.styles;
      if(!texture)return;
      const v=texture.image.data,original=v.slice();
      restore.push(()=>{v.set(original);texture.needsUpdate=true;});
      for(let i=0;i<v.length;i+=24){v[i]=.26;v[i+1]=.28;v[i+2]=.29;}
      texture.needsUpdate=true;
    });
    const generic=capture();
    restore.forEach(fn=>fn());
    let conditioned=0;
    for(let i=0;i<adapted.length;i+=4)
      if(Math.abs(adapted[i]-generic[i])+Math.abs(adapted[i+1]-generic[i+1])+Math.abs(adapted[i+2]-generic[i+2])>4)conditioned++;
    return {conditioned,changed,center,released,source,credit:document.getElementById('facade-credit').href};
  },candidates.slice(0,60));
  assert.equal(result.released,2);
  assert.ok(manifest.tiles.every(tile=>!('image' in tile) && tile.panels.every(panel=>Array.isArray(panel[10]))));
  assert.ok(result.conditioned>80,'Generated walls must respond to their surveyed material palette at street level');
  assert.ok(Object.values(manifest.frames).some(frame=>frame.url===result.credit));
  await page.screenshot({path:join(out,'modeled-street-facade.png')});
  console.log('Modeled street facade',result.changed,'visible geometry samples,',result.conditioned,'responding base material samples, material and geometry disposed and rebuilt',result.credit);
}

export async function verifyPhotoStart(page,base,manifest){
  const id=Object.keys(manifest.frames)[0],source=manifest.frames[id];
  await page.goto(base+'/?diagnostics&capture='+encodeURIComponent(id));
  await page.waitForFunction(()=>window.driveMetrics?.frames>=5,null,{timeout:45000});
  assert.equal(await page.locator('#spawn').inputValue(),'Street photograph');
  assert.equal(await page.locator('#drive-course').inputValue(),'roam');
  const pose=await page.evaluate(()=>{
    const {car,network}=window.driveMetrics;
    return {x:car.x,z:car.z,heading:car.heading,clear:!network.blocked(car.x,car.z,car.y,1),surface:network.sample(car.x,car.z,car.y).surface};
  });
  assert.ok(pose.clear && pose.surface==='road');
  assert.ok(Math.hypot(pose.x-source.x,pose.z-source.z)<60);
  assert.ok(Math.cos(pose.heading-(Math.PI-source.heading*Math.PI/180))>.9999);
  await page.goto(base+'/?diagnostics&capture=missing');
  await page.waitForFunction(()=>window.driveMetrics?.frames>=5,null,{timeout:45000});
  assert.equal(await page.locator('#spawn').inputValue(),'University Drive');
}

export async function verifyFacilitiesPhotos(page,manifest,out){
  const json=async name=>JSON.parse(await readFile(new URL('../'+name+'.json',import.meta.url)));
  const region=await json('campus-region');
  const detail=(await json('region-detail')).architecture;
  const candidates=[];
  for(const [key,source] of Object.entries(manifest.materialSources)){
    if(source.kind!=='facilities') continue;
    const building=+key,block=region.blocks[building];
    let walls=[];
    if(block){
      const ring=block[0];
      let area=0;
      for(let i=0;i<ring.length;i+=2){const next=(i+2)%ring.length;area+=ring[i]*ring[next+1]-ring[next]*ring[i+1];}
      for(let i=0;i<ring.length;i+=2){
        const next=(i+2)%ring.length,dx=ring[next]-ring[i],dz=ring[next+1]-ring[i+1],length=Math.hypot(dx,dz);
        if(length<6) continue;
        walls.push([ring[i],ring[i+1],ring[next],ring[next+1],block[2]+block[3],Math.sign(area)*dz/length,-Math.sign(area)*dx/length]);
      }
    }else walls=detail.core[building-region.blocks.length][2];
    for(const [ax,az,bx,bz,top,nx,nz] of walls){
      const length=Math.hypot(ax-bx,az-bz);
      if(length<7) continue;
      const mx=(ax+bx)*.5,mz=(az+bz)*.5;
      const distance=Math.max(12,Math.min(30,length*.72));
      candidates.push({x:mx+distance*nx,z:mz+distance*nz,heading:Math.atan2(-nx,-nz),rank:Math.min(48,length)*Math.max(...manifest.materials[key].slice(0,6).map(Math.abs)),name:source.name});
    }
  }
  candidates.sort((a,b)=>b.rank-a.rank);
  const result=await page.evaluate(async candidates=>{
    const m=window.driveMetrics,canvas=document.createElement('canvas');canvas.width=240;canvas.height=144;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const shot=()=>{ctx.drawImage(m.renderCanvas(),0,0,240,144);return ctx.getImageData(0,0,240,144).data;};
    for(const {x,z,heading,name} of candidates){
      const y=m.network.groundAt(x,z);
      if(m.network.blocked(x,z,y,1.05)) continue;
      m.surveyView({x,y,z,heading,pitch:0});
      for(let i=0;i<10;i++)await new Promise(requestAnimationFrame);
      const observed=shot(),restore=[];
      m.facades.traverse(mesh=>{
        const texture=mesh.material?.userData.styles;
        if(!texture)return;
        const v=texture.image.data,original=v.slice();
        restore.push(()=>{v.set(original);texture.needsUpdate=true;});
        for(let i=0;i<v.length;i+=24)if(v[i+3]!==8){v[i]=.24;v[i+1]=.28;v[i+2]=.30;}
        texture.needsUpdate=true;
      });
      const plain=shot();restore.forEach(fn=>fn());m.renderCanvas();
      let changed=0;
      for(let row=35;row<90;row++) for(let col=65;col<175;col++){
        const i=(row*240+col)*4;
        if(Math.abs(plain[i]-observed[i])+Math.abs(plain[i+1]-observed[i+1])+Math.abs(plain[i+2]-observed[i+2])>7) changed++;
      }
      if(changed>450) return {name,changed};
    }
    throw new Error('No catalogue-matched building material appeared in the approaches checked');
  },candidates.slice(0,100));
  await page.screenshot({path:join(out,'western-facilities-material.png')});
  console.log('Western Facilities exterior material',result.name,result.changed,'changed central samples');
}
