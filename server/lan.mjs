import {networkInterfaces} from 'node:os'
import {spawn} from 'node:child_process'
import {parseArgs} from 'node:util'

const {values}=parseArgs({options:{port:{type:'string',default:process.env.PORT || '4173'},host:{type:'string',default:'0.0.0.0'},root:{type:'string'},'persist-to':{type:'string'}}})
const addresses=Object.entries(networkInterfaces()).flatMap(([name,addresses])=>
  addresses.filter(a=>a.family==='IPv4' && !a.internal && !a.address.startsWith('169.254.')).map(a=>({name,ip:a.address})))
const wifi=addresses.find(a=>/^(en0|wl.*|wi-fi)$/i.test(a.name)) ?? addresses[0]
const address=values.host==='0.0.0.0'?wifi?.ip:values.host
const origin=address?'http://'+address+':'+values.port:''
const args=values.root?['serve.mjs','--root',values.root,'--host',values.host,'--port',values.port]:
  ['node_modules/wrangler/bin/wrangler.js','dev','--local','--config','server/wrangler.jsonc','--ip',values.host,'--port',values.port,'--inspector-port','0','--var','MULTIPLAYER:1',...(origin?['--var','PAD_LAN_ORIGIN:'+origin]:[])]
if(origin && !values.root)console.log('Desktop: '+origin+'   Phone: '+origin+'/pad')
if(values['persist-to'] && !values.root)args.push('--persist-to',values['persist-to'])
const child=spawn(process.execPath,args,{stdio:'inherit'})
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal))
child.once('exit',(code,signal)=>{process.exitCode=code ?? (signal==='SIGINT'?0:1)})
