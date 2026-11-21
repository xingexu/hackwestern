import qr from 'qrcode-generator'
import {reserve, Session} from '../net/session.mjs'
import {createFleet} from './remote.mjs'
import './lobby.css'

export function attachOnline({THREE,scene,coupe,changeCourse,reset,carState}) {
  const by = id => document.getElementById(id)
  const menu=document.createElement('dialog')
  menu.id='online-menu'
  menu.innerHTML=`<div class="heading"><h2>Race with friends</h2><button id="online-close" aria-label="Close">×</button></div>
  <div id="online-entry"><div class="profile"><label>Nickname<input id="race-name" maxlength="18" value="Driver"></label><label>Colour<input id="race-color" type="color" value="#d94a28"></label></div>
  <button id="make-room">Create race room</button><label>Room code<input id="room-code" maxlength="6" autocomplete="off"></label><button id="join-room">Join room</button></div>
  <div id="online-room" hidden><h3 id="room-label"></h3><ul id="room-roster"></ul><fieldset id="race-settings"><label>Course<select id="race-course"><option value="college">College Hill</option><option value="stadium">Stadium</option><option value="campus">Thames Bridges</option></select></label><label>Laps<input id="race-laps" type="number" min="1" max="5" value="1"></label><label><span><input id="race-contact" type="checkbox"> Car collisions</span></label></fieldset>
  <div class="actions"><button id="race-ready">Ready</button><button id="race-start">Start race</button><button id="race-again" hidden>Race again</button><button id="race-leave">Leave</button></div></div>
  <p><button id="make-pad">Pair phone controller</button></p><div id="pad-info" hidden><strong id="pad-code"></strong><img id="pad-qr" alt="Scan to pair a phone"><a id="pad-url"></a><p id="pad-state"></p><button id="end-pad">Unpair</button></div><output id="online-status" aria-live="polite"></output>`
  document.body.append(menu)
  const toggle=document.createElement('button')
  toggle.textContent='Online'
  document.querySelector('.course-card nav').append(toggle)
  toggle.onclick=()=>menu.showModal()
  by('online-close').onclick=()=>menu.close()
  const banner=document.createElement('output')
  banner.id='race-banner'
  banner.hidden=true
  by('drive-ui').append(banner)
  const fleet=createFleet(THREE,scene,coupe)
  let session,room,controller,pad,lastPad=0,lastState=0,lastFinish=0
  const status=s=>{by('online-status').value=s}
  const command=data=>session?.send(data)
  const me=()=>room?.players.find(p=>p.id===session.ticket.id)
  function clearRoom() {
    room=null
    session=null
    sessionStorage.removeItem('western-room')
    fleet.roster([],null)
    by('online-entry').hidden=false
    by('online-room').hidden=true
    by('drive-course').disabled=false
    by('trial-open').disabled=false
    banner.hidden=true
  }
  function display(m) {
    const before=room
    room=m
    const player=me()
    if(!player)return
    const host=room.host===player.id
    by('online-entry').hidden=true
    by('online-room').hidden=false
    by('room-label').textContent='Room '+session.ticket.code
    const ordered=room.players.slice().sort((a,b)=>(a.finish||Infinity)-(b.finish||Infinity))
    by('room-roster').replaceChildren(...ordered.map((p,i)=>{
      const li=document.createElement('li')
      li.textContent=(p.finish ? (i+1)+'. ' : '')+p.nickname+' · '+(!p.connected ? 'Disconnected' : p.finish ? (p.finish/1000).toFixed(2)+' s' : room.race ? 'Lap '+(p.lap+1) : p.ready ? 'Ready' : 'Waiting')
      return li
    }))
    by('race-settings').disabled=!host || !!room.race
    by('race-course').value=room.settings.course
    by('race-laps').value=room.settings.laps
    by('race-contact').checked=room.settings.collisions
    by('race-ready').textContent=player.ready?'Unready':'Ready'
    by('race-ready').hidden=!!room.race
    by('race-start').hidden=!host || !!room.race
    by('race-start').disabled=room.players.length<2 || !room.players.every(p=>p.ready && p.connected)
    by('race-again').hidden=!host || !room.race || !room.players.every(p=>p.finish)
    fleet.roster(room.players,player.id)
    by('drive-course').disabled=!!room.race
    by('trial-open').disabled=!!room.race
    if(room.race && room.race!==before?.race){
      changeCourse(room.settings.course)
      const car=carState()
      const i=room.players.findIndex(p=>p.id===player.id)
      const offset=(i%2 ? -1 : 1)*1.05
      car.x+=Math.cos(car.heading)*offset-Math.sin(car.heading)*Math.floor(i/2)*4
      car.z-=Math.sin(car.heading)*offset+Math.cos(car.heading)*Math.floor(i/2)*4
      menu.close()
    }
    if(room.race && before?.race===room.race && player.lap>(before.players.find(p=>p.id===player.id)?.lap??0) && !player.finish) reset()
    if(player.finish && !menu.open) menu.showModal()
    banner.hidden=!room.race
  }
  function connectRoom(ticket) {
    sessionStorage.setItem('western-room',JSON.stringify(ticket))
    session=new Session(ticket,m=>{
      if(m.type==='room') display(m)
      if(m.type==='state') fleet.push(m)
    },s=>{status(s);if(s==='Session ended')clearRoom()})
  }
  async function enter(create) {
    try {
      const code=by('room-code').value.trim()
      if(!create && !code)throw Error('Enter a room code')
      const nickname=by('race-name').value.trim(),color=by('race-color').value
      const ticket=await reserve('rooms',create?null:code,{nickname,color})
      localStorage.setItem('western-profile',JSON.stringify({nickname,color}))
      connectRoom(ticket)
    }catch(err){status(err.message)}
  }
  by('make-room').onclick=()=>enter(true)
  by('join-room').onclick=()=>enter(false)
  by('race-ready').onclick=()=>command({type:'ready',ready:!me().ready})
  by('race-start').onclick=()=>command({type:'start'})
  by('race-again').onclick=()=>command({type:'again'})
  by('race-leave').onclick=()=>{session.close();clearRoom();status('Left room')}
  by('race-settings').onchange=()=>command({type:'settings',course:by('race-course').value,laps:by('race-laps').valueAsNumber,collisions:by('race-contact').checked})
  const profile=JSON.parse(localStorage.getItem('western-profile')||'null')
  if(profile){by('race-name').value=profile.nickname;by('race-color').value=profile.color}
  const previous=JSON.parse(sessionStorage.getItem('western-room')||'null')
  if(previous)connectRoom(previous)
  function closePad(){
    controller?.close()
    controller=pad=null
    by('pad-info').hidden=true
    by('make-pad').hidden=false
  }
  by('end-pad').onclick=closePad
  by('make-pad').onclick=async()=>{
    try{
      const ticket=await reserve('pads',null,{})
      controller=new Session(ticket,m=>{
        if(m.type==='pad'){pad=m.input;lastPad=performance.now()}
        if(m.type==='room')by('pad-state').textContent=m.players.some(p=>p.id!==ticket.id && p.connected)?'Phone connected':'Waiting for phone'
      },s=>{if(s==='Session ended')closePad()})
      const url=new URL('/pad',location.origin)
      url.searchParams.set('code',ticket.code)
      const image=qr(0,'M')
      image.addData(url.href);image.make()
      by('pad-qr').src=image.createDataURL(4)
      by('pad-code').textContent='Pairing code '+ticket.code
      by('pad-url').textContent=by('pad-url').href=url.href
      by('pad-info').hidden=false
      by('make-pad').hidden=true
    }catch(err){status(err.message)}
  }
  return {
    get racing(){return !!room?.race},
    get waiting(){return room?.race && (session.now()<room.start || !!me()?.finish)},
    controls(input) {
      if(!pad || performance.now()-lastPad>220)return input
      return {...input,steer:Math.max(-1,Math.min(1,input.steer+pad.steer)),brake:Math.max(input.brake,pad.brake),throttle:Math.max(input.throttle,pad.throttle)}
    },
    update(timestamp,dt) {
      if(!room?.race)return
      const player=me(),car=carState(),now=session.now()
      const countdown=Math.ceil((room.start-now)/1000)
      const label=countdown>0?'Starting in '+countdown:player.finish?'Finished':('Lap '+(player.lap+1)+' / '+room.settings.laps)
      if(banner.textContent!==label) banner.textContent=label
      if(timestamp-lastState>=40){
        const {x,y,z,heading,speed}=car
        command({type:'state',race:room.race,x,y,z,heading,speed})
        lastState=timestamp
      }
      if(!player.finish && car.phase==='finished' && timestamp-lastFinish>400){
        command({type:'lap',race:room.race,lap:player.lap+1})
        lastFinish=timestamp
      }
      fleet.update(now,car,room.settings.collisions && now>room.start && !player.finish,dt)
    }
  }
}
