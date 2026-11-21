import {execFileSync} from 'node:child_process';
import {campusAssets} from './build/campus_assets.mjs';
import {bakeMesh} from './build/bake_mesh.mjs';
import {defineConfig} from 'vite';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,rename,rm} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {brotliCompressSync,constants} from 'node:zlib';

const web=fileURLToPath(new URL('./web/',import.meta.url));
const output=process.env.CAMPUS_RACE_PREVIEW || join(web,'dist','app');
const staging=join(web,'dist','.building-'+process.pid);
const page=await readFile(join(web,'index.html'),'utf8');
const imports=JSON.parse(page.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const aliases=Object.entries(imports).filter(([name])=>name!=='three').map(([name,location])=>({find:name,replacement:join(web,location)}));
const phoneAssets=['app.webmanifest','drive-192.png','drive-512.png','apple-touch-icon.png'];
const datasets=['campus-buildings.json','world.json','street-signs.json','campus-boundary.json','driving-horizon.json','world.bin','campus-ground.json','campus-region.json','drive-network.json','drive-route.json','drive-trees.json','street-detail.json','region-detail.json','municipal-detail.json','mesh-worker.js'];
const tileSources=['ground-materials.json','surface-tiles.json','canopy-survey.json','region-detail.json','streetview-facades.json'];

const [boundary,terrain]=await Promise.all(['campus-boundary.json','campus-region.json'].map(async file=>JSON.parse(await readFile(join(web,file)))));
const scope=campusAssets(boundary,terrain);

function mappedAssets(file,source) {
  const data=scope(file.replace('.json',''),JSON.parse(source));
  const assets=new Map();
  function unpack(payload,extension) {
    const bytes=Buffer.from(payload,'base64');
    const hash=createHash('sha256').update(bytes).digest('hex').slice(0,18);
    const name='assets/'+hash+'.'+extension;
    assets.set(name,bytes);
    return './'+name;
  }
  if(file==='ground-materials.json'){
    delete data.frames;
    delete data.rejected;
    data.landcover.transitions=unpack(data.landcover.transitions,'bin');
    if(data.landcover.pavingTone)data.landcover.pavingTone.samples=unpack(data.landcover.pavingTone.samples,'bin');
    const context=data.landcover.context;
    if(context){
      for(const key of ['vertices','indices','cover','coverage','trees'])if(context[key])context[key]=unpack(context[key],'bin');
      if(context.backdrop)for(const [key,bytes] of Object.entries(context.backdrop))context.backdrop[key]=unpack(bytes,'bin');
    }
    data.estates.coverage=unpack(data.estates.coverage,'bin');
    for(const section of [data.landcover,data.landcover.vigor,data.estates]) section.samples=unpack(section.samples,'bin');
    for(const tile of Object.values(data.tiles)){
      delete tile.proof;delete tile.origin;
      if(!Array.isArray(tile.cells) || 'image' in tile) throw new Error('Ground tiles must contain material classes');
    }
  }else if(file==='surface-tiles.json'){
    delete data.core;
    for(const tile of data.walkways) tile.samples=unpack(tile.samples,'bin');
    for(const section of [data.relief,data.groundCover,data.carriageway]) if(section) section.samples=unpack(section.samples,'bin');
    for(const key of ['preview']) if(typeof data[key]==='string') data[key]=unpack(data[key],'webp');
    for(const [key,image] of Object.entries(data.tiles)) data.tiles[key]=unpack(image,'webp');
    for(const [key,image] of Object.entries(data.finishes)) data.finishes[key]=unpack(image,'png');
  }else if(file==='streetview-facades.json'){
    if(data.tiles.some(tile=>'image' in tile)) throw new Error('Facade tiles must contain modeled features');

  }else if(file==='region-detail.json'){
    data.architecture.roof=unpack(data.architecture.roof,'webp');
    delete data.architecture.atlas.image;
  } else {
    for(const tile of Object.values(data.tiles)) tile.data=unpack(tile.data,'bin');
  }
  assets.set(file,Buffer.from(JSON.stringify(data)));
  return assets;
}

function gameContent() {
  const developmentAssets=new Map(),manifest={};
  return {
    name:'western-campus-content',
    transformIndexHtml:{order:'pre',handler(html){
      return html.replace('./phone/app.webmanifest','./app.webmanifest').replace('./phone/apple-touch-icon.png','./apple-touch-icon.png').replace('name="campus-entry" content="map"','name="campus-entry" content="drive"')
        .replace('name="campus-course" content="sprint"','name="campus-course" content="roam"')
        .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/,'');
    }},
    configureServer(server){
      server.middlewares.use(async(req,res,next)=>{
        try{
          const name=new URL(req.url,'http://localhost').pathname.slice(1);
          if(phoneAssets.includes(name)){
            res.setHeader('Content-Type',name.endsWith('.webmanifest')?'application/manifest+json':'image/png');
            res.end(await readFile(join(web,'phone',name)));
            return;
          }
          if(tileSources.includes(name)){
            const mapped=mappedAssets(name,await readFile(join(web,name)));
            for(const [key,bytes] of mapped) developmentAssets.set(key,bytes);
          }
          const bytes=developmentAssets.get(name);
          if(!bytes) return next();
          res.setHeader('Content-Type',name.endsWith('.json')?'application/json':name.endsWith('.webp')?'image/webp':name.endsWith('.png')?'image/png':'application/octet-stream');
          res.end(bytes);
        }catch(error){next(error);}
      });
    },
    async generateBundle() {
      execFileSync(join(web,'../.venv/bin/python'),[join(web,'../build/compile_buildings.py')],{stdio:'inherit'});
      const emit=(file,source)=>{
        let fileName=file;
        if(!file.startsWith('assets/')){
          const digest=createHash('sha256').update(source).digest('hex').slice(0,18);
          fileName='assets/'+file.replace('.json','-'+digest+'.json');
          manifest[file]='./'+fileName;
        }
        this.emitFile({type:'asset',fileName,source});
      };
      const [world,ground,trees,region]=await Promise.all(['world.json','campus-ground.json','drive-trees.json','campus-region.json'].map(async name=>JSON.parse(await readFile(join(web,name)))));
      const packed=await bakeMesh(web,world,ground,trees);
      const key=createHash('sha256').update(packed.source).digest('hex').slice(0,18);
      const meshName='assets/core-'+key+'.bin';
      world.coreMesh={url:'./'+meshName,chunks:packed.chunks,triangles:packed.triangles};
      this.emitFile({type:'asset',fileName:meshName,source:packed.source});
      delete ground.texture;
      delete ground.cut;
      delete trees.cells;
      delete region.ortho;
      const compiled={'campus-region.json':scope('campus-region',region),'world.json':world,'campus-ground.json':ground,'drive-trees.json':trees};
      for(const file of datasets) {
        if(file==='world.bin'||file==='mesh-worker.js'||tileSources.includes(file)) continue;
        if(['municipal-detail.json','drive-network.json'].includes(file)){
          const data=JSON.parse(await readFile(join(web,file)));
          emit(file,JSON.stringify(scope(file.replace('.json',''),data)));
          continue;
        }
        emit(file,compiled[file]?JSON.stringify(compiled[file]):await readFile(join(web,file)));
      }
      for(const file of tileSources){
        for(const [name,source] of mappedAssets(file,await readFile(join(web,file))))
          emit(name,source);
      }
    },
    async writeBundle(){
      const htmlFile=join(staging,'index.html');
      const html=await readFile(htmlFile,'utf8');
      await writeFile(htmlFile,html.replace('<head>','<head><script type="application/json" id="campus-assets">'+JSON.stringify(manifest)+'</script>'));
      const files=await readdir(join(staging,'assets'));
      await mkdir(join(output,'assets'),{recursive:true});
      async function publish(name){
        const src=join(staging,name),dest=join(output,name);
        if(/\.(js|json|css|html|bin|webmanifest)$/.test(basename(name))){
          const raw=await readFile(src);
          const br=brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:5}});
          await writeFile(src+'.br',br);
          await rename(src+'.br',dest+'.br');
        }
        await rename(src,dest);
      }
      for(const file of phoneAssets){
        await writeFile(join(staging,file),await readFile(join(web,'phone',file)));
        await publish(file);
      }
      for(const file of files) await publish('assets/'+file);
      await publish('index.html');
      await rm(staging,{recursive:true,force:true});
    }
  };
}

export default defineConfig({
  root:web,base:'./',publicDir:false,resolve:{alias:aliases},
  server:{host:'127.0.0.1'},
  build:{target:'es2022',outDir:staging,emptyOutDir:true,reportCompressedSize:false},
  plugins:[gameContent()]
});
