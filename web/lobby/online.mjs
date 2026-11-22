import {pairPhone} from './pair-phone.mjs'
import {RaceSession,seat} from '../net/race-session.mjs'
import {createFleet} from './remote.mjs'
import {pixelCountdown} from '../race/pixel-countdown.mjs'
import './lobby.css'

const by=id=>document.getElementById(id)
export function mountOnline(health){
  const menu=document.createElement('dialog')
  menu.id='online-menu'
  menu.setAttribute('aria-labelledby','online-title')
  menu.innerHTML=`<div class="heading"><h2 id="online-title">Race with friends</h2><button id="online-close" aria-label="Close">×</button></div>
    <div id="online-entry"><div class="profile"><label>Nickname<input id="race-name" maxlength="18" value="Driver"></label><label>Colour<input id="race-color" type="color" value="#d94a28"></label></div>
    <button id="make-room">Create room</button><label>Room code<input id="room-code" maxlength="6" autocomplete="off"></label><button id="join-room">Join room</button></div>
    <div id="online-room" hidden><button id="room-label" title="Copy room code"></button><div class="actions"><button id="share-room">Share invite</button><button id="copy-room">Copy link</button></div>
    <ul id="room-roster"></ul><label>Nickname<input id="room-name" maxlength="18"></label><fieldset id="race-settings"><label>Course<select id="race-course"><option value="sprint">UC Hill Sprint</option><option value="college">College Hill</option><option value="stadium">Stadium</option><option value="campus">Thames Bridges</option><option value="roam">Free roam</option></select></label>
    <label>Laps<input id="race-laps" type="number" min="1" max="5" value="1"></label><label>Time limit (seconds)<input id="race-limit" type="number" min="30" max="900" value="300"></label><label><span><input id="race-contact" type="checkbox"> Car collisions</span></label></fieldset>
    <div class="actions"><button id="race-ready">Ready</button><button id="race-start">Start race</button><button id="race-again" hidden>Vote to restart</button><button id="race-leave">Leave</button></div></div>
    <p><button id="make-pad">Pair phone controller</button></p><output id="online-status" aria-live="polite"></output>`
  document.body.append(menu)
  const toggle=document.createElement('button')
  toggle.textContent='Online'
  toggle.hidden=!health.multiplayer
  document.querySelector('.course-card nav').append(toggle)
  toggle.onclick=()=>menu.showModal()
  by('online-close').onclick=()=>menu.close()
  const banner=document.createElement('output')
  banner.id='race-banner';banner.hidden=true;by('drive-ui').append(banner)
  const q=new URLSearchParams(location.search),invite=q.get('room')?.toUpperCase()
  const debug=q.has('netdebug')?document.createElement('pre'):null
  if(debug){debug.id='net-debug';by('drive-ui').append(debug)}
  let game,fleet,session,room,loaded=false,positioned=null,reportAt=0,stuck=0,connection=''
  const phone=pairPhone(action=>{
    if(action==='recover' && !by('recover').hidden)by('recover').click()
    else by('restart').click()
  })
  const state=()=>room?.players.find(p=>p.id===session?.ticket.id)
  const status=value=>{by('online-status').value=value}
  const send=m=>session?.send(m)
  function clear(){
    const sprint=positioned && room?.settings.course==='sprint'
    room=null;session=null;loaded=false;positioned=null;reportAt=0
    sessionStorage.removeItem('western-room')
    fleet?.roster([],null)
    by('online-entry').hidden=false;by('online-room').hidden=true
    by('drive-course').disabled=false
    if(game)by('trial-open').disabled=false
    if(sprint)game?.changeCourse('sprint')
    banner.hidden=true
    pixelCountdown().hide()
    if(debug)debug.textContent=''
  }
  function render(){
    if(!room)return
    const p=state()
    if(!p)return
    const host=p.id===room.host, lobby=room.phase==='lobby', roam=room.settings.course==='roam'
    by('online-entry').hidden=true;by('online-room').hidden=false
    by('room-label').textContent='Room '+room.code
    if(document.activeElement!==by('room-name'))by('room-name').value=p.nickname
    const rows=room.phase==='results'?room.results:room.players
    by('room-roster').replaceChildren(...rows.map((r,i)=>{
      const li=document.createElement('li'),player=room.players.find(v=>v.id===r.id)
      const label=room.phase==='results'?(r.finish?(r.finish/1000).toFixed(2)+' s':'DNF'):!r.connected?'Reconnecting':!r.loaded?'Loading campus…':r.ready && lobby?'Ready':lobby?'Waiting':r.finish?'Finished':r.dnf?'DNF':room.settings.course==='sprint'?'Racing':'Lap '+(r.lap+1)
      li.textContent=(room.phase==='results'?(i+1)+'. ':'')+r.nickname+' · '+label+(room.host===r.id?' · Host':'')
      li.style.borderColor=player?.color||'transparent'
      return li
    }))
    by('race-settings').disabled=!host || !lobby || !session.connected || !!room.drain
    by('race-course').value=room.settings.course
    by('race-laps').disabled=room.settings.course==='sprint'
    by('race-laps').value=room.settings.laps;by('race-limit').value=room.settings.limit
    by('race-contact').checked=room.settings.collisions
    by('race-ready').textContent=!p.loaded?'Loading campus…':p.ready?'Unready':'Ready'
    by('race-ready').disabled=!p.loaded || !session.connected || !!room.drain
    by('race-ready').hidden=!lobby || roam
    by('race-start').hidden=!host || !lobby || roam
    by('race-start').disabled=!!room.drain || !session.connected || room.players.length<2 || !room.players.every(p=>p.loaded && p.connected && p.ready)
    by('race-again').hidden=lobby
    by('race-again').disabled=p.vote || !session.connected
    by('race-again').textContent=p.vote?'Voted · '+room.players.filter(p=>p.vote).length+'/'+room.players.filter(p=>p.connected).length:'Vote to restart'
    by('drive-course').disabled=true
    if(game)by('trial-open').disabled=!!room.race
    fleet?.roster(room.players,p.id)
    status(room.drain?'Server updating':connection)
  }
  function apply(before){
    render()
    if(!game || !room || !session?.connected)return
    const p=state()
    if(!p)return
    if(!loaded){loaded=true;send({type:'loaded'})}
    if(room.settings.course==='roam' && before?.settings.course!=='roam'){game.changeCourse('roam');session.reset()}
    if(room.race && positioned!==room.race){
      game.changeCourse(room.settings.course,true)
      game.gridPosition(p.slot)
      positioned=room.race;reportAt=0;session.reset();fleet.respawn()
      menu.close()
    }
    if(room.phase==='positioning' && !p.placed && !placementSent){placementSent=true;send({type:'placed',race:room.race})}
    if(before?.race===room.race && room.race && !p.finish && p.lap>(before.players.find(v=>v.id===p.id)?.lap??0)){
      game.audio.cue('lap');game.reset();session.reset();fleet.respawn()
    }
    if(before?.race===room.race && room.race && p.finish && !before.players.find(v=>v.id===p.id)?.finish)game.audio.cue('finish')
    if(!room.race){
      if(positioned){game.changeCourse(room.settings.course);session.reset();fleet.respawn()}
      positioned=null;placementSent=false
    }
    if(room.phase==='results' && before?.phase!=='results' && !menu.open)menu.showModal()
  }
  let placementSent=false,safeSpot=null
  function connect(ticket,profile){
    sessionStorage.setItem('western-room',JSON.stringify({ticket,profile}))
    session=new RaceSession(ticket,profile,m=>{const before=room;room=m;apply(before)},s=>{
      connection=s
      if(s==='Connected'){loaded=false;placementSent=false;reportAt=0}
      if(session?.closed)clear()
      render();status(s)
    })
  }
  const profile=JSON.parse(localStorage.getItem('western-profile')||'null')
  if(profile){by('race-name').value=profile.nickname;by('race-color').value=profile.color}
  async function enter(create){
    const code=by('room-code').value.trim().toUpperCase()
    if(!create && !code)return status('Enter a room code')
    const profile={nickname:by('race-name').value.trim(),color:by('race-color').value,arrival:!create && code===invite?'invite':'code'}
    status(create?'Creating room…':'Joining room…')
    by('make-room').disabled=by('join-room').disabled=true
    try{
      connect(await seat(create?null:code,profile),profile)
      localStorage.setItem('western-profile',JSON.stringify(profile))
    }catch(e){status(e.message)}
    finally{by('make-room').disabled=by('join-room').disabled=false}
  }
  async function share(mode){
    const url=new URL('/',health.inviteOrigin||location.origin)
    url.searchParams.set('room',room.code)
    try{
      if(mode==='share' && navigator.share)await navigator.share({title:'Drive Western',url:url.href})
      else{
        const text=mode==='code'?room.code:url.href
        if(navigator.clipboard)await navigator.clipboard.writeText(text)
        else{
          const field=document.createElement('textarea');menu.append(field);field.value=text;field.select()
          const copied=document.execCommand('copy');field.remove()
          if(!copied)return status(text)
        }
        status(mode==='code'?'Code copied':'Invite link copied')
      }
      send({type:'share'})
    }catch(e){if(e.name!=='AbortError')status(url.href)}
  }
  by('room-label').onclick=()=>share('code');by('copy-room').onclick=()=>share('link');by('share-room').onclick=()=>share('share')
  by('make-pad').onclick=()=>{menu.close();phone.open()}
  by('make-room').onclick=()=>enter(true);by('join-room').onclick=()=>enter(false)
  by('room-name').onchange=()=>{const nickname=by('room-name').value.trim();send({type:'rename',nickname})}
  by('race-ready').onclick=()=>send({type:'ready',ready:!state().ready})
  by('race-start').onclick=()=>send({type:'start'})
  by('race-again').onclick=()=>send({type:'vote',race:room.race})
  by('race-leave').onclick=()=>{session.close();clear();status('Left room')}
  by('race-settings').onchange=()=>send({type:'settings',course:by('race-course').value,laps:by('race-laps').valueAsNumber,limit:by('race-limit').valueAsNumber,collisions:by('race-contact').checked})
  const prev=JSON.parse(sessionStorage.getItem('western-room')||'null')
  if(health.multiplayer && prev?.ticket && (!invite || prev.ticket.code===invite))connect(prev.ticket,prev.profile)
  else if(invite && health.multiplayer){by('room-code').value=invite;menu.showModal()}
  return {
    attach(deps){game=deps;fleet=createFleet(deps.THREE,deps.scene,deps.coupe,deps.audio);apply(null)},
    get racing(){return !!room?.race},
    get active(){return !!room},
    get opponents(){return room?fleet?.poses:undefined},
    get cue(){
      if(!session?.clock.synced || !['countdown','playing'].includes(room?.phase))return null
      const left=room.start-session.clock.server(performance.now())
      return left>0?String(Math.min(3,Math.ceil(left/1000))):left> -800?'GO':null
    },
    get waiting(){return room?.race && (room.phase==='positioning' || (room.phase==='countdown' && (!session.clock.synced || session.clock.server(performance.now())<room.start)) || room.phase==='results' || state()?.dnf || !!state()?.finish)},
    get padConnected(){return phone.connected},
    controls(local){return phone.controls(local,game?.carState())},
    recoverySpot(car){
      session?.reset();fleet?.respawn();stuck=0
      return room && safeSpot?.car===car && safeSpot.gates===car.checkpointsPassed?safeSpot.pose:null
    },
    details(){return [...(session?.tracks||[])].map(([slot,t])=>({slot,path:t.path,correction:t.correction,age:t.raw(performance.now())?.age,jitter:t.jitter}))},
    update(stamp,dt,input,pad){
      if(!room || !game)return
      const p=state(),car=game.carState(),now=session.clock.server(performance.now())
      if(!p)return
      if(!this.waiting && !car.contact && !car.offCourse && car.surface==='road' && car.speed>2 && (!safeSpot || safeSpot.car!==car || stamp-safeSpot.at>600)){
        safeSpot={car,at:stamp,gates:car.checkpointsPassed,pose:{x:car.x,y:car.y,z:car.z,heading:car.nextGate?Math.atan2(car.nextGate.x-car.x,car.nextGate.z-car.z):car.heading,distance:car.distance,phase:car.phase}}
      }
      session.frame(car,input,stamp)
      fleet.update(session,car,room.settings.collisions && (!room.race || room.phase==='playing') && !p.finish && car.phase!=='finished',dt)
      const seconds=Math.ceil((room.start-now)/1000),left=Math.ceil((room.deadline-now)/1000)
      const untilStart=(room.start-now)/1000
      if(room.race && session.clock.synced && (room.phase==='countdown' || room.phase==='playing') && untilStart>-1 && untilStart<=3.2)pixelCountdown().sync(untilStart)
      else pixelCountdown().hide()
      stuck=input.throttle>.6 && Math.abs(car.speed)<.8 && !this.waiting?stuck+dt:0
      const raceProgress=room.settings.course==='sprint'
        ? car.nextGate ? 'Checkpoint '+(car.checkpointsPassed+1)+' / '+car.checkpointCount : 'UC Hill Sprint'
        : 'Lap '+(p.lap+1)+' / '+room.settings.laps
      const label=!session.connected?connection:room.drain?'Server updating':room.phase==='positioning'?'Taking starting positions…':room.phase==='countdown' && seconds>0?'Starting in '+seconds:stuck>2?'Stuck? '+(phone.connected || matchMedia('(pointer:coarse)').matches?'Tap Recover':pad?'Press Menu to recover':'Press R to recover'):p.finish?'Finished':room.phase==='playing'?raceProgress+(left<=30?' · '+left+' s left':''):''
      banner.hidden=!label
      if(banner.textContent!==label)banner.textContent=label
      if(session.connected && room.phase==='playing' && !p.finish && !p.dnf && car.phase==='finished' && stamp>=reportAt){
        reportAt=stamp+350;send({type:'lap',race:room.race,lap:p.lap+1})
      }
      if(debug && stamp>(this.debugDue||0)){
        this.debugDue=stamp+250
        debug.textContent=this.details().map(t=>'Slot '+(t.slot+1)+' '+(t.path||'syncing')+' · age '+Math.round((t.age||0)*1000)+' ms · correction '+t.correction.toFixed(2)+' m · jitter '+Math.round(t.jitter)+' ms').join('\n')
      }
    }
  }
}
