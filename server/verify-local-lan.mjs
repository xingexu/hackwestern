import {once} from 'node:events'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'

const listener=createServer().listen(0,'0.0.0.0')
await once(listener,'listening')
const {port}=listener.address()
await new Promise(resolve=>listener.close(resolve))
const storage=await mkdtemp(join(tmpdir(),'western-lan-'))
const worker=spawn(process.execPath,['server/lan.mjs','--port',String(port),'--persist-to',storage],{stdio:['ignore','pipe','pipe'],detached:true})
let log=''
for(const stream of [worker.stdout,worker.stderr])stream.on('data',data=>{log=(log+data).slice(-8192)})
try{
  let origin
  for(let retry=0;retry<150;retry++){
    origin=log.match(/Desktop: (\S+)/)?.[1]
    if(origin){
      try{if((await fetch(origin+'/api/health')).ok)break}catch{}
    }
    if(worker.exitCode!==null || retry===149)throw Error(log || 'LAN Worker failed to advertise an origin')
    await delay(100)
  }
  const check=spawn(process.execPath,['server/verify-lan.mjs','http://127.0.0.1:'+port,origin],{stdio:'inherit'})
  const [code]=await once(check,'exit')
  if(code!==0)throw Error('LAN pairing failed')
}finally{
  try{process.kill(-worker.pid,'SIGTERM')}catch{}
  await rm(storage,{recursive:true,force:true,maxRetries:3})
}
