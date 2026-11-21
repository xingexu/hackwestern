import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../../',import.meta.url));
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']});
let browser;
try{
  const [message]=await once(server.stdout,'data');
  const base=message.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(base+'/?audit&diagnostics');
  await page.waitForFunction(()=>window.campusAudit,null,{timeout:90000});
  const measure=async (x,z,pose,check)=>{
    await page.evaluate(c=>campusAudit.focus(c),{id:'x'+x+'z'+z,x:x*50,z:z*50});
    await page.waitForLoadState('networkidle');
    return page.evaluate(async ({pose,check})=>{
      const {scene,renderer,sun,THREE}=driveMetrics.inspectLook();
      const {width,height}=pose;
      const cv=new OffscreenCanvas(width,height),ctx=cv.getContext('2d',{willReadFrequently:true});
      ctx.imageSmoothingQuality='high';
      const read=async (scale=1)=>{
        campusAudit.render({...pose,width:width*scale,height:height*scale});
        ctx.drawImage(renderer.domElement,0,0,width,height);
        return ctx.getImageData(0,0,width,height).data;
      };
      const first=await read();
      if(check==='pavementBands'){
        const rows=[];
        for(let y=228;y<291;y++){
          let total=0;
          for(let x=35;x<200;x++){
            const i=4*(y*width+x);
            total+=(first[i]+first[i+1]+first[i+2])/3;
          }
          rows.push(total/165);
        }
        const bends=rows.slice(2).map((value,i)=>Math.abs(value-2*rows[i+1]+rows[i])).sort((a,b)=>a-b);
        return bends[Math.floor(bends.length*.9)];
      }
      if(check==='walkEdge'){
        const boundary=x=>{
          for(let y=65;y<167;y++){
            const i=4*(y*width+x),j=i+4*width;
            if(first[i+1]-first[i]>6 && first[j+1]-first[j]<=6)return y;
          }
          throw Error('Missing concrete edge at '+x);
        };
        return Math.abs(boundary(706)-(boundary(626)+boundary(786))*.5)/20;
      }
      if(check==='reflection'){
        const values=[];
        for(let y=40;y<140;y++)for(let x=110;x<330;x++)values.push(first[4*(y*width+x)+1]);
        values.sort((a,b)=>a-b);
        return values[Math.floor(values.length*.9)]-values[Math.floor(values.length*.1)];
      }
      if(check==='waterSeams'){
        const contrasts=[];
        for(let cell=3;cell<=5;cell++){
          const x=Math.round(cell/.13*20);
          for(let z=-386;z<-376;z++){
            const i=4*((z+400)*20*width+x);
            contrasts.push(Math.abs(first[i-8+1]-first[i+8+1]));
          }
        }
        return contrasts.sort((a,b)=>a-b)[Math.floor(.9*contrasts.length)];
      }
      if(check==='oblique'){
        const reference=await read(3);
        let error=0,count=0;
        for(let y=150;y<325;y++)for(let x=16;x<470;x++){
          const i=4*(y*width+x);
          if(reference[i]-reference[i+1]<16 || reference[i+2]-reference[i+1]<18)continue;
          error+=Math.abs(reference[i+1]-first[i+1]);count++;
        }
        return {error:error/count,count};
      }
      if(check==='lotTone'){
        const i=4*((height>>1)*width+(width>>1));
        return Array.from(first.slice(i,i+3));
      }
      if(check==='jointBands'){
        const mean=(x,y)=>{
          let sum=0;
          for(let j=-1;j<=1;j++)for(let i=0;i<18;i++)sum+=first[((y+j)*width+x+i)*4+1];
          return sum/54;
        };
        return [340,376,412].reduce((sum,y)=>sum+(mean(946,y-7)+mean(946,y+7))*.5-mean(946,y),0)/3;
      }
      if(check==='bank'){
        const sky=scene.background;
        scene.background=new THREE.Color(0xff00ff);
        const magenta=await read();
        scene.background=new THREE.Color(0x0000ff);
        const blue=await read();
        scene.background=sky;
        let leaks=0;
        for(let y=220;y<294;y++)for(let x=320;x<480;x++){
          const i=4*(y*width+x);
          if(Math.abs(magenta[i]-blue[i])>50)leaks++;
        }
        return leaks;
      }
      if(check==='roof'){
        sun.castShadow=false;
        const lit=await read();
        sun.castShadow=true;
        let error=0,count=0;
        for(let y=212;y<250;y++)for(let x=58;x<112;x++){
          const i=4*(y*width+x)+1;
          error+=Math.abs(lit[i]-first[i]);count++;
        }
        return error/count;
      }
      if(check==='aggregate'){
        let jumps=0,count=0;
        for(let y=234;y<280;y++)for(let x=15;x<207;x++){
          const i=4*(y*width+x)+1;
          if(Math.abs(first[i+4]-first[i])>4)jumps++;
          count++;
        }
        return jumps/count;
      }
      if(check==='canopy'){
        const leaves=[];
        scene.traverseVisible(m=>{if(m.name==='Surveyed canopy clusters' && m.castShadow)leaves.push(m);});
        for(const leaf of leaves)leaf.castShadow=false;
        const bare=await read();
        for(const leaf of leaves)leaf.castShadow=true;
        const again=await read();
        let shadow=0,unstable=0;
        for(let i=0;i<first.length;i+=4){
          if(bare[i+1]-first[i+1]>18)shadow++;
          if(Math.abs(again[i+1]-first[i+1])>1)unstable++;
        }
        return {shadow,unstable};
      }
      if(check==='glass'){
        const original=sun.position.clone();
        sun.position.copy(sun.target.position).add(new THREE.Vector3(-.77,.89,-.42).normalize().multiplyScalar(180));
        const glazed=await read(),glass=[];
        scene.traverseVisible(mesh=>{if(mesh.isMesh && mesh.castShadow && mesh.material.transparent && mesh.material.userData.styles)glass.push(mesh);});
        for(const mesh of glass)mesh.castShadow=false;
        const clear=await read();
        sun.position.copy(original);
        for(const mesh of glass)mesh.castShadow=true;
        let tinted=0;
        for(let i=0;i<clear.length;i+=4)if(clear[i+1]-glazed[i+1]>8)tinted++;
        return tinted;
      }
      if(check==='walk'){
        let red=0;
        for(const [cx,cz] of [[15,767.5],[16,776.5],[16.5,785.5],[17,787]]){
          for(let j=-4;j<=4;j++)for(let i=-4;i<=4;i++){
            const k=4*((Math.round((cz-750)*20)+j)*width+Math.round(cx*20)+i);
            red=Math.max(red,first[k]-first[k+1]);
          }
        }
        return red;
      }
      if(check==='lanes'){
        const reference=await read(3);
        let error=0,n=0;
        for(let x=25;x<475;x++){
          const edge=158+x*.018;
          for(let y=Math.ceil(edge+2);y<edge+11;y++){
            const i=(y*width+x)*4+1;
            error+=Math.abs(first[i]-reference[i]);n++;
          }
        }
        return error/n;
      }
      if(check==='square'){
        const center=4*(width*(height>>1)+(width>>1));
        let maximum=0;
        for(let y=0;y<height;y+=17)for(let x=0;x<width;x+=17){
          const pixel=4*(y*width+x);
          for(let c=0;c<3;c++)maximum=Math.max(maximum,Math.abs(first[pixel+c]-first[center+c]));
        }
        return maximum;
      }
      const at=(width*500+940)*4;
      return Array.from(first.slice(at,at+3));
    },{pose,check});
  };
  const canopy=await measure(-5,5,{eye:[-179,62.146,321],at:[-225,17.146,275],fov:55,width:500,height:360},'canopy');
  const laneError=await measure(5,25,{eye:[275.5,8.412,1275.5],at:[291.5,7.712,1275.5],fov:65,width:500,height:300},'lanes');
  const ortho=(x,y,z)=>({eye:[x,y+145,z],at:[x,y,z],up:[0,0,-1],span:50,width:1000,height:1000});
  const walkEdge=await measure(-4,22,ortho(-175,21.99,1125),'walkEdge');
  const pavementBands=await measure(1,28,{"name":"eye-N","eye":[60.16,16.413139501571656,1435.69],"at":[60.16,15.923139501571656,1421.69],"fov":55,"width":500,"height":300},'pavementBands');
  const reflection=await measure(-3,15,{"eye":[-119.31,24.153156586170198,770.84],"at":[-133.31,23.6631565861702,770.84],"fov":55,"width":500,"height":300},'reflection');
  const oblique=await measure(5,25,{eye:[321,54.812101,1321],at:[275,9.812101,1275],fov:55,width:500,height:360},'oblique');
  const lotTone=await measure(-3,9,{...ortho(-125,16,475),layer:'ground'},'lotTone');
  const square=await measure(-11,8,{...ortho(-525,13.819,425),eye:[-525,160,425],at:[-525,300,425],layer:'ground'},'square');
  const waterSeams=await measure(0,-8,ortho(25,6.71,-375),'waterSeams');
  const water=await measure(0,-8,ortho(25,6.71,-375),'water');
  const glass=await measure(9,-1,ortho(475,12.065,-25),'glass');
  const jointRed=await measure(0,15,ortho(25,20.378,775),'walk');
  const roof=await measure(2,-6,{eye:[171,59.087,-229],at:[125,14.087,-275],fov:55,width:500,height:360},'roof');
  const aggregate=await measure(0,18,{eye:[20.16,18.8165,925.69],at:[20.16,18.3265,911.69],fov:55,width:500,height:300},'aggregate');
  const bank=await measure(12,-5,{"eye":[620.16,9.127812617778787,-224.31],"at":[620.16,8.637812617778787,-238.31],"fov":55,"width":500,"height":300},'bank');
  const jointBands=await measure(-1,16,ortho(-25,20.168666823387145,825),'jointBands');
  console.log({pavementBands,walkEdge,reflection,waterSeams,oblique,lotTone,canopy,laneError,square,water,glass,jointRed,roof,aggregate,bank,jointBands});
  assert.ok(pavementBands<1,'The level asphalt remains free of horizontal ambient occlusion bands');
  assert.ok(walkEdge<.3,'The boulevard walk follows the straight surveyed edge within 30 cm');
  assert.ok(reflection>22,'The terrace glazing reflects the light sky and darker campus at the same pane');
  assert.ok(waterSeams<4,'Adjacent cells of the Thames bed share continuous surface colour');
  assert.ok(oblique.count>15000 && oblique.error<7.7,'Purple track lanes resolve continuously in the stadium oblique');
  assert.ok(lotTone[0]>135 && lotTone[0]-lotTone[2]>7,'The surveyed parking slab has the warmer, pale concrete finish');
  assert.ok(Math.abs(jointBands)<2,'Narrow sidewalk joints do not spread into grey bands across the slab');
  assert.equal(bank,0,'Thames bank is closed across the campus boundary');
  assert.ok(roof<.55,'Unobstructed garage deck receives direct sunlight across its interior');
  assert.ok(aggregate<.05 && aggregate>.003,'Near-field asphalt has fine aggregate without square tonal steps');
  assert.ok(canopy.shadow>1800 && canopy.unstable===0,'Alpha-cut crowns cast stable shadows');
  assert.ok(laneError<14,'Subpixel track stripes agree with a 3x supersampled reference');
  assert.equal(square,0,'The orthographic background is uniform across the capture target');
  assert.ok(water[1]>water[2]+5 && water[0]>water[2],'Overhead creek water is olive');
  assert.ok(glass>500,'Glazing attenuates sunlight between the mullions');
  assert.ok(jointRed<7,'Concrete joints retain a neutral colour as the coverage is filtered');
  assert.deepEqual(errors,[]);
}finally{await browser?.close();server.kill();}
