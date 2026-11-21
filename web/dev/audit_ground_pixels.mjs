import assert from 'node:assert/strict';
import {campusFootprint} from '../campus-clip.js';
import {readFile} from 'node:fs/promises';

function imageSize(encoded){
  const bytes=Buffer.from(encoded,'base64');
  switch(bytes.toString('ascii',12,16)){
    case 'VP8X':return [1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3)];
    case 'VP8 ':return [bytes.readUInt16LE(26)&16383,bytes.readUInt16LE(28)&16383];
    case 'VP8L':{
      const size=bytes.readUInt32LE(21);
      return [1+(size&16383),1+((size>>>14)&16383)];
    }
    default:throw new Error('Unrecognized aerial tile format.');
  }
}

export async function auditGroundPixels(page){
  const aerial=JSON.parse(await readFile(new URL('../surface-tiles.json',import.meta.url)));
  const region=JSON.parse(await readFile(new URL('../campus-region.json',import.meta.url)));
  const boundary=JSON.parse(await readFile(new URL('../campus-boundary.json',import.meta.url)));
  const site=campusFootprint(boundary);
  const tiles=Object.entries(aerial.tiles).map(([name,image])=>{
    const [width,height]=imageSize(image);
    const [i,j]=name.split(',').map(Number);
    return {name,width,height,left:region.xs[i],right:region.xs[Math.min(i+24,region.xs.length-1)],top:region.zs[j],bottom:region.zs[Math.min(j+24,region.zs.length-1)]};
  }).filter(t=>site.intersects(t.left,t.top,t.right,t.bottom));
  const report=await page.evaluate(({tiles,polygons})=>{
    const {THREE,scene,renderer}=window.campusMetrics.inspectScene();
    const region=scene.getObjectByName('Western campus region');
    const mask=new THREE.Scene();
    const material=new THREE.ShaderMaterial({
      vertexShader:'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:'void main(){gl_FragColor=vec4(.25,0.,0.,1.);}',
      transparent:true,blending:THREE.AdditiveBlending,depthTest:false,depthWrite:false
    });
    const names=new Set();
    for(const part of region.children.filter(part=>part.name.startsWith('Terrain '))){
      const mesh=new THREE.Mesh(part.geometry,material);
      mask.add(mesh);
      names.add(part.name.slice(8));
    }
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,1,600);
    camera.up.set(0,0,-1);
    const target=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,stencilBuffer:false});
    const clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha(),previous=renderer.getRenderTarget();
    const issues=[];
    let scanned=0,overlap=0,uncovered=0;
    renderer.setClearColor(0,0);
    try{
      for(const tile of tiles){
        if(!names.has(tile.name)) throw Error('Missing rendered ground tile '+tile.name);
        const x=(tile.left+tile.right)*.5,z=(tile.top+tile.bottom)*.5;
        camera.position.set(x,300,z);
        camera.lookAt(x,0,z);
        camera.left=tile.left-x;camera.right=tile.right-x;
        camera.bottom=z-tile.bottom;camera.top=z-tile.top;
        camera.updateProjectionMatrix();
        target.setSize(tile.width,tile.height);
        renderer.setRenderTarget(target);
        renderer.render(mask,camera);
        const bytes=new Uint8Array(tile.width*tile.height*4);
        renderer.readRenderTargetPixels(target,0,0,tile.width,tile.height,bytes);
        for(let row=0;row<tile.height;row++){
          const wz=tile.bottom-(row+.5)*(tile.bottom-tile.top)/tile.height;
          for(const rings of polygons){
            const hits=[];
            for(const ring of rings) for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
              if((ring[j+1]>wz)!==(ring[i+1]>wz)) hits.push(ring[j]+(wz-ring[j+1])*(ring[i]-ring[j])/(ring[i+1]-ring[j+1]));
            }
            hits.sort((a,b)=>a-b);
            for(let n=0;n<hits.length;n+=2){
              const start=Math.max(0,Math.ceil((hits[n]-tile.left)*tile.width/(tile.right-tile.left)-.5));
              const end=Math.min(tile.width,Math.ceil((hits[n+1]-tile.left)*tile.width/(tile.right-tile.left)-.5));
              for(let col=start;col<end;col++){
                scanned++;
                const value=bytes[(row*tile.width+col)*4];
                if(value===64) continue;
                if(value===0) uncovered++; else overlap++;
                if(issues.length<12) issues.push([tile.name,col,row,value]);
              }
            }
          }
        }
      }
    }finally{
      renderer.setRenderTarget(previous);
      renderer.setClearColor(clear,alpha);
      target.dispose();material.dispose();
    }
    return {tiles:tiles.length,scanned,overlap,uncovered,issues};
  },{tiles,polygons:boundary.polygons});
  assert.equal(report.tiles,tiles.length);
  assert.ok(report.scanned>8000000);
  assert.equal(report.overlap+report.uncovered,0,JSON.stringify(report));
  console.log('Ground raster '+JSON.stringify(report));
}
