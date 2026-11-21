export async function loadArchitecture(THREE,data,buildingMaterials={}) {
  const loader=new THREE.TextureLoader();
  const load=source=>loader.loadAsync(source.startsWith('data:')||source.startsWith('/')||source.startsWith('./')||source.startsWith('http')?source:'data:image/webp;base64,'+source);
  const roofs=await load(data.roof);
  roofs.flipY=false;roofs.colorSpace=THREE.SRGBColorSpace;roofs.magFilter=THREE.NearestFilter;roofs.anisotropy=4;
  const swatches=new Uint8Array(data.atlas.forms.length*8);
  for(const [i,form] of data.atlas.forms.entries()){
    for(const [j,tint] of [form.wall,form.glass].entries())
      swatches.set([tint>>16,(tint>>8)&255,tint&255,j?255:form.pattern],i*8+j*4);
  }
  const styles=new THREE.DataTexture(swatches,2,data.atlas.forms.length);
  styles.needsUpdate=true;
  const material=new THREE.MeshLambertMaterial({side:THREE.DoubleSide,vertexColors:true});
  const rows=Object.entries(buildingMaterials),materialRows=new Map();
  const lut=new Uint8Array((rows.length+1)*8);
  for(const [i,[building,values]] of rows.entries()){
    const row=i+1;
    materialRows.set(Number(building),row);
    for(let k=0;k<2;k++){
      const offset=row*8+k*4;
      for(let ch=0;ch<3;ch++) lut[offset+ch]=Math.round((values[k*3+ch]+1)*127.5);
      lut[offset+3]=Math.round(values[6+k]*255);
    }
  }
  const tones=new THREE.DataTexture(lut,2,rows.length+1);
  tones.needsUpdate=true;
  const materialStrength={value:1};
  material.customProgramCacheKey=()=>'western-modeled-buildings-v4';
  material.onBeforeCompile=shader=>{
    shader.uniforms.styleMap={value:styles};
    shader.uniforms.responseMap={value:tones};
    shader.uniforms.bayStyles={value:data.atlas.forms.length};
    shader.uniforms.photoMaterialStrength=materialStrength;
    shader.uniforms.roofMap={value:roofs};
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
      attribute vec3 buildingUv;
      uniform sampler2D responseMap;
      uniform sampler2D styleMap;
      varying vec4 stoneStyle;
      varying vec3 glassStyle;
      uniform float bayStyles;
      varying vec4 darkResponse;
      varying vec4 lightResponse;
      varying vec3 facadeUV;
      varying vec3 facadePosition;`)
      .replace('#include <begin_vertex>',`#include <begin_vertex>
        facadeUV=buildingUv;
        int response=int(floor((buildingUv.z+.5)/bayStyles));
        darkResponse=vec4(1.,1.,1.,.01);
        lightResponse=vec4(1.,1.,1.,.35);
        if(response>0){
          vec4 dark=texelFetch(responseMap,ivec2(0,response),0);
          vec4 light=texelFetch(responseMap,ivec2(1,response),0);
          darkResponse=vec4(exp2(dark.rgb*2.-1.),dark.a);
          lightResponse=vec4(exp2(light.rgb*2.-1.),light.a);
          facadeUV.z-=float(response)*bayStyles;
        }
        int bay=max(0,int(floor(facadeUV.z+.5)));
        vec4 style=texelFetch(styleMap,ivec2(0,bay),0);
        stoneStyle=vec4(pow(style.rgb,vec3(2.2)),floor(style.a*255.+.5));
        glassStyle=pow(texelFetch(styleMap,ivec2(1,bay),0).rgb,vec3(2.2));
        facadePosition=position;`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
      varying vec3 facadeUV;
      varying vec3 facadePosition;
      varying vec4 stoneStyle;
      varying vec3 glassStyle;
      uniform float photoMaterialStrength;
      varying vec4 darkResponse;
      varying vec4 lightResponse;
      uniform sampler2D roofMap;
      float joint(float v,float thickness){
        float edge=min(fract(v),1.-fract(v));
        float width=min(.18,max(.004,fwidth(v)));
        return (1.-smoothstep(thickness,thickness+width,edge))*(1.-smoothstep(.18,.65,fwidth(v)));
      }`)
      .replace('#include <map_fragment>',`
        if(facadeUV.z< -1.5){
          vec2 courses=vec2((facadePosition.x+facadePosition.z)*3.2,facadePosition.y*5.8);
          courses.x+=mod(floor(courses.y),2.)*.5;
          float tone=.94+.10*fract(sin(dot(floor(courses),vec2(33.7,28.4)))*2147.);
          diffuseColor.rgb*=vec3(.15,.14,.13)*tone*(1.-.10*max(joint(courses.x,.04),joint(courses.y,.04)));
        }else if(facadeUV.z<-.5) {
          vec3 survey=texture2D(roofMap,facadeUV.xy).rgb;
          diffuseColor.rgb*=mix(survey,vec3(dot(survey,vec3(.23,.68,.09))),.08);
        } else {
          vec2 bay=fract(facadeUV.xy);
          float kind=stoneStyle.a, height=facadePosition.y;
          float horizontal=facadePosition.x+facadePosition.z;
          float wood=float(kind==8.),brick=float(kind==2.||kind==6.),panelMetal=float(kind==5.);
          vec2 courses=vec2(horizontal*mix(1.4,3.7,brick),height*mix(3.,9.,brick));
          courses.x+=mod(floor(courses.y),2.)*.5;
          float line=max(joint(courses.x,.027),joint(courses.y,.034));
          float grain=fract(sin(dot(mod(floor(courses),229.),vec2(18.17,4.91)))*16719.)-.5;
          vec3 wall=stoneStyle.rgb*(1.+grain*.095-line*.16);
          if(wood>.5 || panelMetal>.5 || kind==7.) wall=stoneStyle.rgb*(1.-joint(height*mix(2.2,5.8,wood),.045)*.19);
          float width=kind==3.?.91:kind==0.?.5:kind==1.?.65:.57;
          float above=kind==0.? .68+.19*(1.-abs(2.*(bay.x-.5)/width)):.82;
          float border=min((width*.5-abs(bay.x-.5)),min(bay.y-.24,above-bay.y));
          if(kind<4. || wood>.5 || kind==6.){
            if(border>-.025) wall=stoneStyle.rgb*1.13+vec3(.009);
            if(border>.008){
              float reflection=.84+.32*bay.y+.08*fract(floor(facadeUV.x)*.631+floor(facadeUV.y)*.313);
              wall=glassStyle*reflection+vec3(.009,.015,.022)*smoothstep(.42,.76,bay.y);
              float mullion=max(1.-smoothstep(.007,.02,abs(bay.x-.5)),1.-smoothstep(.009,.02,abs(bay.y-.61)));
              wall=mix(wall,stoneStyle.rgb*.57,mullion);
            }
          }
          float value=dot(wall,vec3(.2126,.7152,.0722));
          float tone=smoothstep(darkResponse.a,max(darkResponse.a+.008,lightResponse.a),value);
          wall*=mix(vec3(1.),mix(darkResponse.rgb,lightResponse.rgb,tone),photoMaterialStrength);
          diffuseColor.rgb*=wall;
        }`);
  };
  return {data,material,materialRows,materialStrength};
}

function clippedRoof(poly,project,sign) {
  const points=[];
  for(let i=0;i<poly.length;i++) {
    const a=poly[i],b=poly[(i+1)%poly.length];
    const u=project(a)*sign,v=project(b)*sign;
    if(u>=-1e-6) points.push(a);
    if(u*v<0) {
      const t=u/(u-v);
      points.push(a.clone().lerp(b,t));
    }
  }
  return points;
}

export function createArchitecture(THREE,region,architecture,world,groundAt) {
  const group=new THREE.Group();
  group.name='Surveyed roofs and street facades';
  const {data,material,materialRows}=architecture;
  let row=0,originalStyle=-1,slate=false;
  const chunks=new Map();
  const [x0,z0,x1,z1]=region.bounds;
  const roofUv=(x,z)=>[(x-x0)/(x1-x0),(z-z0)/(z1-z0),slate?-2:-1];
  function chunk(x,z) {
    const key=Math.floor(x/112)+','+Math.floor(z/112);
    if(!chunks.has(key)) chunks.set(key,{positions:[],indices:[],uv:[],colors:[]});
    return chunks.get(key);
  }
  function vertex(buf,x,y,z,uv,tint) {
    buf.positions.push(x,y,z);
    buf.colors.push(tint,tint,tint);
    buf.uv.push(uv[0],uv[1],uv[2]===originalStyle && uv[2]>=0 ? uv[2]+row*data.atlas.forms.length : uv[2]);
  }
  function wall(buf,p,q,low,highA,highB,style,bayCount,base,storey,tint,phase=0) {
    const id=buf.positions.length/3;
    const v0=(low-base)/storey, va=(highA-base)/storey,vb=(highB-base)/storey;
    vertex(buf,p.x,low,p.y,[phase,v0,style],tint);
    vertex(buf,p.x,highA,p.y,[phase,va,style],tint);
    vertex(buf,q.x,highB,q.y,[phase+bayCount,vb,style],tint);
    vertex(buf,q.x,low,q.y,[phase+bayCount,v0,style],tint);
    buf.indices.push(id,id+1,id+2,id,id+2,id+3);
  }
  function roof(buf,polygon,holes,roofY,soffit=false) {
    const faces=THREE.ShapeUtils.triangulateShape(polygon,holes);
    const offset=buf.positions.length/3;
    for(const ring of [polygon,...holes]) for(const p of ring)
      vertex(buf,p.x,roofY(p),p.y,soffit?[p.x/3,p.y/3,panel]:roofUv(p.x,p.y),soffit?.82:1.20);
    for(const [a,b,c] of faces) buf.indices.push(offset+(soffit?a:c),offset+b,offset+(soffit?c:a));
  }
  const blank=data.atlas.forms.findIndex(form=>form.name==='stone');
  const panel=data.atlas.forms.findIndex(form=>form.name==='panel');
  function ringsOf(input){
    return input.map(r=>{
      const loop=[];
      for(let n=0;n<r.length;n+=2) loop.push(new THREE.Vector2(r[n],r[n+1]));
      return loop;
    });
  }
  function cutEdge(p,q){
    const epsilon=.035;
    const horizontal=Math.abs(q.y-p.y)<epsilon && (Math.abs(q.y)<epsilon || Math.abs(q.y-world.depth)<epsilon);
    const vertical=Math.abs(q.x-p.x)<epsilon && (Math.abs(q.x)<epsilon || Math.abs(q.x-world.width)<epsilon);
    return horizontal && p.x>=-.01 && p.x<=world.width+.01 && q.x>=-.01 && q.x<=world.width+.01 ||
      vertical && p.y>=-.01 && p.y<=world.depth+.01 && q.y>=-.01 && q.y<=world.depth+.01;
  }
  function foundation(buf,p,q,base) {
    const deep=Math.min(base-1,groundAt?.(p.x,p.y)??base,groundAt?.(q.x,q.y)??base)-3;
    wall(buf,p,q,deep,base,base,blank,p.distanceTo(q)/3.2,base,3.4,.77);
  }
  function contains(loops,x,z) {
    let inside=false;
    for(const loop of loops) for(let i=0,j=loop.length-1;i<loop.length;j=i++){
      const a=loop[i],b=loop[j];
      if((a.y>z)!==(b.y>z) && x<(b.x-a.x)*(z-a.y)/(b.y-a.y)+a.x) inside=!inside;
    }
    return inside;
  }
  function tiers(buf,bands,base,style,form,tint,patches) {
    const profiles=patches?bands.flatMap((band,i)=>patches[i]??[band]):bands;
    const areas=profiles.map(([height,rings,opening])=>{
      const loops=ringsOf(rings);
      return {height,opening,loops,box:new THREE.Box2().setFromPoints(loops[0])};
    });
    for(const area of areas){
      const top=base+area.height;
      roof(buf,area.loops[0],area.loops.slice(1),()=>top);
      if(area.opening!==undefined) roof(buf,area.loops[0],area.loops.slice(1),()=>base+area.opening,true);
      for(const [index,loop] of area.loops.entries()){
        const normalSign=(THREE.ShapeUtils.isClockWise(loop)?-1:1)*(index===0?1:-1);
        for(let j=0;j<loop.length;j++){
          const p=loop[j],q=loop[(j+1)%loop.length],length=p.distanceTo(q);
          if(length<.04 || cutEdge(p,q)) continue;
          const mx=(p.x+q.x)/2+normalSign*(q.y-p.y)*.09/length;
          const mz=(p.y+q.y)/2-normalSign*(q.x-p.x)*.09/length;
          const adjacent=areas.find(other=>other!==area && other.box.min.x<=mx && other.box.max.x>=mx &&
            other.box.min.y<=mz && other.box.max.y>=mz && contains(other.loops,mx,mz));
          const along=(p.x*(q.x-p.x)+p.y*(q.y-p.y))/length;
          const bottom=base+(area.opening??0);
          if(area.opening===undefined && (!adjacent || adjacent.opening!==undefined)) foundation(buf,p,q,base);
          if(adjacent?.opening!==undefined && bottom<base+adjacent.opening-.03)
            wall(buf,p,q,bottom,Math.min(top,base+adjacent.opening),Math.min(top,base+adjacent.opening),panel,length/form.bay,base,form.floor,tint*.87,along/form.bay);
          const low=Math.max(bottom,base+(adjacent?.height??0));
          if(top<=low+.03) continue;
          const release=top-low;
          const cladding=adjacent && release<form.floor*1.12 ? panel : style;
          wall(buf,p,q,low,top,top,cladding,length/form.bay,base,form.floor,tint,along/form.bay);
        }
      }
    }
  }
  const housing=new Map((region.southernHousing??[]).map(h=>[h.index??-h.objectId,h]));
  const footprints=region.blocks.map((b,i)=>[i,b]);
  for(const [i,h] of housing) if(i<0) footprints.push([i,h.block]);
  const housingStyle=data.atlas.forms.findIndex(f=>f.name==='brickHome');
  for(const [i,footprint] of footprints) {
    const [ring,holes,base,height]=footprint;
    if(region.campusBoundary){
      let l=Infinity,t=Infinity,r=-Infinity,b=-Infinity;
      for(let j=0;j<ring.length;j+=2){l=Math.min(l,ring[j]);r=Math.max(r,ring[j]);t=Math.min(t,ring[j+1]);b=Math.max(b,ring[j+1]);}
      if(!region.campusBoundary.intersects(l,t,r,b))continue;
    }
    const house=housing.get(i);slate=Boolean(house);
    const [style,ridge]=house?[housingStyle,[]]:data.forms[i];
    row=materialRows?.get(i)??0;originalStyle=style;
    const form=data.atlas.forms[style];
    const buf=chunk(ring[0],ring[1]);
    const loops=ringsOf([ring,...holes]);
    const hip=house?.hip??data.hips?.[i];
    const eaves=base+height-(ridge.length?ridge[4]*.50:hip?hip[0]*.50:0);
    const storeys=Math.max(1,Math.round((eaves-base)/form.floor)),storey=(eaves-base)/storeys;
    const wallTint=.91+.15*((i*37%29)/28);
    const bands=data.tiers?.[i];
    if(bands){
      tiers(buf,bands,base,style,form,wallTint,region.buildingBases?.[i]?.tiers);
      continue;
    }
    const ridgeOffset=p=>ridge.length?(p.x-ridge[0])*Math.cos(ridge[2])-(p.y-ridge[1])*Math.sin(ridge[2]):0;
    const roofY=p=>ridge.length?eaves+ridge[4]*Math.max(0,1-Math.abs(ridgeOffset(p))/(ridge[3]/2)):eaves;
    if(hip){
      const [,vertices,triangles]=hip,offset=buf.positions.length/3;
      for(let j=0;j<vertices.length;j+=3){
        const x=vertices[j],z=vertices[j+1];
        vertex(buf,x,eaves+vertices[j+2],z,roofUv(x,z),1.20);
      }
      for(let j=0;j<triangles.length;j+=3) buf.indices.push(offset+triangles[j+2],offset+triangles[j+1],offset+triangles[j]);
    } else if(ridge.length && !holes.length) {
      for(const s of [-1,1]) {
        const half=clippedRoof(loops[0],ridgeOffset,s);
        if(half.length>=3) roof(buf,half,[],roofY);
      }
    } else roof(buf,loops[0],loops.slice(1),roofY);
    for(const loop of loops) for(let k=0;k<loop.length;k++) {
      const p=loop[k],q=loop[(k+1)%loop.length],length=p.distanceTo(q);
      if(length<.015 || cutEdge(p,q)) continue;
      foundation(buf,p,q,base);
      const bays=Math.max(1,Math.round(length/form.bay));
      const wallStyle=form.name==='garageDoor' && length<3.3 ? data.atlas.forms.findIndex(s=>s.name==='panel') : style;
      wall(buf,p,q,base,eaves,eaves,wallStyle,bays,base,storey,wallTint);
      if(ridge.length) {
        const points=[p],a=ridgeOffset(p),b=ridgeOffset(q);
        if(a*b<0) points.push(p.clone().lerp(q,a/(a-b)));
        points.push(q);
        for(let j=1;j<points.length;j++){
          const left=points[j-1],right=points[j];
          if(Math.max(roofY(left),roofY(right))-eaves>.025){
            const trim=data.atlas.forms.findIndex(s=>s.name==='panel');
            wall(buf,left,right,eaves,roofY(left),roofY(right),trim,right.distanceTo(left)/4,base,4,.94);
          }
        }
      }
    }
  }
  function stoneProjection(buf,p,q,nx,nz,low,high,depth,tint) {
    const frontP=new THREE.Vector2(p.x+nx*depth,p.y+nz*depth);
    const frontQ=new THREE.Vector2(q.x+nx*depth,q.y+nz*depth);
    for(const [start,end] of [[frontP,frontQ],[p,frontP],[frontQ,q]])
      wall(buf,start,end,low,high,high,blank,start.distanceTo(end)/2.2,low,2.4,tint);
    const id=buf.positions.length/3;
    for(const [u,v,point] of [[0,0,p],[0,.15,frontP],[p.distanceTo(q)/2,.15,frontQ],[p.distanceTo(q)/2,0,q]])
      vertex(buf,point.x,high,point.y,[u,v,blank],tint*1.18);
    buf.indices.push(id,id+1,id+2,id,id+2,id+3);
  }
  function collegeStonework(buf,p,q,nx,nz,base,top,name,bays) {
    const length=p.distanceTo(q),height=top-base;
    stoneProjection(buf,p,q,nx,nz,top-.30,top,.21,1.32);
    stoneProjection(buf,p,q,nx,nz,base+.75,base+.93,.16,1.19);
    if(length<3) return;
    const floors=Math.max(1,Math.round(height/(name==='universityBay'?4.6:4.18)));
    const step=length/bays;
    for(let n=0;n<bays;n++){
      const centre=(n+.5)/bays;
      const width=(name==='universityBay'?.53:.45)/bays;
      const left=p.clone().lerp(q,centre-width/2),right=p.clone().lerp(q,centre+width/2);
      for(let f=0;f<floors;f++){
        const sill=base+height/floors*(f+.20);
        stoneProjection(buf,left,right,nx,nz,sill-.13,sill+.02,.12,1.40);
      }
      if(n===0 || n%3 || step<2.8) continue;
      const a=p.clone().lerp(q,n/bays-.27/length),b=p.clone().lerp(q,n/bays+.27/length);
      stoneProjection(buf,a,b,nx,nz,base+.9,base+height*.55,.36,1.05);
      stoneProjection(buf,a,b,nx,nz,base+height*.55,top-.25,.23,1.14);
    }
  }
  function conronHall(base){
    const angle=Math.PI/18,nx=Math.cos(angle),nz=Math.sin(angle);
    const front=v=>new THREE.Vector2(301.5+2.73*nx-v*nz,310.5+2.73*nz+v*nx);
    const a=front(4.5),b=front(33.1),buf=chunk(a.x,a.y);
    const arch=data.atlas.forms.findIndex(f=>f.name==='conronTracery');
    const sash=data.atlas.forms.findIndex(f=>f.name==='universityBay');
    wall(buf,a,b,base+5.2,base+14.9,base+14.9,arch,5,base+5.2,9.7,1.07);
    wall(buf,a,b,base+.65,base+5.2,base+5.2,sash,5,base+.65,4.55,1.04);
    stoneProjection(buf,a,b,nx,nz,base+5.06,base+5.29,.24,1.37);
    for(let k=0;k<=5;k++){
      const station=4.5+k*5.72,left=front(station-.24),right=front(station+.24);
      stoneProjection(buf,left,right,nx,nz,base+5.28,base+14.85,.39,1.18);
      stoneProjection(buf,left,right,nx,nz,base+14.85,base+15.37,.27,1.35);
    }
  }
  slate=false;
  for(const [i,[name,base,segments]] of data.core.entries()) {
    const style=data.atlas.forms.findIndex(form=>form.name===name),form=data.atlas.forms[style];
    row=materialRows?.get(region.blocks.length+i)??0;originalStyle=style;
    const college=name==='universityBay'||name==='middlesexBay';
    if(name==='universityBay') conronHall(base);
    for(const [ax,az,bx,bz,top,nx,nz] of segments) {
      const buf=chunk((ax+bx)/2,(az+bz)/2);
      const p=new THREE.Vector2(ax,az),q=new THREE.Vector2(bx,bz);
      const floors=Math.max(1,Math.round((top-base)/form.floor));
      foundation(buf,p,q,base);
      const bays=Math.max(1,Math.round(p.distanceTo(q)/form.bay));
      wall(buf,p,q,base,top,top,style,bays,base,(top-base)/floors,1);
      if(college) collegeStonework(buf,p,q,nx,nz,base,top,name,bays);
      const id=buf.positions.length/3;
      for(const point of [p,q]) for(const d of [0,-1.38]) {
        const x=point.x+nx*d,z=point.y+nz*d;
        vertex(buf,x,top,z,[d*.1,0,data.atlas.forms.findIndex(s=>s.name==='stone')],.86);
      }
      buf.indices.push(id,id+1,id+2,id+1,id+3,id+2);
    }
  }
  for(const buf of chunks.values()) {
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(buf.positions,3));
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(buf.colors,3));
    geometry.setAttribute('buildingUv',new THREE.Float32BufferAttribute(buf.uv,3));
    geometry.setIndex(buf.indices);
    geometry.computeVertexNormals();geometry.computeBoundingSphere();
    const mesh=new THREE.Mesh(geometry,material);
    mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);
  }
  return group;
}
