import {campusAssets} from '../build/campus_assets.mjs';
import {assetTypes} from '../build/asset_types.mjs';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('./', import.meta.url));
const { values } = parseArgs({
  options: { 'world-dir': { type: 'string' }, output: { type: 'string' }, drive: { type: 'boolean', default: false } }
});
const worldDir = values['world-dir'] ? resolve(values['world-dir']) : root;
const output = values.output ? resolve(values.output) : resolve(root, values.drive ? 'dist/uc-hill-sprint.html' : 'dist/campus.html');
const [page, main, worker, world, compressed] = await Promise.all([
  readFile(resolve(root, 'index.html'), 'utf8'),
  readFile(resolve(root, 'main.js'), 'utf8'),
  readFile(resolve(root, 'mesh-worker.js')),
  readFile(resolve(worldDir, 'world.json'), 'utf8'),
  readFile(resolve(worldDir, 'world.bin'))
]);
const moduleTag = '<script type="module" src="./main.js"></script>';
if (!page.includes('./three.module.js') || !page.includes(moduleTag)) throw new Error('The page is missing its Three.js import or main module.');
const metadata = world.replaceAll('<', '\\u003c');
const inlineMain = main.replace(/<\/script/gi, '<\\/script');
const inline = [
  `<script id="embedded-world" type="application/json">${metadata}</script>`,
  `<script id="embedded-voxels" type="application/octet-stream">${compressed.toString('base64')}</script>`,
  `<script id="embedded-worker" type="application/octet-stream">${worker.toString('base64')}</script>`,
  `<script type="module">\n${inlineMain}</script>`
].join('\n  ');
const importMap = JSON.parse(page.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const aliasByFile=new Map(Object.entries(importMap).map(([key,url])=>[posix.normalize(url),key]));
const gameModules = Object.values(importMap).filter(url => url.startsWith('./')).map(url => url.slice(2));
const embeddedMap={...importMap};
for(const file of gameModules){
  let source=(await readFile(resolve(root,file),'utf8')).replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,(match,start,path,end)=>{
    const target=posix.normalize(posix.join(posix.dirname(file),path));
    if(!aliasByFile.has(target)){
      aliasByFile.set(target,'embedded/'+target);
      gameModules.push(target);
    }
    return start+aliasByFile.get(target)+end;
  });
  for(const [expression,,relative] of source.matchAll(/new URL\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g)){
    const path=posix.join(posix.dirname(file),relative);
    const bytes=await readFile(resolve(root,path));
    const type=assetTypes[posix.extname(path)]??'application/octet-stream';
    source=source.replace(expression,()=>'new URL("data:'+type+';base64,'+bytes.toString('base64')+'")');
  }
  embeddedMap[aliasByFile.get(file)]='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
}
const css = await readFile(resolve(root, 'drive.css'), 'utf8');
const uiMime = { '.png': 'image/png', '.woff2': 'font/woff2' };
async function uiDataUrl(path) {
  const extension = path.slice(path.lastIndexOf('.'));
  return `data:${uiMime[extension]};base64,${(await readFile(resolve(root, 'ui', path))).toString('base64')}`;
}
async function inlineUiAssets(text, pattern, prefix) {
  for (const path of new Set([...text.matchAll(pattern)].map(match => match[1]))) text = text.replaceAll(prefix + path, await uiDataUrl(path));
  return text;
}
const uiCss = await inlineUiAssets(await readFile(resolve(root, 'ui/components.css'), 'utf8'), /url\(\.\/([\w./-]+\.woff2)\)/g, './');
const uiScript = (await readFile(resolve(root, 'ui/components.mjs'), 'utf8')).replace(/<\/script/gi, '<\\/script');
const datasets = JSON.parse(world).driveCourse ? ['drive-trees', 'drive-route', 'campus-ground', 'campus-region', 'street-detail','drive-network','region-detail','surface-tiles','canopy-survey','municipal-detail','ground-materials','driving-horizon','campus-buildings','streetview-facades','street-signs','campus-boundary'] : [];
const scope=datasets.length?campusAssets(...await Promise.all(['campus-boundary','campus-region'].map(async name=>JSON.parse(await readFile(resolve(worldDir,name+'.json')))))):null;
const inlineDatasets = await Promise.all(datasets.map(async name => {
  let content = (await readFile(resolve(worldDir, name + '.json'), 'utf8')).replaceAll('<', '\\u003c');
  if(['campus-region','surface-tiles','canopy-survey','municipal-detail','region-detail','drive-network'].includes(name)){
    content=JSON.stringify(scope(name,JSON.parse(content))).replaceAll('<','\\u003c');
  }
  if(name==='ground-materials'){
    const model=JSON.parse(content);
    delete model.frames;
    delete model.rejected;
    for(const tile of Object.values(model.tiles)){delete tile.proof;delete tile.origin;}
    content=JSON.stringify(model).replaceAll('<','\\u003c');
  }
  if(['drive-network','region-detail','surface-tiles','canopy-survey','municipal-detail','ground-materials','driving-horizon','campus-buildings','streetview-facades','street-signs','campus-boundary'].includes(name)) return `<script id="embedded-${name}" data-compression="deflate" type="application/octet-stream">${deflateSync(content).toString('base64')}</script>`;
  return `<script id="embedded-${name}" type="application/json">${content}</script>`;
}));
const template=page.replace(/<script type="importmap">[\s\S]*?<\/script>/,()=>'<script type="importmap">'+JSON.stringify({imports:embeddedMap})+'</script>')
  .replace(/  <link rel="(?:manifest|apple-touch-icon)"[^>]+>\n/g,'')
  .replace(/  <link rel="preload" href="\.\/ui\/fonts\/[^>]+>\n/g,'');
const html = (await inlineUiAssets(template, /"\.\/ui\/([\w-]+\.png)"/g, './ui/'))
  .replace('name="campus-entry" content="map"', () => `name="campus-entry" content="${values.drive ? 'drive' : 'map'}"`)
  .replace('<link rel="stylesheet" href="./drive.css">', () => `<style>${css}</style>`)
  .replace('<link rel="stylesheet" href="./ui/components.css">', () => `<style>${uiCss}</style>`)
  .replace('<script type="module" src="./ui/components.mjs"></script>', () => `<script type="module">\n${uiScript}</script>`)
  .replace(moduleTag, () => [...inlineDatasets, inline].join('\n  '));

await mkdir(dirname(output), { recursive: true });
const pending = `${output}.${process.pid}.tmp`;
await writeFile(pending, html, { flag: 'wx' });
await rename(pending, output);
console.log(`Built ${output} (${Buffer.byteLength(html).toLocaleString('en-US')} bytes)`);
