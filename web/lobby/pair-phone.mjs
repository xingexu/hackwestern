import {changedInput} from '../race/input.mjs'
import qr from 'qrcode-generator'
import {reserve,Session} from '../net/session.mjs'

export function pairPhone(onAction) {
  const dialog=document.createElement('dialog')
  dialog.id='phone-pair'
  dialog.setAttribute('aria-labelledby','pad-title')
  dialog.innerHTML=`<form method="dialog"><h2 id="pad-title">Phone controller</h2><button aria-label="Close" autofocus>×</button></form>
    <div id="pad-info" hidden><img id="pad-qr" alt="Scan to pair your phone"><div><label for="pad-code">Join code</label><output id="pad-code"></output><p>Scan the QR code or open <a id="pad-url"></a> on your phone and enter the code.</p></div></div>
    <p id="pad-state" role="status"></p><button id="end-pad" hidden>End pairing</button>`
  document.body.append(dialog)
  const field=id=>dialog.querySelector('#'+id)
  const button=document.createElement('button')
  button.textContent='Phone controller'
  document.querySelector('.course-card nav').append(button)
  let session,pending=false,connected=false,input,lastInput=0,activity=-1,previous=null
  function status(message){field('pad-state').textContent=message}
  function release(){input=previous=null;connected=false;activity=-1}
  function end(){
    release()
    session?.close()
    session=null
    sessionStorage.removeItem('western-pad-host')
    field('pad-info').hidden=field('end-pad').hidden=true
    dialog.close()
  }
  function connect(ticket){
    const url=new URL('/pad',ticket.padOrigin || location.origin)
    const link=field('pad-url')
    link.href=url.href
    link.textContent=url.host+url.pathname
    url.searchParams.set('code',ticket.code)
    const image=qr(0,'M')
    image.addData(url.href)
    image.make()
    field('pad-qr').src=image.createDataURL(6)
    field('pad-code').textContent=ticket.code
    field('pad-info').hidden=field('end-pad').hidden=false
    session=new Session(ticket,m=>{
      if(m.type==='pad' && connected){
        input=m.input;lastInput=performance.now()
        if(changedInput(previous,input) || (previous && input.profile!==previous.profile)){
          activity=lastInput;previous=input
        }
      }
      if(m.type==='pad-action' && connected)onAction(m.action)
      if(m.type==='room'){
        const phone=m.players.some(p=>p.id!==ticket.id && p.connected)
        if(!phone) release()
        if(phone && !connected) dialog.close()
        connected=phone
        status(phone?'Phone connected':'Waiting for phone')
      }
    },s=>{
      if(s==='Session ended')end()
      if(s==='Reconnecting…'){release();status(s)}
    })
  }
  async function open(){
    if(!dialog.open)dialog.showModal()
    if(session || pending)return
    pending=true
    status('Getting a join code…')
    try{
      const ticket=await reserve('pads',null,{})
      sessionStorage.setItem('western-pad-host',JSON.stringify(ticket))
      connect(ticket)
    }catch(e){status(e.message)}
    finally{pending=false}
  }
  const saved=sessionStorage.getItem('western-pad-host')
  if(saved)connect(JSON.parse(saved))
  button.onclick=open
  field('end-pad').onclick=end
  let nextFeedback=0
  return {open,get connected(){return connected},controls(local,car){
    if(!connected || !input || performance.now()-lastInput>230)return local
    if(car && input.profile==='wheel' && performance.now()>=nextFeedback){
      const straight=Math.abs(car.yawRate)<.06 && Math.abs(car.steer)<.035 && Math.abs(car.lateralSpeed)<.4
      session.send({type:'pad-straight',straight})
      nextFeedback=performance.now()+200
    }
    const profile=activity>local.activity?input.profile:local.profile
    return {...local,profile,digitalSteer:profile==='buttons' || profile==='keyboard',steer:Math.max(-1,Math.min(1,local.steer+input.steer)),brake:Math.max(local.brake,input.brake),throttle:Math.max(local.throttle,input.throttle),handbrake:Math.max(local.handbrake??0,input.handbrake??0)}
  }}
}
