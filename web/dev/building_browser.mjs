import {createRequire} from 'node:module';
import {existsSync,readdirSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';

export async function openBrowser(){
  const require=createRequire(import.meta.url);
  const cache=join(process.env.npm_config_cache??join(homedir(),'.npm'),'_npx');
  const cli=process.env.PATH.split(delimiter).map(p=>join(p,'playwright')).find(existsSync);
  const packages=['playwright',...(cli?[dirname(realpathSync(cli))]:[]),...(existsSync(cache)?readdirSync(cache).map(k=>join(cache,k,'node_modules/playwright')):[])];
  for(const location of packages){
    let driver;
    try{driver=require(location);}catch{continue;}
    if(existsSync(driver.chromium.executablePath()))return driver.chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
  }
  throw new Error('Install Playwright and its Chromium browser for offline building previews.');
}
