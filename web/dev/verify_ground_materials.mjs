import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';

export async function verifyGroundMaterials(page,manifest,out){
  assert.equal(manifest.cellMeters,8);
  assert.ok(Object.values(manifest.tiles).every(t=>Object.keys(t).every(k=>['reference','cells'].includes(k)) && t.cells.every(c=>c.length===5 && c.slice(2).every(n=>Number.isInteger(n) && n>=0 && n<=3))));
  const candidates=Object.values(manifest.tiles).map(tile=>tile.reference).filter(Boolean).sort((a,b)=>b.contrast-a.contrast);
  assert.ok(candidates.length>1);
  const chase=page.locator('#view-toggle');
  if(await chase.getAttribute('aria-pressed')==='false') await chase.click();
  const result=await page.evaluate(async sources=>{
    const {network,facades,surveyView,renderCanvas}=window.driveMetrics;
    const ground=facades.parent.getObjectByName('Western campus region');
    const raf=()=>new Promise(requestAnimationFrame);
    const sample=new OffscreenCanvas(320,200),ctx=sample.getContext('2d',{willReadFrequently:true});
    function capture(){
      ctx.drawImage(renderCanvas(),0,0,320,200);
      return ctx.getImageData(0,0,320,200).data;
    }
    const visited=new Set();
    for(const source of sources){
      if(visited.has(source.id)) continue;
      visited.add(source.id);
      const [x,z]=source.camera,y=network.groundAt(x,z),heading=(180-source.heading)*Math.PI/180;
      if(network.blocked(x,z,y,.75)) continue;
      surveyView({x,y,z,heading,pitch:0});
      let active;
      for(let i=0;i<100;i++){
        await raf();
        active=[];
        ground.traverse(o=>{
          const surface=o.material?.userData;
          if(surface && 'finish' in surface && o.material.map!==surface.finish && !o.material.map.isDataTexture)
            throw new Error('Driving terrain contains a photographic color map');
          if(!surface?.conditionStrength) return;
          if(!surface.conditions.isDataTexture || o.material.map!==surface.finish) throw new Error('The ground renderer must use a categorical material grid');
          const texels=surface.conditions.image.data;
          for(let i=0;i<texels.length;i++) if(texels[i]%85) throw new Error('A continuous image value reached the ground material grid');
          active.push(surface.conditionStrength);
        });
        if(i>=26 && active.length) break;
      }
      if(!active.length) continue;
      const before=capture();
      for(const strength of active) strength.value=0;
      const base=capture();
      for(const strength of active) strength.value=1;
      capture();
      let changed=0;
      for(let y=104;y<155;y++) for(let x=55;x<260;x++){
        const i=(y*320+x)*4;
        if(Math.abs(base[i]-before[i])+Math.abs(base[i+1]-before[i+1])+Math.abs(base[i+2]-before[i+2])>9) changed++;
      }
      if(changed>80) return {id:source.id,changed};
    }
    throw new Error('Observed surface classes did not change the visible game pavement');
  },candidates.slice(0,14));
  await page.screenshot({path:join(out,'street-material-road.png')});
  const estateRoad=manifest.estates.ways.find(w=>w.id===123525149);
  assert.ok(estateRoad?.points.length>8);
  const estate=await page.evaluate(async points=>{
    const {network,surveyView,facades}=window.driveMetrics;
    const road=facades.parent.getObjectByName('Platt’s Lane Estates campus grounds');
    if(!road || !road.material.customProgramCacheKey().includes('estates-ground-classes')) throw new Error('Missing reconstructed road material on the southern parcel');
    for(const [px,pz] of [[-59.11,1810.50],[26.37,1808.75],[254.07,1826.99]]){
      const y=network.groundAt(px,pz);
      if(network.sample(px,pz,y).surface!=='road') throw new Error('A surveyed estate parking space uses unpaved driving physics');
    }
    const middle=Math.floor(points.length/2),[x,z]=points[middle],[nx,nz]=points[middle+1],y=network.groundAt(x,z);
    surveyView({x,y,z,heading:Math.atan2(nx-x,nz-z),pitch:0});
    for(let i=0;i<10;i++) await new Promise(requestAnimationFrame);
    return points.slice(1,-1).map(([px,pz])=>{
      const height=network.groundAt(px,pz),contact=network.sample(px,pz,height);
      return [contact.surface,Math.abs(height-contact.y)];
    });
  },estateRoad.points);
  assert.ok(estate.every(([kind,error])=>kind==='road' && error<.16),'Southern service driveway must remain drivable on its modeled terrain');
  await page.screenshot({path:join(out,'platts-lane-drive.png')});
  if(await chase.getAttribute('aria-pressed')==='true') await chase.click();
  console.log('Verified road material classes from survey '+result.id+' across '+result.changed+' visible pavement samples.');
}

export async function verifyStadiumVerge(page,shot){
  const reference=await readFile(new URL('../../data/audit/ortho-2025/150_1050.jpg',import.meta.url));
  const result=await page.evaluate(async ([capture,aerial])=>{
    async function rgb(encoded,type){
      const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      const image=await createImageBitmap(new Blob([bytes],{type}));
      const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');
      ctx.drawImage(image,0,0);
      return {width:image.width,height:image.height,data:ctx.getImageData(0,0,image.width,image.height).data};
    }
    const shot=await rgb(capture,'image/png'),photo=await rgb(aerial,'image/jpeg');
    const {network,inspectLook}=window.driveMetrics;
    const {THREE,camera}=inspectLook();
    const {width,height}=shot,eye=camera.position,ray=new THREE.Vector3();
    const first=Math.floor(height*.58),last=Math.floor(height*.88),columns=Math.floor(width*.255);
    const edges=[],errors=[];
    let turf=0,green=0,paved=0,hard=0,expected=0;
    for(let x=0;x<columns;x++){
      let observed=null;
      const referenceGrass=[];
      for(let y=first;y<last;y++){
        const k=(y*width+x)*4,r=shot.data[k],g=shot.data[k+1],b=shot.data[k+2];
        const grass=g-r>9 && g-b>17;
        if(grass && observed===null)observed=y;
        if((y-first)%2)continue;
        ray.set((x+.5)*2/width-1,1-(y+.5)*2/height,.5).unproject(camera).sub(eye).normalize();
        let lo=0,hi=120;
        for(let i=0;i<17;i++){
          const d=(lo+hi)*.5;
          if(eye.y+d*ray.y>network.groundAt(eye.x+d*ray.x,eye.z+d*ray.z))lo=d;
          else hi=d;
        }
        const u=Math.floor((eye.x+ray.x*hi-150)*10),v=Math.floor((eye.z+ray.z*hi-1050)*10);
        if(u<0||v<0||u>=photo.width||v>=photo.height)throw new Error('Stadium verge extends beyond its reference photograph');
        const j=(v*photo.width+u)*4,red=photo.data[j],olive=photo.data[j+1],blue=photo.data[j+2];
        referenceGrass.push((red-olive>5 && olive-blue>10 && red-blue>20 || olive>red+4 && olive>blue+7) && red<180);
        if(red-blue>28 && olive-blue>16 && red<149 && red>75){turf++;green+=grass?1:0;}
        if(red>156 && red-olive<10 && olive-blue<25){paved++;hard+=grass?0:1;}
      }
      let native=null;
      for(let i=4;i<referenceGrass.length-4;i++){
        if(referenceGrass.slice(i-4,i+5).filter(Boolean).length>=7){native=first+i*2;break;}
      }
      if(native!==null && native<height*.73){
        expected++;
        if(observed!==null){edges.push([x,observed]);errors.push(Math.abs(native-observed));}
      }
    }
    const jumps=[];
    for(let i=1;i<edges.length;i++)if(edges[i][0]===edges[i-1][0]+1)jumps.push(Math.abs(edges[i][1]-edges[i-1][1]));
    errors.sort((a,b)=>a-b);
    return {columns,expected,coverage:edges.length/expected,maximum:Math.max(...jumps),steps:jumps.filter(n=>n>3).length,
      median:errors[Math.floor(errors.length*.5)],turf,paved,lawnAgreement:green/turf,pavingAgreement:hard/paved};
  },[shot.toString('base64'),reference.toString('base64')]);
  assert.ok(result.expected>result.columns*.65 && result.coverage>.95 && result.maximum<=6 && result.steps<=2,'Athletics verge contains visible stair steps '+JSON.stringify(result));
  assert.ok(result.median<=8 && result.turf>2500 && result.paved>2000 && result.lawnAgreement>.975 && result.pavingAgreement>.85,'Stadium lawn and paved apron disagree with the city photograph '+JSON.stringify(result));
  console.log('Stadium verge checked against the 2025 aerial',JSON.stringify(result));
}
