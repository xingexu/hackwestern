import {estateBoundary,joinTerrainEdges} from './look/ground-join.mjs';
import {riverFinish} from './look/water.mjs';
export function createDrivingHorizon(THREE,data,landscape){
  const positions=[],colors=[],cells=new Map(),surveyAt=landscape.heightAt;
  const key=(x,z)=>Math.floor(x/8)+','+Math.floor(z/8);
  const lawn=new THREE.Color(0x819967);
  const elevation=(x,survey,z,rim)=>{
    const t=Math.min(1,Math.max(0,(z-data.edge)/26));
    return survey+(surveyAt(x,data.edge)-rim)*(1-t*t*(3-2*t));
  };
  for(let i=0;i<data.indices.length;i+=3){
    const a=data.vertices[data.indices[i]],b=data.vertices[data.indices[i+1]],c=data.vertices[data.indices[i+2]];
    const start=positions.length;
    const cross=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);
    for(const [x,survey,z,rim] of cross>0?[a,c,b]:[a,b,c]){
      const y=elevation(x,survey,z,rim);
      const tone=.97+.028*Math.sin(x*.039+z*.025)+.018*Math.cos(z*.049-x*.021);
      positions.push(x,y,z);
      colors.push(lawn.r*tone,lawn.g*tone,lawn.b*tone);
    }
    const triangle=positions.slice(start);
    const xs=[triangle[0],triangle[3],triangle[6]],zs=[triangle[2],triangle[5],triangle[8]];
    for(let row=Math.floor(Math.min(...zs)/8);row<=Math.floor(Math.max(...zs)/8);row++)
      for(let col=Math.floor(Math.min(...xs)/8);col<=Math.floor(Math.max(...xs)/8);col++){
        const bin=col+','+row;
        if(!cells.has(bin))cells.set(bin,[]);
        cells.get(bin).push(triangle);
      }
  }
  landscape.estateBoundary=estateBoundary(data.vertices,data.indices,elevation);
  landscape.heightAt=(x,z)=>{
    if(z<=data.edge)return surveyAt(x,z);
    for(const [ax,ay,az,bx,by,bz,cx,cy,cz] of cells.get(key(x,z))??[]){
      const a=(cx-bx)*(z-bz)-(cz-bz)*(x-bx);
      const b=(ax-cx)*(z-cz)-(az-cz)*(x-cx);
      const c=(bx-ax)*(z-az)-(bz-az)*(x-ax);
      if(Math.max(a,b,c)<.00001)return (a*ay+b*by+c*cy)/(a+b+c);
    }
    return surveyAt(x,z);
  };
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  const normals=[];
  for(let i=0;i<positions.length;i+=3){
    const x=positions[i],z=positions[i+2],d=.5;
    const dx=landscape.heightAt(x+d,z)-landscape.heightAt(x-d,z);
    const dz=landscape.heightAt(x,z+d)-landscape.heightAt(x,z-d);
    const length=Math.hypot(dx,2*d,dz);
    normals.push(-dx/length,2*d/length,-dz/length);
  }
  g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  g.computeBoundingSphere();
  const material=landscape.estatesMaterial??new THREE.MeshStandardMaterial({vertexColors:true});
  const park=new THREE.Mesh(g,material);
  park.name='Platt’s Lane Estates campus grounds';
  park.receiveShadow=true;
  const waterMaterial=new THREE.MeshStandardMaterial({roughness:.27,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  waterMaterial.customProgramCacheKey=()=>'north-thames-water';
  waterMaterial.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 waterXZ;').replace('#include <begin_vertex>','#include <begin_vertex>\nwaterXZ=position.xz;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 waterXZ;')
      .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb=riverColour(vec3(0.),waterXZ,1.);');
    riverFinish(shader,'waterXZ','1.');
  };
  for(const reach of data.water){
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(reach.vertices.flat(),3));
    geo.setIndex(reach.indices);
    geo.computeVertexNormals();geo.computeBoundingSphere();
    const mesh=new THREE.Mesh(geo,waterMaterial);
    mesh.name='North Thames inside the Western campus parcel';
    mesh.receiveShadow=true;park.add(mesh);
  }
  return park;
}


export function campusEntranceMarker(THREE,roadData,network,boundary){
  const crossing=roadData.ways.find(w=>String(w.id)==='142399227'&&w.bridge);
  if(!crossing)return null;
  const points=crossing.points[0][0]>crossing.points.at(-1)[0]?crossing.points:[...crossing.points].reverse();
  const [x,y,z]=points[0],dx=x-points[1][0],dz=z-points[1][2],length=Math.hypot(dx,dz),ux=dx/length,uz=dz/length;
  let distance=0;
  while(distance<40&&boundary.contains(x+ux*distance,z+uz*distance))distance+=.15;
  const exit=distance-2.8,X=x+ux*exit,Z=z+uz*exit;
  const group=new THREE.Group(),wood=new THREE.MeshStandardMaterial({color:0x75685b}),metal=new THREE.MeshStandardMaterial({color:0x676f71});
  group.name='Playable campus limit at University Drive';
  group.position.set(X,network.sample(X,Z,y).y,Z);
  group.rotation.y=Math.atan2(ux,uz);
  function box(width,height,depth,x,y,z,material,lean=0){
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(width,height,depth),material);
    mesh.position.set(x,y,z);mesh.rotation.x=lean;group.add(mesh);
    mesh.updateWorldMatrix(true,false);
    network.addBox?.(mesh.matrixWorld.clone().scale(new THREE.Vector3(width,height,depth)).elements,'campus barrier');
    return mesh;
  }
  const lamps=new THREE.MeshStandardMaterial({color:0xffac39,emissive:0xd67d19,emissiveIntensity:.50});
  function sign(width,height,y,paint){
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=Math.round(1024*height/width);
    paint(canvas.getContext('2d'),canvas.width,canvas.height);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=8;
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(width,height),new THREE.MeshStandardMaterial({map:texture}));
    panel.position.set(0,y,-.052);panel.rotation.y=Math.PI;group.add(panel);
    box(width,height,.09,0,y,0,metal);
  }
  for(const u of [-3.15,3.15]){
    for(const side of [-1,1])box(.13,1.72,.13,u,.84,side*.26,wood,-side*.27);
    const lamp=new THREE.Mesh(new THREE.SphereGeometry(.145,8,6),lamps);lamp.position.set(u,1.82,0);group.add(lamp);
  }
  for(const y of [.69,1.36])sign(7.25,.29,y,(ctx,w,h)=>{
    ctx.fillStyle='#faf2d6';ctx.fillRect(0,0,w,h);ctx.fillStyle='#d76834';
    for(let x=-80;x<w+80;x+=100){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x+49,0);ctx.lineTo(x+49-h,h);ctx.lineTo(x-h,h);ctx.closePath();ctx.fill();}
  });
  for(const u of [-.86,.86])box(.06,1.1,.06,u,1.67,.045,metal);
  sign(2.35,.55,1.95,(ctx,w,h)=>{
    ctx.fillStyle='#f0e9d4';ctx.fillRect(0,0,w,h);ctx.fillStyle='#3e3457';ctx.fillRect(6,6,w-12,h-12);
    ctx.fillStyle='#fff6de';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold '+Math.round(h*.56)+'px sans-serif';ctx.fillText('CAMPUS LIMIT',w/2,h*.53,w*.92);
  });
  return group;
}

export function anchoredHeight(vertices,bindings,i){
  const a=bindings[i+1]*3+1,b=bindings[i+2]*3+1,c=bindings[i+3]*3+1;
  const y=vertices[a];
  return y+bindings[i+4]*(vertices[b]-y)+bindings[i+5]*(vertices[c]-y);
}

export async function createCampusContext(THREE,meta,landscape,unpack,groundDetail,contextTrees){
  const [vertexBytes,indexBytes,coverBytes,treeBytes]=await Promise.all([meta.vertices,meta.indices,meta.coverage??meta.cover,meta.trees].map(unpack));
  const source=new Float32Array(vertexBytes),indices=new Uint32Array(indexBytes);
  const positions=new Float32Array(source.length/4*3);
  for(let k=0;k<source.length;k+=4){
    const [x,y,z,d]=source.subarray(k,k+4),t=Math.min(1,d/12);
    const rim=d<.01 && z>landscape.zs.at(-1)?landscape.estateBoundary?.height(x,z):undefined;
    const near=rim??(t<1?landscape.heightAt(x,z):y);
    positions.set([x,near+(y-near)*t*t*(3-2*t),z],k/4*3);
  }
  for(let k=0;k<indices.length;k+=3){
    const a=indices[k]*3,b=indices[k+1]*3,c=indices[k+2]*3;
    if((positions[b]-positions[a])*(positions[c+2]-positions[a+2])>(positions[b+2]-positions[a+2])*(positions[c]-positions[a])){
      [indices[k+1],indices[k+2]]=[indices[k+2],indices[k+1]];
    }
  }
  const joined=joinTerrainEdges(positions,indices,source,landscape);
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(joined.vertices,3));
  geo.setIndex(new THREE.BufferAttribute(joined.faces,1));
  geo.computeVertexNormals();
  const normals=geo.attributes.normal,vertices=geo.attributes.position,normal=new THREE.Vector3(),surveyNormal=new THREE.Vector3();
  for(let i=0;i<vertices.count;i++){
    const distance=i*4<source.length?source[i*4+3]:0;
    if(distance>=6)continue;
    const x=vertices.getX(i),z=vertices.getZ(i),d=.5;
    surveyNormal.set(landscape.heightAt(x-d,z)-landscape.heightAt(x+d,z),2*d,landscape.heightAt(x,z-d)-landscape.heightAt(x,z+d)).normalize();
    normal.fromBufferAttribute(normals,i).lerp(surveyNormal,1-distance/6).normalize();
    normals.setXYZ(i,normal.x,normal.y,normal.z);
  }
  const [w,h]=meta.size;
  let masks=new Uint8Array(coverBytes);
  if(!meta.coverage){
    const legacy=masks;
    masks=new Uint8Array(w*h*4);
    for(let k=0;k<legacy.length;k++)if(legacy[k])masks[k*4+legacy[k]-1]=255;
  }
  const cover=new THREE.DataTexture(masks,w,h,THREE.RGBAFormat);
  cover.magFilter=THREE.LinearFilter;cover.minFilter=THREE.LinearMipmapLinearFilter;cover.generateMipmaps=true;
  cover.needsUpdate=true;
  const material=new THREE.MeshStandardMaterial({roughness:.94});
  material.customProgramCacheKey=()=>'surveyed-campus-surroundings-2';
  material.onBeforeCompile=shader=>{
    shader.uniforms.contextCover={value:cover};
    shader.uniforms.regionalPavement={value:landscape.pavement};
    shader.uniforms.surveyColour={value:landscape.grassVigor};
    shader.uniforms.regionalBounds={value:new THREE.Vector4(...landscape.regionBounds)};
    shader.uniforms.contextBounds={value:new THREE.Vector4(...meta.bounds)};
    shader.uniforms.groundGrain={value:landscape.groundGrain};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 contextXZ;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\ncontextXZ=position.xz;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
      varying vec2 contextXZ; uniform sampler2D contextCover,regionalPavement,surveyColour; uniform vec4 contextBounds,regionalBounds;
      ${groundDetail}`).replace('#include <color_fragment>',`#include <color_fragment>
      vec2 uv=(contextXZ-contextBounds.xy)/(contextBounds.zw-contextBounds.xy);
      vec4 weights=texture2D(contextCover,uv);
      vec4 spread=clamp(fwidth(weights),.035,.43);
      vec4 edge=smoothstep(.5-spread,.5+spread,weights);
      vec3 grain=groundParticle(contextXZ);
      vec2 regionalUV=(contextXZ-regionalBounds.xy)/(regionalBounds.zw-regionalBounds.xy);
      vec2 surveyTone=texture2D(surveyColour,clamp(regionalUV,0.,1.)).rg;
      vec3 land=summerLawn(contextXZ,surveyTone.r,grain.r);
      vec3 woodland=forestFloor(contextXZ,grain);
      float trees=textureLod(contextCover,uv,2.25).g;
      float canopy=textureLod(contextCover,uv,4.25).g;
      float litter=max(trees,.77*smoothstep(.19,.75,canopy));
      land=mix(land,woodland,smoothstep(.04,.96,litter+.10*(grain.b-.05)));
      land=mix(land,vec3(.094,.093,.087)*(1.+.44*grain.g+.55*(surveyTone.g-.502)),edge.r);
      land=mix(land,vec3(.286,.270,.240)*(1.+.37*grain.b),edge.b);
      float shore=smoothstep(.04,.46,weights.a);
      land=mix(land,vec3(.12,.13,.077)*(1.+grain.b*.36),shore);
      land=riverColour(land,contextXZ,edge.a);
      
      if(all(greaterThanEqual(regionalUV,vec2(0.)))&&all(lessThanEqual(regionalUV,vec2(1.)))){
        float street=texture2D(regionalPavement,regionalUV).r;
        float aa=clamp(fwidth(street),.025,.44);
        float aggregate=riverNoise(contextXZ*2.6)-.5,wear=riverNoise(contextXZ*.091)-.5;
        vec3 bitumen=vec3(.061,.062,.061)*(1.+.46*grain.g+.17*aggregate+.21*wear+.55*(surveyTone.g-.502));
        land=mix(land,bitumen,smoothstep(.5-aa,.5+aa,street)*(1.-edge.a));
      }
      diffuseColor.rgb*=land;`);
    riverFinish(shader,'contextXZ','edge.a');
  };
  const group=new THREE.Group();
  group.name='Landscape beyond the playable parcel';
  const ground=new THREE.Mesh(geo,material);
  ground.receiveShadow=true;
  group.add(ground);
  const trees=new Float32Array(treeBytes);
  if(meta.backdrop?.nearStems){
    const bindings=new Float32Array(await unpack(meta.backdrop.nearStems));
    for(let i=0;i<bindings.length;i+=6)trees[bindings[i]*4+3]=anchoredHeight(positions,bindings,i);
  }
  const vegetation=contextTrees(THREE,trees,landscape.permitsContextTree);
  group.add(vegetation);
  group.traverse(o=>o.layers.set(1));
  group.userData.vertices=positions;
  group.userData.update=vegetation.userData.update;
  return group;
}
