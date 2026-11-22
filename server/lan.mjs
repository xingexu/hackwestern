import {networkInterfaces} from 'node:os'
import {spawn} from 'node:child_process'
import {parseArgs} from 'node:util'
import {existsSync} from 'node:fs'
import {lanAddresses} from './lan-address.mjs'

const {values}=parseArgs({options:{port:{type:'string',default:process.env.PORT || '4173'},host:{type:'string',default:'0.0.0.0'},root:{type:'string'},'persist-to':{type:'string'},'https-cert':{type:'string'},'https-key':{type:'string'}}})
const cert=values['https-cert'],key=values['https-key']
if((cert || key) && (!cert || !key || !existsSync(cert) || !existsSync(key) || values.root))
  throw new Error('Phone HTTPS needs both --https-cert and --https-key pointing to existing local PEM files and the Worker server.')
const protocol=cert?'https':'http'
const addresses=lanAddresses(networkInterfaces())
const address=values.host==='0.0.0.0'?addresses[0]:values.host
const origin=address?protocol+'://'+address+':'+values.port:''
const args=values.root?['serve.mjs','--root',values.root,'--host',values.host,'--port',values.port]:
  ['node_modules/wrangler/bin/wrangler.js','dev','--local','--config','server/wrangler.jsonc','--ip',values.host,'--port',values.port,'--inspector-port','0','--var','MULTIPLAYER:1',...(origin?['--var','PAD_LAN_ORIGIN:'+origin]:[])]
if(!values.root){
  if(origin)console.log('Desktop: '+origin+'   Phone: '+origin+'/pad')
  if(!address || /^(localhost|127\.)/.test(address))console.warn('Loopback is for this computer only. To pair a physical phone, restart with --host <computer-Wi-Fi-IPv4>.')
  else console.log('Same Wi-Fi: open the Desktop URL, select Phone controller, then scan. If the address is wrong, restart with --host <computer-Wi-Fi-IPv4>.')
  if(cert)args.push('--local-protocol','https','--https-cert-path',cert,'--https-key-path',key)
}
if(values['persist-to'] && !values.root)args.push('--persist-to',values['persist-to'])
const child=spawn(process.execPath,args,{stdio:'inherit'})
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal))
child.once('exit',(code,signal)=>{process.exitCode=code ?? (signal==='SIGINT'?0:1)})
