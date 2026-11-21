export function buildArchitecture(records, level=1, audit=false, contacts=null) {
  const positions=[], normals=[], uvs=[], styles=[], indices=[], boxes=[], solids=[], footings=[],palette=[], paletteMap=new Map();
  const ranges=audit?[]:undefined;
  const near=level===2, medium=level>=1, collisionOnly=level===-1;
  let b,s,ground,arcadePiers;
  const clamp=(n,a,c)=>Math.max(a,Math.min(c,n));
  function merge(...items){
    const out={};
    for(const item of items)for(const [key,val] of Object.entries(item??{}))out[key]=val && typeof val==='object' && !Array.isArray(val)?merge(out[key],val):val;
    return out;
  }
  const cache=new Map(),caps=new Map();
  function material(ref,extra){
    let base=s.materials[ref]??s.materials.wall;
    if(typeof ref==='string' && ref.startsWith('#'))base={kind:'painted-metal',color:ref};
    const declared=base;
    if(!extra && cache.has(declared))return cache.get(declared);
    if(base.surface==='perforated')base={...base,kind:'perforated-mesh',unitSize:base.unitSize??[.14,.14],opacity:base.opacity??.3};
    if(base.surface==='opaque' && base.kind==='glass-curtain')base={...base,kind:'spandrel-glass',opacity:1};
    const m=extra?{...base,...extra}:base;
    const key=JSON.stringify(m);
    if(!paletteMap.has(key)){paletteMap.set(key,palette.length);palette.push(m);}
    const id=paletteMap.get(key);
    if(!extra)cache.set(declared,id);
    return id;
  }
  function face(points,mat,uv=null,aim=null){
    if(collisionOnly)return;
    const a=points[0],v=points[1],w=points[2];
    const x=v[0]-a[0],y=v[1]-a[1],z=v[2]-a[2],u=w[0]-a[0],h=w[1]-a[1],t=w[2]-a[2];
    let nx=y*t-z*h,ny=z*u-x*t,nz=x*h-y*u;
    const length=Math.hypot(nx,ny,nz);
    if(length<.000001)return;
    if(contacts){contacts.face(points);return;}
    const reverse=aim && nx*aim[0]+ny*aim[1]+nz*aim[2]<0;
    const k=(reverse?-127:127)/length;
    nx=Math.round(nx*k);ny=Math.round(ny*k);nz=Math.round(nz*k);
    const start=positions.length/3;
    points.forEach((p,i)=>{
      positions.push(...p);normals.push(nx,ny,nz);styles.push(mat);
      uvs.push(...(uv?.[i]??(Math.abs(ny)>90?[p[0],p[2]]:[Math.abs(nx)>Math.abs(nz)?p[2]:p[0],p[1]])));
    });
    for(let i=2;i<points.length;i++)indices.push(start,start+(reverse?i:i-1),start+(reverse?i-1:i));
  }
  function solid(loop,low,high){if(collisionOnly)solids.push([low,high,loop.map(r=>r.flat())]);}
  function block(x,y,z,w,h,d,theta,mat,collides=false,toGrade=false){
    if(toGrade){
      const key=x.toFixed(3)+','+z.toFixed(3);
      if(collisionOnly)footings.push([key,x,z]);
      const surface=b.contactHeights?.[key];
      if(Number.isFinite(surface)){
        const top=y+h*.5;
        h=Math.max(.025,top-surface+.12);y=top-h*.5;
      }
    }
    if(!(w>.009 && h>.009 && d>.009))return;
    if(level===1 && !collides && !toGrade){
      const narrow=(w<.14?1:0)+(h<.14?1:0)+(d<.14?1:0);
      if(narrow>=2 && Math.max(w,h,d)<3.5)return;
    }
    if(contacts){contacts.box(x,y,z,w,h,d,theta);return;}
    if(collides && collisionOnly){
      const c=Math.cos(theta),t=Math.sin(theta);
      solid([[[1,1],[-1,1],[-1,-1],[1,-1]].map(([a,v])=>[x+a*w*c/2-v*d*t/2,z+a*w*t/2+v*d*c/2])],y-h/2,y+h/2);
    }
    if(!collisionOnly)boxes.push(x,y,z,w,h,d,theta,mat);
  }
  function frame(a,c,bulge=0,kink=null){
    const dx=c[0]-a[0],dz=c[1]-a[1],len=Math.hypot(dx,dz),tx=dx/len,tz=dz/len,nx=tz,nz=-tx;
    const angle=Math.atan2(tz,tx);
    const knot=kink?clamp(((kink[0]-a[0])*tx+(kink[1]-a[1])*tz)/len,.001,.999):.5;
    const offsetAt=q=>kink?bulge*Math.min(q/knot,(1-q)/(1-knot)):4*q*(1-q)*bulge;
    const at=(u,y,d=0)=>{const q=clamp(u/len,0,1),offset=d+offsetAt(q);return [a[0]+u*tx+offset*nx,y,a[1]+u*tz+offset*nz];};
    const sections=!bulge?[0,len]:kink?[0,knot*len,len]:Array.from({length:1+Math.max(1,Math.min(16,Math.ceil(Math.sqrt(Math.abs(bulge)/(near?.045:.12)))))},(_,i)=>i);
    if(bulge && !kink)for(let i=0;i<sections.length;i++)sections[i]=i*len/(sections.length-1);
    const split=(left,right)=>[left,...sections.filter(v=>v>left+.0001 && v<right-.0001),right];
    function box(u,y,d,w,h,depth,m,col=false,toGrade=false){
      if(!bulge || w<len*.22){block(...at(u,y,d),w,h,depth,angle,m,col,toGrade);return;}
      const stops=split(u-w/2,u+w/2);
      for(let i=1;i<stops.length;i++){
        const a=at(stops[i-1],y,d),c=at(stops[i],y,d);
        block((a[0]+c[0])/2,y,(a[2]+c[2])/2,Math.hypot(c[0]-a[0],c[2]-a[2]),h,depth,Math.atan2(c[2]-a[2],c[0]-a[0]),m,col,toGrade);
      }
    }
    function surface(poly,m,depth=0,uv=null){
      if(!bulge){face(poly.map(([u,y])=>at(u,y,depth)),m,uv??poly,[nx,0,nz]);return;}
      if(collisionOnly)return;
      const points=poly.map(([u,y],i)=>[u,y,...(uv?.[i]??[u,y])]);
      function clip(input,limit,side){
        const out=[];
        for(let j=0;j<input.length;j++){
          const a=input[(j+input.length-1)%input.length],b=input[j],da=(a[0]-limit)*side,db=(b[0]-limit)*side;
          if(da*db<0){const t=da/(da-db);out.push(a.map((v,k)=>v+(b[k]-v)*t));}
          if(db>=0)out.push(b);
        }
        return out;
      }
      const stops=sections;
      for(let j=1;j<stops.length;j++){
        const clipped=clip(clip(points,stops[j-1],1),stops[j],-1);
        if(clipped.length<3)continue;
        const start=normals.length;
        face(clipped.map(([u,y])=>at(u,y,depth)),m,clipped.map(v=>v.slice(2)),[nx,0,nz]);
        if(normals.length===start)continue;
        for(const [i,[u]] of clipped.entries()){
          const slope=kink?bulge/len*(u/len<knot?1/knot:-1/(1-knot)):4*bulge/len*(1-2*u/len),scale=127/Math.hypot(1,slope);
          normals[start+3*i]=Math.round(scale*(nx-slope*tx));normals[start+3*i+2]=Math.round(scale*(nz-slope*tz));
        }
      }
    }
    const rect=(left,bot,right,top,m,d=0)=>{if(right>left+.0001 && top>bot+.0001)surface([[left,bot],[right,bot],[right,top],[left,top]],m,d);};
    return {at,box,surface,rect,split,len,tx,tz,nx,nz,angle,a};
  }
  function molding(f,left,right,cross,finish,soffit=finish){
    if(right-left<.02)return;
    for(let i=1;i<cross.length;i++){
      const [y0,d0]=cross[i-1],[y1,d1]=cross[i];
      const stops=f.split(left,right);
      for(let j=1;j<stops.length;j++){
        const a=stops[j-1],c=stops[j];
        face([f.at(a,y0,d0),f.at(c,y0,d0),f.at(c,y1,d1),f.at(a,y1,d1)],d1>d0?soffit:finish,null,[f.nx*(y1-y0),d0-d1,f.nz*(y1-y0)]);
      }
    }
    const extremity=cross.length>4?[cross[0],cross[1],cross.at(-2),cross.at(-1)]:cross;
    for(const u of [left,right])face(extremity.map(([y,d])=>f.at(u,y,d)),finish);
  }
  function glazingBar(f,u0,y0,u1,y1,back,width,finish){
    const vertical=y0!==y1,depth=clamp(width*1.8,.070,.16);
    if(!caps.has(finish))caps.set(finish,material(null,{...palette[finish],profile:'pressure-cap'}));
    const extrusion=caps.get(finish);
    f.box((u0+u1)/2,(y0+y1)/2,back+depth/2,vertical?width:Math.abs(u1-u0),vertical?Math.abs(y1-y0):width,depth,extrusion);
  }
  function rainLeader(f,u,foot,head,reach,ref){
    if(head-foot<1.5)return;
    const m=material(ref??'#786f60',{kind:'painted-metal',roughness:.46});
    f.box(u,(foot+head)/2,.085,.10,head-foot,.11,m);
    beam(f.at(u,head,.085),f.at(u,head+.25,reach),.11,m);
    beam(f.at(u,foot,.085),f.at(u,foot-.12,.25),.10,m);
    if(near)for(let y=foot+.65;y<head-.30;y+=3.1)f.box(u,y,.085,.14,.050,.14,m);
  }
  function matches(key,id){
    if(Array.isArray(key))return key.some(k=>matches(k,id));
    const w=b.walls[id],sel=String(key);
    if(sel==='all')return true;
    if(!w)return false;
    if(sel==='street')return w.street;
    if(w.faces===sel)return true;
    const range=sel.split('-').map(Number);
    return id>=range[0] && id<=(range[1]??range[0]);
  }
  function openingProfile(type,width,height){
    if(!['lancet','tudor-arch','round-arch','segmental-arch','gothic-portal','arched-portal'].includes(type))return [[-.5,1],[.5,1]];
    const pointed=['lancet','gothic-portal','tudor-arch'].includes(type);
    const rise=Math.min(.65,width/height*(type==='tudor-arch'||type==='segmental-arch'?.22:type==='lancet'?.82:.53));
    const count=near?10:6;
    return Array.from({length:count+1},(_,i)=>{
      const x=i/count*2-1;
      const y=pointed?Math.sqrt(Math.max(0,1-((Math.abs(x)+.65)/1.65)**2))/.919:Math.sqrt(Math.max(0,1-x*x));
      return [x/2,1-rise+rise*y];
    });
  }
  function wallDepth(f,left,right){
    let clearance=3.4;
    const samples=[left+.001,(left+right)/2,right-.001];
    if(f.rings)for(const ring of f.rings)for(const [x,z] of ring){
      const d=(f.a[0]-x)*f.nx+(f.a[1]-z)*f.nz,along=(x-f.a[0])*f.tx+(z-f.a[1])*f.tz;
      if(d>1e-6 && d<clearance && along>left && along<right)samples.push(along);
    }
    if(f.rings)for(const along of samples){
      const [px,,pz]=f.at(along,0);
      for(const ring of f.rings)for(let j=0;j<ring.length;j++){
        const a=ring[j],c=ring[(j+1)%ring.length],ex=c[0]-a[0],ez=c[1]-a[1],den=ex*f.nz-ez*f.nx;
        if(Math.abs(den)<.0001)continue;
        const d=((a[0]-px)*ez-(a[1]-pz)*ex)/den,t=((a[1]-pz)*f.nx-(a[0]-px)*f.nz)/den;
        if(d>1e-6 && t>=0 && t<=1)clearance=Math.min(clearance,d*.94);
      }
    }
    return clearance;
  }
  function opening(f,cell,opening,wall){
    if(contacts && cell.bot>contacts.ceiling)return;
    const {l,r,bot,top}=cell,{u,sill,width,height,type,depth,glass,trim,frameWidth,win}=opening;
    const left=u-width/2,right=u+width/2,peak=sill+height;
    const clearance=near?wallDepth(f,left,right):3.4;
    const projection=opening.projection??(type==='oriel'?.55:0);
    const back=near && projection===0?-Math.min(clearance*.80,Math.max(.11,depth)+.045):.015;
    const profile=openingProfile(type,width,height);
    const inner=profile.map(([x,y])=>[u+x*width,sill+y*height]);
    if(near){
      f.rect(l,bot,left,top,wall);f.rect(right,bot,r,top,wall);f.rect(left,bot,right,sill,wall);
      for(let i=1;i<inner.length;i++){
        const [ax,ay]=inner[i-1],[bx,by]=inner[i];
        f.surface([[ax,ay],[bx,by],[bx,top],[ax,top]],wall);
      }
    }
    if(opening.cutOnly)return;
    const outline=[[left,sill],[right,sill],...inner.toReversed()];
    const center=[u,sill+height*.44];
    const splay=near?Math.min(width*.18,win.splay??0):0;
    const jamb=outline.map(([x,y])=>[x+(u-x)*2*splay/width,y+(center[1]-y)*splay/height]);
    const trimmed=jamb.map(([x,y])=>[x+(u-x)*Math.min(.38,2*frameWidth/width),y+(center[1]-y)*Math.min(.35,2*frameWidth/height)]);
    for(let i=0;i<outline.length;i++){
      const j=(i+1)%outline.length,a=outline[i],c=outline[j],v=trimmed[i],w=trimmed[j];
      if(near){
        face([f.at(...a),f.at(...c),f.at(...jamb[j],back+.042),f.at(...jamb[i],back+.042)],opening.reveal??trim);
        face([f.at(...jamb[i],back+.042),f.at(...jamb[j],back+.042),f.at(...w,back+.005),f.at(...v,back+.005)],trim,null,[f.nx,0,f.nz]);
      }
    }
    if((projection>0 || win.rake) && !opening.cutOnly){
      const end=Number(win.rake)||0,lip=near?.085:.026;
      const front=([x,y])=>f.at(u+(x-u)*(projection>0?.83:1),y,back+projection+end*(y-sill)/height);
      const shell=material(win.frameColor??s.materials.frame?.color??'#869398');
      const glassUV=p=>[(p[0]-left)/width,(p[1]-sill)/height];
      for(let i=0;i<outline.length;i++){
        const j=(i+1)%outline.length,a=outline[i],c=outline[j];
        face([f.at(...a,back),f.at(...c,back),front(c),front(a)],Math.abs(a[0]-c[0])<.01?glass:shell,[[0,0],[1,0],[1,1],[0,1]]);
        if(near)beam(front(a),front(c),lip,shell);
      }
      face(outline.map(front),glass,outline.map(glassUV),[f.nx,0,f.nz]);
      return;
    }
    const pane=near?trimmed:outline;
    if(near && palette[glass].opacity<1 && !win.openBack){
      const innerDepth=Math.max(-clearance,back-Math.min(2.3,Math.max(.72,width*.54),Math.max(.72,Math.min(left,f.len-right))));
      const rear=material('#727063',{kind:'interior'});
      f.rect(left,sill,right,sill+height,rear,innerDepth);
      for(const [a,c] of [[outline[0],outline[1]],[outline[0],outline.at(-1)],[outline[1],outline[2]]])face([f.at(...a,back),f.at(...c,back),f.at(...c,innerDepth),f.at(...a,innerDepth)],rear);
    }
    f.surface(pane,glass,back,pane.map(([x,y])=>[(x-left)/width,(y-sill)/height]));
    if(!near)return;
    const frameMat=material(win.frameColor??s.materials.frame?.color??'#a8a296');
    const resolved=width>.83 && height>.65 && sill-ground<24;
    const bars=resolved?Math.max(0,win.mullions?.vertical??1):0,horizontal=resolved?Math.max(0,(win.mullions?.horizontal??0)+(win.transom?1:0)):0;
    const thick=win.mullions?.width??.062;
    for(let k=1;k<=bars;k++){
      const t=k/(bars+1),at=Math.min(inner.length-2,Math.floor(t*(inner.length-1))),blend=t*(inner.length-1)-at;
      const head=inner[at][1]*(1-blend)+inner[at+1][1]*blend;
      glazingBar(f,left+width*t,sill+.035,left+width*t,head-.035,back,thick,frameMat);
    }
    for(let k=1;k<=horizontal;k++){
      const y=sill+height*k/(horizontal+1);
      let half=width/2;
      for(let n=1;n<inner.length;n++){
        const [x0,y0]=inner[n-1],[x1,y1]=inner[n];
        if(y<Math.min(y0,y1) || y>=Math.max(y0,y1))continue;
        half=Math.min(half,Math.abs(x0+(x1-x0)*(y-y0)/(y1-y0)-u));
      }
      glazingBar(f,u-half+splay+.04,y,u+half-splay-.04,y,back-.009,thick,frameMat);
    }
    if(profile.length>2 && (win.surround||win.hoodMould||win.tracery)){
      const stone=material(win.surroundMaterial??'trim'),outer=inner.map(([x,y])=>[u+(x-u)*(1+.24/width),y+.16]);
      for(let i=1;i<inner.length;i++){
        f.surface([inner[i-1],inner[i],outer[i],outer[i-1]],stone,.095);
        face([f.at(...outer[i-1],.095),f.at(...outer[i],.095),f.at(...outer[i]),f.at(...outer[i-1])],stone);
      }
      if(win.tracery){
        for(const sign of [-1,1])beam(f.at(u,sill+height*.72,back+.055),f.at(u+sign*width*.20,sill+height*.88,back+.055),.085,stone);
      }
    }
    if(win.sillProjecting){
      molding(f,left-.085,right+.085,[[sill-.12,-.026],[sill-.12,.115],[sill-.14,.145],[sill-.14,.185],[sill-.037,.185],[sill+.008,-.026]],trim);
    }
    if((win.lintel||win.hoodMould) && profile.length===2){
      const rise=win.hoodMould?.20:.14,reach=win.hoodMould?.21:.105;
      molding(f,left-.125,right+.125,[[peak+.018,-.02],[peak+.018,reach*.68],[peak+.053,reach],[peak+rise,reach],[peak+rise+.025,-.02]],trim);
    }
    if(win.hoodMould)for(const a of [-1,1])f.box(u+a*(width+.17)/2,peak-.11,.08,.12,.33,.22,trim);
    if(win.surround && win.surround!=='none')for(const a of [-1,1])f.box(u+a*(width+.12)/2,sill+height*.45,.035,.14,height*.9,.12,trim);
    if(win.shading==='sloped-glass'){
      const project=Math.min(1.45,width*.36),drop=.50;
      const corners=[f.at(left,peak+.17),f.at(right,peak+.17),f.at(right,peak+.17-drop,project),f.at(left,peak+.17-drop,project)];
      face(corners,material('#79979c',{kind:'glass-curtain',opacity:.63}),[[0,0],[1,0],[1,1],[0,1]],[f.nx,.8,f.nz]);
      for(let i=0;i<4;i++)beam(corners[i],corners[(i+1)%4],.065,frameMat);
    }
    if(win.shading==='overhang')f.box(u,peak+.12,.41,width+.45,.14,.86,trim);
    if(win.shading==='fins'){
      const reach=clamp(win.finDepth??win.projection??.22,.05,1.5);
      for(const side of [-1,1])f.box(u+side*(width/2-.025),sill+height/2,reach/2,.047,height,reach,frameMat);
    }
    if(win.shading==='louvres')for(let i=1;i<5;i++)f.box(u,sill+i*height/5,.14,width,.085,.34,trim);
  }
  function frustum(x,z,w,d,lo,hi,w2,d2,n,angle,mat,sides=true){
    const pts=(rw,rd,y)=>Array.from({length:n},(_,i)=>{
      const a=(i+.5)*Math.PI*2/n,scale=n===4?Math.SQRT2:1,px=rw*.5*Math.cos(a)*scale,pz=rd*.5*Math.sin(a)*scale;
      return [x+px*Math.cos(angle)-pz*Math.sin(angle),y,z+px*Math.sin(angle)+pz*Math.cos(angle)];
    });
    const low=pts(w,d,lo),high=pts(w2,d2,hi);
    if(sides)for(let i=0;i<n;i++){
      const j=(i+1)%n;
      face([low[i],low[j],high[j],high[i]],mat,null,[low[i][0]-x,0,low[i][2]-z]);
    }
    face(high,mat,null,[0,1,0]);
    return low.map(p=>[p[0],p[2]]);
  }
  function entrance(f,e,u,y){
    const w=e.width??2.3,h=e.height??2.7,steps=Math.min(40,e.steps??0),trim=material(e.surround??'trim');
    const c=e.canopy, rise=.155;
    const street=y-steps*rise;
    if(level===0 && steps>0){
      face([f.at(u-w/2,y,0),f.at(u+w/2,y,0),f.at(u+w/2,street,steps*.32),f.at(u-w/2,street,steps*.32)],trim,null,[0,1,0]);
    }
    for(let i=0;i<steps && level!==0;i++){
      const sh=(i+1)*rise;
      f.box(u,street+sh*.5,(steps-i-.5)*.32,Math.max(w+.75,(c?.width??w)*.96),sh,.32,trim,true,true);
    }
    if(e.ramp){
      const depth=Math.max(1,steps*.32),run=Math.max(2,steps*rise*11);
      const x=u+w/2+run*.5;
      const spans=Math.max(1,Math.ceil(run/.55));
      for(let k=0;k<spans;k++){
        const t=(k+.5)/spans,rise=(y-street)*(1-t);
        if(collisionOnly)f.box(x+(t-.5)*run,street+rise*.5,depth*.5,run/spans,rise,depth,trim,true,true);
      }
      face([f.at(x-run/2,y,depth),f.at(x+run/2,street,depth),f.at(x+run/2,street,.02),f.at(x-run/2,y,.02)],trim,null,[0,1,0]);
    }
    if(c){
      const d=c.depth??1.5,cw=c.width??w+1,cm=c.type==='glass'?material(c.material??'glass',{kind:'glass-curtain',opacity:.43,color:s.materials[c.material]?.color??'#96b0ae'}):material(c.material??'trim');
      const shape=c.form??(c.type==='portico' && e.type==='gothic-portal'?'gable':c.type);
      const peaked=['arched','gable','pitched','shed'].includes(shape),peaks=c.peaks??1;
      const heightAt=q=>{const wave=(q*peaks)%1;return y+h+.12+(c.rise??Math.min(1.55,cw/peaks*.26))*(shape==='arched'?Math.sin(q*Math.PI):shape==='shed'?q:1-Math.abs(wave*2-1));};
      const border=material(c.frameMaterial??(c.type==='glass'?c.material??'frame':c.material??'trim'));
      if(shape==='shed'){
        const back=y+h+.15+(c.rise??.42),front=y+h+.15;
        const a=u-cw/2,b=u+cw/2;
        for(const [dh,finish] of [[0,cm],[-.085,c.type==='glass'?cm:material(c.soffitMaterial??c.material??'trim')]]){
          if(c.type==='glass' && dh<0)continue;
          face([f.at(a,back+dh,0),f.at(b,back+dh,0),f.at(b,front+dh,d),f.at(a,front+dh,d)],finish,null,[f.nx,.9,f.nz]);
        }
        f.box(u,front-.026,d,cw,.12,.085,border);
        const n=Math.max(1,Math.ceil(cw/1.3));
        for(let i=0;i<=n;i++)beam(f.at(a+cw*i/n,back-.045,0),f.at(a+cw*i/n,front-.045,d),.085,border);
      }else if(peaked){
        const n=shape==='arched'?12:2*peaks;
        const at=k=>heightAt(k/n);
        for(let i=0;i<n;i++){
          const a=u+(i/n-.5)*cw,v=a+cw/n;
          face([f.at(a,at(i),0),f.at(v,at(i+1),0),f.at(v,at(i+1),d),f.at(a,at(i),d)],cm,null,[0,1,0]);
          if(c.type==='portico' && shape==='gable' && !c.glazedGable){
            f.surface([[a,y+h+.095],[v,y+h+.095],[v,at(i+1)],[a,at(i)]],cm,d-.035);
            beam(f.at(a,at(i),d),f.at(v,at(i+1),d),.15,border);
          }
          if(c.glazedGable){
            const glass=material('#91adb5',{kind:'glass-curtain',opacity:.49});
            f.surface([[a,y+h+.10],[v,y+h+.10],[v,at(i+1)],[a,at(i)]],glass,d-.10);
            beam(f.at(a,at(i),d),f.at(v,at(i+1),d),.10,material('frame'));
          }
          f.surface([[a,at(i)-.16],[v,at(i+1)-.16],[v,at(i+1)],[a,at(i)]],cm,d);
        }
      }else f.box(u,y+h+.23,d/2,cw,.22,d,cm,true);
      const count=c.columns??(c.type==='portico'?2:0);
      for(let i=0;i<count;i++){
        const along=count===1?0:(i/(count-1)-.5)*(cw-.4);
        const head=shape==='shed'?y+h+.15:peaked?heightAt(along/cw+.5):y+h+.23;
        f.box(u+along,(street+head)/2,(c.columnDepth??d)-.22,.29,head-street,.29,cm,true,true);
      }
      if(c.type==='glass' && !peaked){
        const n=Math.max(1,Math.ceil(cw/1.35));for(let i=0;i<=n;i++)f.box(u+(i/n-.5)*cw,y+h+.19,d/2,.065,.095,d,material('frame'));
      }
    }
    if(e.pediment){
      const ped=e.pediment,pw=ped.width??w+1,y0=y+h+.17,peak=y0+(ped.height??.6);
      const pm=material(ped.material??'trim');
      f.surface([[u-pw/2,y0],[u+pw/2,y0],[u,peak]],pm,.18);
      for(const side of [-1,1])beam(f.at(u+side*pw/2,y0,.2),f.at(u,peak,.2),.15,pm);
    }
    if(e.vault){
      const depth=e.recess??1.25,chrome=material('#c4d0cf',{kind:'painted-metal',roughness:.13,metalness:.91});
      const backY=y+h,curve=k=>[u+w*.52*Math.cos(k*Math.PI/16),backY+w*.43*Math.sin(k*Math.PI/16)];
      for(let k=0;k<16;k++){
        const a=curve(k),b=curve(k+1);
        face([f.at(...a,.22),f.at(...b,.22),f.at(...b,-depth),f.at(...a,-depth)],chrome);
        if(e.vault.balcony){
          const l=u-w*.52+k*w*1.04/16,r=l+w*1.04/16,reach=v=>1.1+1.1*Math.cos((v-u)/w*Math.PI);
          for(const h0 of [backY,backY-.19])face([f.at(l,h0,-.1),f.at(r,h0,-.1),f.at(r,h0,reach(r)),f.at(l,h0,reach(l))],trim);
          face([f.at(l,backY-.19,reach(l)),f.at(r,backY-.19,reach(r)),f.at(r,backY,reach(r)),f.at(l,backY,reach(l))],trim);
          beam(f.at(l,backY+.86,reach(l)),f.at(r,backY+.86,reach(r)),.06,chrome);
          if(k%2===0)beam(f.at(l,backY,reach(l)),f.at(l,backY+.86,reach(l)),.045,chrome);
        }
      }
    }
    if((e.type==='glass-vestibule'||e.type==='revolving') && !(e.recess>0))f.box(u,y+h*.5,.47,w,h,.9,material('#718994',{kind:'glass-curtain',opacity:.42}),true);
  }
  function facade(f,part,id,base,top,lo,profile,which,segment=null){
    const refWall=b.walls[id];
    function interval(rows,field){
      const extent=refWall?(refWall.b[0]-refWall.a[0])*f.tx+(refWall.b[1]-refWall.a[1])*f.tz:f.len;
      if(segment?.[4]===rows){
        const [origin,span]=segment[5];
        return [origin,span];
      }
      const local=!refWall || part.wallProfiles?.[id]?.[field]===rows || part.facade?.[field]===rows;
      if(local){
        const length=segment?.[3]??f.len,begin=segment?.[0]??0;
        return extent<0?[length-begin,-length]:[-begin,length];
      }
      return [(refWall.a[0]-f.a[0])*f.tx+(refWall.a[1]-f.a[1])*f.tz,extent];
    }
    if(profile.segments?.length){
      const {segments:specified,...common}=profile;
      const [origin,extent]=interval(specified,'segments');
      const segments=specified.map(row=>{
        const limits=row.range.map(t=>origin+extent*t);
        return {...row,limits,range:limits.map(v=>v/f.len).sort((a,b)=>a-b)};
      });
      const limits=[...new Set([0,1,...segments.flatMap(s=>s.range.map(t=>clamp(t,0,1)))])].sort((a,c)=>a-c);
      for(let j=1;j<limits.length;j++){
        const a=limits[j-1],c=limits[j],mid=(a+c)/2;
        if((c-a)*f.len<.006)continue;
        const p=f.at(a*f.len,0),q=f.at(c*f.len,0),child=frame([p[0],p[2]],[q[0],q[2]]);
        child.rings=f.rings;child.joinedRoof=f.joinedRoof;
        if(f.grade)child.grade=u=>f.grade(a*f.len+u);
        const override=segments.find(s=>s.range[0]<=mid && mid<=s.range[1]);
        facade(child,part,id,base,top,lo,merge(common,override),which,[a*f.len,c*f.len,override?.bays?.count!==undefined,f.len,override?.sections,override?[override.limits[0]-a*f.len,override.limits[1]-override.limits[0]]:null]);
      }
      return;
    }
    const finish=profile.material??part.material??'wall',authored=s.materials[finish];
    const interior=s.style!=='greenhouse' && !/greenhouse|aviary|shelter|growing (?:range|house)|glasshouse|conservatory|rooftop biome|hoop house/i.test(part.name+' '+s.name);
    const occupiedGlass=authored?.kind==='glass-curtain' && authored.surface!=='opaque' && interior;
    function room(l,r,bottom,head,front=0){
      if(!medium || head<=bottom+.05 || r<=l+.04)return;
      const depth=Math.min(2.6,wallDepth(f,l+.018,r-.018)*.88);
      if(depth<front+.025)return;
      const back=material('#8b806f',{kind:'interior'}),floor=material('#847d70',{kind:'interior'}),side=material('#726d62',{kind:'interior'});
      f.rect(l,bottom,r,head,back,-depth);
      face([f.at(l,bottom,-front),f.at(r,bottom,-front),f.at(r,bottom,-depth),f.at(l,bottom,-depth)],floor,null,[0,1,0]);
      if(!near)return;
      for(const x of [l,r])face([f.at(x,bottom,-front),f.at(x,head,-front),f.at(x,head,-depth),f.at(x,bottom,-depth)],side);
      face([f.at(l,head,-front),f.at(l,head,-depth),f.at(r,head,-depth),f.at(r,head,-front)],side,null,[0,-1,0]);
    }
    const wall=material(finish,occupiedGlass?{opacity:medium?(authored.opacity??.78):1}:profile.blank?{plainElevation:true}:undefined),trim=material('trim');
    let sections=[];
    if(profile.sections?.length && !collisionOnly){
      const [origin,extent]=interval(profile.sections,'sections');
      const layers=profile.sections.map(row=>{
        const a=origin+extent*row.start,c=origin+extent*row.end;
        const grid=!!(row.verticalMullionSpacing || row.horizontalMullions);
        const glass=s.materials[row.material]?.kind==='glass-curtain';
        const sectionMid=(clamp(a,0,f.len)+clamp(c,0,f.len))/2;
        let recessed=row.recess??0;
        if(glass && !recessed && arcadePiers.length){
          const [x,,z]=f.at(sectionMid,ground);
          if(arcadePiers.some(p=>p.low<row.top && p.high>row.base && Math.hypot(p.center[0]-x,p.center[1]-z)<Math.max(5,f.len*.53)))recessed=.80;
        }
        const sectionFinish=material(row.material,glass && interior?{opacity:medium?(s.materials[row.material].opacity??.83):1,...(grid && medium?{line:0}:{})}:grid && glass && medium?{line:0}:undefined);
        return {l:clamp(Math.min(a,c),0,f.len),r:clamp(Math.max(a,c),0,f.len),bot:Math.max(lo,ground+row.base),top:Math.min(top,ground+row.top),mat:sectionFinish,depth:near?Math.min(recessed,wallDepth(f,clamp(Math.min(a,c),0,f.len),clamp(Math.max(a,c),0,f.len))*.75):0,row};
      }).filter(t=>t.r-t.l>.015 && t.top-t.bot>.015);
      if(layers.length){
        sections=layers;
        const original=f;
        const cladding=new Set([wall,material(finish),material(finish,{plainElevation:true})]);
        for(const floor of [profile.groundFloor,profile.topFloor,...Object.values(profile.floorOverrides??{})]){
          if(floor?.material)cladding.add(material(floor.material,floor.blank?{plainElevation:true}:undefined));
        }
        const panels=(l,bot,r,head,emit)=>{
          if(!layers.some(t=>l<t.r && r>t.l && bot<t.top && head>t.bot))return emit(l,bot,r,head,null);
          const cut=(lo,hi,values)=>[lo,...new Set(values.filter(v=>v>lo && v<hi).sort((a,c)=>a-c)),hi];
          const us=cut(l,r,layers.flatMap(t=>[t.l,t.r])),ys=cut(bot,head,layers.flatMap(t=>[t.bot,t.top]));
          let active=new Map();
          for(let j=1;j<ys.length;j++){
            const y=(ys[j-1]+ys[j])/2,next=new Map();
            let from=0;
            for(let i=1;i<us.length;i++){
              const u=(us[i-1]+us[i])/2;
              const index=layers.findIndex(t=>u>=t.l && u<=t.r && y>=t.bot && y<=t.top);
              if(i<us.length-1){
                const x=(us[i]+us[i+1])/2;
                if(index===layers.findIndex(t=>x>=t.l && x<=t.r && y>=t.bot && y<=t.top))continue;
              }
              const key=from+','+i+','+index;
              const span=active.get(key)??[us[from],ys[j-1],us[i],ys[j],layers[index]];
              span[3]=ys[j];next.set(key,span);active.delete(key);
              from=i;
            }
            for(const span of active.values())emit(...span);
            active=next;
          }
          for(const span of active.values())emit(...span);
        };
        const rect=(l,bot,r,head,m,d=0)=>cladding.has(m)?panels(l,bot,r,head,(a,y,c,h,t)=>original.rect(a,y,c,h,t?.mat??m,d-(t?.depth??0))):original.rect(l,bot,r,head,m,d);
        const surface=(shape,mat,depth=0,uv=null)=>{
          if(uv || !cladding.has(mat) || shape.length!==4 || shape[0][1]!==shape[1][1] || shape[2][1]!==shape[3][1])return original.surface(shape,mat,depth,uv);
          const xs=shape.map(p=>p[0]),ys=shape.map(p=>p[1]);
          rect(Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys),mat,depth);
        };
        f={...original,rect,panels,surface};
        if(medium)for(const t of layers){
          if(interior && !occupiedGlass && s.style!=='parking-structure' && palette[t.mat].kind==='glass-curtain')room(t.l,t.r,t.bot,t.top,t.depth+.04);
          if(t.depth>.01){
            const outline=[[t.l,t.bot],[t.r,t.bot],[t.r,t.top],[t.l,t.top]];
            const reveal=material(t.row.surroundMaterial??finish,{reveal:true});
            for(let j=0;j<4;j++){
              const a=outline[j],b=outline[(j+1)%4];
              face([f.at(...a),f.at(...b),f.at(...b,-t.depth),f.at(...a,-t.depth)],reveal);
            }
          }
          if(t.row.verticalMullionSpacing){
            const n=Math.max(1,Math.round((t.r-t.l)/t.row.verticalMullionSpacing));
            for(let k=0;k<=n;k+=near?1:Math.max(1,Math.ceil(1.65/t.row.verticalMullionSpacing)))f.box(t.l+(t.r-t.l)*k/n,(t.top+t.bot)/2,.045-t.depth,.055,t.top-t.bot,.09,material('frame'));
          }
          for(let k=1;k<=(t.row.horizontalMullions??0);k++)f.box((t.l+t.r)/2,t.bot+(t.top-t.bot)*k/(t.row.horizontalMullions+1),.045-t.depth,t.r-t.l,.06,.09,material('frame'));
        }
      }
    }
    const entries=part.low===0?(s.entrances??[]).map((e,i)=>({...e,entryId:i,boundAlong:e.boundAlong===undefined?undefined:e.boundAlong+(f.entryOffsets?.get(b.entranceEdges?.[i])??0)})).filter(e=>(b.entranceEdges?.[e.entryId]===which || f.entryOffsets?.has(b.entranceEdges?.[e.entryId])) && (!segment || e.boundAlong>=segment[0] && e.boundAlong<segment[1])):[];
    const project=e=>{if(e.boundAlong!==undefined)return e.boundAlong-(segment?.[0]??0);const w=b.walls[e.wall],t=e.position??.5;const [x,z]=e.at??[w.a[0]+(w.b[0]-w.a[0])*t,w.a[1]+(w.b[1]-w.a[1])*t];return (x-f.a[0])*f.tx+(z-f.a[1])*f.tz;};
    for(const e of entries)entrance(f,e,project(e),(b.entryGround?.[e.entryId]??base)+(e.steps??0)*.155+.035);
    const len=f.len;
    const parking=s.style==='parking-structure' && !/stair|lift|elevator|enclosed/i.test(part.name??'');
    const glazedStair=parking && profile.windows?.type==='curtain-wall' && /stair/i.test(profile.material??'');
    const apertures=parking && !glazedStair;
    const transparent=palette[wall].kind==='glass-curtain'||palette[wall].kind==='perforated-mesh';
    if(apertures || transparent){
      const floorCount=clamp(part.floors,1,48),floor=(top-base)/floorCount;
      const pitch=Math.max(1,Math.round(len/(apertures?6.3:2.4)));
      const accesses=entries.map(e=>{
        const width=Math.min(len-.06,e.width??2.3),u=clamp(project(e),width/2+.015,len-width/2-.015);
        const sill=(b.entryGround?.[e.entryId]??base)+(e.steps??0)*.155+.035;
        return {e,l:u-width/2,r:u+width/2,u,width,sill,head:sill+(e.height??2.7)};
      }).sort((a,c)=>a.l-c.l);
      const glazing=profile.windows??{},sculpted=transparent && !accesses.length && (glazing.rake || glazing.projectEvery);
      const occupied=occupiedGlass && !apertures;
      if(occupied && medium && !collisionOnly){
        const count=Math.max(1,Math.ceil(len/8));
        const slab=material('#aaa397',{kind:'concrete-smooth'});
        for(let bay=0;bay<count;bay++){
          const l=len*bay/count,r=len*(bay+1)/count,depth=Math.min(wallDepth(f,l+.02,r-.02),1.7);
          if(depth<.22)continue;
          room(l,r,Math.max(lo,base)+.075,top-.04,.045);
          if(near)for(let j=1;j<floorCount;j++){
            const h=base+j*floor;
            face([f.at(l,h,-.22),f.at(r,h,-.22),f.at(r,h,-depth),f.at(l,h,-depth)],slab,null,[0,1,0]);
            f.rect(l,h-.16,r,h,slab,-.22);
          }
        }
      }
      if(sculpted){
        const frameMat=material('frame'),n=Math.max(1,Math.round(len/(profile.bays?.width??3.6))),width=len/n;
        for(let k=0;k<n;k++){
          const l=k*width,r=(k+1)*width,depth=glazing.projectEvery && k%glazing.projectEvery===0?(glazing.projection??.48):0;
          const low=depth,high=depth+(glazing.rake??0);
          const sill=u=>part.low===0?(f.grade?.(u)??base)+.18:lo;
          const corners=[f.at(l,sill(l),low),f.at(r,sill(r),low),f.at(r,top,high),f.at(l,top,high)];
          if(part.low===0){
            const plinth=material('base');
            f.surface([[l,lo],[r,lo],[r,sill(r)],[l,sill(l)]],plinth);
            if(depth){
              f.surface([[l,lo],[r,lo],[r,sill(r)],[l,sill(l)]],plinth,depth);
              face([f.at(l,sill(l)),f.at(r,sill(r)),corners[1],corners[0]],plinth,null,[0,1,0]);
            }
          }
          face(corners,wall,[[0,0],[width,0],[width,top-lo],[0,top-lo]],[f.nx,0,f.nz]);
          if(depth>0){
            for(const u of [l,r])face([f.at(u,lo),f.at(u,lo,low),f.at(u,top,high),f.at(u,top)],wall);
            f.box((l+r)/2,top-.05,depth/2,width,.11,depth,frameMat);
            if(collisionOnly)f.box((l+r)/2,(top+lo)/2,depth/2,width,top-lo,depth,frameMat,true);
          }
          if(medium){
            beam(corners[0],corners[3],depth?.14:.085,frameMat);
            if(depth)beam(corners[1],corners[2],.14,frameMat);
            const divisions=Math.max(1,glazing.mullions?.vertical??1);
            for(let i=1;i<divisions;i++)beam(f.at(l+width*i/divisions,lo,low),f.at(l+width*i/divisions,top,high),.065,frameMat);
          }
        }
        return;
      }
      if(transparent){
        let left=0;
        for(const {e,l,r,u,width,sill,head} of accesses){
          f.rect(left,lo,l,top,wall);f.rect(l,lo,r,sill,wall);f.rect(l,head,r,top,wall);
          opening(f,{l,r,bot:sill,top:head},{u,width,sill,height:head-sill,type:e.type,depth:e.recess??.28,frameWidth:.09,glass:material('frame',{kind:'door',color:e.doorColor??'#536976'}),trim:material('frame'),win:{}},wall);
          left=Math.max(left,r);
        }
        f.rect(left,lo,len,top,wall);
      }
      for(let k=0;k<pitch;k++){
        if(accesses.some(o=>k*len/pitch>o.l && k*len/pitch<o.r))continue;
        const thick=apertures?.40:palette[wall].kind==='perforated-mesh'?.085:.075;
        f.box(k*len/pitch,base+(top-base)/2,apertures?-.56:-thick/2,thick,top-base,thick,material(apertures?'wall':'frame'),true,part.low===0);
      }
      for(let k=0;k<(apertures && part.deckLevels?part.deckLevels.length:floorCount);k++){
        if(apertures){
          const level=k===0?(f.grade?.(len/2)??base):(part.deckLevels?.[k-1]?.[0]??base+k*floor);
          const next=part.deckLevels?.[k]?.[0]??base+(k+1)*floor;
          if(part.officeTop && k===(part.deckLevels?.length??floorCount)-1){
            const p=profile.topFloor??profile,window=p.windows??profile.windows??{};
            f.rect(0,level,len,level+.92,wall);
            f.rect(0,level+.92,len,Math.max(level+1.05,top-.35),material('frame',{kind:'glazing',color:window.glassColor??'#56696c',vertical:0,horizontal:0,frameColor:'#706b5e'}));
            f.rect(0,top-.35,len,top,wall);
            if(medium)for(let n=1;n<pitch*2;n++)f.box(n*len/(pitch*2),.5*(top+level+.57),.015,.095,Math.max(.24,top-level-1.27),.12,material('frame'));
            continue;
          }
          const row=k===0?profile.groundFloor:profile.floorOverrides?.[k],window={...profile.windows,...row?.windows};
          const height=id<0?(k===0?.27:.92):clamp(window.sill??.92,.2,Math.max(.24,next-level-.75));
          const openings=k===0?entries.map(e=>[clamp(project(e)-(e.width??3)/2,0,len),clamp(project(e)+(e.width??3)/2,0,len)]).sort((a,c)=>a[0]-c[0]):[];
          let left=0;
          for(const [a,c] of [...openings,[len,len]]){
            if(a>left+.03){
              const center=(a+left)/2,span=a-left,g0=k===0?(f.grade?.(left)??level):level,g1=k===0?(f.grade?.(a)??level):level;
              const cap=Math.max(g0,g1)+height,low=Math.min(g0,g1)-.12;
              f.box(center,(cap+low)/2,-.16,span,cap-low,.34,wall,true);
              if(medium && k>0 && id>=0){
                molding(f,left,a,[[cap-.27,-.02],[cap-.25,.13],[cap-.065,.13],[cap,.085],[cap,-.02]],wall);
              }
              if(s.materials.mesh && id>=0 && medium && next>cap+.35){
                const mesh=material('mesh',{kind:'perforated-mesh',unitSize:[.14,1.35],opacity:.60,surface:'vertical-slats'});
                f.rect(left,cap,a,Math.min(next-.15,cap+(window.height??1.55)),mesh,-(window.recess??.22));
              }
            }
            left=Math.max(left,c);
          }
          const balcony=profile.balconies;
          if(medium && balcony && k>0 && (!balcony.floors || balcony.floors.includes(k))){
            const depth=balcony.depth??1.5,span=len/pitch*.84;
            for(let j=0;j<pitch;j+=Math.max(1,balcony.every??1)){
              const along=(j+.5)*len/pitch;
              f.box(along,level-.10,depth/2,span,.20,depth,wall);
              f.box(along,level+.48,depth-.1,span,1.06,.20,wall);
              for(const sign of [-1,1])f.box(along+sign*(span-.16)/2,level+.48,depth/2,.16,1.06,depth,wall);
            }
          }
        }else f.box(len/2,base+k*floor+.04,-.03,len,.075,.09,material('frame'));
      }
      if(apertures && medium && id>=0 && profile.parapet?.type==='metal-rail' && part.parkingAngle!==undefined){
        const h=profile.parapet.fenceHeight??Math.max(2.35,profile.parapet.height??1.8),frameMat=material('#626866'),mesh=material('mesh',{kind:'perforated-mesh',unitSize:[.105,.65],opacity:.54,surface:'picket'});
        f.rect(0,top+.12,len,top+h*.78,mesh,-.20);
        face([f.at(0,top+h*.78,-.20),f.at(len,top+h*.78,-.20),f.at(len,top+h,-.68),f.at(0,top+h,-.68)],mesh);
        const n=Math.max(1,Math.ceil(len/2.2));
        for(let j=0;j<n;j++){
          const along=(j+.08)*len/n;
          f.box(along,top+h*.39,-.20,.065,h*.78,.065,frameMat);
          beam(f.at(along,top+h*.78,-.20),f.at(along,top+h,-.68),.07,frameMat);
        }
        beam(f.at(0,top+h,-.68),f.at(len,top+h,-.68),.075,frameMat);
      }
      return;
    }
    if(profile.fasciaBeam){
      const beam=profile.fasciaBeam,n=Math.max(1,Math.round(len/beam.spacing));
      f.rect(0,lo,len,top,material('#56544e'));
      for(let j=0;j<n;j++){
        const suspended=part.low>0 && len>2.8,depth=beam.projection*(j%2 && suspended?.72:1);
        const width=Math.max(.06,len/n-(beam.gap??.12)),u=(j+.5)*len/n;
        const finish=suspended && j%3===1?material(profile.material??part.material??'wall',{color:palette[wall].secondaryColor??palette[wall].color}):wall;
        f.box(u,(top+base)/2,depth/2,width,top-base,depth,finish);
        if(suspended && medium){
          const shadow=material('#67645d',{kind:'concrete-smooth'});
          f.box(u,base+.052,depth+.004,width-.035,.060,.018,shadow);
          if(near)f.box(u,base-.070,-.32,Math.min(width,.24),.14,.94,shadow);
        }
      }
      return;
    }
    if(collisionOnly)return;
    const plinth=part.low===0 && !part.openSoffit?profile.base:null;
    const start=base+(part.low===0?Math.max(0,s.floors.raisedGround??0):0);
    const count=clamp(part.floors,1,80);
    const first=Math.min(top-start,part.openSoffit?part.openSoffit-start:profile.groundFloor?.height??s.floors.groundFloorHeight??(top-start)/count);
    const ends=[start];
    for(let j=1;j<=count;j++)ends.push(j===count?top:start+first+(j-1)*(top-start-first)/Math.max(1,count-1));
    const bays=profile.bays??{};
    const margin=clamp(bays.edgeMargin??.25,0,len*.22);
    const inventoryWall=b.walls[id];
    const original=inventoryWall?Math.hypot(inventoryWall.b[0]-inventoryWall.a[0],inventoryWall.b[1]-inventoryWall.a[1]):len;
    const repeats=bays.count===undefined?(len-2*margin)/(bays.width??3.8):bays.count*Math.min(1,len/(segment?.[2] || part.facade?.bays?.count && !segment?len:original));
    const n=clamp(Math.round(repeats),1,160);
    const pitch=(len-2*margin)/n;
    if(level===0){
      const win=profile.windows??{};
      if(profile.blank || win.type==='none' || len<1.3){f.rect(0,lo,len,top,wall);return;}
      const curtain=['curtain-wall','storefront','ribbon'].includes(win.type);
      const mat=material(profile.material??part.material??'wall',{kind:'distant-wall',glassColor:win.glassColor??'#597481',coverage:clamp((win.width??(curtain?pitch*.91:1.5))/pitch,.1,.96),vertical:clamp((win.height??2)/((top-base)/count),.15,.92)});
      f.rect(0,lo,len,start,wall);
      const distant=(a,y,c,h,layer)=>{
        if(layer){f.rect(a,y,c,h,layer.mat);return;}
        const corners=[[a,y],[c,y],[c,h],[a,h]];
        f.surface(corners,mat,0,corners.map(([u,v])=>[n*u/len,count*(v-start)/(top-start)]));
      };
      if(f.panels)f.panels(0,start,len,top,distant);
      else distant(0,start,len,top,null);
      return;
    }
    if(!near)f.rect(0,part.openSoffit??lo,len,top,wall);
    if(near){
      if(!entries.length && !part.openSoffit)f.rect(0,lo,len,start,wall);
      if(plinth && plinth.height>.01 && (plinth.projection??.04)>.01){
        const m=material(plinth.material??'trim'),reach=plinth.projection??.04,toe=reach+(plinth.batter??0);
        const breaks=entries.map(e=>[clamp(project(e)-(e.width??2.3)/2-.08,0,len),clamp(project(e)+(e.width??2.3)/2+.08,0,len)]).sort((a,b)=>a[0]-b[0]);
        let left=0;
        for(const [right,end] of [...breaks,[len,len]]){
          if(right-left>.16){
            const low=u=>(f.grade?.(u)??base)-.09;
            const crest=u=>(f.grade?.(u)??base)+plinth.height;
            face([f.at(left,low(left),toe),f.at(right,low(right),toe),f.at(right,crest(right)-.045,reach),f.at(left,crest(left)-.045,reach)],m,null,[f.nx,.1,f.nz]);
            face([f.at(left,crest(left)-.045,reach),f.at(right,crest(right)-.045,reach),f.at(right,crest(right)),f.at(left,crest(left))],m,null,[0,1,0]);
            for(const u of [left,right])face([f.at(u,low(u)),f.at(u,low(u),toe),f.at(u,crest(u)-.045,reach),f.at(u,crest(u))],m);
          }
          left=Math.max(left,end);
        }
      }
    }
    const continuous=sections.filter(t=>['glass-curtain','glazing'].includes(palette[t.mat].kind)).map(t=>[t.l,t.r,t.bot,t.top]);
    const storey=j=>merge(profile,j===0?profile.groundFloor:null,j===count-1?profile.topFloor:null,profile.floorOverrides?.[j]);
    for(let j=0;j<count;j++){
      if(contacts && ends[j]>contacts.ceiling)break;
      const startFloor=j,pf=storey(j);
      if(j===0 && part.openSoffit){
        const next=part.openSoffit,frameMat=material(pf.material??'wall'),postCount=Math.max(1,Math.round(len/(pf.bays?.width??7)));
        if(next>base+.35){
          const vehicleDoors=entries.filter(e=>e.type==='garage'||e.type==='loading-dock').map(e=>[clamp(project(e)-(e.width??4)/2,0,len),clamp(project(e)+(e.width??4)/2,0,len)]).sort((a,c)=>a[0]-c[0]);
          for(let k=0;k<postCount;k++){
            const u=len*(k+.04)/postCount;
            if(vehicleDoors.some(([l,r])=>u>l && u<r))continue;
            f.box(u,(base+next)/2,-.31,.53,next-base,.58,frameMat,true,true);
          }
          f.box(len/2,next-.14,-.14,len,.28,.32,frameMat);
          let left=0;
          for(const [l,r] of [...vehicleDoors,[len,len]]){
            if(l-left>.04){
              const g0=f.grade?.(left)??base,g1=f.grade?.(l)??base;
              const toe=Math.min(g0,g1)-.10,head=Math.max(g0,g1)+.22;
              f.box((l+left)/2,(head+toe)/2,-.11,l-left,head-toe,.20,frameMat,true);
              beam(f.at(left,g0+.82,-.13),f.at(l,g1+.82,-.13),.065,material('frame'));
            }
            left=Math.max(left,r);
          }
        }
        continue;
      }
      const wm=material(pf.material??part.material??'wall',pf.blank?{plainElevation:true}:undefined),win=pf.windows??{},typ=win.type??'punched';
      const floor=ends[j],fh=ends[j+1]-floor;
      const span=win.spanFloors??(win.type==='curtain-wall'?count:win.splay && j>0?2:Math.max(1,Math.ceil(((win.height??0)+(win.sill??0))/(fh+.17))));
      while(j+1<count && j+1-startFloor<span){
        const next=storey(j+1);
        const reserved=win.height>ends[startFloor+1]-floor && ['round-arch','lancet','tudor-arch'].includes(typ) && next.windows?.type==='none';
        if(!reserved && (next.blank || (next.windows?.type??'punched')!==typ))break;
        j++;
      }
      const multi=j>startFloor,ceiling=ends[j+1],height=ceiling-floor;
      if(height<.03)continue;
      const windows=[];
      if(!pf.blank && typ!=='none' && len>1.3 && height>1 && (level>0||len>3)){
        const curtain=['ribbon','curtain-wall','storefront'].includes(typ);
        const group=clamp(win.perBay??bays.groupSize??(bays.pattern==='paired'?2:1),0,12);
        const gap=clamp(win.spacing??bays.groupGap??.18,.02,pitch*.4);
        const gw=Math.min(win.width??(curtain?pitch:1.5),Math.max(.18,(pitch-(group-1)*gap-.12)/Math.max(1,group)));
        const width=curtain && group===1?Math.max(.19,pitch-.12):gw;
        const sill=clamp(win.sill??(typ==='clerestory'?height*.62:curtain?.15:.82),.01,height*.82);
        const h=clamp(multi && curtain?height-sill-.12:win.height??(curtain?height-sill-.12:height*.54),.1,height-sill-.025);
        const trimMat=material(win.surroundMaterial??(win.surround==='brick-soldier'?'wall':'trim'));
        if(multi)win.mullions={...win.mullions,horizontal:(win.mullions?.horizontal??0)+(j-startFloor)};
        const glass=material('frame',{opacity:near?(win.opacity??(win.glass==='reflective'?.88:win.glass==='dark'?.92:.76)):1,kind:'glazing',color:win.glassColor??({dark:'#34474d',reflective:'#819aa8',frosted:'#b4c2c5',leaded:'#61747b'}[win.glass]??'#597481'),frameColor:win.frameColor??s.materials.frame?.color??'#a5a098',vertical:win.mullions?.vertical??(typ==='glass-block'?4:1),horizontal:(win.mullions?.horizontal??(typ==='glass-block'?4:0))+(win.transom?1:0),line:clamp((win.mullions?.width??.06)/width,.007,.12),glass:win.glass??'clear',tracery:win.tracery,roughness:win.glass==='frosted'?.55:.20,metalness:.33});
        for(let k=0;k<n;k++)for(let g=0;g<group;g++){
          const jitter=bays.pattern==='irregular'?.12*pitch*Math.sin(k*27.1):0;
          const u=margin+(k+.5)*pitch+(g-(group-1)/2)*(width+gap)+jitter;
          if(u-width/2<=0 || u+width/2>=len)continue;
          if(sections.some(t=>u+width/2>t.l && u-width/2<t.r && floor+sill+h>t.bot && floor+sill<t.top))continue;
          const windowBottom=part.low===0 && f.grade?Math.max(floor+sill,f.grade(u)+.16):floor+sill;
          if(floor+sill+h-windowBottom<.49)continue;
          const projected=typ==='oriel'||typ==='bay-window'||(win.projectEvery && k%win.projectEvery===0);
          windows.push({u,width,bay:k,slotL:margin+k*pitch+g*pitch/group,slotR:margin+k*pitch+(g+1)*pitch/group,projection:projected?(win.projection??.55):0,sill:windowBottom,height:floor+sill+h-windowBottom,type:typ,depth:win.recess??.19,glass,trim:trimMat,reveal:material(win.surroundMaterial??pf.material??'wall',{reveal:true}),frameWidth:.085,win});

        }
      }
      if(typ==='ribbon' && !sections.length && !entries.length && windows.length>1 && !pf.bayMaterials?.length && !win.projectEvery && !win.rake){
        const first=windows[0],last=windows.at(-1),left=first.u-first.width/2,right=last.u+last.width/2;
        const lights=windows.length*((win.mullions?.vertical??1)+1)-1;
        const finish=palette[first.glass];
        windows.splice(0,windows.length,{...first,u:(left+right)/2,width:right-left,glass:material('frame',{...finish,vertical:lights,line:(win.mullions?.width??.06)/(right-left)}),win:{...win,mullions:{...win.mullions,vertical:lights}}});
      }
      for(const e of entries){
        const y=(b.entryGround?.[e.entryId]??base)+(e.steps??0)*.155+.035;
        if(y>=ceiling || y+(e.height??2.7)<=floor)continue;
        const width=Math.min(e.width??2.3,len-.06),u=clamp(project(e),width/2+.015,len-width/2-.015);
        for(let i=windows.length-1;i>=0;i--){
          const window=windows[i],left=window.u-window.width/2,right=window.u+window.width/2;
          if(right<=u-width/2-.11 || left>=u+width/2+.11)continue;
          if(window.cutOnly)continue;
          const a=window.slotL,c=window.slotR;
          const spans=[[a,u-width/2-.16],[u+width/2+.16,c]].filter(([l,r])=>r-l>=.57);
          windows.splice(i,1,...spans.map(([l,r])=>({...window,slotL:l,slotR:r,u:(l+r)/2,width:Math.min(window.width,r-l)})));
        }
        const dType=e.type??'doors-double';
        windows.push({u,width,sill:Math.max(j===0?lo:floor,y),height:Math.max(.01,Math.min(ceiling,y+(e.height??2.7))-Math.max(startFloor===0?lo:floor,y)),type:'punched',cutOnly:true,doorType:dType,fanlight:e.fanlight??(dType==='doors-single' && s.style==='residential-brick'),sidelights:e.sidelights,depth:e.recess??.28,glass:material('frame',{kind:'door',opaqueLeaf:dType==='doors-single',doorSlats:['garage','loading-dock'].includes(dType),unitSize:[1,e.doorSlatHeight??(dType==='garage'?.245:.115)],color:e.doorColor??s.materials[e.material??'door']?.color??(dType.includes('portal')?'#594437':'#50636a'),vertical:['doors-single','garage','loading-dock'].includes(dType)?0:1,horizontal:['garage','loading-dock'].includes(dType)?0:1,frameColor:'#9c9486',line:.035}),trim:material(e.surround??'trim'),frameWidth:.11,win:{hoodMould:dType.includes('portal'),surround:'stone'}});
      }
      if(medium)for(const w of windows){
        if(multi || w.cutOnly)continuous.push([w.u-w.width/2-.035,w.u+w.width/2+.035,w.sill,w.sill+w.height]);
      }
      windows.sort((a,b)=>a.u-b.u);
      const bot=startFloor===0 && entries.length?lo:floor;
      if(!windows.length){if(near || wm!==wall)f.rect(0,bot,len,ceiling,wm,near?0:.007);continue;}
      for(let i=0;i<windows.length;i++){
        const w=windows[i],l=i?(windows[i-1].u+windows[i-1].width/2+w.u-w.width/2)/2:0;
        const r=i===windows.length-1?len:(w.u+w.width/2+windows[i+1].u-windows[i+1].width/2)/2;
        if(!near && wm!==wall)f.rect(l,bot,r,ceiling,wm,.007);
        const accents=pf.bayMaterials??[],cladding=accents.length && w.bay!==undefined?material(accents[w.bay%accents.length]):wm;
        opening(f,{l,r,bot,top:ceiling},w,cladding);
        const stack=pf.verticalSpandrels;
        if(stack && w.bay!==undefined && w.bay%(stack.every??1)===0){
          const half=Math.min(stack.width??w.width,r-l)*.5,spandrel=material(stack.material);
          f.rect(w.u-half,Math.max(start,bot),w.u+half,w.sill,spandrel,.018);
          f.rect(w.u-half,w.sill+w.height,w.u+half,ceiling,spandrel,.018);
        }
        if(pf.spandrelMaterial && w.bay!==undefined)f.rect(w.u-w.width/2,bot,w.u+w.width/2,w.sill,material(pf.spandrelMaterial),.025);
        if(w.cutOnly){
          const e=entries.find(e=>Math.abs(project(e)-w.u)<=(e.width??2.3)/2);
          if(e){
            const sy=(b.entryGround?.[e.entryId]??base)+(e.steps??0)*.155+.035,h=e.height??2.7;
            if(sy<ceiling && (sy>=floor||startFloor===0)){
              const entire={...w,sill:sy,height:h,type:w.doorType,cutOnly:false};
              opening(f,{l:w.u-w.width/2,r:w.u+w.width/2,bot:sy,top:sy+h},entire,wm);
              if(near && (w.fanlight || w.sidelights)){
                const glass=material('#788e92',{kind:'glazing',opacity:.90,vertical:0,horizontal:0,line:.026}),d=-Math.min(w.depth,wallDepth(f,w.u-w.width/2,w.u+w.width/2)*.80)+.035;
                if(w.fanlight){
                  const width=Math.min(1.2,w.width*.78),sill=sy+h*.70;
                  f.rect(w.u-width/2,sill,w.u+width/2,sy+h-.11,glass,d);
                  f.box(w.u,sill,d+.018,width+.05,.045,.038,trim);
                }
                if(w.sidelights)for(const sign of [-1,1]){
                  const u=w.u+sign*w.width*.37;
                  f.rect(u-w.width*.075,sy+.19,u+w.width*.075,sy+h-.13,glass,d);
                  f.box(u-sign*w.width*.075,sy+h/2,d+.018,.055,h-.22,.04,trim);
                }
              }
            }
          }
        }
      }
      const balconies=pf.balconies;
      if(medium && balconies && (balconies.floors??[]).includes(startFloor))for(let k=0;k<n;k+=balconies.bayPattern?1:Math.max(1,balconies.every??1)){
        if(balconies.bayPattern && !balconies.bayPattern[k%balconies.bayPattern.length])continue;
        const u=margin+(k+.5)*pitch,d=balconies.depth??1.3,deckWidth=Math.min(balconies.width??pitch*.84,pitch-.04);
        const deckMat=material(balconies.deckMaterial??'trim'),edgeMat=material(balconies.edgeMaterial??balconies.deckMaterial??'trim'),capMat=material(balconies.capMaterial??balconies.railMaterial??'trim');
        f.box(u,floor+.08,d/2,deckWidth,.19,d,deckMat);
        if(balconies.edgeMaterial)f.box(u,floor+.08,d+.014,deckWidth,.19,.028,edgeMat);
        f.box(u,floor+.89,d-.05,deckWidth,.062,.084,capMat);
        const solidH=balconies.frontHeight??(balconies.endPanels && balconies.infill==='solid'?1.27:.83);
        if(balconies.rail==='solid'||balconies.infill==='solid')f.box(u,floor+.13+solidH/2,d-.075,deckWidth,solidH,.16,material(balconies.material??'trim'));
        if(balconies.infill==='lower-panel'||balconies.infill==='alternating'){
          const n=balconies.infill==='alternating'?4:1;
          for(let j=0;j<n;j+=2)f.box(u+((j+.5)/n-.5)*(deckWidth-.04),floor+.41,d-.075,(deckWidth-.04)/n,.57,.085,material(balconies.panelMaterial??'rail'));
        }
        if(balconies.divider)f.box(u,floor+.65,d/2,.095,1.12,d,trim);
        if(balconies.rail==='glass')f.box(u,floor+.51,d-.075,(deckWidth-.04),.83,.055,material('#8fadb5',{kind:'glass-curtain',opacity:.38}));
        if(balconies.rail==='metal')for(const h of near?[.32,.58]:[.48])f.box(u,floor+h,d-.06,deckWidth,.04,.04,capMat);
        if(balconies.endPanels)for(const side of [-1,1])f.box(u+side*(deckWidth-.12)/2,floor+.13+solidH/2,d/2,.12,solidH,d,material(balconies.panelMaterial??balconies.material??'trim'));
        if(near && balconies.rail!=='solid')for(let t=-2;t<=2;t++)f.box(u+t*deckWidth*.215,floor+.5,d-.05,.045,.85,.045,trim);
      }
    }
    if(!medium)return;
    const freeEdge=!f.joinedRoof;
    const corn=freeEdge && !part.roof.suspension?profile.cornice:null,par=freeEdge?(profile.parapet??(part.roof.edge==='parapet'?{height:.35,type:'coped'}:null)):null;
    if(corn && (corn.height??.22)>.01 && (corn.depth??.14)>.01){
      const height=corn.height??.22,reach=corn.depth??.14,foot=top-height,m=material(corn.material??'trim');
      molding(f,0,len,[[foot,-.035],[foot,reach*.58],[foot+height*.28,reach*.64],[foot+height*.62,reach],[top,reach],[top,-.035]],m,material(corn.soffitMaterial??corn.material??'trim'));
    }
    if(par){
      const h=par.height??.6,m=material(par.material??'wall'),cren=par.type==='crenellated';
      if(par.type==='pierced'){
        const n=Math.max(1,Math.round(len/.92));
        for(const y of [top+.08,top+h-.08])f.box(len/2,y,-.08,len,.16,.28,m);
        for(let j=0;j<n;j++)f.box((j+.5)*len/n,top+h/2,-.08,.22,h,.26,m);
      }else if(par.type==='stepped'){
        const n=Math.max(1,Math.round(len/(par.spacing??6)));
        for(let j=0;j<n;j++){const rise=h*(j%2?.65:1);f.box((j+.5)*len/n,top+rise/2,-.08,len/n,rise,.28,m);}
      }else if(par.type==='glass-rail'||par.type==='metal-rail'){
        if(par.type==='glass-rail')f.rect(0,top,len,top+h,material('#9fb6bd',{kind:'glass-curtain',opacity:.4}),-.08);
        f.box(len/2,top+h,-.08,len,.065,.07,trim);
        if(par.type==='metal-rail')f.box(len/2,top+h*.48,-.08,len,.045,.06,trim);
        const count=Math.max(1,Math.ceil(len/1.8));
        for(let k=0;k<count;k++)f.box(k*len/count,top+h*.5,-.08,.055,h,.055,trim);
      }else if(h>.005)f.box(len/2,top+h*(cren?.25:.5),-.08,len,h*(cren?.5:1),.27,m);
      if(h>.005 && par.type==='coped'){
        const y=top+h,cap=material(par.copingMaterial??'trim');
        molding(f,0,len,[[y-.028,-.245],[y+.045,-.245],[y+.102,.125],[y-.040,.125],[y-.040,.083],[y-.014,.068]],cap);
      }
      if(cren){const num=Math.max(1,Math.round(len/1.55));for(let k=0;k<num;k++)f.box((k+.5)*len/num,top+h*.72,-.08,len/num*.48,h*.56,.30,m);}
    }
    for(const band of profile.bands??[]){
      const ys=Array.isArray(band.at)?band.at.map(y=>ground+y):ends.slice(0,-1).map((floor,j)=>floor+(band.at==='sill-lines'?.8:band.at==='head-lines'?(ends[j+1]-floor)*.78:0));
      for(const y of ys)if(y>base+.02 && y<top){
        const gaps=continuous.filter(g=>y>g[2]-.02 && y<g[3]+.02).sort((a,c)=>a[0]-c[0]);
        let left=0;
        for(const [a,c] of [...gaps,[len,len]]){
          if(a>left+.025)f.box((left+a)/2,y,.035,a-left,band.height??.14,Math.max(.04,(band.depth??.07)*2),material(band.material??'trim'));
          left=Math.max(left,c);
        }
      }
    }
    const rhythm=profile.piers;
    for(const [member,buttress] of [[rhythm,false],[profile.buttresses,true]]){
      if(!member || member.every===0)continue;
      const w=member.width??.43,d=member.depth??.25,m=material(member.material??'wall');
      const endPiers=!buttress && (member.endPiers??(profile.blank && n>1 && w>.19));
      const slots=[];
      for(let i=1;i<n;i+=Math.max(1,member.every??1))slots.push(margin+i*pitch);
      if(endPiers && len>w*2)slots.push(w/2,len-w/2);
      for(const u of slots){
        const extension=member.aboveRoof??0;
        const shortButtress=buttress && member.stepped && member.fullHeight===false;
        const h=member.height??(shortButtress?Math.min((top-base)*.72,(ends[1]-base)*1.62):((top-base)*(member.fullHeight===false?.76:1)+extension+(extension>0?(par?.height??0):0)));
        const sawtooth=!buttress && (member.profile==='sawtooth' || (member.profile===undefined && profile.windows?.type==='slot' && d>=.65 && s.materials[member.material]?.kind==='precast-panel'));
        if(sawtooth){
          const side=member.hand==='left'?-1:1,span=Math.min(pitch-.09,Math.max(w,pitch*.74)),lip=u+side*span/2;
          for(const y of [base,base+h])face([f.at(lip-side*span,y),f.at(lip,y,d),f.at(lip,y)],m);
          face([f.at(lip-side*span,base),f.at(lip,base,d),f.at(lip,base+h,d),f.at(lip-side*span,base+h)],m);
          const slot=material('frame',{kind:'glazing',color:profile.windows.glassColor??'#50616a',vertical:0,horizontal:Math.max(0,count-1)});
          face([f.at(lip,base+.08),f.at(lip,base+.08,d),f.at(lip,base+h,d),f.at(lip,base+h)],slot,[[0,0],[1,0],[1,1],[0,1]]);
        }else f.box(u,base+h/2,d*.45,w,h,d,m);
        if(buttress && member.pinnacles){
          const [px,,pz]=f.at(u,top,d*.38);
          frustum(px,pz,w*.93,d*.9,top,top+.72,w*.93,d*.9,4,f.angle,m);
          crown(px,pz,w*1.08,d*1.08,top+.72,1.05,f.angle,'pyramid',trim);
        }
        if(buttress && member.stepped)for(let k=1;k<=2;k++){
          const head=base+h/(k+1),out=d*(.94+k*.46),back=out-d*.47,half=w*(1+.08*k)/2;
          f.box(u,(base+head)/2,(back+out)/2,half*2,head-base,out-back,m);
          const weathering=[[u-half,head, out],[u+half,head,out],[u+half,head+.29,back],[u-half,head+.29,back]];
          face(weathering.map(v=>f.at(...v)),trim,null,[f.nx,.8,f.nz]);
        }
        if(member.cap==='gabled' || shortButtress && member.cap===undefined){
          const y=base+h,end=d+.095,half=w*.5+.075,ridge=y+Math.max(.46,w*.72);
          f.surface([[u-half,y],[u+half,y],[u,ridge]],trim,end);
          for(const side of [-1,1])face([f.at(u+side*half,y,-.03),f.at(u+side*half,y,end),f.at(u,ridge,end),f.at(u,ridge,-.03)],trim,null,[0,1,0]);
        }
      }
    }
    if(near && profile.quoins)for(let y=base+.32;y<top;y+=.65)f.box(.32,y,.02,.64,.31,.11,trim);
    if(profile.gables){
      const num=clamp(profile.gables.count??1,1,20),pw=len/num,m=wall;
      for(let i=0;i<num;i++){
        const x=(i+.5)*pw;
        const rise=part.roof.rise??0,backed=profile.gables.type==='parapet' && ['gable','gambrel'].includes(part.roof.form);
        const h=backed?rise+.20:Math.min(profile.gables.height??2.2,pw*.8,(top-base)*.54);
        if(profile.gables.type==='stepped'||profile.gables.type==='dutch')for(let k=0;k<4;k++)f.box(x,top+h*(k+.5)/4,-.11,pw*(1-k*.24),h/4,.3,m);
        else{
          const shape=[[x-pw/2,top],[x+pw/2,top],[x,top+h]],outer=.095,inner=-.21;
          f.surface(shape,m,outer);f.surface(shape.toReversed(),m,inner);
          for(let j=1;j<3;j++){
            const l=shape[j],r=shape[(j+1)%3];
            face([f.at(...l,outer),f.at(...r,outer),f.at(...r,inner),f.at(...l,inner)],trim,null,[0,1,0]);
          }
        }
      }
    }
  }
  function crown(x,z,w,d,lo,h,theta,type,m){
    if(['cupola','dome','lantern'].includes(type)){
      const n=type==='dome'?16:8;
      frustum(x,z,w,d,lo,lo+h*.29,w*.89,d*.89,n,theta,m);
      for(let i=0;i<6;i++){
        const size=t=>Math.max(.015,Math.cos(t*Math.PI/2)*.89);
        frustum(x,z,w*size(i/6),d*size(i/6),lo+h*(.29+.71*Math.sin(i/6*Math.PI/2)),lo+h*(.29+.71*Math.sin((i+1)/6*Math.PI/2)),w*size((i+1)/6),d*size((i+1)/6),n,theta,m);
      }
    }else if(type==='spire'){
      const oct=8;
      frustum(x,z,w,d,lo,lo+h*.30,w*.83,d*.83,oct,theta,m);
      frustum(x,z,w*.86,d*.86,lo+h*.30,lo+h*.39,w*.73,d*.73,oct,theta,m);
      frustum(x,z,w*.73,d*.73,lo+h*.39,lo+h*.95,w*.052,d*.052,oct,theta,m);
      frustum(x,z,w*.052,d*.052,lo+h*.95,lo+h,.018,.018,oct,theta,material('#8c8170'));
    }else frustum(x,z,w,d,lo,lo+h,.02,.02,4,theta,m);
  }
  function beam(a,b,width,mat,collides=false){
    const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],len=Math.hypot(dx,dy,dz);
    if(len<.01)return;
    const span=Math.hypot(dx,dz);
    const u=span>.001?[-dz/span,0,dx/span]:[1,0,0],v=[dy*u[2]/len,(dz*u[0]-dx*u[2])/len,-dy*u[0]/len];
    const ring=p=>[[1,1],[-1,1],[-1,-1],[1,-1]].map(([i,j])=>p.map((val,k)=>val+(u[k]*i+v[k]*j)*width*.5));
    const aa=ring(a),bb=ring(b);
    if(collides && collisionOnly && span>.001){
      const end=width*.5*Math.abs(dy)/len;
      const along=[dx/span,dz/span],across=[u[0]*width/2,u[2]*width/2];
      const loop=[[a,-1,-1],[a,-1,1],[b,1,1],[b,1,-1]].map(([p,j,k])=>[p[0]+along[0]*end*j+across[0]*k,p[2]+along[1]*end*j+across[1]*k]);
      const levels=[...aa,...bb].map(v=>v[1]);
      solid([loop],Math.min(...levels),Math.max(...levels));
    }
    for(let i=0;i<4;i++)face([aa[i],aa[(i+1)%4],bb[(i+1)%4],bb[i]],mat);
  }
  function suspension(roof){
    for(const mast of roof.suspension?.masts??[]){
      const [x,z]=mast.center,y=ground+mast.headAboveGround,deck=Math.max(...b.parts.map(p=>roofAt(p,x,z)));
      if(!Number.isFinite(deck))continue;
      const steel=material('mast');
      frustum(x,z,1.02,1.02,deck-.12,y,.38,.38,12,0,steel);
      for(const [ax,az] of mast.anchors){
        let seat=Math.max(...b.parts.map(p=>roofAt(p,ax,az)));
        if(!Number.isFinite(seat))seat=ground+b.parts[0].high;
        const distance=Math.hypot(ax-x,az-z),diameter=mast.cableDiameter??roof.suspension.cableDiameter??.095;
        const count=near && distance>22?(mast.bundleCount??2):1,steelCable=material(roof.suspension.cableMaterial??'#60665f');
        for(let n=0;n<count;n++){
          const delta=(n-(count-1)/2)*diameter*1.85,nx=-(az-z)/Math.max(.01,distance),nz=(ax-x)/Math.max(.01,distance);
          beam([x+delta*nx,y-.14,z+delta*nz],[ax+delta*nx,seat+.16,az+delta*nz],count>1?diameter*.72:diameter,steelCable);
        }
        const saddle=roof.suspension.saddleSize??[.45,.57,.28];
        const rot=Math.atan2(az-z,ax-x);
        block(ax,seat+saddle[2]/2,az,saddle[0],saddle[2],saddle[1],rot,steel);
        if(near){
          block(ax,seat+.035,az,saddle[0]+.22,.070,saddle[1]+.20,rot,material('#888278'));
          const at=(d,h)=>[ax-d*Math.cos(rot),seat+h,az-d*Math.sin(rot)];
          beam(at(.02,.12),at(.39,.48),.18,steelCable);
        }
      }
    }
  }
  function suspensionTies(layout){
    for(const tie of layout?.ties??[]){
      let previous;
      for(const [x,z] of tie){
        const y=Math.max(...b.parts.map(p=>roofAt(p,x,z)));
        if(Number.isFinite(y)){
          const point=[x,y+.40,z];
          if(previous)beam(previous,point,.12,material('#5f615b'));
          previous=point;
        }
      }
    }
  }
  function tower(t){
    const [x,z]=t.at,[w,d=w]=t.size,angle=(t.rotation??0)*Math.PI/180,top=ground+t.height-(t.piercedParapet?.height??0);
    const m=material(t.material??'wall'),trim=material('trim'),n=t.plan==='round'?(medium?24:10):t.plan==='octagon'?8:4;
    const stack=n>=8 && /stack|flue|chimney/i.test(t.name??'');
    const ratio=stack?clamp(t.topDiameter?t.topDiameter/w:/taper|brick/i.test(t.name)?.64:.93,.25,1):1;
    const patterned=(!stack && (t.belfry || t.windows && t.windows.type!=='none'));
    const bottom=Math.min(ground-.5,b.foundation??ground-4);
    const shaft=frustum(x,z,w,d,bottom,top,w*ratio,d*ratio,n,angle,m,!near||!patterned);
    if(stack){
      for(let j=1;j<10;j+=/brick/i.test(t.name)?4:2)frustum(x,z,w*(1+(ratio-1)*j/10)+.11,d*(1+(ratio-1)*j/10)+.11,ground+t.height*j/10,ground+t.height*j/10+.12,w*(1+(ratio-1)*j/10)+.11,d*(1+(ratio-1)*j/10)+.11,n,angle,m);
      frustum(x,z,w*ratio*.79,d*ratio*.79,top+.005,top+.018,w*ratio*.79,d*ratio*.79,n,angle,material('#373935'));
      solid([shaft],bottom,top);return;
    }
    solid([shaft],bottom,top);
    const topType=t.top?.type??'flat',h=t.top?.height??2;
    const faces=t.clockFaces,clocks=Array.isArray(faces)?faces.length:faces??0;
    for(let i=0;i<n;i++){
      const f=frame(shaft[i],shaft[(i+1)%n]),u=f.len/2,bell=top-(clocks?10:7);
      for(const y of (!medium?[.98]:t.windows?.topStage?[.59,.78,.98]:[.24,.59,.84,.98]))f.box(u,ground+y*(top-ground),.065,f.len+.25,.25,.28,trim);
      if(t.buttresses){
        const [px,,pz]=f.at(.14,ground,.10);
        block(px,ground+t.height*.5,pz,.95,t.height+1,.95,angle,m,true);
        block(px,ground+t.height*.27,pz,1.45,t.height*.54,1.45,angle,m,true);
      }
      if(!collisionOnly && patterned){
        let shelf=bottom;
        const win=t.windows??{};
        if(!win.topStage && win.type && win.type!=='none')for(const fraction of [.26,.38,.50]){
          const y=ground+t.height*fraction,available=(t.belfry?bell:top)-y;
          const height=Math.min(win.height??2.4,t.height*.11,available-.1);
          if(height<=.15)continue;
          const width=Math.min(f.len*.55,win.width??1.15),glass=material('frame',{kind:'glazing',color:win.glassColor??'#53636b',opacity:near?.77:1});
          const normal=b.walls[t.oriel?.wall]?.normal;
          const projection=normal && fraction===.26 && f.nx*normal[0]+f.nz*normal[1]>.7?t.oriel.projection:0;
          opening(f,{l:0,r:f.len,bot:shelf,top:y+height+.04},{u,width,sill:y,height,projection,type:win.type,depth:win.recess??.36,glass,trim,frameWidth:.10,win},m);
          shelf=y+height+.04;
        }
        if(t.belfry){
          const single=win.perBay===1 && !win.topStage && win.width>f.len*.32;
          const ww=Math.min(f.len*(single?.84:.44),single||win.topStage?(win.width??1.4):f.len*.22),hh=Math.min(win.height??4.1,top-bell-.18);
          for(const sign of single?[0]:[-1,1]){
            const center=u+sign*f.len*.19;
            const glazed=t.belfryInfill==='glazed' || t.belfryInfill!=='louvres' && Boolean(win.glass);
            const infill=glazed?material('frame',{kind:'glazing',color:win.glassColor??'#687879',glass:win.glass,opacity:near?.84:1,vertical:win.mullions?.vertical??1,horizontal:win.mullions?.horizontal??1,tracery:win.tracery??true}):material('#373b38',{kind:'perforated-mesh',opacity:.18});
            opening(f,{l:single||sign<0?0:u,r:single||sign>0?f.len:u,bot:shelf,top},{u:center,width:ww,sill:bell,height:hh,type:win.type==='none'?'lancet':win.type??'lancet',depth:.68,glass:infill,trim,frameWidth:.12,win:{...win,surround:'stone',mullions:{vertical:single?(win.mullions?.vertical??2):win.topStage?1:0,horizontal:0},tracery:!!(win.topStage||win.tracery)}},m);
            if(!glazed)for(let k=1;k<=6;k++)f.box(center,bell+k*hh/8,-.35,ww*.78,.095,.16,material('#4c504a'));
          }
        }else if(near)f.rect(0,shelf,f.len,top,m);
      }
      const compass=['north','northeast','east','southeast','south','southwest','west','northwest'];
      const bearing=(Math.round(Math.atan2(f.nx,-f.nz)*4/Math.PI)+8)%8;
      if(Array.isArray(faces)?faces.some(v=>v.toLowerCase()===compass[bearing]||v.toLowerCase()===compass[bearing].replace(/north|south|east|west/g,k=>k[0])):i<clocks){
        const y=top-4.8,r=Math.min(w*.19,1.55);
        const sides=medium?32:12;
        const disk=(radius,depth,mat)=>f.surface(Array.from({length:sides},(_,k)=>[u+radius*Math.cos(k*2*Math.PI/sides),y+radius*Math.sin(k*2*Math.PI/sides)]),mat,depth);
        disk(r+.19,.14,material('#4a4940'));disk(r,.15,material('#e2dcca'));
        for(let k=0;k<12 && medium;k++){
          const a=k*Math.PI/6,dx=Math.cos(a),dy=Math.sin(a);
          f.surface([[u+r*.86*dx-.045*dy,y+r*.86*dy+.045*dx],[u+r*.60*dx-.045*dy,y+r*.60*dy+.045*dx],[u+r*.60*dx+.045*dy,y+r*.60*dy-.045*dx],[u+r*.86*dx+.045*dy,y+r*.86*dy-.045*dx]],material('#3c403e'),.164);
        }
        f.surface([[u-.08,y-.07],[u+r*.53,y+r*.53],[u+.10,y+.05]],material('#262d2d'),.17);
        f.surface([[u-.09,y],[u-.57*r,y+.34*r],[u+.07,y+.09]],material('#262d2d'),.18);
      }
      if(t.piercedParapet){
        const h=t.piercedParapet.height,n=t.piercedParapet.openings,pitch=f.len/n;
        f.box(u,top+.09,-.08,f.len,.18,.36,m);
        f.box(u,top+h-.085,-.08,f.len+.08,.17,.42,trim);
        for(let k=0;k<=n;k++){
          const width=k===0||k===n?pitch*.19:pitch*.38,center=clamp(k*pitch,width/2,f.len-width/2);
          f.box(center,top+h/2,-.08,width,h,.32,m);
        }
      }
      if(topType==='battlements'){
        f.box(u,top+.25,.01,f.len,.55,.4,m);
        const cells=Math.max(2,Math.round(f.len/1.9));
        for(let j=0;j<cells;j++)f.box((j+.5)*f.len/cells,top+h*.54,.02,f.len/cells*.55,h,.42,m);
      }
    }
    if(t.cornerTurrets){
      const width=t.cornerTurrets.width,high=top+h+t.cornerTurrets.height;
      for(const [px,pz] of shaft){
        const ring=frustum(px,pz,width,width,top-1.6,high-.44,width,width,8,angle,m);
        for(let k=0;k<ring.length;k+=2){
          const side=frame(ring[k],ring[(k+1)%ring.length]);
          side.box(side.len/2,high-.22,-.08,side.len,.44,.22,trim);
        }
      }
    }
    if(topType==='spire' && t.top?.openwork && medium){
      const baseRadius=Math.min(w,d)*.40,apex=[x,top+h,z];
      const steel=material(t.top.material??'roof');
      for(let i=0;i<8;i++){
        const a=i*Math.PI/4+angle,b=a+Math.PI/4;
        const at=(r,phi)=>[x+baseRadius*(1-r)*Math.cos(phi),top+h*r,z+baseRadius*(1-r)*Math.sin(phi)];
        beam(at(0,a),apex,.085,steel);
        for(const r of [.18,.45,.70]){beam(at(r,a),at(r,b),.058,steel);beam(at(r,a),at(Math.min(.95,r+.25),b),.044,steel);}
      }
    }else if(!['battlements','flat'].includes(topType))crown(x,z,w*.73,d*.73,top,h,angle,topType,material(t.top?.material??'roof'));
    for(let i=0;i<(t.pinnacles??0);i++){
      const [px,pz]=shaft[Math.floor(i*n/t.pinnacles)%n];
      const ph=clocks?5.8:4.7;
      frustum(px,pz,1.2,1.2,top-.15,top+ph*.34,1.05,1.05,4,angle,trim);
      crown(px,pz,1.12,1.12,top+ph*.34,ph*.66,angle,'pyramid',trim);
    }
    if(t.top?.type==='dome' && /telescope|observatory/i.test(t.name??'')){
      const hh=t.top.height,ww=w*.73;
      for(let j=0;j<14;j++){
        const phi=j*Math.PI/7;
        let last;
        for(let k=0;k<=10;k++){
          const a=k*Math.PI/20,radius=ww*.454*Math.cos(a);
          const point=[x+radius*Math.cos(phi),top+hh*(.29+.71*Math.sin(a))+.035,z+radius*Math.sin(phi)];
          if(last)beam(last,point,j===0||j===7?.24:.044,trim);
          last=point;
        }
      }
    }
    if(t.flagpole)block(x,top+3.2,z,.09,6.4,.09,0,trim);
  }
  function curvedRoofNormals(vertices,index){
    const sums=vertices.map(()=>[0,0,0]);
    for(let i=0;i<index.length;i+=3){
      const ids=index.slice(i,i+3),[a,c,d]=ids.map(i=>vertices[i]);
      const ax=c[0]-a[0],ay=c[1]-a[1],az=c[2]-a[2],bx=d[0]-a[0],by=d[1]-a[1],bz=d[2]-a[2];
      const n=[ay*bz-az*by,az*bx-ax*bz,ax*by-ay*bx],orientation=n[1]<0?-1:1;
      for(const vi of ids)for(let j=0;j<3;j++)sums[vi][j]+=orientation*n[j];
    }
    return sums.map(n=>{const k=127/Math.max(.00001,Math.hypot(...n));return n.map(v=>Math.round(v*k));});
  }
  function mansardFinish(part){
    const roof=part.roof,edgeMaterials=[part.facade,...Object.values(part.wallProfiles??{})].map(p=>p?.parapet?.material??p?.cornice?.material);
    const perimeter=edgeMaterials.find(ref=>ref && /metal|copper/.test(s.materials[ref]?.kind??''));
    const finish=roof.skirtMaterial??perimeter??roof.material??'roof';
    return material(finish,{kind:'standing-seam-metal',unitSize:[.40,3],roofSurface:true});
  }
  function roofAt(part,x,z){
    const [vertices,idx]=part.surface;
    for(let i=0;i<idx.length;i+=3){
      const [a,c,d]=[vertices[idx[i]],vertices[idx[i+1]],vertices[idx[i+2]]];
      const ax=c[0]-a[0],az=c[2]-a[2],bx=d[0]-a[0],bz=d[2]-a[2],den=ax*bz-az*bx;
      if(Math.abs(den)<.00001)continue;
      const u=((x-a[0])*bz-(z-a[2])*bx)/den,v=(ax*(z-a[2])-az*(x-a[0]))/den;
      if(u>=-.0001&&v>=-.0001&&u+v<1.0001)return ground+part.high+a[1]+u*(c[1]-a[1])+v*(d[1]-a[1]);
    }
    return -Infinity;
  }
  function feature(row,owner){
    if(row.type==='antenna' && s.roof.suspension && row.style?.includes('mast'))return;
    const type=row.type;let theta=(row.rotation??0)*Math.PI/180,m=material(row.material??({skylight:'#7c9da4','solar-panels':'#344758','green-roof':'#6f814e',hvac:'#9ca5a2',chimney:'wall'}[type]??'roof'));
    const sizes={chimney:[.85,.85,2.45],hvac:[2.1,1.5,1.1],antenna:[.075,.075,3.6],penthouse:[6.3,4.5,2.7],'stair-tower':[3,3,3.1],skylight:[2.3,1.6,.6],dormers:[2.2,2.1,1.35],'solar-panels':[2.3,1.25,.22],'green-roof':[4,4,.12]};
    const [w,d,h]=[...(row.size??sizes[type]??[2,2]),2];
    const hh=row.height??h;
    for(let i=0;i<Math.min(row.count??1,64);i++){
      const at=row.at??row.center??owner.center;
      let x=at[0]+(i%4)*(w+.6),z=at[1]+Math.floor(i/4)*(d+.7);
      if(row.walls!=null && !row.at && !row.center){
        const walls=b.walls.filter((_,id)=>matches(row.walls,id));
        if(walls.length){
          const wall=walls[i%walls.length],f=(.5+Math.floor(i/walls.length))/Math.max(1,Math.ceil((row.count??1)/walls.length));
          x=wall.a[0]+(wall.b[0]-wall.a[0])*f-wall.normal[0]*(d*.48+.1);
          z=wall.a[1]+(wall.b[1]-wall.a[1])*f-wall.normal[1]*(d*.48+.1);
          theta=Math.atan2(wall.b[1]-wall.a[1],wall.b[0]-wall.a[0]);
        }
      }
      const y=Math.max(...b.parts.map(p=>roofAt(p,x,z)));
      if(!Number.isFinite(y))continue;
      if(collisionOnly){
        if(['penthouse','stair-tower','hvac','chimney','dormers'].includes(type))block(x,y+hh/2,z,w,hh,d,theta,m,true);
        continue;
      }
      const style=(row.style??'').toLowerCase(),dark=material('#505854'),frameMat=material('frame');
      const c=Math.cos(theta),sn=Math.sin(theta),p=(u,h,v)=>[x+u*c-v*sn,y+h,z+u*sn+v*c];
      if(level===0 && ['hvac','chimney','skylight','solar-panels','penthouse','stair-tower','dormers','green-roof'].includes(type)){
        const sill=[p(-w/2,0,-d/2),p(w/2,0,-d/2),p(w/2,0,d/2),p(-w/2,0,d/2)];
        if(Math.max(w,d)<3.25 && hh<2.1 && !['penthouse','stair-tower'].includes(type)){
          const peak=p(0,hh,0);
          for(let k=0;k<4;k++)face([sill[k],sill[(k+1)%4],peak],m);
        }else{
          const cap=sill.map(([x,y,z])=>[x,y+hh,z]);
          face(cap,m,null,[0,1,0]);
          for(let k=0;k<4;k++)face([sill[k],sill[(k+1)%4],cap[(k+1)%4],cap[k]],m);
        }
        continue;
      }
      if(row.rotor){
        frustum(x,z,.11,.11,y,y+hh,.085,.085,8,0,m);
        for(let k=0;k<3;k++){
          const a=k*2*Math.PI/3,dx=Math.cos(a),dy=Math.sin(a),hub=y+hh;
          face([[x,hub,z+.11],[x+dx*.38-dy*.12,hub+dy*.38+dx*.12,z+.13],[x+dx*1.2,hub+dy*1.2,z+.2]],m);
        }
      }else if((type==='chimney' && /metal|stack|round|flue/.test(style)) || type==='hvac' && /exhaust|flue|vent (pipe|stack)/.test(style)){
        const r=Math.min(w,d),top=r*(/taper/.test(style)?.69:.89);
        frustum(x,z,r,r,y,y+hh,top,top,12,theta,m);
        frustum(x,z,top*1.13,top*1.13,y+hh-.11,y+hh+.035,top*1.13,top*1.13,12,theta,m);
        frustum(x,z,top*.78,top*.78,y+hh+.04,y+hh+.046,top*.78,top*.78,12,theta,dark);
      }else if(['cupola','lantern'].includes(type))crown(x,z,w,d,y,hh,theta,type,m);
      else if(type==='dormers'){
        block(x,y+.27*hh,z,w,hh*.67,d,theta,m);
        const c=Math.cos(theta),q=Math.sin(theta);
        const p=(u,h,v)=>[x+u*c-v*q,y+h,z+u*q+v*c];
        for(const side of [-1,1])face([p(-w*.55,hh*.60,side*d*.56),p(w*.55,hh*.60,side*d*.56),p(0,hh,side*d*.56)],m);
        for(const side of [-1,1])face([p(side*w*.55,hh*.60,-d*.56),p(0,hh,-d*.56),p(0,hh,d*.56),p(side*w*.55,hh*.60,d*.56)],material('roof'),null,[0,1,0]);
        const pane=material('glass',{kind:'glazing',opacity:.81,color:'#728b93',frameColor:s.materials.trim?.color??'#c6c4b2',vertical:/twin|paired/.test(style)?1:0,horizontal:1,line:.055});
        for(const side of [-1,1]){
          const front=v=>p(v[0],v[1],side*d*.515);
          face([[-w*.32,hh*.08],[w*.32,hh*.08],[w*.32,hh*.60],[-w*.32,hh*.60]].map(front),pane,[[0,0],[1,0],[1,1],[0,1]]);
        }
      }else if(type==='skylight' && /round|circular|oculus/.test(style)){
        frustum(x,z,w,d,y,y+hh*.42,w,d,24,theta,frameMat);
        const pane=material(row.material??'glass',{kind:'glass-curtain',opacity:.68,color:'#879e9f'});
        for(let j=0;j<4;j++){
          const a=j*Math.PI/8,b=(j+1)*Math.PI/8;
          frustum(x,z,w*Math.cos(a),d*Math.cos(a),y+hh*(.42+.58*Math.sin(a)),y+hh*(.42+.58*Math.sin(b)),Math.max(.015,w*Math.cos(b)),Math.max(.015,d*Math.cos(b)),16,theta,pane);
        }
      }else if(type==='hvac'){
        const long=Math.max(w,d),short=Math.min(w,d),rot=theta+(w<d?Math.PI/2:0);
        const at=(u,height,v)=>[x+u*Math.cos(rot)-v*Math.sin(rot),y+height,z+u*Math.sin(rot)+v*Math.cos(rot)];
        if(row.housing==='drain' || /drain|scupper|strainer/.test(style)){
          const collar=material(row.material??'roof',{kind:'painted-metal',roughness:.76});
          const cover=material(row.material??'roof',{kind:'painted-metal',surface:'drain-grate',roughness:.73});
          const lip=Math.min(.048,hh*.35);
          if(/round|circular|dome/.test(style)){
            frustum(x,z,w,d,y,y+hh-lip,w*.84,d*.84,12,rot,collar);
            frustum(x,z,w*.85,d*.85,y+hh-lip,y+hh,w*.71,d*.71,12,rot,cover);
          }else{
            block(...at(0,(hh-lip)/2,0),long,hh-lip,short,rot,collar);
            block(...at(0,hh-lip/2,0),long*.86,lip,short*.82,rot,cover);
          }
          continue;
        }
        const access=row.housing==='hatch'||/hatch|access cover/.test(style);
        const screen=row.housing==='screen'||/louvred|louvered|plant screen/.test(style);
        if(access){
          block(...at(0,hh*.33,0),long,hh*.66,short,rot,m);
          block(...at(0,hh*.79,0),long+.12,hh*.22,short+.12,rot,frameMat);
          block(...at(long*.34,hh*.94,0),.08,.08,short*.18,rot,dark);
          continue;
        }
        if(screen){
          const slats=material(row.material??'#96978d',{surface:'louvre',kind:'metal-panel',opacity:1});
          for(const side of [-1,1]){
            block(...at(0,hh/2,side*(short-.09)/2),long,hh,.09,rot,slats);
            block(...at(side*(long-.09)/2,hh/2,0),.09,hh,short-.18,rot,slats);
          }
          continue;
        }
        const duct=row.housing==='duct'||/duct/.test(style)||(!style && long>short*2.6 && long>4);
        const fan=row.fanGrid || row.housing==='fan' || /fan|condenser|cooling tower/.test(style);
        if(duct){
          block(...at(0,hh*.54,0),long,hh*.87,short,rot,m);
          const count=Math.max(1,Math.round(long/2.3));
          if(near)for(let j=0;j<=count;j++){
            const offset=(long-.08)*(j/count-.5);
            block(...at(offset,hh*.55,0),.062,hh*.93,short+.08,rot,frameMat);
          }
          continue;
        }
        const body=long,along=0;
        const sample=/^#[0-9a-f]{6}$/i.test(row.material)?[1,3,5].map(i=>parseInt(row.material.slice(i,i+2),16)):null;
        const shadedSample=style==='measured roof plant' && sample && Math.max(...sample)<102;
        const coating=shadedSample?'#929692':palette[m].color;
        const casing=material(row.material??'#a6aca7',{kind:'metal-panel',color:coating,roughness:.57});
        block(...at(along,hh*.535,0),body,hh*.89,short,rot,casing);
        if(medium){
          block(...at(0,hh*.06,0),body*.94,hh*.12,short*.91,rot,dark);
          block(...at(0,hh*.98,0),body+.06,Math.min(.075,hh*.07),short+.06,rot,casing);
        }
        if(medium){
          const vents=Math.max(2,Math.min(7,Math.round(body/.8)));
          for(let k=0;k<vents;k++)block(...at(along+body*((k+.5)/vents-.5),hh*.57,short*.503),body/vents*.74,hh*.36,.035,rot,material('#636864',{kind:'painted-metal',surface:'louvre',roughness:.61}));
          if(fan){
            const [n,cross]=row.fanGrid??[long>short*1.27||/paired|twin/.test(style)?2:1,1];
            const r=Math.min(short/cross*.71,long/n*.72);
            for(let k=0;k<n;k++)for(let j=0;j<cross;j++){
              const [fx,,fz]=at(long*((k+.5)/n-.5),hh,short*((j+.5)/cross-.5));
              frustum(fx,fz,r,r,y+hh,y+hh+.08,r,r,12,theta,dark);
              if(near && r>.75){
                frustum(fx,fz,r*.19,r*.19,y+hh+.08,y+hh+.15,r*.14,r*.14,8,theta,m);
                for(let blade=0;blade<5;blade++){
                  const a=theta+blade*Math.PI*.4;
                  face([[fx,y+hh+.102,fz],[fx+r*.41*Math.cos(a),y+hh+.103,fz+r*.41*Math.sin(a)],[fx+r*.32*Math.cos(a+.49),y+hh+.117,fz+r*.32*Math.sin(a+.49)]],frameMat,null,[0,1,0]);
                }
              }
            }
          }
        }
      }else if(['skylight','clerestory','solar-panels'].includes(type)){
        const frameFinish=material('frame'),panel=type==='solar-panels'?material('#344354',{kind:'spandrel-glass',roughness:.24}):material(row.material??'#99b2b7',{kind:'glass-curtain',opacity:.74});
        const ridge=type==='skylight'?0:d*.48,curb=Math.min(.25,hh*.35);
        const hipped=type==='skylight' && (Math.max(w,d)/Math.min(w,d)>1.75 || /linear|ridge|hip/.test(style));
        if(hipped){
          const along=Math.max(w,d),across=Math.min(w,d),end=along/2,r=Math.max(.05,end-Math.min(across*.55,end*.60)),low=curb+.022;
          const point=(u,h,v)=>w>=d?p(u,h,v):p(v,h,-u);
          block(x,y+curb*.5,z,w,curb,d,theta,frameFinish);
          for(const side of [-1,1]){
            const v=across*side/2;
            face([point(-end,low,v),point(end,low,v),point(r,hh,0),point(-r,hh,0)],panel,null,[0,1,0]);
            face([point(side*end,low,-across/2),point(side*end,low,across/2),point(side*r,hh,0)],panel,null,[0,1,0]);
            for(const k of [-1,1])beam(point(k*end,low,v),point(k*r,hh,0),.066,frameFinish);
            if(near){const n=Math.ceil(2*r/1.6);for(let j=0;j<=n;j++)beam(point(r*(2*j/n-1),low,v),point(r*(2*j/n-1),hh,0),.055,frameFinish);}
          }
          beam(point(-r,hh,0),point(r,hh,0),.085,frameFinish);
          continue;
        }
        block(x,y+curb*.5,z,w,curb,d,theta,frameFinish);
        for(const side of [-1,1]){
          const edge=d*.5*side,low=curb+.018;
          face([p(-w*.5,low,edge),p(w*.5,low,edge),p(w*.5,hh,ridge),p(-w*.5,hh,ridge)],panel,null,[0,1,0]);
          for(const end of [-1,1])face([p(end*w*.5,low,edge),p(end*w*.5,low,ridge),p(end*w*.5,hh,ridge)],m);
          if(near){
            const bays=Math.max(1,Math.round(w/1.25));
            for(let j=0;j<=bays;j++)beam(p(w*(j/bays-.5),low,edge),p(w*(j/bays-.5),hh,ridge),.055,frameFinish);
          }
        }
        beam(p(-w*.5,hh,ridge),p(w*.5,hh,ridge),.09,frameFinish);
      }else{
        const equipment=type==='penthouse' || type==='stair-tower';
        const siding=equipment && !/press box/.test(style)?material(row.material??'roof',{kind:palette[m].kind==='membrane'?'metal-panel':palette[m].kind,surface:/louv|vent/i.test(style)?'louvre':palette[m].surface}):m;
        block(x,y+hh/2,z,w,hh,d,theta,siding);
        if(equipment && medium){
          const flashing=material(row.material??'roof',{kind:'painted-metal',roughness:.56});
          block(x,y+hh+.046,z,w+.09,.095,d+.09,theta,flashing);
          if(near && hh>1.9 && w>2.4){
            const leafWidth=Math.min(1.1,w*.31),t=theta;
            block(...p(-w*.17,Math.min(1.04,hh*.37),d*.5+.02),leafWidth,Math.min(2.08,hh*.74),.04,t,material('#81847d'));
            block(...p(-w*.17+leafWidth*.32,.93,d*.5+.065),.14,.036,.065,t,frameMat);
          }
        }
        if(/press box/.test(row.style??'')){
          const wall=b.walls[s.seating?.fieldFacingWall],front=wall?Math.sign(wall.normal[0]*c+wall.normal[1]*sn):1;
          const width=d*.92,n=Math.max(3,Math.round(width/1.55)),v=front*(w*.5+.025);
          const finish=material('glass',{kind:'glazing',color:'#78949e',opacity:.89,horizontal:0,vertical:0});
          for(let k=0;k<n;k++){
            const a=-width/2+width*k/n,b=a+width/n-.065;
            face([p(v,hh*.35,a),p(v,hh*.35,b),p(v,hh*.80,b),p(v,hh*.80,a)],finish,[[0,0],[1,0],[1,1],[0,1]]);
          }
          block(...p(v+front*.10,hh*.82,0),.32,.13,width+.25,theta,frameMat);
        }

      }
    }
  }
  function attachment(row){
    const lines=row.path?[row.path]:b.walls.flatMap((w,i)=>matches(row.walls??'all',i)?[[w.a,w.b]]:[]).slice(0,row.walls===undefined?1:undefined);
    for(const line of lines)for(let i=1;i<line.length;i++){
      const f=frame(line[i-1],line[i]),w=row.width??2.2,h=row.stairLevels?row.stairLevels[i]-row.stairLevels[i-1]:(row.height??3.5),base=row.stairLevels?.[i-1]??((b.entryGround?.[row.gradeEntry]??ground)+(row.baseOffset??(row.type==='skybridge'?4:0))),u=f.len/2,offset=row.path?0:w/2;
      if(row.paving){
        const cross=row.paving[i-1],finish=material(row.material??'trim',{drivingSurface:'parking'});
        for(let j=1;j<cross.length;j++){
          const previous=cross[j-1],next=cross[j];
          const corners=[previous[0],previous[1],next[1],next[0]];
          face(corners,finish,null,[0,1,0]);
          const levels=corners.map(v=>v[1]);
          solid([corners.map(v=>[v[0],v[2]])],Math.min(...levels)-h-.015,Math.max(...levels));
          if(level===0)continue;
          const edges=[[previous[0],next[0]],[next[1],previous[1]]];
          if(j===1)edges.push(previous);
          if(j===cross.length-1)edges.push(next);
          for(const [a,b] of edges)face([a,b,[b[0],b[1]-h-.015,b[2]],[a[0],a[1]-h-.015,a[2]]],finish);
        }
        continue;
      }
      if(row.type==='lattice-dome'){
        const m=material(row.material??'trim'),sectors=level===0?6:12,steps=level===0?2:5;
        const point=(j,k)=>{
          const phi=2*Math.PI*j/sectors,latitude=k*Math.PI/(steps*2);
          return f.at(u+u*Math.cos(phi)*Math.cos(latitude),base+h*Math.sin(latitude),w*.5*Math.sin(phi)*Math.cos(latitude));
        };
        for(let j=0;j<sectors;j++)for(let k=0;k<steps;k++){
          beam(point(j,k),point(j,k+1),.13,m,true);
          if(k%2===0)beam(point(j,k),point(j+1,k),.095,m,true);
        }
        continue;
      }
      if(row.type==='ramp' && !row.baseOffset){
        const toe=base,crest=base+h;
        const depth=Math.max(.09,Math.min(.18,w*.13));
        for(const end of [0,f.len]){
          for(const sign of [-1,1]){
            const y=end===0?toe:crest;
            f.box(end,y-.12,offset+sign*(w-depth)/2,depth,.24,depth,material(row.material??'trim'),true,true);
          }
        }
      }
      const m=material(row.material??'trim'),c=row.columns!==undefined?Math.max(1,Math.round(row.columns*f.len/line.slice(1).reduce((sum,p,k)=>sum+Math.hypot(p[0]-line[k][0],p[1]-line[k][1]),0))):Math.max(2,Math.round(f.len/4));
      if(level===0 && ['exterior-stair','fire-escape','ramp'].includes(row.type)){
        face([f.at(0,base,offset-w/2),f.at(0,base,offset+w/2),f.at(f.len,base+h,offset+w/2),f.at(f.len,base+h,offset-w/2)],m,null,[0,1,0]);
        continue;
      }
      if(['exterior-stair','fire-escape','ramp'].includes(row.type)){
        const count=row.type==='ramp'?1:Math.max(1,Math.ceil(h/.17));
        if(row.type==='ramp'){
          face([f.at(0,base,offset-w/2),f.at(0,base,offset+w/2),f.at(f.len,base+h,offset+w/2),f.at(f.len,base+h,offset-w/2)],m,null,[0,1,0]);
          if(collisionOnly)for(let k=0;k<12;k++)f.box((k+.5)*f.len/12,base+h*(k+.5)/24,offset,f.len/12,h*(k+.5)/12,w,m,true);
        }else{
          const flights=row.landing && h>.65?Math.max(2,Math.ceil(h/2.8)):1;
          const landing=Math.min(w, f.len*.22/(flights-1||1)),run=(f.len-landing*(flights-1))/flights;
          const treads=Math.ceil(count/flights),open=!row.stairLevels && Boolean(row.baseOffset || row.type==='fire-escape');
          for(let j=0;j<flights;j++){
            const a=j*(run+landing),low=base+h*j/flights,high=base+h*(j+1)/flights;
            for(let k=0;k<treads;k++){
              const top=low+(high-low)*(k+1)/treads,bottom=open?top-.135:base-.04;
              f.box(a+run*(k+.5)/treads,(bottom+top)/2,offset,run/treads+.008,top-bottom,w,m,true,!open);
            }
            for(const side of [-1,1]){
              const d=offset+side*(w*.5-.035);
              beam(f.at(a,low+.94,d),f.at(a+run,high+.94,d),.055,m);
              for(const t of [0,.5,1])f.box(a+t*run,low+(high-low)*t+.45,d,.055,.96,.055,m);
              if(open){
                beam(f.at(a,low-.12,d),f.at(a+run,high-.12,d),.18,m);
                if(j===0 && i===1)f.box(a+.085,low-.5,d,.16,1,.16,m,true,true);
              }
            }
            if(j+1<flights)f.box(a+run+landing/2,high-.09,offset,landing,.18,w,m,true);
          }
        }
      }else if(['colonnade','arcade','covered-walkway','loading-bay'].includes(row.type)){
        if(row.cover==='open-slats'){
          const n=Math.max(1,Math.round(f.len/(row.slatSpacing??.75)));
          for(let j=0;j<n;j++)f.box((j+.5)*f.len/n,base+h,offset,.13,.17,w,m,true);
          for(const side of [-1,1])f.box(u,base+h-.11,offset+side*w*.41,f.len,.17,.16,m,true);
        }else if(row.roofRise){
          const y=base+h,rise=row.roofRise,d=offset+w/2;
          for(const [l,r,lh,rh] of [[0,u,y,y+rise],[u,f.len,y+rise,y]]){
            face([f.at(l,lh,d-w),f.at(r,rh,d-w),f.at(r,rh,d),f.at(l,lh,d)],m,null,[0,1,0]);
            f.surface([[l,lh-.12],[r,rh-.12],[r,rh],[l,lh]],m,d);
          }
          solid([[f.at(0,0,d-w),f.at(f.len,0,d-w),f.at(f.len,0,d),f.at(0,0,d)].map(p=>[p[0],p[2]])],y-.12,y+rise);
        }else f.box(u,base+h,offset,f.len,.27,w,m,true);
        for(let k=0;k<c;k++){
          const along=(k+.5)*f.len/c;
          const diameter=row.columnDiameter??Math.min(.52,w*.8);
          if(row.columnShape==='round'){
            const [x,,z]=f.at(along,base,offset+w*.37);
            const foot=!row.baseOffset?Math.min(base,b.foundation):base;
            const ring=frustum(x,z,diameter,diameter,foot,base+h,diameter,diameter,level>0?12:8,0,m);
            solid([ring],foot,base+h);
          }else f.box(along,base+h/2,offset+w*.37,diameter,h,diameter,m,true,!row.baseOffset);
          if(row.footing)f.box(along,base+row.footing.height/2,offset+w*.37,row.footing.diameter,row.footing.height,row.footing.diameter,material(row.footing.material),true,true);
        }
      }else if(row.type==='retaining-wall' && row.pathGround){
        const a=row.pathGround[i-1],c=row.pathGround[i];
        const ring=[f.at(0,a-.12,-w/2),f.at(f.len,c-.12,-w/2),f.at(f.len,c-.12,w/2),f.at(0,a-.12,w/2)];
        const cap=ring.map(([x,y,z])=>[x,y+h+.12,z]);
        face(cap,m,null,[0,1,0]);
        for(let j=0;j<4;j++){const k=(j+1)%4;face([ring[j],ring[k],cap[k],cap[j]],m);}
        solid([ring.map(p=>[p[0],p[2]])],Math.min(a,c)-.12,Math.max(a,c)+h);
      }else{
        f.box(u,base+h*.5,offset,f.len,h,w,m,true,row.type==='terrace' && !row.baseOffset);
        if(row.type==='skybridge')for(const side of [-1,1]){
          const d=offset+side*(w/2+.026);
          f.box(u,base+h*.57,d,f.len*.93,h*.62,.04,material('#667e88',{kind:'spandrel-glass'}));
          if(medium){
            const n=Math.max(2,Math.round(f.len/(h*1.2))),steel=material(row.trussMaterial??row.material??'trim');
            for(let k=0;k<n;k++)beam(f.at(f.len*k/n,base+h*(k%2?.84:.24),d+side*.046),f.at(f.len*(k+1)/n,base+h*(k%2?.24:.84),d+side*.046),.13,steel);
          }
        }
      }
    }
  }
  function exposeRoofEdges(firstIndex,firstBox){
    const planes=new Map();
    for(let k=firstBox;k<boxes.length;k+=8){
      const [x,y,z,w,h,d,angle,mat]=boxes.slice(k,k+8);
      if(palette[mat].opacity<1 || ['glass-curtain','perforated-mesh'].includes(palette[mat].kind))continue;
      const key=Math.round((y+h/2)*10000);
      if(!planes.has(key))planes.set(key,[]);
      const c=Math.cos(angle),t=Math.sin(angle),u=w/2,v=d/2;
      planes.get(key).push({x,z,c,t,u,v,ex:Math.abs(c)*u+Math.abs(t)*v,ez:Math.abs(t)*u+Math.abs(c)*v});
    }
    if(!planes.size)return;
    const stop=indices.length;
    let cursor=firstIndex;
    for(let k=firstIndex;k<stop;k+=3){
      const a=indices[k],b=indices[k+1],c=indices[k+2],y=positions[3*a+1];
      const row=normals[3*a+1]>125 && Math.abs(y-positions[3*b+1])<.0001 && Math.abs(y-positions[3*c+1])<.0001 && planes.get(Math.round(y*10000));
      let polys;
      if(row){
        const pts=[a,b,c].map(i=>[positions[i*3],positions[i*3+2],uvs[2*i],uvs[2*i+1]]);
        const xs=pts.map(p=>p[0]),zs=pts.map(p=>p[1]),l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...zs),d=Math.max(...zs);
        for(const box of row){
          if(box.x+box.ex<=l || box.x-box.ex>=r || box.z+box.ez<=t || box.z-box.ez>=d)continue;
          const result=[];
          for(const poly of polys??[pts]){
            let inner=poly;
            const outside=[];
            for(const [dx,dz,limit] of [[box.c,box.t,box.u],[-box.c,-box.t,box.u],[-box.t,box.c,box.v],[box.t,-box.c,box.v]]){
              const keep=[],cut=[];
              for(let j=0;j<inner.length;j++){
                const p=inner[(j+inner.length-1)%inner.length],q=inner[j];
                const dp=(p[0]-box.x)*dx+(p[1]-box.z)*dz-limit,dq=(q[0]-box.x)*dx+(q[1]-box.z)*dz-limit;
                if(dp*dq<0){const v=p.map((n,i)=>n+(q[i]-n)*dp/(dp-dq));keep.push(v);cut.push(v);}
                if(dq<=0)keep.push(q);if(dq>=0)cut.push(q);
              }
              if(cut.length>=3)outside.push(cut);
              inner=keep;if(inner.length<3)break;
            }
            if(inner.length>=3)result.push(...outside);else result.push(poly);
          }
          if(result.length!==1 || result[0]!==pts)polys=result;
        }
      }
      if(!polys){indices[cursor++]=a;indices[cursor++]=b;indices[cursor++]=c;continue;}
      for(const poly of polys){
        const start=positions.length/3;
        for(const [x,z,u,v] of poly){positions.push(x,y,z);normals.push(0,127,0);styles.push(styles[a]);uvs.push(u,v);}
        for(let j=2;j<poly.length;j++)indices.push(start,start+j-1,start+j);
      }
    }
    if(cursor!==stop){indices.copyWithin(cursor,stop);indices.length-=stop-cursor;}
  }
  function farEnvelope(building,joints){
    const [left,north,right,south]=building.bounds??[0,0,25,25];
    const area=Math.max(1,building.footprintArea??(right-left)*(south-north));
    const limit=Math.max(32,building.farBudget??Math.floor(64+10.65*Math.sqrt(area)));
    const firstTri=indices.length,firstBox=boxes.length,flatCaps=[];
    const count=()=>(indices.length-firstTri)/3+(boxes.length-firstBox)*1.5;
    const buffers=[positions,normals,uvs,styles,indices,boxes,flatCaps];
    const save=()=>buffers.map(a=>a.length);
    const restore=mark=>buffers.forEach((arr,i)=>arr.length=mark[i]);
    function tryDraw(cap,draw){
      const mark=save();
      draw();
      if(count()<=cap)return true;
      restore(mark);
      return false;
    }
    const footprint=ring=>Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p[0]*q[1]-q[0]*p[1];},0))*.5;
    const masses=b.parts.map((p,i)=>({p,i,area:footprint(p.rings[0])})).sort((a,c)=>c.area-a.area);
    const features=new Map();
    for(const {p} of masses)for(const row of p.roof.features??[]){
      const [w,d=w]=row.size??[2,2],h=row.height??row.size?.[2]??1.3;
      if(Math.min(w,d)<1 || Math.max(w,d)<2.3 || h<.80 || row.housing==='duct' && h<1.4 || ['antenna','solar-panels','green-roof'].includes(row.type))continue;
      const key=JSON.stringify(row);
      if(!features.has(key))features.set(key,{p,row,priority:w*d*h});
    }
    function wallFinish(p,r,j,segment,height){
      const id=p.wallIds[r][j],pf=merge(s.walls.default,p.material?{material:p.material}:null,...Object.entries(s.walls.byWall??{}).filter(([key])=>matches(key,id)).map(([,v])=>v),p.facade,p.wallProfiles?.[id]);
      const win=pf.windows??{},base=pf.material??p.material??'wall';
      if(pf.blank || win.type==='none' || segment<1.3 || height<1 || s.materials[base]?.kind==='glass-curtain')return [material(base),null];
      const pitch=Math.max(1.15,pf.bays?.width??3.8),rows=Math.max(1,p.floors);
      const pane=material(base,{kind:'distant-wall',glassColor:win.glassColor??'#597481',coverage:clamp((win.width??1.5)/pitch,.1,.96),vertical:clamp((win.height??2)*rows/height,.12,.91)});
      return [pane,[pitch,rows/height]];
    }
    const flatStyles=new Map();
    for(const {p} of masses)if(p.roof.form==='flat'){
      const ref=p.roof.material??'roof',key=p.high+'|'+ref;
      if(!flatStyles.has(key))flatStyles.set(key,material(ref,{...p.roofFinish,roofSurface:true}));
    }
    const shellHeight=p=>ground+p.high;
    function shell(p,pi,simple){
      const top=shellHeight(p),floor=p.low===0?(b.foundation??ground-.6):ground+p.low;
      const ref=p.roof.material??'roof',roof=flatStyles.get(p.high+'|'+ref)??material(ref,{...p.roofFinish,roofSurface:true});
      const [verts,idx]=p.surface,wall=material(p.material??'wall');
      if(simple){
        const loop=p.rings[0],sides=loop.map((v,i)=>frame(v,loop[(i+1)%loop.length])).sort((a,c)=>c.len-a.len),axis=sides[0];
        if(!axis || !Number.isFinite(axis.len) || axis.len<.02)return;
        const us=loop.map(([x,z])=>(x-axis.a[0])*axis.tx+(z-axis.a[1])*axis.tz);
        const ds=loop.map(([x,z])=>(x-axis.a[0])*axis.nx+(z-axis.a[1])*axis.nz);
        const l=Math.min(...us),r=Math.max(...us),d=Math.min(...ds),e=Math.max(...ds);
        const corners=[[l,d],[r,d],[r,e],[l,e]].map(([u,v])=>axis.at(u,top,v)),rise=Math.max(0,...verts.map(v=>v[1]));
        if(rise>.28){
          const mid=axis.at((l+r)/2,top+rise,(d+e)/2);
          for(let i=0;i<4;i++)face([corners[i],corners[(i+1)%4],mid],roof,null,[0,1,0]);
        }else face(corners,roof,null,[0,1,0]);
        for(let i=0;i<4;i++){
          const a=corners[i],c=corners[(i+1)%4];
          face([[a[0],floor,a[2]],[c[0],floor,c[2]],c,a],wall);
        }
        return;
      }
      const flat=p.roof.form==='flat' && verts.every(v=>Math.abs(v[1])<.001);
      const boundary=new Map(),capStart=indices.length;
      const skirt=p.roof.form==='mansard'?mansardFinish(p):null;
      for(let k=0;k<idx.length;k+=3){
        const ids=idx.slice(k,k+3),tri=ids.map(i=>[verts[i][0],top+verts[i][1],verts[i][2]]);
        const slope=skirt!==null && Math.max(...tri.map(p=>p[1]))-Math.min(...tri.map(p=>p[1]))>.12;
        face(tri,slope?skirt:roof,null,[0,1,0]);
        if(!flat)for(let i=0;i<3;i++){
          const a=ids[i],c=ids[(i+1)%3],key=Math.min(a,c)+':'+Math.max(a,c);
          if(!boundary.delete(key))boundary.set(key,[verts[a],verts[c]]);
        }
      }
      if(flat && p.rings.length===1 && p.rings[0].length===4 && indices.length-capStart===6){
        const corners=new Map();
        for(const vi of indices.slice(capStart))corners.set(positions[vi*3]+','+positions[vi*3+2],vi);
        if(corners.size===4)flatCaps.push({start:capStart,roof,top,corners:[...corners.values()]});
      }
      for(const [a,c] of boundary.values()){
        if(Math.max(a[1],c[1])<.025)continue;
        const f=frame([a[0],a[2]],[c[0],c[2]]);
        if(f.len<.025)continue;
        const poly=[[0,top],[f.len,top]];
        if(c[1]>.001)poly.push([f.len,top+c[1]]);
        if(a[1]>.001)poly.push([0,top+a[1]]);
        f.surface(poly,wall);
      }
      for(const [r,ring] of p.rings.entries())for(let j=0;j<ring.length;j++){
        if(joints.has(pi+':'+r+':'+j) || p.deckEdges?.[r]?.[j])continue;
        const a=ring[j],c=ring[(j+1)%ring.length],f=frame(a,c,p.curves?.[r]?.[j]);
        if(f.len<.025)continue;
        const [m,pattern]=wallFinish(p,r,j,f.len,p.high-p.low),bottom=p.openSoffit??floor;
        const corners=[[0,bottom],[f.len,bottom],[f.len,top],[0,top]];
        f.surface(corners,m,0,pattern?corners.map(([u,y])=>[u/pattern[0],(y-ground-p.low)*pattern[1]]):null);
      }
    }
    function silhouette(t){
      const [x,z]=t.at,[w,d=w]=t.size,m=material(t.material??'wall'),rot=(t.rotation??0)*Math.PI/180;
      const n=t.plan==='round'||t.plan==='octagon'?8:4,y=ground+t.height;
      const ratio=t.topDiameter?clamp(t.topDiameter/w,.2,1):1;
      frustum(x,z,w,d,ground-.55,y,w*ratio,d*ratio,n,rot,m);
      if(t.top && !['flat','battlements'].includes(t.top.type)){
        const cap=material(t.top.material??'roof'),h=t.top.height??2;
        if(t.top.type==='dome'){
          frustum(x,z,w*.76,d*.76,y,y+h*.52,w*.65,d*.65,8,rot,cap);
          frustum(x,z,w*.65,d*.65,y+h*.52,y+h,.04,.04,8,rot,cap);
        }else frustum(x,z,w*.76,d*.76,y,y+h,.04,.04,n,rot,cap);
      }
      if(t.top?.type==='battlements')for(const [px,pz] of [[-.38,-.38],[-.38,.38],[.38,.38],[.38,-.38]]){
        const c=Math.cos(rot),sn=Math.sin(rot);
        const cx=x+w*px*c-d*pz*sn,cz=z+w*px*sn+d*pz*c;
        frustum(cx,cz,w*.20,d*.20,y,y+(t.top.height??1),w*.20,d*.20,4,rot,m);
      }
    }
    const towers=(s.towers??[]).toSorted((a,c)=>c.height-a.height);
    const landmark=towers[0] && towers[0].height>8;
    const reserve=landmark?Math.min(95,Math.floor(limit*.46)):0;
    const core=Math.max(12,limit-reserve);
    const sizable=masses.filter(({p,area})=>area>=1 && !(p.high-p.low<.30 && p.low===0) && (!/^seating row/i.test(p.name) || p.high>1.5));
    for(const [i,mass] of (sizable.length?sizable:masses.slice(0,1)).entries()){
      const {p,i:pi}=mass;
      if(i && /^(?:Cable|Balcony panel|.*(?:handrail|mullion|end panel|post|sash|trim strip))\b/i.test(p.name??'') && mass.area<5)continue;
      if(count()+8>core)break;
      const cap=i===0 && sizable.length>1?Math.max(12,Math.floor(core*.76)):core;
      if(tryDraw(cap,()=>shell(p,pi,false)))continue;
      tryDraw(core,()=>shell(p,pi,true));
    }
    for(const t of towers){
      if(tryDraw(limit,()=>silhouette(t)))continue;
      if(t===towers[0])tryDraw(limit,()=>{
        const [x,z]=t.at,[w,d=w]=t.size,y=ground+t.height,rotation=(t.rotation??0)*Math.PI/180;
        frustum(x,z,w,d,ground-.2,y,w,d,4,rotation,material(t.material??'wall'));
        if(t.top && !['flat','battlements'].includes(t.top.type))frustum(x,z,w*.78,d*.78,y,y+(t.top.height??2),.04,.04,4,rotation,material(t.top.material??'roof'));
      });
    }
    for(const {p,row} of [...features.values()].sort((a,c)=>c.priority-a.priority)){
      if(count()+10>limit)break;
      tryDraw(limit,()=>feature({...row,count:Math.min(4,row.count??1)},p));
    }
    if(!count() && masses.length)shell(masses[0].p,masses[0].i,true);
    const adjacent=new Map(),removed=new Set(),joined=new Set();
    const xy=i=>[positions[i*3],positions[i*3+2]];
    const cross=(a,c,d)=>(c[0]-a[0])*(d[1]-a[1])-(c[1]-a[1])*(d[0]-a[0]);
    for(const cap of flatCaps){
      const ring=cap.corners.map(i=>[...xy(i),i]),cx=ring.reduce((sum,v)=>sum+v[0],0)/4,cz=ring.reduce((sum,v)=>sum+v[1],0)/4;
      ring.sort((a,c)=>Math.atan2(a[1]-cz,a[0]-cx)-Math.atan2(c[1]-cz,c[0]-cx));
      for(let j=0;j<4;j++){
        const a=ring[j],c=ring[(j+1)%4],key=cap.roof+'|'+cap.top+'|'+[a.slice(0,2).join(','),c.slice(0,2).join(',')].sort().join('|');
        const other=adjacent.get(key);
        if(!other){adjacent.set(key,{cap,ring});continue;}
        if(joined.has(other.cap.start) || joined.has(cap.start))continue;
        const corners=[...other.ring,...ring].filter(v=>!(v[0]===a[0] && v[1]===a[1]) && !(v[0]===c[0] && v[1]===c[1]));
        if(corners.length!==4)continue;
        const x=corners.reduce((sum,v)=>sum+v[0],0)/4,z=corners.reduce((sum,v)=>sum+v[1],0)/4;
        corners.sort((a,c)=>Math.atan2(c[1]-z,c[0]-x)-Math.atan2(a[1]-z,a[0]-x));
        if(![a,c].every(p=>corners.some((v,i)=>Math.abs(cross(v,corners[(i+1)%4],p))<.001)))continue;
        const [v0,v1,v2,v3]=corners.map(v=>v[2]);
        indices.splice(other.cap.start,6,v0,v1,v2,v0,v2,v3);
        removed.add(cap.start);joined.add(cap.start);joined.add(other.cap.start);break;
      }
    }
    if(removed.size){
      let end=firstTri;
      for(let i=firstTri;i<indices.length;){if(removed.has(i)){i+=6;continue;}indices[end++]=indices[i++];}
      indices.length=end;
    }
  }
  function roofJunctions(parts){
    const rows=new Map(),joined=new Set();
    for(const [index,p] of parts.entries()){
      for(const [r,ring] of p.rings.entries())for(let j=0;j<ring.length;j++){
        const a=ring[j],b=ring[(j+1)%ring.length];
        const code=point=>point.map(v=>Math.round(v*50)).join(',');
        const key=[Math.round(p.high*100),...[code(a),code(b)].sort()].join(':');
        const id=index+':'+r+':'+j;
        if(rows.has(key)){joined.add(id);joined.add(rows.get(key));}
        else rows.set(key,id);
      }
    }
    return joined;
  }
  for(const item of records){
    const firstIndex=indices.length,firstBox=boxes.length;
    b=item;s=b.spec;ground=b.ground;
    arcadePiers=b.parts.filter(p=>/arcade pier/i.test(p.name??''));
    if(s.present===false)continue;
    const joints=roofJunctions(b.parts);
    if(level===0){
      farEnvelope(b,joints);
      if(ranges)ranges.push([b.id,positions.length/3,boxes.length/8]);
      continue;
    }
    for(const [pi,part] of b.parts.entries()){
      const [vertices,idx]=part.surface,top=ground+part.high,base=ground+part.low,lo=part.low===0?Math.min(ground-.5,b.foundation??ground-4):base;
      if(part.paving){
        const finish=material(part.roof.material??part.material??'wall',{drivingSurface:'parking'});
        for(let i=0;i<idx.length;i+=3){
          const points=idx.slice(i,i+3).map(k=>[vertices[k][0],top+vertices[k][1],vertices[k][2]]);
          face(points,finish,null,[0,1,0]);
        }
        for(const [r,ring] of part.rings.entries())for(let j=0;j<ring.length;j++){
          const a=ring[j],k=(j+1)%ring.length,c=ring[k],ga=part.grade[r][j],gc=part.grade[r][k];
          face([[a[0],ga-.04,a[1]],[c[0],gc-.04,c[1]],[c[0],gc+part.high,c[1]],[a[0],ga+part.high,a[1]]],finish);
        }
        continue;
      }
      const garage=s.style==='parking-structure' && !/stair|lift|elevator|enclosed/i.test(part.name??'');
      if(garage && collisionOnly && part.deckLevels){
        for(const layer of part.deckLevels)for(let i=0;i<idx.length;i+=3){
          const ids=idx.slice(i,i+3);
          solid([ids.map(k=>[vertices[k][0],vertices[k][2]])],Math.min(...ids.map(k=>layer[k]))-.16,Math.max(...ids.map(k=>layer[k])));
        }
      }else if(garage){for(let j=1;j<=part.floors;j++)solid(part.solidRings??part.rings,base+(top-base)*j/part.floors-.16,base+(top-base)*j/part.floors);}
      else if(part.openSoffit){
        solid(part.solidRings??part.rings,part.openSoffit-.16,top);
      }else if(collisionOnly && part.collisionShells){
        for(const rings of part.collisionShells)solid(rings,lo,top);
        for(const [id,rings] of part.doorHeads){
          const e=s.entrances[id],sill=(b.entryGround?.[id]??base)+(e.steps??0)*.155+.035;
          if(sill>lo)solid(rings,lo,sill);
          if(sill+(e.height??2.7)<top)solid(rings,sill+(e.height??2.7),top);
        }
      }else solid(part.solidRings??part.rings,lo,top);
      const finish=part.roof.material??'roof';
      const rm=material(finish,{...part.roofFinish,roofSurface:true,parkingMarkings:part.parkingAngle===undefined?0:part.parkingAngle+4,drivingSurface:garage?'parking':undefined}),wall=material(part.material??'wall');
      const stairShaft=s.style==='parking-structure' && /(?:stair|lift).*shaft/i.test(part.name??'');
      if(stairShaft && medium){
        const ring=part.rings[0],edges=ring.map((a,j)=>frame(a,ring[(j+1)%ring.length])).sort((a,b)=>b.len-a.len),f=edges[0];
        const side=(part.center[0]-f.a[0])*f.nx+(part.center[1]-f.a[1])*f.nz;
        const depth=Math.min(1.20,Math.abs(side)*.64),wing=f.len*.34,edge=material('#777971',{kind:'concrete-smooth'});
        for(let j=0;j<part.floors;j++){
          const floor=base+(top-base)*j/part.floors,rise=(top-base)/part.floors/2;
          for(let k=0;k<2;k++){
            const start=f.len/2+(k?wing:-wing),end=f.len-start,offset=side+(k?.6:-.6)*depth;
            const y=floor+k*rise;
            face([f.at(start,y,offset-depth/2),f.at(start,y,offset+depth/2),f.at(end,y+rise,offset+depth/2),f.at(end,y+rise,offset-depth/2)],edge,null,[0,1,0]);
            if(near){
              const count=Math.ceil(rise/.18);
              for(let n=1;n<=count;n++)f.box(start+(end-start)*(n-.5)/count,y+rise*n/count-.065,offset,Math.abs(end-start)/count,.13,depth,edge);
              beam(f.at(start,y+.88,offset),f.at(end,y+rise+.88,offset),.052,material('frame'));
            }
          }
        }
      }
      const roofGlass=medium && s.materials[finish]?.kind==='glass-curtain';
      const deck=garage?material(part.roof.material??'roof',{kind:'concrete-smooth',roughness:.93,drivingSurface:'parking'}):wall;
      if(part.garageApron && medium){
        const baseSlab=material('#98978e',{kind:'concrete-smooth',roughness:.92,drivingSurface:'parking'});
        for(const tri of part.garageApron)face(tri,baseSlab,null,[0,1,0]);
      }
      if(medium && part.soffitRibs){
        const finish=material(part.material??'wall',{roughness:.91});
        for(const [a,c] of part.soffitRibs){
          const f=frame(a,c);
          f.box(f.len/2,base-.125,0,f.len,.25,.17,finish);
        }
      }
      if(medium && part.plantings){
        const trunk=material('#76644f',{kind:'wood-siding'}),leaf=material('#607347',{kind:'stucco',roughness:.97}),sunlit=material('#788654',{kind:'stucco',roughness:.96});
        for(const tree of part.plantings){
          const [x,z]=tree.at,r=tree.radius??2.1,h=tree.height??4.9,bed=roofAt(part,x,z);
          if(!Number.isFinite(bed))continue;
          frustum(x,z,.22,.24,bed,bed+h*.54,.16,.16,7,0,trunk);
          for(let i=0;i<4;i++){
            const theta=.71*x+2.399*i,reach=i<3?r*.37:0,px=x+reach*Math.cos(theta),pz=z+reach*Math.sin(theta),y=bed+h*(i<3?.63:.82),d=r*(i<3?1.24:1.44);
            frustum(px,pz,d*.37,d*.40,y-h*.19,y,d,d*.93,7,theta,i%2?leaf:sunlit);
            frustum(px,pz,d,d*.93,y,y+h*.17,d*.24,d*.29,7,theta,i%2?leaf:sunlit);
          }
        }
      }
      if(part.deckStructure){
        const {angle,posts,spans}=part.deckStructure;
        const layers=part.openSoffit?[part.openSoffit]:part.deckLevels.map(layer=>layer[0]);
        const concrete=material(part.material??'wall',{kind:'concrete-smooth',color:'#aaa8a1'}),lamp=material('#e6e2d4');
        for(const [x,z,foot] of posts){
          const height=layers.at(-1)-foot;
          block(x,foot+height/2,z,.55,height,.60,angle,concrete,true,true);
        }
        if(medium)for(const [x,z,width] of spans)for(const y of layers){
          block(x,y-.285,z,width,.25,.39,angle,concrete);
          if(near)block(x,y-.417,z,1.34,.035,.16,angle,lamp);
        }
      }
      for(const [px,pz] of part.posts??[])block(px,base-.5,pz,.28,1,.28,0,material('frame'),true,true);
      for(const [px,pz,from,to] of part.seats??[])block(px,ground+(from+to)/2,pz,.45,to-from,.45,0,material('frame'),true);
      const seating=/^seating row/i.test(part.name??'');
      if(seating){
        const ring=part.rings[0],sides=ring.map((point,j)=>frame(point,ring[(j+1)%ring.length])).sort((a,c)=>c.len-a.len);
        if(sides.length>=2){
          const f=sides[0],g=sides[1],span=Math.abs((g.a[0]-f.a[0])*f.nx+(g.a[1]-f.a[1])*f.nz),frameMat=material('frame');
          const central=s.seating?.centralSection,section=Math.max(1,b.parts.filter(p=>/^seating row/i.test(p.name??'')).length),rowIndex=Math.max(0,Number(part.name.match(/row\s+(\d+)/i)?.[1]??pi+1)-1),row=rowIndex/section;
          const modules=Math.max(1,Math.round(f.len/8));
          if(level===0)f.box(f.len/2,top+.14,-span*.55,f.len,.12,span*.43,material('wall'));
          for(let k=0;k<modules && level!==0;k++){
            const a=(k+.5)/modules,u=f.len*a;
            const color=central&&a>central.alongStand[0]&&a<central.alongStand[1]&&row>central.acrossRake[0]&&row<central.acrossRake[1]?material(central.material):material('wall');
            f.box(u,top+.14,-span*.55,f.len/modules-.72,.12,span*.43,color);
            if(medium && k>0 && k%2===0 && rowIndex%3===0){
              const aisle=k*f.len/modules;
              const a=f.at(aisle,top+.86,-span*.14),c=f.at(aisle,top+1.12,-span*.91);
              beam(a,c,.058,frameMat);
              for(const [depth,height] of [[-.14,.86],[-.91,1.12]])f.box(aisle,top+height/2,span*depth,.05,height,.05,frameMat);
            }
            if(near && rowIndex%4===0 && rowIndex>1 && part.low>1.2){
              const root=f.at(u,base-.61,-span*.50);
              beam(root,f.at(u-.71,base-.07,-span*.50),.10,frameMat);
              beam(root,f.at(u+.71,base-.07,-span*.50),.10,frameMat);
            }
            if(rowIndex===section-1 && medium){
              for(const height of [.58,1.05])f.box(u,top+height,-span*.72,f.len/modules,.055,.055,frameMat);
              f.box(k*f.len/modules+.07,top+.51,-span*.72,.065,1.08,.065,frameMat);
            }
            if(rowIndex%4===0){
              const h=part.low,foot=f.at(u,ground,-span*.5),head=f.at(u,base,-span*.5);
              f.box(u,ground+h/2,-span*.5,.15,h,.15,frameMat,true,true);
              if(medium && k+1<modules){
                const end=u+f.len/modules;
                beam(foot,f.at(end,head[1],-span*.5),.105,frameMat);
                if(row>.5)beam(head,f.at(end,ground,-span*.5),.105,frameMat);
              }
            }
          }
        }
      }
      if(part.deckLevels && part.roof.form==='shed' && medium){
        const edge=material('trim');
        const ring=part.rings[0];
        for(let j=0;j<ring.length;j++){
          const a=ring[j],c=ring[(j+1)%ring.length],f=frame(a,c);
          const ai=vertices.findIndex(v=>Math.hypot(v[0]-a[0],v[2]-a[1])<.01),ci=vertices.findIndex(v=>Math.hypot(v[0]-c[0],v[2]-c[1])<.01);
          if(ai<0 || ci<0 || Math.abs(vertices[ai][1]-vertices[ci][1])<.1)continue;
          for(const layer of part.deckLevels){
            const ay=layer[ai],cy=layer[ci];
            for(const h of [.20,.89])beam(f.at(.18,ay+h,-.14),f.at(f.len-.18,cy+h,-.14),h<.3?.23:.095,edge);
            const count=Math.ceil(f.len/4);
            for(let k=0;k<=count;k++)f.box(.18+(f.len-.36)*k/count,ay+(cy-ay)*k/count+.47,-.14,.095,.9,.095,edge);
          }
        }
      }
      if(!collisionOnly){
        const boundary=new Map();
        const smooth=!contacts && ['dome','barrel','upswept'].includes(part.roof.form)?curvedRoofNormals(vertices,idx):null;
        for(let i=0;i<idx.length;i+=3){
          const ids=idx.slice(i,i+3);
          const roofPoints=ids.map(k=>[vertices[k][0],top+vertices[k][1],vertices[k][2]]);
          const skirt=part.roof.form==='mansard' && Math.max(...ids.map(k=>vertices[k][1]))-Math.min(...ids.map(k=>vertices[k][1]))>.12;
          const roofMat=skirt?mansardFinish(part):rm;
          const firstNormal=normals.length;
          face(roofPoints,roofMat,null,[0,1,0]);
          if(smooth && normals.length===firstNormal+9)for(let j=0;j<3;j++)for(let k=0;k<3;k++)normals[firstNormal+3*j+k]=smooth[ids[j]][k];
          if(garage && medium && part.deckLevels)for(const layer of part.deckLevels.slice(0,-1)){
            const corners=ids.map(k=>[vertices[k][0],layer[k],vertices[k][2]]);
            face(corners,deck,null,[0,1,0]);
            face(corners.map(([x,y,z])=>[x,y-.16,z]),material('wall',{kind:'concrete-smooth',color:'#8b8980'}),null,[0,-1,0]);
          }else if(garage && medium)for(let j=1;j<part.floors;j++)face(ids.map(k=>[vertices[k][0],base+(top-base)*j/part.floors,vertices[k][2]]),wall,null,[0,1,0]);
          if(garage || part.openSoffit){
            const level=part.openSoffit??top;
            face(ids.map(k=>[vertices[k][0],level+(garage?vertices[k][1]:0)-.165,vertices[k][2]]),material('#a6a49d',{kind:'concrete-board-formed'}),null,[0,-1,0]);
          }
          if(part.low>0){
            const fascia=part.facade?.fasciaBeam;
            const soffit=fascia?material('wall',{kind:'concrete-smooth',color:fascia.soffitColor??'#645f57',surface:'coffered-soffit'}):wall;
            face(ids.map(k=>[vertices[k][0],base,vertices[k][2]]),soffit,null,[0,-1,0]);
          }
          if(part.roof.suspension||!['flat','lidar'].includes(part.roof.form))for(let j=0;j<3;j++){
            const a=ids[j],c=ids[(j+1)%3],key=Math.min(a,c)+':'+Math.max(a,c);
            if(!boundary.delete(key))boundary.set(key,[vertices[a],vertices[c]]);
          }
        }
        if(roofGlass && part.roof.form==='flat' && part.rings[0].length===4){
          const ring=part.rings[0];
          const long=Math.hypot(ring[0][0]-ring[1][0],ring[0][1]-ring[1][1])>=Math.hypot(ring[1][0]-ring[2][0],ring[1][1]-ring[2][1])?0:1;
          const [a,c,d,e]=[0,1,2,3].map(i=>ring[(i+long)%4]);
          const bays=Math.max(1,Math.round(Math.hypot(c[0]-a[0],c[1]-a[1])/1.08));
          const bar=material('frame'),at=(a,b,t)=>[a[0]+(b[0]-a[0])*t,top+.036,a[1]+(b[1]-a[1])*t];
          for(let k=0;k<=bays;k++)beam(at(a,c,k/bays),at(e,d,k/bays),.075,bar);
          beam(at(a,e,.5),at(c,d,.5),.065,bar);
        }
        const apertures=[part.atticAperture,...(part.atticApertures??[])].filter(Boolean);
        if(medium)for(const aperture of apertures){
          const f=frame(aperture.a,aperture.b);
          for(const panel of aperture.panels)f.surface(panel.map(([x,h])=>[x,top+h]),wall);
          for(const {u,window:win} of aperture.openings??[aperture]){
            const sill=top+win.sill,head=sill+win.height,left=u-win.width/2,right=u+win.width/2;
            const glass=material('frame',{kind:'glazing',color:win.glassColor??'#546166',glass:win.glass??'clear',opacity:near?.80:1,roughness:.22});
            if(!near)f.rect(left,sill,right,head,wall,-.009);
            opening(f,{l:left,r:right,bot:sill,top:head},{u,sill,width:win.width,height:win.height,type:win.type,depth:win.recess??.13,glass,trim:material(win.surroundMaterial??'trim'),frameWidth:.055,win},wall);
          }
        }
        for(const [key,[a,c]] of boundary){
          if(part.roof.suspension && medium){
            const rim=material('trim');
            beam([a[0],top+a[1]-.06,a[2]],[c[0],top+c[1]-.06,c[2]],.26,rim);
          }
          if(a[1]+c[1]<.001)continue;
          const points=[[a[0],top,a[2]],[c[0],top,c[2]],[c[0],top+c[1],c[2]],[a[0],top+a[1],a[2]]];
          if(c[1]<.00001)points.splice(2,1);
          if(!medium || !apertures.some(ap=>ap.edges.includes(key)))face(points,wall);
          const joinedSlope=part.roof.form==='shed' && part.rings[0].some((v,j)=>{
            if(!joints.has(pi+':0:'+j))return false;
            const q=part.rings[0][(j+1)%part.rings[0].length],f=frame(v,q);
            return [a,c].every(p=>Math.abs((p[0]-v[0])*f.nx+(p[2]-v[1])*f.nz)<.07 && (p[0]-v[0])*f.tx+(p[2]-v[1])*f.tz>-.07 && (p[0]-v[0])*f.tx+(p[2]-v[1])*f.tz<f.len+.07);
          });
          if(medium && !joinedSlope && part.roof.edge!=='none' && Math.abs(a[1]-c[1])>.16 && ['gable','gambrel','half-hip','shed'].includes(part.roof.form)){
            beam([a[0],top+a[1]-.045,a[2]],[c[0],top+c[1]-.045,c[2]],.17,material('trim'));
          }
        }
      }
      for(let r=0;r<part.rings.length;r++){
        const ring=part.rings[r];
        for(let j=0;j<ring.length;j++){
          const id=part.wallIds[r][j],startEdge=j;
          let f=frame(ring[j],ring[(j+1)%ring.length],part.curves?.[r]?.[j]);
          const pg=s.walls.byWall?.[id];
          if(id>=0 && j+1<ring.length && part.wallIds[r][j+1]===id && pg?.bays?.count===1 && ['lancet','round-arch','tudor-arch'].includes(pg?.windows?.type)){
            const mid=ring[j+1],end=ring[(j+2)%ring.length],chord=frame(ring[j],end),knot=(mid[0]-ring[j][0])*chord.tx+(mid[1]-ring[j][1])*chord.tz;
            const deviation=(mid[0]-ring[j][0])*chord.nx+(mid[1]-ring[j][1])*chord.nz;
            if(knot>.03 && knot<chord.len-.03 && Math.abs(deviation)<chord.len*.06){
              f=frame(ring[j],end,deviation,mid);
              f.entryOffsets=new Map([[pi+':'+r+':'+j,0],[pi+':'+r+':'+(j+1),knot]]);
              j++;
            }
          }
          if(f.len<.025 || part.deckEdges?.[r]?.[j])continue;
          if(part.parkingAngle!==undefined && medium && r===0 && f.len>16){
            const lamps=Math.max(1,Math.round(f.len/20));
            for(let k=0;k<lamps;k++){
              const u=(k+.50)*f.len/lamps;
              f.box(u,top+2.8,-1.25,.12,5.6,.12,material('#666a67'));
              f.box(u,top+5.58,-1.63,.23,.12,.85,material('#6c706d'));
            }
          }
          f.rings=part.solidRings??part.rings;f.joinedRoof=joints.has(pi+':'+r+':'+j);
          if(near && part.low>0 && part.facade?.soffitBeams && r===0){
            const ribs=part.facade.soffitBeams,n=Math.max(1,Math.round(f.len/ribs.spacing)),concrete=material(ribs.material??'wall');
            for(let k=0;k<n;k++){
              const u=f.len*(k+.5)/n,d=Math.min(ribs.depth,wallDepth(f,u-.12,u+.12));
              if(d>.3)f.box(u,base-ribs.height/2,-d/2,ribs.width,ribs.height,d,concrete);
            }
          }
          if(part.grade?.[r])f.grade=u=>part.grade[r][startEdge]+(part.grade[r][(j+1)%ring.length]-part.grade[r][startEdge])*u/f.len;
          const overrides=Object.entries(s.walls.byWall??{}).filter(([key])=>matches(key,id)).map(([,style])=>style);
          const profile=merge(s.walls.default,part.material?{material:part.material}:null,...overrides,part.facade,r>0||part.courtyardEdges?.includes(j)?s.walls.courtyard:part.wallProfiles?.[id]);
          facade(f,part,id,base,top,lo,profile,pi+':'+r+':'+startEdge);
          if(medium && part.low>2 && /enclosed bridge|trussed link/i.test(part.name) && f.len>(top-base)*3 && profile.sections?.length){
            const n=Math.max(2,Math.round(f.len/((top-base)*1.25))),steel=material(profile.trussMaterial??part.material??'trim');
            for(let k=0;k<n;k++)beam(f.at(f.len*k/n,base+(top-base)*(k%2?.88:.14),.11),f.at(f.len*(k+1)/n,base+(top-base)*(k%2?.14:.88),.11),.13,steel);
          }
          if(near && !f.joinedRoof && r===0 && part.roof.edge==='gutter' && part.low===0 && f.len>3.5){
            const n=Math.ceil(f.len/16),ref=profile.downspout?.material??'trim';
            for(let k=0;k<n;k++){
              const u=.30+(f.len-.60)*k/n;
              rainLeader(f,u,(f.grade?.(u)??base)+.34,top-.30,.18,ref);
            }
          }
          if(medium && !f.joinedRoof && !part.roof.suspension && ['fascia','cornice','gutter'].includes(part.roof.edge))f.box(f.len/2,top-.04,.05,f.len,.12,.19,material('trim'));
        }
      }
    }
    {
      const seen=new Set();
      for(const part of b.parts)for(const row of part.roof.features??[]){
        const key=JSON.stringify(row);
        if(!seen.has(key)){feature(row,part);seen.add(key);}
      }
    }
    if(!collisionOnly){
      suspension(s.roof);
      suspensionTies(s.roof.suspension);
      const board=s.roof.scoreboardSupport;
      if(board){
        const [x,z]=board.center,y=Math.max(...b.parts.map(p=>roofAt(p,x,z))),width=board.width,h=board.heightAboveRoof;
        if(Number.isFinite(y)){
          const m=material(board.material),panel=material('#37383d');
          for(let j=-1;j<=1;j++)block(x+j*width*.38,y+h*.45,z,.20,h*.9,.21,0,m);
          if(medium)for(const side of [-1,1]){
            const end=x+side*width*.38;
            beam([end,y+.16,z-.18],[x,y+h*.54,z-.18],.095,m);
            beam([x,y+.16,z-.18],[end,y+h*.54,z-.18],.095,m);
            beam([end,y+.13,z-.16],[end,y+h*.65,z-.75],.085,m);
          }
          block(x,y+h*.73,z,width,h*.54,.40,0,panel);
          block(x,y+h,z,width+.12,.14,.5,0,m);
        }
      }
    }
    for(const t of s.towers??[])tower(t);
    for(const a of s.attachments??[])attachment(a);
    if(!collisionOnly && !contacts)exposeRoofEdges(firstIndex,firstBox);
    if(ranges)ranges.push([b.id,positions.length/3,boxes.length/8]);
  }
  return {positions:Float32Array.from(positions),normals:Int8Array.from(normals),uvs:Float32Array.from(uvs),styles:Uint16Array.from(styles),index:(positions.length/3>65535?Uint32Array:Uint16Array).from(indices),boxes:Float32Array.from(boxes),palette,solids,footings,...(audit?{ranges}:{})};
}
