export async function iceServers(env,account,now){
  const servers=[{urls:'stun:stun.cloudflare.com:3478'}]
  if(!env.TURN_URL)return servers
  const urls=env.TURN_URL.split(',').map(s=>s.trim()).filter(s=>/^turns?:[^\s/?#]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/i.test(s))
  if(!urls.length)return servers
  if(env.TURN_SECRET){
    const username=Math.floor(now/1000+86400)+':'+account
    const bytes=new TextEncoder()
    const key=await crypto.subtle.importKey('raw',bytes.encode(env.TURN_SECRET),{name:'HMAC',hash:'SHA-1'},false,['sign'])
    const signature=await crypto.subtle.sign('HMAC',key,bytes.encode(username))
    servers.push({urls,username,credential:btoa(String.fromCharCode(...new Uint8Array(signature)))})
  }else if(env.TURN_USER && env.TURN_PASSWORD)servers.push({urls,username:env.TURN_USER,credential:env.TURN_PASSWORD})
  return servers
}
