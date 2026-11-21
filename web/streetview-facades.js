import * as THREE from 'three';

function facadeMaterial(){
  const material=new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide});
  material.customProgramCacheKey=()=>'modeled-street-frontages-v1';
  material.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec3 finishCoord; varying vec3 finish;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nfinish=finishCoord;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 finish;')
      .replace('#include <color_fragment>',`#include <color_fragment>
        if(finish.z>.5){
          vec2 course=finish.xy*vec2(2.95,7.25);
          course.x+=mod(floor(course.y),2.)*.5;
          vec2 edge=min(fract(course),1.-fract(course));
          vec2 width=min(vec2(.5),fwidth(course));
          vec2 joint=1.-smoothstep(vec2(.014),.025+width,edge);
          float fade=1.-smoothstep(.18,.7,max(width.x,width.y));
          float stone=fract(sin(dot(mod(floor(course),251.),vec2(74.23,41.01)))*3517.83);
          diffuseColor.rgb*=1.+fade*((stone-.5)*.075-max(joint.x,joint.y)*.16);
        }`);
  };
  return material;
}

function alignWindowFragments(items,length,height){
  const peers=items.filter(f=>f.kind==='window' && f.w*length>=.88 && f.h*height>=1.16);
  return items.map(f=>{
    if(f.kind!=='window' || f.w*length>=.88 && f.h*height>=1.16) return f;
    const rows=peers.filter(p=>Math.abs(p.v-f.v)*height<.53 && Math.abs(p.u-f.u)*length<11);
    const columns=peers.filter(p=>Math.abs(p.u-f.u)*length<.46 && Math.abs(p.v-f.v)*height<9);
    const aligned={...f};
    function median(candidates,key){
      const values=candidates.map(p=>p[key]).sort((a,b)=>a-b);
      return values[Math.floor(values.length/2)];
    }
    if(rows.length>=2){
      aligned.v=median(rows,'v');
      aligned.h=Math.max(f.h,Math.min(f.h+.82/height,median(rows,'h'),2*aligned.v,2*(1-aligned.v)));
    }
    if(columns.length>=2){
      aligned.u=median(columns,'u');
      aligned.w=Math.max(f.w,Math.min(f.w+.72/length,median(columns,'w'),2*aligned.u,2*(1-aligned.u)));
    }
    return aligned;
  });
}

export function modelFacadeTile(tile,styles=new Map()){
  const positions=[],colors=[],indices=[],finish=[];
  const features={};
  for(const [ax,az,bx,bz,base,top,nx,nz,building,,items] of tile.panels){
    const length=Math.hypot(bx-ax,bz-az),height=top-base;
    if(length<.12 || height<.12 || !items?.length) continue;
    const tx=(bx-ax)/length,tz=(bz-az)/length,plane=.205;
    const color=(hex,reference,weight)=>new THREE.Color(hex).lerp(new THREE.Color(reference),weight);
    const coating=items.find(item=>item.kind==='wall'),style=styles.get(building);
    const masonry=style ? style.wall.clone() : color(coating?.color??0xb6a794,0xb9ac96,.60);
    if(style && coating){
      const sampled=new THREE.Color(coating.color);
      const value=c=>.21*c.r+.72*c.g+.07*c.b;
      sampled.multiplyScalar(value(masonry)/Math.max(.012,value(sampled)));
      masonry.lerp(sampled,.16);
    }
    const fittings=alignWindowFragments(items,length,height);
    if(style && (coating?.coverage??0)<.78 && [0,1,2,3,6,8].includes(style.pattern)){
      const floor=style.floor,spacing=style.bay;
      const count=Math.max(1,Math.round(length/spacing));
      const pitch=length/count;
      const first=Math.ceil((base-style.base)/floor-.65);
      for(let level=first;style.base+(level+.5)*floor<top;level++){
        const y=style.base+(level+.52)*floor;
        const h=Math.min(floor*.52,(top-y)*1.85,(y-base)*1.85);
        if(h<.8) continue;
        for(let bay=0;bay<count;bay++){
          const u=(bay+.5)/count,v=(y-base)/height;
          const w=Math.min(pitch*(style.pattern===3?.77:style.pattern===0?.43:.54),3.8);
          if(w<.75) continue;
          if(fittings.some(f=>f.kind!=='wall' && f.kind!=='band' && Math.abs(f.u-u)*length<(f.w*length+w)*.5+.35 &&
              Math.abs(f.v-v)*height<(f.h*height+h)*.5+.25)) continue;
          fittings.push({kind:'window',u,v,w:w/length,h:h/height,color:style.glass,authored:true});
        }
      }
    }
    function quad(points,tint,course=0){
      const n=positions.length/3;
      for(const [u,v,d] of points){
        positions.push(ax+tx*u+nx*d,base+v,az+tz*u+nz*d);
        colors.push(tint.r,tint.g,tint.b);
        finish.push(ax*tx+az*tz+u,base+v,course);
      }
      if((tz*nx-tx*nz)>=0) indices.push(n,n+1,n+2,n,n+2,n+3);
      else indices.push(n+2,n+1,n,n+3,n+2,n);
    }
    function face(left,bottom,right,upper,depth,tint,course=0){
      if(right-left>.001 && upper-bottom>.001)
        quad([[left,bottom,depth],[left,upper,depth],[right,upper,depth],[right,bottom,depth]],tint,course);
    }
    function reveals(l,b,r,t,front,back,tint){
      quad([[l,b,back],[l,t,back],[l,t,front],[l,b,front]],tint);
      quad([[r,b,front],[r,t,front],[r,t,back],[r,b,back]],tint);
      quad([[l,t,front],[l,t,back],[r,t,back],[r,t,front]],tint);
      quad([[l,b,back],[l,b,front],[r,b,front],[r,b,back]],tint);
    }
    function relief(l,b,r,t,back,front,tint){
      if(r-l<.012 || t-b<.012) return;
      face(l,b,r,t,front,tint);
      reveals(l,b,r,t,front,back,tint);
    }
    const cuts=[];
    for(const item of fittings){
      if(item.kind==='wall') continue;
      const l=Math.max(0,(item.u-item.w*.5)*length),r=Math.min(length,(item.u+item.w*.5)*length);
      const b=Math.max(0,(item.v-item.h*.5)*height),t=Math.min(height,(item.v+item.h*.5)*height);
      const w=r-l,h=t-b;
      if(w<.055 || h<.055) continue;
      const category=item.authored?'authoredWindow':item.kind;
      features[category]=(features[category]??0)+1;
      if(item.kind==='window' || item.kind==='door'){
        cuts.push([l,b,r,t]);
        const door=item.kind==='door',depth=door?.027:.052;
        const frame=color(door?0x4f514f:0x66747a,0x665d50,.25);
        const glass=color(item.color,door?0x465954:0x587787,door?.45:.60);
        const edge=Math.min(.075,w*.068,h*.062),raise=plane+.035;
        face(l,b,r,t,depth,glass);
        reveals(l,b,r,t,plane,depth,masonry.clone().multiplyScalar(.70));
        relief(l,b,l+edge,t,depth,raise,frame);
        relief(r-edge,b,r,t,depth,raise,frame);
        relief(l+edge,t-edge,r-edge,t,depth,raise,frame);
        relief(l+edge,b,r-edge,b+edge,depth,raise,frame);
        if(door){
          if(w>1.55) relief((l+r)*.5-.028,b,(l+r)*.5+.028,t,depth,plane-.05,frame);
          relief(r-w*.18-.022,b+h*.38,r-w*.18+.022,b+h*.54,depth,plane+.018,color(0xadaba0,0x90866d,.2));
          if(h>1.7) relief(l+edge,b+h*.32,r-edge,b+h*.32+.045,depth,plane-.06,frame);
        }else{
          const panes=Math.min(4,Math.max(1,Math.round(w/1.02)));
          for(let k=1;k<panes;k++){const x=l+w*k/panes;relief(x-.022,b+edge,x+.022,t-edge,depth,plane-.025,frame);}
          if(h>1.45) relief(l+edge,b+h*.66,r-edge,b+h*.66+.047,depth,plane-.025,frame);
          relief(Math.max(0,l-.045),Math.max(0,b-.06),Math.min(length,r+.045),b+.025,plane,plane+.11,masonry.clone().lerp(new THREE.Color(0xc4b9a1),.37));
        }
      }else if(item.kind==='band'||item.kind==='pier'||item.kind==='sign'){
        const sign=item.kind==='sign',pier=item.kind==='pier';
        const tint=color(item.color,sign?0x555954:0xa99981,sign?.12:.20);
        relief(l,b,r,t,plane,plane+(pier?.22:sign?.14:.095),tint);
      }
    }
    const rows=[...new Set([0,height,...cuts.flatMap(v=>[v[1],v[3]])])].sort((a,b)=>a-b);
    for(let i=1;i<rows.length;i++){
      const b=rows[i-1],t=rows[i],mid=(b+t)*.5;
      const spans=cuts.filter(c=>c[1]<mid && c[3]>mid).sort((a,b)=>a[0]-b[0]);
      let left=0;
      for(const [l,,r] of spans){
        if(l>left) face(left,b,l,t,plane,masonry,1);
        left=Math.max(left,r);
      }
      if(left<length) face(left,b,length,t,plane,masonry,1);
    }
    reveals(0,0,length,height,plane,.012,masonry);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.setAttribute('finishCoord',new THREE.Float32BufferAttribute(finish,3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();geometry.computeBoundingSphere();
  const mesh=new THREE.Mesh(geometry,facadeMaterial());
  mesh.name='Modeled doors, sills and window reveals';
  mesh.receiveShadow=true;mesh.castShadow=true;
  mesh.userData.details=features;
  mesh.userData.tile=tile.x+','+tile.z;
  return mesh;
}

export function createStreetviewFacades(data,onChange,credit,architecture,region){
  const group=new THREE.Group(),styles=new Map();
  const forms=architecture.atlas.forms;
  for(const tile of data.tiles) for(const panel of tile.panels){
    const id=panel[8];
    if(styles.has(id)) continue;
    const block=region.blocks[id],core=architecture.core[id-region.blocks.length];
    const form=block?forms[architecture.forms[id][0]]:forms.find(f=>f.name===core?.[0]);
    if(!form) continue;
    const tint=block ? .9+.14*((id*37%29)/28) : 1,wall=new THREE.Color(form.wall).multiplyScalar(tint);
    const correction=data.materials?.[id];
    if(correction){wall.r*=2**correction[3];wall.g*=2**correction[4];wall.b*=2**correction[5];}
    styles.set(id,{...form,wall,base:block?.[2]??core[1]});
  }
  group.name='Street reference architecture';
  const housingTiles=[];
  for(const house of region.southernHousing??[]){
    const [ring,,base,height]=house.block,id=house.index??-house.objectId,eave=base+height-(house.hip?.[0]??0)*.5;
    const style=forms.find(f=>f.name==='brickHome');
    styles.set(id,{...style,wall:new THREE.Color(style.wall),base});
    const panels=[];
    let area=0;
    for(let k=0;k<ring.length;k+=2){const j=(k+2)%ring.length;area+=ring[k]*ring[j+1]-ring[j]*ring[k+1];}
    for(let k=0;k<ring.length;k+=2){
      const j=(k+2)%ring.length,x=ring[k],z=ring[k+1],xx=ring[j],zz=ring[j+1],l=Math.hypot(xx-x,zz-z);
      if(l<2.3) continue;
      panels.push([x,z,xx,zz,base,eave,Math.sign(area)*(zz-z)/l,-Math.sign(area)*(xx-x)/l,id,null,[{kind:'wall',u:.5,v:.5,w:1,h:1,color:style.wall,coverage:0}]]);
    }
    housingTiles.push({x:ring[0],z:ring[1],panels});
  }
  const references=Object.values(data.materialSources??{}).filter(source=>source.kind==='facilities');
  const entries=[...data.tiles,...housingTiles].filter(tile=>tile.panels.length).map(tile=>{
    const bounds=new THREE.Box2();
    for(const [ax,az,bx,bz] of tile.panels){
      bounds.expandByPoint(new THREE.Vector2(ax,az));
      bounds.expandByPoint(new THREE.Vector2(bx,bz));
    }
    return {tile,bounds,mesh:null,wanted:false};
  });
  let lastX=Infinity,lastZ=Infinity,overview=false,queue=[],scheduled=false;
  function updateCredit(){
    if(!credit) return;
    let nearest=75*75,frame,reference;
    for(const {mesh,tile} of entries){
      if(!mesh) continue;
      for(const panel of tile.panels){
        const [ax,az,bx,bz]=panel,dx=bx-ax,dz=bz-az,id=panel[9];
        const t=THREE.MathUtils.clamp(((lastX-ax)*dx+(lastZ-az)*dz)/(dx*dx+dz*dz),0,1);
        const d=(ax+t*dx-lastX)**2+(az+t*dz-lastZ)**2;
        if(d<nearest && data.frames[id]?.url){nearest=d;frame=data.frames[id];}
      }
    }
    if(!frame) for(const source of references){
      const [x,z]=source.pin,d=(x-lastX)**2+(z-lastZ)**2;
      if(d<nearest){nearest=d;reference=source;}
    }
    credit.hidden=!frame && !reference;
    if(frame){
      credit.href=frame.url;
      credit.textContent='Nearby architectural reference · '+(frame.username||'KartaView')+(frame.date?' · '+frame.date.slice(0,10):'');
    }else if(reference){
      credit.href=reference.url;
      credit.textContent=reference.name+' · Western Facilities exterior material reference';
    }
  }
  function buildNext(){
    scheduled=false;
    const entry=queue.shift();
    if(entry?.wanted && !entry.mesh){
      entry.mesh=modelFacadeTile(entry.tile,styles);group.add(entry.mesh);
      updateCredit();onChange?.();
    }
    if(queue.length) schedule();
  }
  function schedule(){
    if(scheduled) return;
    scheduled=true;requestAnimationFrame(buildNext);
  }
  function release(entry){
    entry.wanted=false;
    if(!entry.mesh) return;
    group.remove(entry.mesh);
    entry.mesh.geometry.dispose();entry.mesh.material.dispose();entry.mesh=null;
  }
  function update(x,z,distance){
    const far=distance>520;
    if(far===overview && Math.hypot(x-lastX,z-lastZ)<6) return;
    lastX=x;lastZ=z;overview=far;queue=[];
    const focus=new THREE.Vector2(x,z);
    for(const entry of entries){
      entry.distance=entry.bounds.distanceToPoint(focus);
      if(far||entry.distance>(entry.wanted?320:250)){release(entry);continue;}
      entry.wanted=true;
      if(!entry.mesh) queue.push(entry);
    }
    queue.sort((a,b)=>a.distance-b.distance);
    if(queue.length) schedule();
    updateCredit();
  }
  return {group,update,dispose(){queue=[];entries.forEach(release);updateCredit();}};
}
