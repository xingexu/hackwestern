import assert from 'node:assert/strict';
import {campusFootprint} from '../campus-clip.js';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function auditStreetViews(page,out){
  const load=async name=>JSON.parse(await readFile(new URL('../'+name+'.json',import.meta.url)));
  const [region,roads,boundary]=await Promise.all([load('campus-region'),load('drive-network'),load('campus-boundary')]);
  const site=campusFootprint(boundary), stride=8;
  const cells=[];
  for(let j=0;j<region.zs.length-1;j+=stride) for(let i=0;i<region.xs.length-1;i+=stride){
    const left=region.xs[i],right=region.xs[Math.min(i+stride,region.xs.length-1)];
    const top=region.zs[j],bottom=region.zs[Math.min(j+stride,region.zs.length-1)];
    if(!site.intersects(left,top,right,bottom)) continue;
    const x=(left+right)*.5,z=(top+bottom)*.5;
    const candidates=[];
    for(const way of roads.ways){
      if(way.kind!=='road') continue;
      for(let k=1;k<way.points.length;k++){
        const [ax,ay,az]=way.points[k-1],[bx,by,bz]=way.points[k];
        const px=(ax+bx)*.5,pz=(az+bz)*.5;
        if(px<left||px>=right||pz<top||pz>=bottom||!site.contains(px,pz)) continue;
        candidates.push({x:px,y:(ay+by)*.5,z:pz,heading:Math.atan2(bx-ax,bz-az),range:Math.hypot(px-x,pz-z)});
      }
    }
    candidates.sort((a,b)=>a.range-b.range);
    cells.push({col:i/stride,row:j/stride,candidates});
  }
  const minCol=Math.min(...cells.map(c=>c.col)),minRow=Math.min(...cells.map(c=>c.row));
  for(const c of cells){c.col-=minCol;c.row-=minRow;}
  await page.locator('#restart').click();
  await page.setViewportSize({width:480,height:288});
  const result=await page.evaluate(async cells=>{
    const metrics=window.driveMetrics,network=metrics.network;
    const width=176,height=106,padding=14;
    const cols=1+Math.max(...cells.map(c=>c.col)),rows=1+Math.max(...cells.map(c=>c.row));
    const atlases=[0,1].map(()=>{
      const canvas=document.createElement('canvas');
      canvas.width=cols*width;canvas.height=rows*(height+padding);
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.fillStyle='#19272a';ctx.fillRect(0,0,canvas.width,canvas.height);
      return ctx;
    });
    const skip=[],errors=[];
    let views=0;
    async function frames(n){for(let i=0;i<n;i++) await new Promise(requestAnimationFrame);}
    for(const cell of cells){
      const point=cell.candidates.find(p=>!network.blocked(p.x,p.z,p.y,1));
      if(!point){skip.push({col:cell.col,row:cell.row,road:cell.candidates.length});continue;}
      const ground=network.sample(point.x,point.z,point.y);
      for(const [index,ctx] of atlases.entries()){
        metrics.surveyView({x:point.x,z:point.z,y:ground.y,pitch:0,heading:point.heading+index*Math.PI});
        await frames(index?3:7);
        const left=cell.col*width,top=cell.row*(height+padding);
        ctx.drawImage(metrics.renderCanvas(),left,top,width,height);
        const bytes=ctx.getImageData(left,top,width,height).data;
        const colors=new Set();
        for(let i=0;i<bytes.length;i+=4) colors.add((bytes[i]>>4)*256+(bytes[i+1]>>4)*16+(bytes[i+2]>>4));
        if(colors.size<25) errors.push([cell.col,cell.row,index,colors.size]);
        ctx.fillStyle='#e5eee6';ctx.font='10px sans-serif';
        ctx.fillText(Math.round(point.x)+', '+Math.round(point.z),left+3,top+height+11);
        views++;
      }
    }
    return {views,skip,errors,images:atlases.map(ctx=>ctx.canvas.toDataURL('image/jpeg',.90).split(',')[1])};
  },cells);
  for(const [index,encoded] of result.images.entries()) await writeFile(join(out,'survey-direction-'+index+'.jpg'),Buffer.from(encoded,'base64'));
  assert.deepEqual(result.errors,[]);
  assert.equal(result.views,(cells.length-result.skip.length)*2);
  assert.ok(result.views>=150);
  console.log('Street grid '+JSON.stringify({cells:cells.length,views:result.views,withoutOpenRoad:result.skip}));
}
