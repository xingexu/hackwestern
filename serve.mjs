import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{root:{type:'string'},port:{type:'string',default:process.env.PORT??'4173'},host:{type:'string',default:'127.0.0.1'}}});
const root=values.root?resolve(values.root):fileURLToPath(new URL('./web/dist/app',import.meta.url));
const types={'.webmanifest':'application/manifest+json','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.bin':'application/octet-stream'};
await stat(resolve(root,'index.html')).catch(()=>{throw new Error('Build the campus application first with npm run build.');});

const server=createServer(async(req,res)=>{
  if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+sep)||file.endsWith('.br')){res.writeHead(404).end();return;}
    const info=await stat(file);
    if(!info.isFile()){res.writeHead(404).end();return;}
    const acceptsBrotli=(req.headers['accept-encoding']??'').split(',').some(value=>/^\s*br\s*(?:;\s*q=(?!0(?:\.0*)?\s*$)[\d.]+)?\s*$/i.test(value));
    const compressed=acceptsBrotli && await stat(file+'.br').catch(()=>null);
    const tag='"'+info.size.toString(16)+'-'+Math.floor(info.mtimeMs).toString(16)+(compressed?'-br':'')+'"';
    res.setHeader('Cache-Control',pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache');
    res.setHeader('ETag',tag);
    res.setHeader('Vary','Accept-Encoding');
    if(req.headers['if-none-match']===tag){res.writeHead(304).end();return;}
    res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');
    res.setHeader('Content-Length',compressed?compressed.size:info.size);
    if(compressed) res.setHeader('Content-Encoding','br');
    if(req.method==='HEAD'){res.end();return;}
    const stream=createReadStream(file+(compressed?'.br':''));
    res.on('close',()=>stream.destroy());
    stream.on('error',()=>res.destroy());
    stream.pipe(res);
  }catch(err){res.writeHead(err.code==='ENOENT'?404:400).end();}
});
server.listen(Number(values.port),values.host,()=>console.log('Western campus running on http://'+values.host+':'+server.address().port));
