import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';

import {fileURLToPath} from 'node:url';
import {campusFootprint} from '../campus-clip.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const read=async name=>JSON.parse(await readFile(new URL('../'+name+'.json',import.meta.url)));
const [roads,parcel]=await Promise.all([read('drive-network'),read('campus-boundary')]);
const outline=campusFootprint(parcel),sites=[];
for(const way of roads.ways){
  if(way.kind!=='road'||way.level!==0)continue;
  for(const p of way.points)if(outline.contains(p[0],p[2]))sites.push([p[0],p[2]]);
}
if(!sites.length)throw Error('Missing survey roads');
const [left,north,right,south]=parcel.bounds,columns=6,rows=9,wide=642,high=128,buffer=new Uint8Array(wide*columns*high*rows*4);
const server=spawn(process.execPath,['serve.mjs','--port','0'],{cwd:root,stdio:['ignore','pipe','inherit']});
let browser;
try{
  const url=String((await once(server.stdout,'data'))[0]).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url+'/?audit&diagnostics&bakeReflections');
  await page.waitForFunction(()=>window.campusAudit,null,{timeout:120000});
  const cached=new Map();
  for(let j=0;j<rows;j++)for(let i=0;i<columns;i++){
    const x=left+(right-left)*i/(columns-1),z=north+(south-north)*j/(rows-1);
    let nearest,minimum=Infinity;
    for(const site of sites){
      const d=(site[0]-x)**2+(site[1]-z)**2;
      if(d<minimum){nearest=site;minimum=d;}
    }
    if(!cached.has(nearest)){
      const [x,z]=nearest,ix=Math.floor(x/50),iz=Math.floor(z/50);
      await page.evaluate(c=>campusAudit.focus(c),{id:'x'+ix+'z'+iz,x:ix*50,z:iz*50});
      await page.waitForLoadState('networkidle');
      const rgb=await page.evaluate(({x,z,wide,high})=>{
        const {renderer}=driveMetrics.inspectLook(),y=driveMetrics.network.groundAt(x,z)+3.2,side=384,fov=102;
        const context=new OffscreenCanvas(side,side).getContext('2d',{willReadFrequently:true}),faces=[];
        for(let q=0;q<4;q++){
          const a=Math.PI*q/2;
          campusAudit.render({eye:[x,y,z],at:[x+Math.sin(a)*24,y,z-Math.cos(a)*24],fov,width:side,height:side});
          context.drawImage(renderer.domElement,0,0,side,side);faces.push(context.getImageData(0,0,side,side).data);
        }
        const out=new Uint8Array(wide*high*4),tan=Math.tan(fov*Math.PI/360);
        for(let v=0;v<high;v++)for(let u=0;u<wide;u++){
          const a=(u-.5)*2*Math.PI/(wide-2),quarter=Math.round(a*2/Math.PI),local=a-quarter*Math.PI/2;
          const pitch=(-28+(v+.5)*68/high)*Math.PI/180,src=faces[(quarter+4)%4];
          const tx=side*.5*(1+Math.tan(local)/tan)-.5,ty=side*.5*(1-Math.tan(pitch)/Math.cos(local)/tan)-.5;
          const sx=Math.floor(tx),sy=Math.floor(ty),fx=tx-sx,fy=ty-sy;
          const index=4*(v*wide+u);
          for(let k=0;k<3;k++){
            let sum=0;for(let py=0;py<2;py++)for(let px=0;px<2;px++){
              const xx=Math.max(0,Math.min(side-1,sx+px)),yy=Math.max(0,Math.min(side-1,sy+py));
              sum+=src[4*(yy*side+xx)+k]*(px?fx:1-fx)*(py?fy:1-fy);
            }
            out[index+k]=Math.round(sum);
          }
          out[index+3]=255;
        }
        return Array.from(out);
      },{x,z,wide,high});
      cached.set(nearest,Uint8Array.from(rgb));
    }
    const tile=cached.get(nearest);
    for(let row=0;row<high;row++)buffer.set(tile.subarray(row*wide*4,(row+1)*wide*4),4*((j*high+row)*wide*columns+i*wide));
  }
  if(errors.length)throw Error(errors.join('\n'));
  const encoder=spawnSync(root+'.venv/bin/python',['-c',"import sys; from PIL import Image; Image.frombytes('RGBA',(int(sys.argv[1]),int(sys.argv[2])),sys.stdin.buffer.read()).convert('RGB').save(sys.argv[3],quality=80,method=6)",String(columns*wide),String(rows*high),root+'web/look/reflection-atlas.webp'],{input:buffer});
  if(encoder.status!==0)throw Error(encoder.stderr.toString());
  const data={bounds:parcel.bounds,columns,rows,wide,high};
  await writeFile(new URL('../look/reflection-survey.mjs',import.meta.url),'export default '+JSON.stringify(data)+';\n');
  console.log(cached.size+' surveyed panoramas, '+wide+' by '+high+' per probe');
}finally{await browser?.close();server.kill();}
