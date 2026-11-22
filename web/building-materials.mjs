import {reflectedCampus} from './look/reflections.mjs';
import * as THREE from 'three';

const families=[
  ['concrete-smooth','limestone-smooth','stucco','painted-metal','membrane'],
  ['brick','terracotta','clay-tile'],
  ['ashlar-stone','split-face-block','rubble-stone'],
  ['concrete-board-formed','wood-siding'],
  ['precast-panel','metal-panel','spandrel-glass','glass-block'],
  ['corrugated-metal','standing-seam-metal','copper-patina','copper-new'],
  ['slate','asphalt-shingle'],
  ['gravel-ballast','green-roof'],
  ['glazing'],['door'],['distant-wall'],['perforated-mesh'],['interior'],['glass-curtain']
];
const units=[[1,1],[.215,.076],[.51,.26],[1.5,.17],[1.5,2.6],[.47,4],[.31,.18],[.17,.17],[1,1],[1,1],[1,1]];
const bonds=['stack','running','english','flemish','random-ashlar','coursed-rubble'];
const rgb=c=>new THREE.Color(c).toArray();
export function pressureCapProfile(shader){
  shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
    attribute float instanceProfile;
    vec3 pressureCap(vec3 p){
      float factor=mix(1.,.72,.5-p.z);
      if(instanceProfile==1.)p.x*=factor;
      if(instanceProfile==2.)p.y*=factor;
      return p;
    }`).replace('#include <begin_vertex>',`#include <begin_vertex>
      transformed=pressureCap(transformed);`);
  shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>',`#include <beginnormal_vertex>
    if(instanceProfile==1.)objectNormal.z-=.14*abs(normal.x);
    if(instanceProfile==2.)objectNormal.z-=.14*abs(normal.y);`);
}
export function surveyMaterial(rows,instanced=false,alpha=false){
  const repairsPerRoof=Math.min(6,rows.reduce((max,m)=>Math.max(max,m.repairs?.length??0),0));
  const width=11+2*Math.max(0,repairsPerRoof-2),stride=width*4;
  const values=new Float32Array(Math.max(rows.length,1)*stride);
  for(const [i,m] of rows.entries()){
    const family=Math.max(0,families.findIndex(v=>v.includes(m.kind)));
    const size=m.unitSize??units[family]??[1,1],glazed=family===8||family===9||family===13;
    const second=glazed?m.frameColor??'#a7a6a0':family===10?m.glassColor:m.secondaryColor;
    const treatment=m.surface??'';
    const profile=treatment==='tinted polycarbonate'?21:treatment==='scored precast'?20:treatment==='climbing ivy'?19:treatment==='drain-grate'?18:/welded fabric/.test(treatment)?17:m.doorSlats?16:m.kind==='wood-siding' && !/vertical board/.test(treatment)?15:treatment==='coffered-soffit'?14:/louvre/.test(treatment)?11:/vertical board/.test(treatment)?12:/vertic.*(rib|scor|corrug)|ribbed-metal/.test(treatment)?13:/rock-faced/.test(treatment)?3:0;
    const metallic=family===5||['metal-panel','painted-metal','spandrel-glass','glass-curtain'].includes(m.kind);
    const a=rgb(m.color).map(c=>c*(m.reveal?.66:1)),other=second?rgb(second):a.map(c=>c*(family===1?1.3:.64));
    values.set([...a,family,...other,m.variation??.22,Math.max(.015,size[0]),Math.max(.015,size[1]),m.roughness??(m.kind==='spandrel-glass'?.31:metallic?.49:.85),m.metalness??(metallic?.48:.015),m.weathering??.16,Math.max(0,bonds.indexOf(m.bond??(family===1||family===2?'running':'stack'))),m.vertical??1,m.horizontal??1,m.line??.026,m.tracery?1:0,m.coverage??.5,m.glass==='frosted'?1:m.glass==='leaded'?2:0,m.opacity??(m.kind==='glass-curtain'?.39:1),profile|| (m.surface==='ribbed-concrete'?1:m.surface==='bush-hammered'?2:m.kind==='rubble-stone'?3:m.kind==='ashlar-stone'?4:m.kind==='split-face-block'?5:m.opaqueLeaf?10:m.kind==='membrane'?6:m.kind==='concrete-board-formed'?7:m.kind==='precast-panel'?(m.plainElevation?9:8):0),m.roofSurface?1+Math.min(6,m.repairs?.length??0):0,m.parkingMarkings??0],stride*i);
    for(const [j,[x,z,w,d,angle,tone]] of (m.repairs??[]).slice(0,6).entries())values.set([x,z,w,d,Math.cos(angle),Math.sin(angle),tone,1],stride*i+(j<2?24+j*8:44+(j-2)*8));
    values.set([Math.cos(m.roofAxis??0),Math.sin(m.roofAxis??0),m.glass==='reflective'?1:0,m.surface==='vertical-slats'?1:m.surface==='picket'?2:0],stride*i+40);
  }
  const tex=new THREE.DataTexture(values,width,Math.max(rows.length,1),THREE.RGBAFormat,THREE.FloatType);
  tex.needsUpdate=true;
  const material=new THREE.MeshStandardMaterial({side:THREE.DoubleSide,transparent:alpha,depthWrite:!alpha});
  material.forceSinglePass=true;
  material.customProgramCacheKey=()=>`western-envelope-17-${instanced}-${alpha}`;
  material.userData.styles=tex;
  material.userData.coverage={value:new THREE.Vector2(0,1)};
  material.onBeforeCompile=shader=>{
    if(instanced)pressureCapProfile(shader);
    shader.uniforms.finishes={value:tex};
    shader.uniforms.buildingCoverage=material.userData.coverage;
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
      attribute float finishId;
      flat varying int finishIndex;
      varying vec2 faceUV;
      varying vec3 campusP;
      varying vec3 campusN;`).replace('#include <begin_vertex>',`#include <begin_vertex>
        finishIndex=int(finishId+.5); faceUV=uv;
        ${instanced?'campusP=(instanceMatrix*vec4(pressureCap(position),1.)).xyz;campusN=normalize(mat3(instanceMatrix)*normal);':'campusP=position;campusN=normal;'}`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
      uniform highp sampler2D finishes;
      uniform vec2 buildingCoverage;
      flat varying int finishIndex;
      varying vec2 faceUV;
      varying vec3 campusP;
      varying vec3 campusN;
      float hashCell(vec2 p) {
        vec3 h=fract(vec3(p.xyx)*vec3(.1031,.11369,.13787));
        h+=dot(h,h.yzx+19.19);
        return fract((h.x+h.y)*h.z);
      }
      float noiseField(vec2 p) {
        vec2 cell=floor(p),t=fract(p);
        t=t*t*(3.-2.*t);
        return mix(mix(hashCell(cell),hashCell(cell+vec2(1.,0.)),t.x),mix(hashCell(cell+vec2(0.,1.)),hashCell(cell+1.),t.x),t.y);
      }
      float stripeIntegral(float x,float width){
        return floor(x)*width+min(fract(x),width);
      }
      float filteredStripe(float phase,float duty,float pixel){
        pixel=max(.0001,pixel);
        float a=phase-pixel*.5+duty*.5;
        return clamp((stripeIntegral(a+pixel,duty)-stripeIntegral(a,duty))/pixel,0.,1.);
      }
      float screened(float phase,float duty){return filteredStripe(phase,duty,fwidth(phase));}
      float ruled(float p,float halfWidth){
        float width=max(.0002,fwidth(p)),ink=2.*halfWidth;
        float a=p+halfWidth-width*.5,b=a+width;
        return clamp(((floor(b)-floor(a))*ink+min(fract(b),ink)-min(fract(a),ink))/width,0.,1.);
      }`).replace('#include <color_fragment>',`#include <color_fragment>
        if(buildingCoverage.x>0. || buildingCoverage.y<1.){
          float rank=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
          if(rank<buildingCoverage.x || rank>=buildingCoverage.y)discard;
        }
        vec4 sw=texelFetch(finishes,ivec2(0,finishIndex),0);
        vec4 joint=texelFetch(finishes,ivec2(1,finishIndex),0);
        vec4 physical=texelFetch(finishes,ivec2(2,finishIndex),0);
        vec4 finish=texelFetch(finishes,ivec2(3,finishIndex),0);
        vec4 pane=texelFetch(finishes,ivec2(4,finishIndex),0);
        vec4 surface=texelFetch(finishes,ivec2(5,finishIndex),0);
        float transmissionAlpha=surface.x;
        int family=int(sw.a+.5);
        vec3 albedo=sw.rgb;
        vec2 texel=abs(campusN.y)>.7?campusP.xz:vec2(dot(campusP.xz,normalize(vec2(campusN.z,-campusN.x)+vec2(.00001))),campusP.y);
        ${instanced?'':'if(abs(campusN.y)<.7)texel=faceUV;'}
        float stoneBump=0.,roughVariation=0.,farGlass=0.,glassFrame=0.;
        vec4 assembly=texelFetch(finishes,ivec2(10,finishIndex),0);
        if(surface.y==17.)texel=vec2(campusP.x,.62*campusP.y+campusP.z);
        if(surface.y==21.){
          albedo=sw.rgb*(1.+.085*(noiseField(campusP.xz*.83)-.5));
        }else if(family==8 || family==9 || family==13){
          vec2 frameUV=family==13?texel/max(physical.xy,vec2(1.2,2.7)):faceUV;
          vec2 uv=family==13?fract(frameUV):frameUV;
          vec3 view=normalize(cameraPosition-campusP);
          float angle=1.-abs(dot(view,normalize(campusN)));
          vec2 glassUnit=max(physical.xy,vec2(1.2,2.7));
          vec2 facadePlane=vec2(dot(campusP.xz,normalize(campusN.zx*vec2(1.,-1.)+vec2(.00001))),campusP.y);
          vec2 du=dFdx(uv),dv=dFdy(uv);
          float det=du.x*dv.y-du.y*dv.x;
          vec2 planeOrigin=facadePlane;
          if(abs(det)>1e-10)planeOrigin-=(dFdx(facadePlane)*(dv.y*uv.x-dv.x*uv.y)+dFdy(facadePlane)*(du.x*uv.y-du.y*uv.x))/det;
          vec2 cell=family==13?floor(texel/glassUnit)+floor(campusN.xz*31.):floor(planeOrigin*.65+.13)+floor(campusN.xz*31.);
          float room=hashCell(cell);
          float shade=clamp(.16+room*.6+.27*abs(view.y),0.,1.);
          albedo=sw.rgb*(.6+shade*.7);
          if(family!=9 && room>.55 && pane.w==0. && surface.z<.5){
            float depth=.12/max(.38,abs(dot(view,normalize(campusN))));
            vec2 recessed=uv+depth*vec2(dot(view.xz,normalize(vec2(campusN.z,-campusN.x)+vec2(.00001))),view.y);
            float cutoff=.24+.54*hashCell(cell+vec2(2.,5.));
            float pixel=max(.002,fwidth(recessed.y));
            float cover=smoothstep(cutoff-pixel,cutoff+pixel,recessed.y);
            float slat=screened(recessed.y*31.,.13);
            vec3 blind=mix(vec3(.36,.35,.31),vec3(.53,.53,.48),room);
            albedo=mix(albedo,blind*(1.-.26*slat),cover*.46);
            float hem=1.-smoothstep(.004,.009+pixel,abs(recessed.y-cutoff));
            albedo*=1.-.13*hem;
          }
          if(family!=9){
            vec3 glassNormal=normalize(campusN);
            vec3 tangent=normalize(vec3(glassNormal.z+.000001,0.,-glassNormal.x));
            glassNormal=normalize(glassNormal+tangent*((room-.5)*.010));
            vec3 reflected=reflect(-view,glassNormal);
            float sky=smoothstep(-.12,.43,reflected.y);
            vec3 reflectedTint=mix(vec3(.115,.145,.142),vec3(.39,.54,.68),sky);
            float azimuth=dot(reflected,vec3(.76,0.,.65));
            float distanceTint=noiseField(campusP.xz*.038+reflected.xz*5.)-.5;
            reflectedTint*=1.+distanceTint*.24;
            float horizon=smoothstep(-.075,.11,reflected.y+.07*azimuth);
            reflectedTint=mix(vec3(.096,.112,.112),reflectedTint,horizon);
            float fresnel=mix(.17,.48,assembly.z)+.34*pow(angle,2.);
            albedo=mix(albedo,reflectedTint,fresnel);
          }
          vec2 paneEdge=min(uv,1.-uv);
          float occlusion=.74+.26*smoothstep(0.,.075,min(paneEdge.x,paneEdge.y));
          albedo*=occlusion;
          if(pane.w==1.)albedo=mix(albedo,vec3(.39,.49,.53),.33);
          if(family==9)albedo=surface.y==10.?sw.rgb*(.91+.09*occlusion):mix(sw.rgb*.72,albedo,smoothstep(.30,.315,uv.y));
          if(family==9 && surface.y==16.){
            float slat=screened(campusP.y/physical.y,.10);
            albedo=sw.rgb*(1.-.24*slat);
            stoneBump=.005*slat;
          }
          float vn=finish.z+1.,hn=finish.w+1.;
          float bars=pane.x>0.?max(ruled(frameUV.x*vn,pane.x*vn*.5),ruled(frameUV.y*hn,pane.x*hn*.36)):0.;
          if(family==9 && surface.y==16.)bars=0.;
          if(pane.w==2.)bars=max(bars,.47*max(ruled((uv.x+uv.y)*6.,.023),ruled((uv.x-uv.y)*6.,.023)));
          if(pane.y>.5 && uv.y>.62)bars=max(bars,.85*ruled((uv.y+abs(uv.x-.5)*.8)*4.,.048));
          glassFrame=bars;
          albedo=mix(albedo,joint.rgb*.84,bars);transmissionAlpha=mix(transmissionAlpha,1.,bars);
        }else if(family==11){
          vec2 grid=texel/physical.xy;
          float pickets=screened(grid.x,assembly.w==1.?.43:assembly.w==2.?.16:.13);
          float rails=screened(grid.y,assembly.w>0.?.055:.13);
          float grille=max(pickets,rails);
          transmissionAlpha=mix(.012,1.,grille);
          albedo*=.87+.13*screened(grid.x+.08,.12);
        }else if(family==12){
          float blind=ruled(texel.y*5.,.23);
          albedo*=.71+.09*blind+.035*sin(texel.x*1.77);
        }else if(family==10){
          vec2 q=abs(fract(faceUV)-.5),aa=max(fwidth(faceUV),vec2(.001));
          vec2 opening=1.-smoothstep(vec2(pane.z,finish.z)*.5-aa*.4,vec2(pane.z,finish.z)*.5+aa*.4,q);
          vec2 coverage=clamp(vec2(pane.z,finish.z),0.,1.);
          opening=mix(opening,coverage,smoothstep(vec2(.24),vec2(.88),aa));
          vec3 view=normalize(cameraPosition-campusP);
          float sky=smoothstep(-.09,.28,reflect(-view,normalize(campusN)).y);
          vec3 glass=mix(joint.rgb,mix(vec3(.13,.16,.17),vec3(.40,.53,.64),sky),.30);
          vec2 paneLocal=(fract(faceUV)-.5)/max(coverage,vec2(.02))+.5;
          float detail=1.-smoothstep(.09,.37,max(aa.x,aa.y));
          float reveal=smoothstep(.0,.09,paneLocal.y)*smoothstep(.0,.055,paneLocal.x);
          float rail=max(ruled(paneLocal.x*2.,.018),ruled(paneLocal.y-0.69,.014));
          glass*=mix(1.,.66+.34*reveal,detail);
          glass=mix(glass,mix(sw.rgb,vec3(.49),.23),rail*detail*.74);
          float sill=(1.-smoothstep(.015,.075,abs(paneLocal.y+.036)))*step(0.,paneLocal.x)*step(paneLocal.x,1.);
          farGlass=opening.x*opening.y;
          albedo=mix(albedo,glass,farGlass*.91);
          albedo*=1.+sill*detail*.14;
        }else{
          vec2 q=texel/physical.xy;
          vec2 unitPixel=fwidth(q);
          float row=floor(q.y);
          if(finish.y==1.)q.x+=.5*mod(row,2.);
          if(finish.y==2.)q.x=q.x*(1.+mod(row,2.))+.5*mod(row,2.);
          if(finish.y==3.)q.x+=.5*mod(row,2.)+.2*mod(floor(q.x),2.);
          if(finish.y>=4.)q.x=q.x*(.75+.58*hashCell(vec2(row,12.)))+hashCell(vec2(row,4.));
          float mortar=0.;
          if(family==1||family==2||family==4||family==6)mortar=max(ruled(q.x,.018),ruled(q.y,.028));
          if(family==6){
            q.x+=.5*mod(row,2.);
            mortar=max(.23*ruled(q.x,.015),.70*ruled(q.y,.018));
          }
          if(family==3)mortar=ruled(q.y,.035);
          if(family==5)mortar=ruled(q.x,.034);
          float visibility=1.-smoothstep(.17,1.,max(unitPixel.x,unitPixel.y));
          float grain=noiseField(texel*18.)-.5;
          float weather=noiseField(texel*.39)*.68+noiseField(texel*.105)*.32;
          float sampleTone=hashCell(floor(q));
          float variation=(sampleTone-.5)*joint.a*visibility;
          if(family==2){
            bool rubble=surface.y==3.;
            vec2 roughQ=q;
            if(rubble){
              roughQ+=vec2(noiseField(texel*5.3)-.5,noiseField(texel*4.1)-.5)*vec2(.095,.066);
              float course=floor(roughQ.y);
              roughQ.x=texel.x/physical.x*(.77+.47*hashCell(vec2(course,19.)))+hashCell(vec2(course,71.));
            }
            float course=floor(roughQ.y),nearestHead=floor(roughQ.x+.5);
            float drift=finish.y>=4.?(hashCell(vec2(nearestHead,course))-.5)*.47:0.;
            float offset=roughQ.x-nearestHead-drift;
            float headJoint=filteredStripe(offset,rubble?.050:.022,unitPixel.x);
            float bedJoint=filteredStripe(roughQ.y,rubble?.080:.036,unitPixel.y);
            mortar=headJoint+bedJoint-headJoint*bedJoint;
            float stone=mix(.5,hashCell(vec2(nearestHead-step(offset,0.),course)),visibility);
            albedo=mix(sw.rgb,joint.rgb,(.18+.75*stone)*joint.a);
            variation=(stone-.5)*joint.a*(rubble?1.35:.78)*visibility;
            float clearance=min(abs(offset)*physical.x,abs(fract(roughQ.y+.5)-.5)*physical.y);
            float bevel=smoothstep(.004,rubble?.021:.012,clearance);
            float split=surface.y==5.?1.:0.;
            float fracture=noiseField(texel*vec2(5.8,9.1)+vec2(stone*7.,course))-.5;
            float closeDetail=1.-smoothstep(.006,.045,max(unitPixel.x*physical.x,unitPixel.y*physical.y));
            variation+=fracture*(rubble?.14:.048+.13*split)*visibility;
            stoneBump=((bevel-1.)*(rubble?.010:.005)+(rubble?.009:.002+.004*split)*fracture+grain*.001)*closeDetail;
          }else if(family==1){
            float pitchY=max(.035,physical.y);
            float rowPhase=fract(texel.y/pitchY);
            float edgeY=min(rowPhase,1.-rowPhase)*pitchY;
            float edgeX=abs(fract(q.x+.5)-.5)*physical.x;
            float bevel=smoothstep(.003,.009,min(edgeX,edgeY));
            float endJoint=filteredStripe(q.x,clamp(.010/physical.x,.018,.13),unitPixel.x);
            float bedJoint=filteredStripe(q.y,clamp(.009/pitchY,.025,.18),unitPixel.y);
            mortar=endJoint+bedJoint-endJoint*bedJoint;
            float firing=noiseField(texel*vec2(.44,.72))-.5;
            variation+=joint.a*(.45*firing+.27*(weather-.5));
            float edgeDetail=1.-smoothstep(.0018,.010,max(unitPixel.x*physical.x,unitPixel.y*pitchY));
            stoneBump=(bevel*.0035+(sampleTone-.5)*.0008+grain*.0006)*edgeDetail;
          }
          if(family==1 || family==2)roughVariation=(.11*mortar+.065*(sampleTone-.5)*visibility+.035*grain*visibility);
          if(surface.y==1. || surface.y==2.){
            float grooves=surface.y==1.?ruled(texel.x/.103,.17):0.;
            mortar*=.23;
            variation=grain*.085-grooves*.11;
            stoneBump=(grain*.0019-grooves*.0035)*(1.-smoothstep(.025,.14,fwidth(texel.x)));
          }
          if(surface.y==7.){
            float board=floor(texel.y/.166),grainLine=noiseField(vec2(texel.x*.94,texel.y*24.))-.5;
            float grainAA=1.-smoothstep(.012,.060,fwidth(texel.y));
            mortar=.14*ruled(texel.y/.166,.010);
            variation=(hashCell(vec2(board,4.))-.5)*.033*visibility+grainLine*.075*grainAA;
            stoneBump=.0023*(grainLine-mortar)*grainAA;
          }
          if(surface.y==8. || surface.y==9.){
            float expansion=ruled(q.x,.004);
            mortar=max(expansion,surface.y==8.?ruled(q.y,.003):0.)*.44;
            variation=(weather-.5)*.065+(sampleTone-.5)*.022*visibility;
          }
          if((family==0 && (surface.y==0. || surface.y==6.)) || family==7)variation=0.;
          if(surface.y==20.){
            vec2 edge=abs(fract(q+.5)-.5)*physical.xy;
            vec2 aa=max(fwidth(texel),vec2(.003));
            vec2 scored=1.-smoothstep(vec2(.009)-aa*.5,vec2(.009)+aa*.5,edge);
            float groove=max(scored.x,scored.y);
            mortar=0.;
            variation=-.46*groove+.14*(weather-.5)+.07*(sampleTone-.5)*visibility;
            stoneBump=-.009*groove;
          }
          if(surface.y==19.){
            float clusters=noiseField(texel*vec2(.64,.46)+vec2(.15,.41));
            float sprigs=noiseField(texel*vec2(2.9,2.2)+clusters);
            float leaves=noiseField(texel*vec2(12.,9.)+sprigs*1.7);
            float detail=1.-smoothstep(.024,.14,max(fwidth(texel.x),fwidth(texel.y)));
            float light=smoothstep(.30,.78,.59*clusters+.41*sprigs);
            albedo=mix(sw.rgb*.68,joint.rgb,light);
            variation=(leaves-.5)*.54*detail;
            stoneBump=.027*(sprigs-.5)+.009*leaves*detail;
          }
          if(surface.y==11.){
            float phase=fract(texel.y/.14),visible=1.-smoothstep(.025,.15,fwidth(texel.y));
            mortar=0.;
            variation=(mix(-.29,.13,smoothstep(.08,.83,phase))-.045)*visible;
            stoneBump=phase*.018*visible;
          }
          if(surface.y==15.){
            vec2 timber=texel;
            float knots=noiseField(vec2(timber.x*.53,timber.y*3.15))-.5;
            float grainLine=noiseField(vec2(timber.x*.86,timber.y*32.+knots*2.1))-.5;
            float aa=1.-smoothstep(.014,.11,fwidth(timber.y));
            mortar=.15*screened(timber.y/max(.12,physical.y),.025);
            variation=grainLine*.16*aa+knots*.085;
            stoneBump=grainLine*.0005*aa;
          }
          if(surface.y==18.){
            float bars=screened(texel.x/.060,.39),crossbars=screened(texel.y/.215,.22);
            float grate=bars+(1.-bars)*crossbars;
            mortar=0.;variation=-.31+.34*grate;
            stoneBump=.0022*grate*(1.-smoothstep(.012,.075,fwidth(texel.x)));
          }
          if(surface.y==17.){
            float across=dot(campusP.xz,assembly.xy)/max(1.0,physical.x);
            float seam=screened(across,.024),edge=ruled(across,.045);
            mortar=0.;
            variation=.022*cos(6.283185*across)-.14*seam-.037*edge+grain*.024;
            stoneBump=.007*edge;
          }
          if(surface.y==14.){
            vec2 bay=texel/vec2(1.62,1.18);
            float ribs=max(screened(bay.x,.095),screened(bay.y,.12));
            float bevel=max(ruled(bay.x,.075),ruled(bay.y,.086));
            variation=.14*ribs-.10*(bevel-ribs);
            stoneBump=.018*bevel;
          }
          if(surface.y==12. || surface.y==13.){
            float pitch=surface.y==12.?.16:.135;
            float jointLine=ruled(texel.x/pitch,.04);
            float wave=.5+.5*cos(texel.x*6.283185/pitch);
            float visible=1.-smoothstep(.022,.15,fwidth(texel.x));
            mortar=jointLine*.54;
            variation=(surface.y==12.?(noiseField(texel*vec2(17.,.65))-.5)*.12:(wave-.5)*.095)*visible;
            stoneBump=(surface.y==12.?-.003*jointLine:.0044*wave)*visible;
          }
          albedo=mix(albedo*(1.+variation),joint.rgb*(family==2?.74:.96),mortar*(family==1?.94:.80));
          albedo*=1.+grain*(family==7?.39:.085)*(1.-smoothstep(.016,.12,max(fwidth(texel.x),fwidth(texel.y))));
          albedo*=1.+(weather-.5)*finish.x*(family==7?.32:.19);
        }
        bool glazing=family==8 || (family==13 && surface.y!=21.) || (family==4 && surface.x<1.);
        if(glazing && transmissionAlpha<1.){
          float facing=abs(dot(normalize(cameraPosition-campusP),normalize(campusN)));
          transmissionAlpha=mix(.70+.30*transmissionAlpha,1.,.7*pow(1.-facing,3.));
        }
        if(surface.z>.5 && surface.y!=17. && campusN.y>.25 && gl_FrontFacing){
          vec2 pt=campusP.xz;
          float patchTone=0.;
          for(int i=0;i<6;i++){
            if(float(i+1)>=surface.z)break;
            int slot=i<2?6+2*i:11+2*(i-2);
            vec4 rect=texelFetch(finishes,ivec2(slot,finishIndex),0),rotation=texelFetch(finishes,ivec2(slot+1,finishIndex),0);
            vec2 q=pt-rect.xy,edge=abs(vec2(dot(q,rotation.xy),dot(q,vec2(-rotation.y,rotation.x))))-rect.zw;
            float signedEdge=max(edge.x,edge.y),aa=max(.07,fwidth(signedEdge));
            float mask=1.-smoothstep(-aa-.18,aa+.18,signedEdge);
            if(rotation.z<0. && rotation.w>.5){
              vec2 local=vec2(dot(q,rotation.xy),dot(q,vec2(-rotation.y,rotation.x)))/max(rect.zw,vec2(.2));
              vec2 flow=vec2(dot(pt,assembly.xy),dot(pt,assembly.yx*vec2(-1.,1.)));
              float wet=noiseField(flow*vec2(.35,.89))*.66+noiseField(flow*vec2(.095,.21))*.34;
              float moisture=sqrt(length(local*local))+.19*(noiseField(pt*.44)-.5);
              float basin=1.-smoothstep(.55,1.14,moisture);
              float pooling=smoothstep(.32,.83,wet);
              float aspect=max(rect.z,rect.w)/max(.2,min(rect.z,rect.w));
              float drainage=smoothstep(2.3,4.8,aspect);
              mask=basin*mix(.74*pooling*pooling,mix(.20,.86,pooling),drainage);
            }
            patchTone+=rotation.w*rotation.z*mask;
          }
          if(surface.w>.1){
            float angle=surface.w-4.;
            vec2 axis=vec2(cos(angle),sin(angle));
            vec2 lane=vec2(dot(pt,axis),dot(pt,vec2(-axis.y,axis.x)));
            float stripe=screened(lane.x/2.65,.036);
            float crossLane=abs(fract(lane.y/16.4+.5)-.5)*16.4;
            float laneWidth=max(.08,fwidth(lane.y)*.5);
            float end=1.-smoothstep(5.0-laneWidth,5.0+laneWidth,crossLane);
            float paint=max(stripe*end,screened(lane.y/16.4,.006));
            albedo=mix(albedo,vec3(.80,.76,.56),paint*.76);
          }
          vec2 dir=assembly.xy;
          vec2 roll=vec2(dot(pt,dir),dot(pt,vec2(-dir.y,dir.x)));
          float runoff=noiseField(roll*vec2(.070,.21))-.5;
          vec2 wearPoint=surface.y==6.?roll*.095+vec2(runoff*.45,0.):roll*.33+vec2(runoff,0.);
          float wear=noiseField(wearPoint)-.5;
          albedo*=max(.28,1.+patchTone+finish.x*(runoff*.58+wear*.39));
          if(surface.y==6.){
            float strip=floor(roll.y/1.35);
            float seam=max(ruled(roll.y/1.35,.006),ruled(roll.x/9.7+hashCell(vec2(strip,23.)),.002));
            float visible=1.-smoothstep(.15,.95,fwidth(roll.y)/1.35);
            float sheetTone=noiseField(roll*.165+vec2(runoff*2.1,runoff))-.5;
            float seep=noiseField(roll*.047+vec2(1.7,3.8))-.5;
            albedo*=1.+finish.x*(sheetTone*.22+seep*.20)-.11*seam*visible;
            albedo*=1.-smoothstep(.67,.96,max(sw.r,max(sw.g,sw.b)))*finish.x*(.21+.17*seep);
          }
        }
        diffuseColor.rgb*=albedo;diffuseColor.a*=transmissionAlpha;`).replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
        if(family==1 || family==2 || surface.y==1. || surface.y==2. || surface.y==7. || surface.y>=11.){
          vec3 vx=dFdx(vViewPosition),vy=dFdy(vViewPosition);
          vec3 a=cross(vy,normal),b=cross(normal,vx);
          float det=dot(vx,a);
          normal=normalize(abs(det)*normal+sign(det)*(dFdx(stoneBump)*a+dFdy(stoneBump)*b));
        }`).replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=glazing?mix(clamp(physical.z,.12,mix(.32,.48,smoothstep(.25,.70,campusN.y))),.60,glassFrame):mix(clamp(physical.z+roughVariation,.06,1.),.30,farGlass);').replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=glazing?max(.3,physical.w):mix(physical.w,.32,farGlass);');
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_end>',`#include <lights_fragment_end>
      float soffit=smoothstep(.35,.85,-campusN.y);
      reflectedLight.indirectDiffuse+=diffuseColor.rgb*vec3(.23,.225,.215)*soffit;`);
    reflectedCampus(shader);
  };
  return material;
}

export function glazingShadow(styles){
  const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  depth.customProgramCacheKey=()=>'western-glass-shadow';
  depth.onBeforeCompile=shader=>{
    shader.uniforms.finishes={value:styles};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float finishId; flat varying int glassStyle;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nglassStyle=int(finishId+.5);');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform highp sampler2D finishes; flat varying int glassStyle;')
      .replace('#include <alphatest_fragment>',`#include <alphatest_fragment>
        float opacity=texelFetch(finishes,ivec2(5,glassStyle),0).x;
        float family=texelFetch(finishes,ivec2(0,glassStyle),0).a;
        float shade=family==11.?.17:clamp(.34+.42*opacity,.34,.71);
        float rank=fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715))));
        if(rank>=shade)discard;`);
  };
  return depth;
}
