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
      if(check.swatches){
        function green(cx,cy){
          let sum=0;
          for(let y=cy-8;y<cy+8;y++)for(let x=cx-8;x<cx+8;x++)sum+=first[4*(y*width+x)+1];
          return sum/256;
        }
        const [a,b]=check.swatches;
        return Math.abs(green(...a)-green(...b));
      }
      if(check==='woodlandClearing'){
        let greenCast=0;
        for(let y=32;y<48;y++)for(let x=512;x<528;x++){
          const i=4*(y*width+x);
          greenCast+=first[i+1]-first[i];
        }
        return greenCast/256;
      }
      if(check==='shadedSlope'){
        const values=[];
        for(let y=180;y<260;y+=2)for(let x=125;x<375;x+=2)values.push(first[4*(y*width+x)+1]);
        values.sort((a,b)=>a-b);
        return values[Math.floor(values.length*.5)];
      }
      if(check==='mound'){
        let jumps=0;
        for(let y=152;y<188;y++)for(let x=242;x<322;x++){
          const i=4*(y*width+x)+1;
          if(Math.abs(first[i+4]-first[i])>3)jumps++;
        }
        return jumps/(36*80);
      }
      if(check==='hatchedApron'){
        const amber=(x,y)=>{
          const i=4*(Math.floor(y)*width+Math.floor(x));
          return first[i]-first[i+2];
        };
        return [[849,434,899,367],[718,731,765,708],[725,780,781,757]].map(([ax,ay,bx,by])=>{
          const dx=bx-ax,dy=by-ay,n=6/Math.hypot(dx,dy),samples=[];
          for(let t=.12;t<.89;t+=.04){
            const x=ax+t*dx,y=ay+t*dy;
            samples.push(amber(x,y)-.5*(amber(x-dy*n,y+dx*n)+amber(x+dy*n,y-dx*n)));
          }
          return samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)];
        });
      }
      if(check==='reflectedDetail'){
        let edges=0,total=0;
        for(let y=height/4;y<3*height/4;y++)for(let x=width/4;x<3*width/4-1;x++){
          const i=4*(y*width+x)+1;
          if(Math.abs(first[i]-first[i+4])>4)edges++;
          total++;
        }
        return edges/total;
      }
      if(check==='stoneWidths'){
        const spreads=[];
        for(let y=25;y<560;y+=36){
          const joints=[];
          let sum=0,count=0,previous=-10;
          for(let x=0;x<width-3;x++){
            let contrast=0;
            for(let dy=-4;dy<=4;dy++){
              const i=4*((y+dy)*width+x)+1;
              contrast+=first[i+12]-first[i];
            }
            if(Math.abs(contrast)<18*9)continue;
            if(x-previous>7 && count){joints.push(sum/count);sum=0;count=0;}
            sum+=x;count++;previous=x;
          }
          if(count)joints.push(sum/count);
          const widths=joints.slice(1).map((v,i)=>v-joints[i]).filter(w=>w>26 && w<114).sort((a,b)=>a-b);
          if(widths.length<5)continue;
          const at=f=>widths[Math.floor((widths.length-1)*f)];
          spreads.push((at(.85)-at(.15))/at(.5));
        }
        spreads.sort((a,b)=>a-b);
        return spreads[Math.floor(spreads.length/2)]??0;
      }
      if(check==='roofCellEdges'){
        const contrasts=[];
        const green=(x,y)=>first[4*(y*width+x)+1];
        for(let x=40;x<202;x+=20)for(let y=520;y<660;y++){
          const above=green(x,y)+green(x+1,y)+green(x+2,y);
          const below=green(x-1,y)+green(x-2,y)+green(x-3,y);
          contrasts.push(Math.abs(above-below)/3);
        }
        for(let y=540;y<650;y+=20)for(let x=32;x<214;x++){
          const above=green(x,y)+green(x,y+1)+green(x,y+2);
          const below=green(x,y-1)+green(x,y-2)+green(x,y-3);
          contrasts.push(Math.abs(above-below)/3);
        }
        return contrasts.sort((a,b)=>a-b)[Math.floor(contrasts.length*.75)];
      }
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
      if(check==='cycleway'){
        const color=(x,y)=>first.subarray(4*(y*width+x),4*(y*width+x)+3);
        const grass=([r,g,b])=>g>b+20 && g>r+3;
        const asphalt=([r,g,b])=>g<130 && b>=g-6 && r<=g+4;
        const sections=[[62,437],[100,429],[126,424],[148,420],[180,414],[250,429]];
        return Math.max(...sections.map(([row,edge])=>{
          const exterior=color(edge+11,row);
          if(row===250 ? exterior[0]<145 || grass(exterior) : !grass(exterior))throw Error('Wrong cycleway shoulder at row '+row);
          for(let x=edge+10;x>=edge-20;x--)if(asphalt(color(x,row)))return Math.abs(x-edge)/20;
          throw Error('Missing asphalt cycleway at sample row '+row);
        }));
      }
      if(check==='walkEdge'){
        const grass=(x,y)=>{
          const i=4*(y*width+x);
          return first[i+1]-first[i]>6 && first[i+1]-first[i+2]>22;
        };
        const crossings=[[626,178],[706,146],[786,115]].map(([x,expected])=>{
          for(let y=expected-19;y<expected+20;y++){
            if(!grass(x,y) && grass(x,y+1))return {y,expected};
          }
          throw Error('Missing boulevard sidewalk at '+x);
        });
        if(grass(706,96))throw Error('Missing paved boarding area at the shelter');
        const [west,middle,east]=crossings.map(point=>point.y);
        const deviations=crossings.map(point=>Math.abs(point.y-point.expected));
        return Math.max(Math.abs(middle-(west+east)*.5),...deviations)/20;
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
      if(check==='membrane'){
        const blocks=[];
        for(let y=380;y<488;y+=12){
          const row=[];
          for(let x=40;x<148;x+=12){
            let sum=0;
            for(let v=y;v<y+12;v++)for(let u=x;u<x+12;u++)sum+=first[(v*width+u)*4+1];
            row.push(sum/144);
          }
          blocks.push(...row.slice(1).map((value,i)=>Math.abs(value-row[i])));
        }
        return blocks.sort((a,b)=>a-b)[Math.floor(blocks.length*.85)];
      }
      if(check==='bank' || check==='estate'){
        const sky=scene.background;
        scene.background=new THREE.Color(0xff00ff);
        const magenta=await read();
        scene.background=new THREE.Color(0x0000ff);
        const blue=await read();
        scene.background=sky;
        let leaks=0;
        const [left,top,right,bottom]=check==='bank'?[320,220,480,294]:[325,181,499,221];
        for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
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
  const slope=await measure(-3,-7,{eye:[-124.69,19.42009,-314.84],at:[-110.69,18.93009,-314.84],fov:55,width:500,height:300},'shadedSlope');
  const reflectedDetail=await measure(1,32,{eye:[55.16,17.07273,1620.69],at:[55.16,16.58273,1606.69],fov:55,width:500,height:300},'reflectedDetail');
  const roofContrast=await measure(-4,-1,ortho(-175,15.3333,-25),{swatches:[[320,780],[368,780]]});
  const dampContrast=await measure(5,5,ortho(275,25,275),{swatches:[[290,520],[360,520]]});
  const apronContrast=await measure(4,19,ortho(225,8.2466,975),{swatches:[[710,480],[758,480]]});
  const mound=await measure(2,6,{eye:[119.05,26.86784,325.5],at:[133.05,25.03384,325.5],fov:55,width:500,height:300},'mound');
  const hatch=await measure(0,34,{...ortho(25,14,1725),layer:'ground'},'hatchedApron');
  console.log({slope,reflectedDetail,roofContrast,dampContrast,apronContrast,mound,hatch});
  assert.ok(mound<.035,'The sloped plaza receives continuous contact shading');
  assert.ok(hatch.every(contrast=>contrast>16),'Photographed hatch and stall lines remain visible on the south parking apron');
  const northwest=await page.evaluate(()=>{
    const cell={id:'x0z34',x:0,z:1700};
    const inspect=(x,z)=>campusAudit.inspect(cell,x,14.7,z);
    const dividers=[[[17.2,1719.45],[18.3,1722.15]],[[20.05,1718.8],[20.95,1721.2]]].map(([a,b])=>{
      let ink=0,road=0;
      for(let i=0;i<12;i++){
        const t=(i+.5)/12,probe=inspect(a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1]));
        if(probe.hits.some(hit=>hit.kind==='paint'))ink++;
        if(probe.physics.surface==='road')road++;
      }
      return {ink,road};
    });
    const kerb=[.2,.5,.8].map(t=>{
      let rise=0,error=0,ink=0,samples=0;
      for(let i=-16;i<=16;i++){
        const offset=i*.025,probe=inspect(2.65+.7*t+.944*offset,1726.6+2*t-.330*offset);
        if(probe.hits.some(hit=>hit.kind==='paint'))ink++;
        for(const hit of probe.hits.filter(hit=>hit.kind==='kerb'||hit.kind==='gutter')){
          rise=Math.max(rise,probe.physics.curb);
          error=Math.max(error,Math.abs(hit.y-probe.physics.y));
          samples++;
        }
      }
      return {rise,error,ink,samples};
    });
    return {dividers,kerb};
  });
  assert.ok(northwest.dividers.every(line=>line.ink>=8 && line.road===12),'Both northwest stall dividers are painted on drivable pavement');
  assert.ok(northwest.kerb.every(section=>section.samples>=12 && section.ink===0 && section.rise>.095 && section.rise<.125 && section.error<.006),'The surveyed concrete kerb supports the vehicle at its rendered height');
  assert.ok(slope>39 && slope<80,'Shaded Medway slope stays visible at eye level');
  assert.ok(reflectedDetail>.029,'The stadium-side window resolves the campus skyline inside the glass');
  assert.ok(roofContrast<7,'Roof weathering preserves the local membrane tone');
  assert.ok(dampContrast>5 && dampContrast<45,'Localized roof moisture remains visible without darkening the whole repair footprint');
  assert.ok(apronContrast<8,'Huron Flats pavement retains its aggregate finish through the lot shoulder');
  const roadSections=await measure(-3,8,ortho(-125,20,425),{swatches:[[500,792],[500,918]]});
  const pathMineral=await measure(-3,8,ortho(-125,20,425),{swatches:[[140,460],[195,460]]});
  const clearing=await measure(6,32,ortho(325,15,1625),'woodlandClearing');
  console.log({roadSections,pathMineral,clearing});
  assert.ok(roadSections<39,'A parking shoulder cannot bleach the adjoining through-road');
  assert.ok(pathMineral<8,'The path by the planting strip has a continuous mineral finish');
  assert.ok(clearing<7,'The small forest clearing retains the photographed leaf-litter tone');
  const stoneWidths=await measure(-8,17,{eye:[-374.02,39.4,876.8],at:[-374.84,39.4,874.69],up:[0,1,0],span:3,width:600,height:600},'stoneWidths');
  assert.ok(stoneWidths>.17,'The Beryl Ivey Library rubble courses have varying widths between mortar joints');
  const roofCellEdges=await measure(10,8,ortho(525,12,425),'roofCellEdges');
  assert.ok(roofCellEdges<3,'Talbot membrane must remain continuous across metre boundaries');
  const cycleway=await measure(3,7,{...ortho(175,22,375),layer:'ground'},'cycleway');
  const walkEdge=await measure(-4,22,{...ortho(-175,21.99,1125),layer:'ground'},'walkEdge');
  const pavementBands=await measure(1,28,{"name":"eye-N","eye":[60.16,16.413139501571656,1435.69],"at":[60.16,15.923139501571656,1421.69],"fov":55,"width":500,"height":300},'pavementBands');
  const reflection=await measure(-3,15,{"eye":[-119.31,24.153156586170198,770.84],"at":[-133.31,23.6631565861702,770.84],"fov":55,"width":500,"height":300},'reflection');
  const oblique=await measure(5,25,{eye:[321,54.812101,1321],at:[275,9.812101,1275],fov:55,width:500,height:360},'oblique');
  const lotTone=await measure(-3,9,{...ortho(-125,16,475),layer:'ground'},'lotTone');
  const huronFlats=await measure(4,20,{...ortho(225,8,1025),layer:'ground'},'lotTone');
  const square=await measure(-11,8,{...ortho(-525,13.819,425),eye:[-525,160,425],at:[-525,300,425],layer:'ground'},'square');
  const membrane=await measure(2,12,ortho(125,20.954,625),'membrane');
  const estate=await measure(-3,37,{eye:[-98.05,17.1633,1855.3453],at:[-112.05,15.3293,1855.3453],fov:55,width:500,height:300},'estate');
  const waterSeams=await measure(0,-8,ortho(25,6.71,-375),'waterSeams');
  const water=await measure(0,-8,ortho(25,6.71,-375),'water');
  const glass=await measure(9,-1,ortho(475,12.065,-25),'glass');
  const jointRed=await measure(0,15,ortho(25,20.378,775),'walk');
  const roof=await measure(2,-6,{eye:[171,59.087,-229],at:[125,14.087,-275],fov:55,width:500,height:360},'roof');
  const aggregate=await measure(0,18,{eye:[20.16,18.8165,925.69],at:[20.16,18.3265,911.69],fov:55,width:500,height:300},'aggregate');
  const bank=await measure(12,-5,{"eye":[620.16,9.127812617778787,-224.31],"at":[620.16,8.637812617778787,-238.31],"fov":55,"width":500,"height":300},'bank');
  const jointBands=await measure(-1,16,ortho(-25,20.168666823387145,825),'jointBands');
  console.log({stoneWidths,roofCellEdges,cycleway,huronFlats,estate,membrane,pavementBands,walkEdge,reflection,waterSeams,oblique,lotTone,canopy,laneError,square,water,glass,jointRed,roof,aggregate,bank,jointBands});
  assert.ok(cycleway<.25,'The paved cycleway boundary stays within 25 cm of its registered cross sections');
  assert.ok(huronFlats[0]>142 && huronFlats[0]-huronFlats[2]>7,'Huron Flats parking uses the pale finish seen in the 2025 aerial');
  assert.equal(estate,0,'Sky is occluded along the southern edge of the Platt’s Lane lawn');
  assert.ok(membrane<1.5,'The flat membrane on the Spencer Engineering Building has continuous shading between sheets');
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
