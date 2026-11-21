import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
const page=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const imports=JSON.parse(page.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
registerHooks({resolve(spec,context,next){
  if(spec!=='three' && Object.hasOwn(imports,spec))return {url:new URL('../'+imports[spec],import.meta.url).href,shortCircuit:true};
  return next(spec,context);
}});
