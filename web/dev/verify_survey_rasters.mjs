import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {engines,serve} from './race_browser.mjs';

const web=new URL('../',import.meta.url);
const output=new URL('dist/app/',web);
const html=await readFile(new URL('index.html',output),'utf8');
const assets=JSON.parse(html.match(/id="campus-assets">(.*?)<\/script>/)[1]);
const server=await serve(true);
const engine=process.argv[2]??'chromium';
let browser;
try{
  browser=await engines[engine].launch({args:engine==='chromium' && process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage();
  await page.route('**/raster-check',route=>route.fulfill({contentType:'text/html',body:'<base href="/dist/app/">'}));
  await page.goto(server.base+'/raster-check');
  for(const file of ['surface-tiles.json','ground-materials.json']){
    const original=JSON.parse(await readFile(new URL(file,web)));
    const compiled=JSON.parse(await readFile(new URL(assets[file],output)));
    const fields=file==='surface-tiles.json'?['relief.samples','groundCover.samples','carriageway.samples']:
      ['landcover.samples','landcover.transitions','landcover.vigor.samples','landcover.pavingTone.samples','landcover.pavingTone.aggregate',
        'landcover.pavingTone.shadedLawn','landcover.pavementDetail.samples','landcover.context.coverage'];
    for(const field of fields){
      const get=root=>field.split('.').reduce((value,key)=>value[key],root);
      const expected=createHash('sha256').update(inflateSync(Buffer.from(get(original),'base64'))).digest('hex');
      const actual=await page.evaluate(async model=>{
        const {rasterBytes,surveyTexture}=await import('/survey-raster.mjs');
        let buffer;
        if(model.tiles){
          const THREE=await import('/three.module.js');
          const {width,height,tileSize}=model;
          const texture=await surveyTexture(THREE,model,width,height,[0,0,width,height]);
          for(let y=0;y<height;y+=tileSize)for(let x=0;x<width;x+=tileSize)await texture.userData.focus(x+1,y+1);
          buffer=texture.image.data.buffer;
          texture.dispose();
        }else buffer=await rasterBytes(model);
        const digest=await crypto.subtle.digest('SHA-256',buffer);
        return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      },get(compiled));
      assert.equal(actual,expected,field);
    }
    console.log(engine,file,fields.length,'full-resolution raster digests matched');
  }
}finally{await browser?.close();server.close();}
