import {edgeGLSL} from './look/surface-response.mjs';
import {riverFinish} from './look/water.mjs';
import {bindGroundEdge,groundDetailGLSL} from 'campus-terrain';
import { createArchitecture } from 'campus-architecture';
import {barkGrainGLSL,foliageCluster,leafSprayTexture,lightLeafBacks} from 'leaf-sprays';

export function createCampusRegion(THREE, region, world, aerial, stoneMaterial, architecture, landscape) {
  const group = new THREE.Group();
  group.name = 'Western campus region';
  const { xs, zs, ortho, bounds } = region;
  const bytes = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
  const elevations = new Int16Array(bytes(region.elevation).buffer);
  function fallbackOrtho(){
    const rgb = bytes(ortho.palette);
    const pixels = bytes(ortho.pixels);
    const rgba = new Uint8Array(pixels.length * 4);
    for (let i = 0; i < pixels.length; i++) {
      const src = pixels[i] * 3, dest = i * 4;
      rgba[dest] = rgb[src];
      rgba[dest + 1] = rgb[src + 1];
      rgba[dest + 2] = rgb[src + 2];
      rgba[dest + 3] = 255;
    }
    return new THREE.DataTexture(rgba,ortho.width,ortho.height);
  }
  const texture=landscape?.preview??fallbackOrtho();
  texture.flipY=false;
  texture.anisotropy=4;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  group.userData.orthophoto = texture;
  function conditionTexture(tiles){
    const cells=Object.values(tiles??{}).flatMap(tile=>tile.cells??[]);
    if(!cells.length)return null;
    const xs=cells.map(c=>c[0]),zs=cells.map(c=>c[1]);
    const left=Math.min(...xs)-1,top=Math.min(...zs)-1,right=Math.max(...xs)+2,bottom=Math.max(...zs)+2;
    const width=right-left,height=bottom-top,pixels=new Uint8Array(width*height*4);
    for(const [x,z,road,walk,paint] of cells){
      const at=((z-top)*width+x-left)*4;
      pixels[at]=Math.max(pixels[at],road*85);
      pixels[at+1]=Math.max(pixels[at+1],walk*85);
      pixels[at+2]=Math.max(pixels[at+2],paint*85);
      pixels[at+3]=255;
    }
    const tex=new THREE.DataTexture(pixels,width,height);
    tex.minFilter=tex.magFilter=THREE.LinearFilter;
    tex.needsUpdate=true;
    tex.userData.bounds=[left*8,top*8,right*8,bottom*8];
    return tex;
  }
  const observations=conditionTexture(aerial.groundMaterials);
  function terrainMaterial(map,highResolution,finish=null,conditions=null,guide=null) {
    const material=new THREE.MeshStandardMaterial({map});
    if(!landscape) return material;
    const gameGround=highResolution||landscape.racing;
    material.customProgramCacheKey=()=>[gameGround,!!finish,!!conditions,guide?.format??0].join('-');
    material.userData.finish=finish;
    material.userData.walkGuide=guide;
    material.userData.conditions=conditions;
    if(conditions) material.userData.conditionStrength={value:1};
    material.onBeforeCompile=shader=>{
      shader.uniforms.groundGrain={value:landscape.groundGrain};
      shader.uniforms.pavementDetail={value:landscape.pavementDetail};
      shader.uniforms.pavingTone={value:landscape.pavingTone};
      bindGroundEdge(shader,landscape);
      shader.uniforms.surfaceCoverage={value:landscape.surfaceCoverage};
      shader.uniforms.grassVigor={value:landscape.grassVigor};
      shader.uniforms.pavementMap={value:landscape.pavement};
      shader.uniforms.landTransitions={value:landscape.landTransitions};
      shader.uniforms.coverSize={value:new THREE.Vector2(landscape.landTransitions.image.width,landscape.landTransitions.image.height)};
      shader.uniforms.coverBounds={value:new THREE.Vector4(...landscape.landTransitions.userData.bounds)};
      shader.uniforms.finishMap={value:finish};
      shader.uniforms.walkGuide={value:guide};
      if(conditions){
        shader.uniforms.conditionMap={value:conditions};
        shader.uniforms.conditionStrength=material.userData.conditionStrength;
        shader.uniforms.conditionBounds={value:new THREE.Vector4(...conditions.userData.bounds)};
      }
      shader.uniforms.surveyBounds={value:new THREE.Vector4(...bounds)};
      shader.vertexShader=shader.vertexShader
        .replace('#include <common>','#include <common>\nvarying vec2 surveyPoint;')
        .replace('#include <begin_vertex>','#include <begin_vertex>\nsurveyPoint=position.xz;');
      shader.fragmentShader=shader.fragmentShader
        .replace('#include <common>',`#include <common>
          ${groundDetailGLSL}
          varying vec2 surveyPoint;
          uniform sampler2D grassVigor,pavementDetail,surfaceCoverage,walkGuide;
          uniform highp sampler2DArray pavingTone;
          ${edgeGLSL}
          uniform sampler2D pavementMap,finishMap,conditionMap,landTransitions;
          uniform vec2 coverSize;
          uniform vec4 surveyBounds,conditionBounds,coverBounds;
          uniform float conditionStrength;
          float grain(vec2 p){return fract(sin(dot(mod(p,257.),vec2(26.51,17.71)))*43758.54)-.5;}
          vec3 groundTint(float kind){
            if(kind==3.) return vec3(.1785,.278,.114);
            if(kind==4.) return vec3(.291,.268,.217);
            if(kind==5.) return vec3(.152,.164,.172);
            if(kind==6.) return vec3(.067,.091,.047);
            if(kind==7.) return vec3(.165,.085,.175);
            if(kind==8.) return vec3(.115,.218,.108);
            if(kind==9.) return vec3(.109,.245,.224);
            if(kind==11.) return vec3(.133,.082,.048);
            if(kind==10.) return vec3(.48,.421,.289);
            return vec3(.1785,.278,.114);
          }
          vec4 surfaceColor(vec4 c){
            float a=mod(floor(c.r*255.+.5),16.),b=floor(c.g*255.+.5);
            vec3 under=mix(groundTint(b==5.?a:b),groundTint(a==5.?b:a),c.b);
            return vec4(under,c.a);
          }
          vec2 walkwayMaterial(ivec2 pixel,ivec2 size){
            float code=floor(texelFetch(finishMap,clamp(pixel,ivec2(0),size-1),0).a*255.+.5);
            return vec2(code==198.?1.:0.,code==145.?1.:0.);
          }
          vec2 walkwayWeights(vec2 uv){
            ivec2 size=textureSize(finishMap,0);
            vec2 p=uv*vec2(size)-.5,f=fract(p);
            ivec2 base=ivec2(floor(p));
            return mix(mix(walkwayMaterial(base,size),walkwayMaterial(base+ivec2(1,0),size),f.x),
                       mix(walkwayMaterial(base+ivec2(0,1),size),walkwayMaterial(base+ivec2(1),size),f.x),f.y);
          }

          float broadNoise(vec2 p){
            vec2 q=floor(p),f=fract(p);f=f*f*(3.-2.*f);
            return mix(mix(grain(q),grain(q+vec2(1.,0.)),f.x),mix(grain(q+vec2(0.,1.)),grain(q+1.),f.x),f.y);
          }`)
        .replace('#include <map_fragment>',gameGround?`vec2 uv=(surveyPoint-surveyBounds.xy)/(surveyBounds.zw-surveyBounds.xy);
          vec2 coverUV=(surveyPoint-coverBounds.xy)/(coverBounds.zw-coverBounds.xy);
          float cover=floor((texture2D(landTransitions,coverUV).r*255.+.5)/16.);

          float raw=texture2D(pavementMap,uv).r,aa=clamp(fwidth(raw),.025,.45);
          float road=smoothstep(.5-aa,.5+aa,raw);
          float carriage=road;
          float lawn=1.-smoothstep(.08,.20,distance(groundTint(0.),groundTint(cover)));
          float nearDetail=1.-smoothstep(.05,.27,length(fwidth(surveyPoint)));
          vec3 particle=groundParticle(surveyPoint);
          float grainFine=particle.g,grainCoarse=broadNoise(mat2(2.7,-1.1,1.1,2.7)*surveyPoint);
          float growth=broadNoise(surveyPoint*.085);
          vec2 cell=coverUV*coverSize-.5,low=floor(cell),part=fract(cell);
          vec4 sw=texture2D(landTransitions,(low+.5)/coverSize),se=texture2D(landTransitions,(low+vec2(1.5,.5))/coverSize);
          vec4 nw=texture2D(landTransitions,(low+vec2(.5,1.5))/coverSize),ne=texture2D(landTransitions,(low+1.5)/coverSize);
          vec4 ground=mix(mix(surfaceColor(sw),surfaceColor(se),part.x),mix(surfaceColor(nw),surfaceColor(ne),part.x),part.y);
          vec4 classes=floor((vec4(sw.r,se.r,nw.r,ne.r)*255.+.5)/16.);
          vec4 natural=1.-step(2.5,classes)+1.-step(.5,abs(classes-11.));
          float naturalCover=mix(mix(natural.x,natural.y,part.x),mix(natural.z,natural.w,part.x),part.y);
          vec4 sand=1.-step(.5,abs(classes-10.));
          float sandCover=mix(mix(sand.x,sand.y,part.x),mix(sand.z,sand.w,part.x),part.y);
          vec2 profileUv=coverUV*coverSize/(2.*vec2(textureSize(surfaceCoverage,0)));
          vec4 profile=texture2D(surfaceCoverage,profileUv);
          vec4 pavingSurvey=texture(pavingTone,vec3(coverUV,0.));
          vec4 mappedMaterials=texture(pavingTone,vec3(coverUV,1.));
          float mappedLot=coverageEdge(pavingSurvey.g);
          float pavedLot=max(coverageEdge(ground.a),mappedLot*max(carriage,smoothstep(.025,.24,textureLod(surfaceCoverage,profileUv,2.).a)));
          float lot=pavedLot*max(mappedLot,smoothstep(.006,.10,textureLod(pavingTone,vec3(coverUV,0.),3.).g));
          road=max(road,pavedLot);
          vec3 land=ground.rgb;
          if(cover==6.) road=0.;
          float turf=1.-smoothstep(.045,.12,distance(ground.rgb,groundTint(0.)));
          vec2 surveyTone=texture2D(grassVigor,uv).rg;
          vec3 blades=summerLawn(surveyPoint,surveyTone.r,particle.r);
          blades*=mix(vec3(1.),vec3(.86,1.32,1.02),pavingSurvey.a);
          land=mix(land,blades,turf*(1.-ground.a));
          float woodland=textureLod(surfaceCoverage,profileUv,3.8).b;
          float forest=smoothstep(.18,.74,woodland)*textureLod(surfaceCoverage,profileUv,2.4).b,waterCoverage=profile.g;
          vec3 litter=forestFloor(surveyPoint,particle);
          float duff=${landscape.pavingTone?.userData.woodlandEdges?'smoothstep(.05,.94,mappedMaterials.a+.13*growth+.045*particle.r)':'1.'};
          land=mix(land,litter,.55*smoothstep(.02,.98,forest)*duff);
          land=groundEdge(land,blades,litter,surveyPoint,naturalCover*(1.-mappedMaterials.b));
          float sport=1.-smoothstep(.012,.078,distance(ground.rgb,groundTint(8.)));
          float fieldCut=cos(dot(surveyPoint,vec2(-.099,.680))+.35*growth);
          vec3 fieldGrass=vec3(.055,.129,.054)*(1.+.016*fieldCut+particle.r*.65+growth*.08);
          land=mix(land,fieldGrass,sport);
          if(cover==4.) land*=1.+particle.b*.72;
          land=mix(land,vec3(.18,.16,.112)*(1.+particle.b*.74+.15*grainCoarse),sandCover*mappedMaterials.b);
          land*=1.+growth*.07+nearDetail*(grainFine*(.10+.11*lawn)+grainCoarse*.12*lawn);
          float waterAA=clamp(fwidth(waterCoverage),.04,.42);
          float waterWeight=smoothstep(.5-waterAA,.5+waterAA,waterCoverage);
          vec3 concrete=vec3(.286,.270,.240)*(1.+particle.b*.36+.055*grainCoarse);
          float coarseWalk=coverageEdge(profile.r);
          ${guide?'coarseWalk*=1.-smoothstep(.01,.11,textureLod(finishMap,vMapUv,4.8).b);':''}
          land=mix(land,concrete,max(coarseWalk,coverageEdge(pavingSurvey.b)));
          vec3 bank=mix(vec3(.111,.130,.078),vec3(.16,.155,.098),.5+growth);
          land=mix(land,bank,smoothstep(.015,.41,waterCoverage));
          land=riverColour(land,surveyPoint,waterWeight);
          vec3 observation=vec3(0.);
          ${conditions?'observation=texture2D(conditionMap,(surveyPoint-conditionBounds.xy)/(conditionBounds.zw-conditionBounds.xy)).rgb*conditionStrength;':''}
          float coarse=clamp((observation.r-.3333)*1.5,0.,1.);
          vec3 bitumen=mix(vec3(.061,.062,.061),vec3(.083,.081,.075),coarse);
          float pale=pavingSurvey.r;
          bitumen=mix(bitumen,vec3(.142,.135,.120),lot*.82);
          float paleLot=smoothstep(.83,.92,pale)*lot;
          bitumen*=.86+.32*smoothstep(.08,.74,pale);
          bitumen=mix(bitumen,vec3(.266,.261,.243),paleLot);
          float mineral=mappedMaterials.g*smoothstep(.24,.49,textureLod(pavingTone,vec3(coverUV,1.),2.2).g);
          bitumen=mix(bitumen,vec3(.478,.459,.385),mix(mineral,mappedMaterials.r,lot)*.89*road);
          float repairs=broadNoise(surveyPoint*.048+vec2(growth,-growth)*.26);
          bitumen*=1.+.55*(surveyTone.g-.502)+road*(repairs*.14+.055*broadNoise(surveyPoint*.19));
          bitumen*=1.+particle.g*.40+nearDetail*(grainFine*(.13+coarse*.16)+grainCoarse*(.068+coarse*.08))+.03*broadNoise(surveyPoint*.72);
          vec2 lotUV=mat2(.90,-.43,.43,.90)*surveyPoint*.051+vec2(repairs,growth)*.08;
          float seal=texture2D(groundGrain,lotUV).a;
          bitumen*=1.-seal*lot*(.085+.065*coarse)*smoothstep(-.14,.29,repairs);
          vec4 measured=texture2D(pavementDetail,coverUV);
          bitumen*=1.-.13*measured.r-.23*measured.g;
          vec3 surface=mix(land,bitumen,road);
          ${finish?`vec4 finish=texture2D(finishMap,vMapUv);
            surface*=1.-.40*(1.-finish.a)*road*(1.-finish.b);
            float pedal=finish.b;
            ${guide?`vec2 rim=min(vMapUv,1.-vMapUv);
              pedal=mix(pedal,texture2D(walkGuide,vMapUv).r,smoothstep(.0005,.008,min(rim.x,rim.y)));`:''}
            float pedestrian=coverageEdge(pedal)*(1.-carriage);
            float asphaltPath=1.-smoothstep(55./255.,145./255.,finish.a);
            ${guide?.format===THREE.RGFormat?'asphaltPath=coverageEdge(texture2D(walkGuide,vMapUv).g);':''}
            vec3 slab=mix(vec3(.286,.270,.240),vec3(.10,.116,.12),asphaltPath);
            float brushed=clamp((observation.g-.3333)*1.5,0.,1.);
            slab*=1.+particle.b*.37+.035*broadNoise(surveyPoint*.77)+nearDetail*(grainFine*(.13+.11*brushed)+grainCoarse*(.035+brushed*.075));
            vec2 jointCoord=mat2(.953,.303,-.303,.953)*surveyPoint/vec2(1.72,2.40);
            vec2 footprintJoint=max(fwidth(jointCoord),.0001);
            vec2 jointDist=abs(fract(jointCoord+.5)-.5);
            vec2 slabSeam=clamp((.0024+footprintJoint*.5-jointDist)/footprintJoint,vec2(0.),min(vec2(1.),.0048/footprintJoint));
            vec2 walkPhase=measured.ba*2.-1.;
            float jointDepth=max(slabSeam.x,slabSeam.y)*(1.-smoothstep(.15,.55,max(footprintJoint.x,footprintJoint.y)));
            if(dot(walkPhase,walkPhase)>.80){
              float station=atan(walkPhase.y,walkPhase.x)*1.27323954;
              float width=max(.001,length(fwidth(surveyPoint))/1.72);
              float delta=abs(fract(station+.5)-.5);
              jointDepth=clamp((.0035+width*.5-delta)/width,0.,min(1.,.007/width));
            }
            slab*=1.-.36*jointDepth*(1.-asphaltPath);
            vec2 paving=vec2(0.);
            if(pedestrian>.001 && finish.a<.995)paving=walkwayWeights(vMapUv);
            vec2 block=surveyPoint/vec2(.22,.40);
            block.x+=.5*mod(floor(block.y),2.);
            vec2 edge=min(fract(block),1.-fract(block));
            vec2 seam=1.-smoothstep(vec2(.012),max(vec2(.046),fwidth(block)),edge);
            float joint=max(seam.x,seam.y)*(1.-smoothstep(.15,.85,length(fwidth(block))));
            vec3 brick=vec3(.385,.291,.235)*(1.-joint*.38+particle.b*.19+.08*grain(floor(block)));
            slab=mix(slab,brick,paving.x);
            slab=mix(slab,vec3(.307,.264,.194)*(1.+particle.b*.84),paving.y);
            surface=mix(surface,slab,pedestrian);`:''}
          diffuseColor.rgb*=surface;
          diffuseColor.a=1.;`:'#include <map_fragment>');
      if(gameGround){
        riverFinish(shader,'surveyPoint','waterWeight');
        shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
          vec3 level=mat3(viewMatrix)*vec3(0.,1.,0.);
          float levelPaving=smoothstep(.83,.985,dot(normal,level))*max(lot,carriage);
          normal=normalize(mix(normal,level,.70*levelPaving*(1.-waterWeight)));`);
        landscape.foundationLight?.(shader);
      }
    };
    return material;
  }
  const terrain=terrainMaterial(texture,false);
  function addMesh(positions, indices, material, colors, uv) {
    if (!indices.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    if (uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    group.add(mesh);
    return mesh;
  }
  const paintMaterial=new THREE.MeshStandardMaterial({roughness:.78,side:THREE.DoubleSide,vertexColors:true,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-1});
  const swatches=[new THREE.Color(0xe1e0d4),new THREE.Color(0xe1be65),new THREE.Color(0xf5f4e9),new THREE.Color(0xecc453),new THREE.Color(0x5b96ab)];
  function observedPaint(condition){
    const material=paintMaterial.clone();
    material.customProgramCacheKey=()=>'modeled-line-wear';
    material.onBeforeCompile=shader=>{
      shader.uniforms.conditions={value:condition};
      shader.uniforms.bounds={value:new THREE.Vector4(...condition.userData.bounds)};
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 markPoint;')
        .replace('#include <begin_vertex>','#include <begin_vertex>\nmarkPoint=position.xz;');
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 markPoint; uniform sampler2D conditions; uniform vec4 bounds;')
        .replace('#include <color_fragment>',`#include <color_fragment>
          float wear=texture2D(conditions,(markPoint-bounds.xy)/(bounds.zw-bounds.xy)).b;
          float grit=fract(sin(dot(mod(floor(markPoint*17.),229.),vec2(13.5,22.17)))*41718.);
          diffuseColor.rgb*=1.-wear*(.08+.37*step(.77,grit)*(1.-smoothstep(.035,.13,length(fwidth(markPoint)))));`);
    };
    return material;
  }
  function* roadPaint(patch){
    const positions=[],colors=[];
    for(const [kind,packed] of patch.strokes.entries()){
      if(!packed) continue;
      const coords=new Uint16Array(bytes(packed).buffer),tint=swatches[kind];
      function emit(x,y,z){
        positions.push(x,y+.011,z);
        colors.push(tint.r,tint.g,tint.b);
      }
      for(let i=0;i<coords.length;i+=6){
        if(i%72===0) yield;
        const points=[];
        for(let k=0;k<3;k++){
          const x=patch.left+coords[i+k*2]/128,z=patch.top+coords[i+k*2+1]/128;
          points.push({x,z,excluded:!landscape.paintable(x,z)});
        }
        const poly=[];
        for(let k=0;k<3;k++){
          const a=points[k],b=points[(k+1)%3];
          if(!a.excluded) poly.push(a);
          if(a.excluded===b.excluded) continue;
          let near=0,far=1;
          for(let step=0;step<9;step++){
            const t=(near+far)/2;
            if(landscape.paintable(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t)!==a.excluded) near=t;
            else far=t;
          }
          poly.push({x:a.x+(b.x-a.x)*near,z:a.z+(b.z-a.z)*near});
        }
        for(let k=2;k<poly.length;k++){
          const face=[poly[0],poly[k-1],poly[k]];
          const x=face.reduce((sum,p)=>sum+p.x,0)/3,z=face.reduce((sum,p)=>sum+p.z,0)/3;
          if(!landscape.paintable(x,z)||face.some(p=>!landscape.paintable(p.x*.99+x*.01,p.z*.99+z*.01)))continue;
          landscape.projectPolygon(face.map(p=>[p.x,p.z]),emit);
        }
      }
    }
    if(!positions.length) return null;
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    g.computeVertexNormals();
    const mesh=new THREE.Mesh(g,markingMaterial);
    mesh.name='Surveyed lane markings';
    mesh.receiveShadow=true;
    return mesh;
  }
  const markingMaterial=observations?observedPaint(observations):paintMaterial;
  const paintQueue=[];
  let paintScheduled=false,pendingStrokes=0;
  group.userData.paintReady=()=>paintQueue.length===0 && pendingStrokes===0;
  function queuePaint(patch){
    if(patch.paintReady)return;
    patch.paintJob??=roadPaint(patch);
    paintQueue.push(patch);
  }
  function schedulePaint(){
    paintQueue.sort((a,b)=>b.paintDistance-a.paintDistance);
    if(paintScheduled || !paintQueue.length)return;
    paintScheduled=true;
    if(landscape?.racing)requestAnimationFrame(preparePaint);
    else preparePaint();
  }
  async function loadStrokes(patch){
    if(patch.loadingStrokes)return;
    patch.loadingStrokes=true;
    pendingStrokes++;
    try{
      const response=await fetch(patch.strokes);
      if(!response.ok)throw new Error('Could not load lane markings '+patch.strokes);
      patch.strokes=await response.json();
    }catch(error){
      console.warn(error.message);
      setTimeout(()=>{
        patch.loadingStrokes=false;
        if(Number.isFinite(patch.paintDistance))loadStrokes(patch);
      },3000);
      return;
    }finally{pendingStrokes--;}
    patch.loadingStrokes=false;
    if(Number.isFinite(patch.paintDistance)){
      queuePaint(patch);
      schedulePaint();
    }
  }
  function attachPaint(patch){
    if(!patch.active || !patch.paint || patch.paint.parent)return;
    patch.mesh.add(patch.paint);
    group.userData.onTextureReady?.();
  }
  function preparePaint(){
    const deadline=landscape?.racing?performance.now()+2:Infinity;
    while(paintQueue.length){
      const patch=paintQueue.at(-1);
      let result;
      do {result=patch.paintJob.next();} while(!result.done && performance.now()<deadline);
      if(result.done){
        paintQueue.pop();
        patch.paintJob=null;
        patch.paint=result.value;
        patch.paintReady=true;
        attachPaint(patch);
      }
      if(performance.now()>=deadline)break;
    }
    paintScheduled=paintQueue.length>0;
    if(paintScheduled)requestAnimationFrame(preparePaint);
  }
  const patches=[];
  const tile = 24;
  for (let j = 0; j < zs.length - 1; j += tile) {
    for (let i = 0; i < xs.length - 1; i += tile) {
      const lastX = Math.min(i + tile, xs.length - 1);
      const lastZ = Math.min(j + tile, zs.length - 1);
      if(region.campusBoundary && !region.campusBoundary.intersects(xs[i],zs[j],xs[lastX],zs[lastZ])) continue;
      const xAxis=landscape?.xs??xs,zAxis=landscape?.zs??zs;
      const i0=landscape?landscape.startsX[i]:i, i1=landscape?landscape.startsX[lastX]:lastX;
      const j0=landscape?landscape.startsZ[j]:j, j1=landscape?landscape.startsZ[lastZ]:lastZ;
      const width=i1-i0+1;
      const pos=[], uv=[], indices=[], normals=[];
      const at=(ix,iz)=>landscape?landscape.heights[iz*xAxis.length+ix]:elevations[iz*xAxis.length+ix]*.1;
      for(let iz=j0;iz<=j1;iz++){
        for(let ix=i0;ix<=i1;ix++){
          const x=xAxis[ix], z=zAxis[iz];
          pos.push(x,at(ix,iz),z);
          uv.push((x-bounds[0])/(bounds[2]-bounds[0]),(z-bounds[1])/(bounds[3]-bounds[1]));
          const left=Math.max(0,ix-1),right=Math.min(xAxis.length-1,ix+1);
          const up=Math.max(0,iz-1),down=Math.min(zAxis.length-1,iz+1);
          const nx=(at(left,iz)-at(right,iz))/(xAxis[right]-xAxis[left]);
          const nz=(at(ix,up)-at(ix,down))/(zAxis[down]-zAxis[up]);
          const magnitude=Math.hypot(nx,1,nz);
          normals.push(nx/magnitude,1/magnitude,nz/magnitude);
          if(ix===i1 || iz===j1) continue;
          if(!landscape && x>=0 && x<world.width && z>=0 && z<world.depth) continue;
          const first=(iz-j0)*width+ix-i0;
          indices.push(first,first+width,first+1,first+1,first+width,first+width+1);
        }
      }
      const mesh=addMesh(pos,indices,terrain,null,uv);
      if(mesh){
        mesh.name='Terrain '+i+','+j;
        mesh.geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      }
      if(mesh && aerial.tiles[i+','+j]) patches.push({mesh,source:aerial.tiles[i+','+j],finish:aerial.finishes?.[i+','+j],strokes:aerial.strokes?.[i+','+j],conditions:aerial.groundMaterials?.[i+','+j],left:xs[i],top:zs[j],right:xs[lastX],bottom:zs[lastZ]});
    }
  }
  const chunk = (x,z) => Math.floor(x / 192) + ':' + Math.floor(z / 192);
  if(architecture) group.add(createArchitecture(THREE,region,architecture,world,landscape?.heightAt));
  const groves=new Map();
  const treeTiles=[];
  for(const tree of region.trees) {
    const key=chunk(tree[0],tree[2]);
    if(!groves.has(key)) groves.set(key,[]);
    groves.get(key).push(tree);
  }
  const matrix=new THREE.Matrix4(), turn=new THREE.Quaternion(), upward=new THREE.Vector3(0,1,0);
  const coarseLobe=new THREE.IcosahedronGeometry(1,0), fineLobe=foliageCluster(.45);
  const stem=sides=>new THREE.CylinderGeometry(1,1,1,sides,1,true);
  const coarseCone=new THREE.ConeGeometry(1,1,5);
  function lobe(shape,x,y,z,width,height=width*.41) {
    return {shape,foliage:true,matrix:matrix.clone().compose(new THREE.Vector3(x,y,z),turn.setFromAxisAngle(upward,x*7+z*5),new THREE.Vector3(width,height,width*.92))};
  }
  function cone(shape,y,width,height) {
    return {shape,foliage:true,matrix:matrix.clone().compose(new THREE.Vector3(0,y,0),turn.setFromAxisAngle(upward,y*9),new THREE.Vector3(width,height,width))};
  }
  function limb(shape,from,to,base,tip) {
    const axis=new THREE.Vector3(...to).sub(new THREE.Vector3(...from));
    const geometry=shape.clone();
    const ring=geometry.attributes.position;
    for(let i=0;i<ring.count;i++){
      const taper=ring.getY(i)>0?tip:base;
      ring.setXYZ(i,ring.getX(i)*taper,ring.getY(i),ring.getZ(i)*taper);
    }
    const middle=new THREE.Vector3(...from).lerp(new THREE.Vector3(...to),.5);
    const orientation=new THREE.Quaternion().setFromUnitVectors(upward,axis.clone().normalize());
    const placement=matrix.clone().compose(middle,orientation,new THREE.Vector3(1,axis.length(),1));
    let shell;
    if(from[1]<0){
      const sides=geometry.parameters.radialSegments;
      shell=[-1,1].flatMap(side=>Array.from({length:sides},(_,i)=>{
        const a=i*2*Math.PI/sides,r=side<0?base:tip;
        return new THREE.Vector3(r*Math.sin(a),side*.5,r*Math.cos(a)).applyMatrix4(placement);
      }));
    }
    return {shape:geometry,branch:[from,to,base,tip,shell],owned:true,matrix:placement};
  }
  function broadleaf(seed,spreading,fine) {
    let state=seed;
    const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
    const leaves=fine?fineLobe:coarseLobe, wood=stem(fine?6:4), parts=[];
    const fork=[0,spreading?.4:.3,0];
    parts.push(limb(wood,[0,-.02,0],fork,.059,.039));
    const count=(spreading?4:3)+(seed%3), start=random()*6.28;
    for(let i=0;i<count;i++){
      const angle=start+i*6.28/count+(random()-.5)*.5;
      const reach=spreading?.5+.14*random():.3+.1*random();
      const rise=spreading?.6+.08*random():.48+.12*i+.04*random();
      const tip=[Math.sin(angle)*reach,rise,Math.cos(angle)*reach];
      if(fine){
        const junction=[0,fork[1]*(.59+.41*i/count),0];
        const elbow=[tip[0]*.42,junction[1]+(tip[1]-junction[1])*(.47+.22*random()),tip[2]*.57];
        parts.push(limb(wood,junction,elbow,.038,.025),limb(wood,elbow,tip,.025,.014));
        const twig=[tip[0]+Math.cos(angle)*.19,tip[1]+.1,tip[2]-Math.sin(angle)*.19];
        parts.push(limb(wood,elbow,twig,.02,.008),lobe(leaves,...twig,.31,.10));
      }
      if(fine||i<2) parts.push(lobe(leaves,tip[0]*1.08,tip[1]+.05,tip[2]*1.08,spreading?.47+.08*random():.5+.06*random()));
    }
    const crest=spreading?.82:.88;
    if(fine) parts.push(limb(wood,fork,[0,crest-.06,0],.04,.02));
    parts.push(lobe(leaves,(random()-.5)*.1,crest,(random()-.5)*.1,spreading?.52:.46,spreading?.205:.20));
    if(!spreading) parts.push(lobe(leaves,0,.66,0,.5,.2));
    if(fine){
      for(let i=0;i<2;i++){
        const angle=start+1.2+i*3.14;
        parts.push(lobe(leaves,Math.sin(angle)*(spreading?.3:.2),spreading?.73:.7+.08*i,Math.cos(angle)*(spreading?.3:.2),spreading?.4:.42));
      }
    }
    return parts;
  }
  function conifer(fine) {
    const parts=[limb(stem(fine?5:4),[0,-.02,0],[0,.97,0],.075,.02)];
    const tiers=fine?6:3;
    for(let i=0;i<tiers;i++){
      const t=i/(tiers-1);
      const width=.78-.52*t,rise=.3+.56*t;
      if(fine){
        for(let spoke=0;spoke<4;spoke++){
          const angle=i*2.4+spoke*1.5708+.37*Math.sin(spoke*1.7+i*.85);
          parts.push(lobe(fineLobe,Math.cos(angle)*width*.42,rise,Math.sin(angle)*width*.42,width*.70,.15-.055*t));
        }
      }else parts.push(cone(coarseCone,rise,width,.44-.1*t));
    }
    return parts;
  }
  function dormant(fine){
    const wood=stem(fine?6:4),base=[0,-.02,0],fork=[.03,.38,-.02],leader=[-.04,.79,.04];
    const parts=[limb(wood,base,fork,.061,.044),limb(wood,fork,leader,.044,.014),limb(wood,leader,[.06,.98,-.03],.015,.002)];
    const arms=fine?8:5;
    for(let i=0;i<arms;i++){
      const t=i/arms,a=i*2.4+.19*Math.sin(i*3.1),reach=(.88-.48*t)*(.91+.09*Math.cos(i));
      const start=[.03-.07*t,.38+.38*t,-.02+.06*t];
      const elbow=[Math.sin(a)*reach*.58,start[1]+.075+.04*t,Math.cos(a)*reach*.58];
      const end=[Math.sin(a+.18)*reach,elbow[1]+.10+.06*t,Math.cos(a+.18)*reach];
      parts.push(limb(wood,start,elbow,.032-.018*t,.014),limb(wood,elbow,end,.014,.003));
      if(fine)for(const side of [-1,1]){
        const angle=a+side*(.73+.12*Math.sin(i)),length=reach*(side>0?.42:.36);
        const joint=side>0?elbow:end,tip=[joint[0]+Math.sin(angle)*length,joint[1]+.10+.04*Math.cos(angle),joint[2]+Math.cos(angle)*length];
        parts.push(limb(wood,joint,tip,.009,.0018));
      }
    }
    return parts;
  }
  const bark=new THREE.Color(0x5c4b3b), sunlit=new THREE.Color();
  function treeGeometry(parts,woodOnly=false) {
    const position=[],normal=[],color=[],leaf=[],uv=[],cameraSolid=[];
    const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),face=new THREE.Vector3();
    for(const part of parts) {
      if(woodOnly && part.foliage) continue;
      const geometry=part.shape.clone().applyMatrix4(part.matrix);
      const faces=geometry.index?geometry.toNonIndexed():geometry;
      const points=faces.attributes.position;
      for(let i=0;i<points.count;i+=3){
        a.fromBufferAttribute(points,i); b.fromBufferAttribute(points,i+1); c.fromBufferAttribute(points,i+2);
        face.subVectors(c,b).cross(a.clone().sub(b)).normalize();
        const middle=a.clone().add(b).add(c).divideScalar(3);
        if(part.foliage){
          const height=Math.min(1,Math.max(0,(middle.y-.42)/.55));
          const outward=Math.max(0,face.x*middle.x+face.z*middle.z)/Math.max(.2,Math.hypot(middle.x,middle.z));
          face.y+=.45; face.normalize();
          const light=.74+.32*height+.14*outward;
          sunlit.setRGB(light*(1+.07*height),light,light*(1-.12*height));
        } else {
          sunlit.copy(bark).multiplyScalar(.72+.38*Math.min(1,middle.y*2));
        }
        for(let k=0;k<3;k++){
          position.push(points.getX(i+k),points.getY(i+k),points.getZ(i+k));
          if(part.shape===fineLobe){
            const n=faces.attributes.normal,u=faces.attributes.uv;
            normal.push(n.getX(i+k),n.getY(i+k),n.getZ(i+k));
            uv.push(u.getX(i+k),u.getY(i+k));
          }else{
            const n=part.branch?faces.attributes.normal:null;
            if(n)normal.push(n.getX(i+k),n.getY(i+k),n.getZ(i+k));
            else normal.push(face.x,face.y,face.z);
            uv.push(.985,.986);
          }
          color.push(sunlit.r,sunlit.g,sunlit.b);
          leaf.push(part.foliage?1:0);
          cameraSolid.push(faces.attributes.cameraSolid?.getX(i+k)??1);
        }
      }
      if(faces!==geometry) faces.dispose();
      geometry.dispose();
    }
    const combined=new THREE.BufferGeometry();
    for(const [name,values,arity] of [['position',position,3],['normal',normal,3],['color',color,3],['leaf',leaf,1],['uv',uv,2]])
      combined.setAttribute(name,new THREE.Float32BufferAttribute(values,arity));
    combined.setAttribute('cameraSolid',new THREE.Uint8BufferAttribute(cameraSolid,1));
    for(const part of parts) if(part.owned) part.shape.dispose();
    return combined;
  }
  function species(build) {
    const fine=build(true);
    return {branches:fine.flatMap(p=>p.branch?[p.branch]:[]),far:treeGeometry(build(false)),near:treeGeometry(fine),bare:treeGeometry(fine,true)};
  }
  const forms=[species(fine=>broadleaf(71,true,fine)),species(fine=>broadleaf(5233,false,fine)),species(fine=>conifer(fine)),species(fine=>broadleaf(2261,true,fine)),species(fine=>broadleaf(743,false,fine))];
  const springForm=forms.length;
  forms.push(species(dormant));
  const vegetation=new THREE.MeshStandardMaterial({vertexColors:true,map:leafSprayTexture(),alphaTest:.36,side:THREE.DoubleSide});
  vegetation.customProgramCacheKey=()=>'campus-leaf-flecks';
  vegetation.onBeforeCompile=shader=>{
    lightLeafBacks(shader);
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float leaf;\nvarying vec3 leafPoint;varying float barkAmount;')
      .replace('#include <color_vertex>','#include <color_vertex>\nvColor.xyz=mix(color.xyz,vColor.xyz,leaf);')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nbarkAmount=1.-leaf;leafPoint=(instanceMatrix * vec4(position,1.)).xyz;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 leafPoint;varying float barkAmount;\n'+barkGrainGLSL)
      .replace('#include <color_fragment>',`#include <color_fragment>
        diffuseColor.rgb*=mix(1.,barkGrain(leafPoint),barkAmount);
        vec3 p=floor(leafPoint*9.);
        float fleck=fract(sin(dot(mod(p,127.),vec3(12.72,53.93,21.13)))*34751.32);
        float close=1.-smoothstep(.04,.35,length(fwidth(leafPoint)));
        diffuseColor.rgb*=1.+(fleck-.5)*.27*close;`);
  };
  const transform=new THREE.Object3D(), color=new THREE.Color();
  function pick([x,,z,h,rgb]) {
    const hash=Math.abs(Math.sin(x*12.9898+z*78.233)*43758.5453)%1;
    const habit=region.regionalHabits?.get(x+','+z);
    if(habit===10)return springForm;
    if(habit===1)return 2;
    const value=Math.max(...rgb)/255;
    if(h>7 && (value<.27 || hash<.06)) return 2;
    return h<9 || hash>.62 ? (hash>.80?4:1) : (hash>.31?3:0);
  }
  for (const trees of groves.values()) {
    const sorted=forms.map(()=>[]);
    for(const tree of trees) sorted[pick(tree)].push(tree);
    sorted.forEach((members,kind)=>{
      if(!members.length) return;
      const mesh=new THREE.InstancedMesh(forms[kind].far,vegetation,members.length);
      members.forEach(([x,y,z,h,rgb,diameter],i)=>{
        const hash=Math.abs(Math.sin(x*3.17+z*9.41)*15731.743)%1;
        const brightness=Math.min(1,Math.max(0,((.3*rgb[0]+.55*rgb[1]+.15*rgb[2])/255-.2)/.4));
        const young=h<9;
        const radius=diameter?diameter*.5:kind===2?Math.min(4.6,h*.24):Math.min(6.8,h*(young?.31:.34));
        transform.position.set(x,y-.15,z);
        transform.rotation.set((hash-.5)*.07,(x+z)*1.7,(Math.abs(Math.sin(x*z))-.5)*.07);
        transform.scale.set(radius*(.9+.2*hash),h*(.94+.12*(1-hash)),radius*(.9+.2*(1-hash)));
        transform.updateMatrix();
        mesh.setMatrixAt(i,transform.matrix);
        if(landscape?.addBranch)for(const [a,b,start,end,shell] of forms[kind].branches){
          if(shell){
            const points=shell.map(p=>p.clone().applyMatrix4(transform.matrix).toArray()),n=points.length/2;
            const faces=Array.from({length:n},(_,i)=>[i,(i+1)%n,(i+1)%n+n,i+n].map(j=>points[j]));
            landscape.addShell(points,faces,'regional trunk');
            continue;
          }
          const point=p=>new THREE.Vector3(...p).applyMatrix4(transform.matrix).toArray();
          const scale=(transform.scale.x+transform.scale.z)*.5;
          landscape.addBranch(point(a),point(b),start*scale,end*scale,'regional tree');
        }
        if(kind===2) color.setHSL(.35+.04*hash,.32+.08*hash,.23+.08*brightness,THREE.SRGBColorSpace);
        else color.setHSL(.215+.103*hash+(young?.018:0),.25+.14*(1-hash),.29+.14*brightness+(young?.035:0),THREE.SRGBColorSpace);
        mesh.setColorAt(i,color);
      });
      mesh.computeBoundingSphere(); mesh.receiveShadow=true; mesh.castShadow=true; group.add(mesh);
      treeTiles.push({mesh,form:forms[kind],x:members.reduce((n,t)=>n+t[0],0)/members.length,z:members.reduce((n,t)=>n+t[2],0)/members.length});
    });
  }
  let textureRevision=0;
  const loader=new THREE.TextureLoader();
  let focusX,focusZ,focusDistance,canopyCoverage;
  const roadCredit=document.getElementById('road-credit');
  group.userData.setCanopyCoverage=fn=>{canopyCoverage=fn;focusX=NaN;};
  group.userData.groundSettledNear=(x,z,radius)=>patches.every(patch=>{
    const dx=Math.max(patch.left-x,0,x-patch.right),dz=Math.max(patch.top-z,0,z-patch.bottom);
    return Math.hypot(dx,dz)>radius || (patch.active && patch.mesh.material!==terrain && (!patch.strokes || patch.paintReady));
  });
  group.userData.updateAerial=(x,z,distance)=>{
    if(Math.hypot(x-focusX,z-focusZ)<10 && Math.abs(distance-focusDistance)<10) return textureRevision;
    focusX=x;focusZ=z;focusDistance=distance;
    if(roadCredit){
      const source=distance<850 && patches.find(p=>p.left<=x && x<p.right && p.top<=z && z<p.bottom)?.conditions?.reference;
      roadCredit.hidden=!source;
      if(source){
        roadCredit.href='https://kartaview.org/details/'+source.sequence+'/'+source.index;
        roadCredit.textContent='Pavement survey reference · '+(source.author||'KartaView')+' · '+source.date;
      }
    }
    for(const tile of treeTiles){
      const near=distance<420 && Math.hypot(x-tile.x,z-tile.z)<285;
      tile.mesh.geometry=!near?tile.form.far:canopyCoverage?.(tile.x,tile.z,145)?tile.form.bare:tile.form.near;
    }
    paintQueue.length=0;
    for(const patch of patches){
      const dx=Math.max(patch.left-x,0,x-patch.right), dz=Math.max(patch.top-z,0,z-patch.bottom);
      const range=Math.hypot(dx,dz);
      const near=distance<850 && range<(patch.active?420:330);
      if(patch.strokes){
        if(near || (landscape?.racing && distance<850 && range<460)){
          patch.paintDistance=range;
          if(typeof patch.strokes==='string')loadStrokes(patch);
          else queuePaint(patch);
        }else{
          patch.paintDistance=Infinity;
          patch.paintJob=null;
          patch.paint?.removeFromParent();
          patch.paint?.geometry.dispose();
          patch.paint=null;
          patch.paintReady=false;
        }
      }
      if(near===Boolean(patch.active)) continue;
      patch.active=near;
      if(!near){
        patch.token=null;
        patch.paint?.removeFromParent();
        if(patch.mesh.material!==terrain) {
          patch.mesh.material.userData.walkGuide?.dispose();
          patch.mesh.material.map.dispose();
          if(patch.mesh.material.userData.finish!==patch.mesh.material.map) patch.mesh.material.userData.finish?.dispose();
          patch.mesh.material.dispose();
          patch.mesh.material=terrain;
          textureRevision++;
        }
        continue;
      }
      attachPaint(patch);
      const token=patch.token={};
      function load(source,type){
        return loader.loadAsync(/^(?:https?:|data:|blob:|\/|\.\.?\/)/.test(source)?source:'data:image/'+type+';base64,'+source);
      }
      load(patch.finish??patch.source,patch.finish?'png':'webp').then(map=>{
        const finish=patch.finish?map:null;
        if(patch.token!==token){map.dispose();return;}
        if(finish){finish.flipY=false;finish.anisotropy=8;}
        const conditions=observations;
        map.flipY=false;
        map.colorSpace=finish?THREE.NoColorSpace:THREE.SRGBColorSpace;
        map.magFilter=THREE.LinearFilter;
        map.anisotropy=8;
        map.repeat.set((bounds[2]-bounds[0])/(patch.right-patch.left),(bounds[3]-bounds[1])/(patch.bottom-patch.top));
        map.offset.set((bounds[0]-patch.left)/(patch.right-patch.left),(bounds[1]-patch.top)/(patch.bottom-patch.top));
        patch.mesh.material=terrainMaterial(map,true,finish,conditions,finish?landscape?.walkwayGuide?.(patch):null);
        textureRevision++;
        group.userData.onTextureReady?.();
      }).catch(error=>{if(patch.token===token){patch.active=false;focusX=NaN;console.warn(error.message);}});
    }
    schedulePaint();
    return textureRevision;
  };
  return group;
}
