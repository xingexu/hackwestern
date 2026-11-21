import {terminalTwigs,budSprig,barkFinish,barkGrainGLSL,foliageCluster,leafSprayTexture,lightLeafBacks,leafPatchGLSL} from 'leaf-sprays';

export function createMunicipalDetail(THREE,data,region,network) {
  const group=new THREE.Group();
  group.name='London municipal survey';
  const {size,tiles}=data;
  const material=new THREE.MeshStandardMaterial({vertexColors:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  const clusters=[foliageCluster(.53),foliageCluster(.40),budSprig(),terminalTwigs()];
  const distantTwigs=terminalTwigs(1);
  const foliage=new THREE.MeshStandardMaterial({map:leafSprayTexture(),alphaTest:.36,side:THREE.DoubleSide});
  foliage.onBeforeCompile=lightLeafBacks;
  const transform=new THREE.Object3D();
  const sourceLeaf=new THREE.IcosahedronGeometry(1,0).attributes.position;
  material.customProgramCacheKey=()=>'municipal-survey-grain';
  material.onBeforeCompile=shader=>{
    shader.uniforms.leafPatch={value:foliage.map};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 localPoint; attribute float woody; varying float barkWeight;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nbarkWeight=woody;\n #ifdef USE_INSTANCING\nlocalPoint=(instanceMatrix*vec4(position,1.)).xyz;\n#else\nlocalPoint=position;\n#endif');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 localPoint;uniform sampler2D leafPatch;varying float barkWeight;\n'+leafPatchGLSL+barkGrainGLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb*=mix(1.,barkGrain(localPoint),barkWeight);
        vec3 coords=localPoint*vec3(19.8,28.2,22.6);
        float grain=sin(dot(coords,vec3(.831,.41,-.22))+1.8*sin(dot(coords,vec3(-.65,.49,.73))))*.5+.5;
        float isLeaf=smoothstep(.008,.045,diffuseColor.g-max(diffuseColor.r,diffuseColor.b));
        float nearCrown=1.-smoothstep(.035,.24,length(fwidth(localPoint)));
        diffuseColor.rgb*=1.+(grain-.5)*.035*nearCrown;
        if(isLeaf>.1)diffuseColor.rgb*=.68+.44*smallLeaves(leafPatch,localPoint);
        #ifdef USE_INSTANCING
          vec3 spray=floor(localPoint*2.65+sin(floor(localPoint*6.1))*.19);
          float cluster=fract(sin(dot(mod(spray,167.),vec3(24.73,7.91,15.93)))*28657.3);
          float rim=1.-smoothstep(.10,.46,abs(dot(normalize(vNormal),normalize(vViewPosition))));
          if(cluster+grain*.28<rim*nearCrown*.55) discard;
          diffuseColor.rgb*=1.+(cluster-.49)*nearCrown*.26;
        #endif`);
  };
  const colors=new Map();
  function color(hex){
    if(!colors.has(hex)) colors.set(hex,new THREE.Color(hex));
    return colors.get(hex);
  }
  function batch(){
    return {positions:[],indices:[],colors:[],bark:[],woody:0,mulch:[],foliage:[[],[],[],[]]};
  }
  function vertex(mesh,x,y,z,tint){
    mesh.positions.push(x,y,z);
    mesh.bark.push(mesh.woody);
    mesh.colors.push(tint.r,tint.g,tint.b);
    return mesh.positions.length/3-1;
  }
  function shaft(mesh,a,b,rA,rB,hex,sides=7,matchFaces=false,owner='municipal wood or mast') {
    if(!mesh&&!matchFaces){
      network.addBranch(a.toArray(),b.toArray(),rA,rB,owner);
      return;
    }
    const axis=new THREE.Vector3().subVectors(b,a).normalize();
    const radial=new THREE.Vector3(1,0,0);
    if(Math.abs(axis.x)>.88) radial.set(0,0,1);
    radial.cross(axis).normalize();
    const other=new THREE.Vector3().crossVectors(axis,radial);
    const tint=color(hex),start=mesh?mesh.positions.length/3:0;
    const points=[],faces=[];
    for(let i=0;i<sides;i++){
      const angle=i*2*Math.PI/sides, c=Math.cos(angle), s=Math.sin(angle);
      const dx=radial.x*c+other.x*s, dy=radial.y*c+other.y*s, dz=radial.z*c+other.z*s;
      const low=[a.x+dx*rA,a.y+dy*rA,a.z+dz*rA],high=[b.x+dx*rB,b.y+dy*rB,b.z+dz*rB];
      if(mesh){vertex(mesh,...low,tint);vertex(mesh,...high,tint);}
      else points.push(low,high);
    }
    for(let i=0;i<sides;i++){
      const j=(i+1)%sides,k=start+2*i,l=start+2*j;
      if(mesh){
        mesh.indices.push(k,l,k+1,l,l+1,k+1);
        if(i>0&&i<sides-1)mesh.indices.push(start+1,k+1,l+1);
      }else{
        faces.push([points[k],points[l],points[l+1],points[k+1]]);
        if(i>0&&i<sides-1)faces.push([points[1],points[k+1],points[l+1]]);
      }
    }
    if(!mesh)network.addShell(points,faces,owner);
  }
  function crown(mesh,x,y,z,rx,ry,rz,yaw,hex,foliage=false) {
    if(foliage){
      if(!mesh)return;
      mesh.foliage[foliage===4?3:foliage===3?2:foliage===true?1:0].push([x,y,z,rx,ry,rz,yaw,hex]);
      return;
    }
    const c=Math.cos(yaw),s=Math.sin(yaw),tint=color(hex),points=[],faces=[];
    for(let i=0;i<sourceLeaf.count;i++){
      const xx=sourceLeaf.getX(i)*rx,zz=sourceLeaf.getZ(i)*rz;
      const p=[x+xx*c+zz*s,y+sourceLeaf.getY(i)*ry,z-xx*s+zz*c];
      if(mesh)mesh.indices.push(vertex(mesh,...p,tint));
      else{
        points.push(p);
        if(i%3===2)faces.push(points.slice(-3));
      }
    }
    if(!mesh)network.addShell(points,faces,'municipal wood or mast');
  }
  function lamp(mesh,[x,z,h,yaw,form,wood]){
    const y=network.groundAt(x,z), mast=wood?0x9a8673:0x768287;
    const point=(u,v)=>new THREE.Vector3(x+Math.sin(yaw)*u,y+v,z+Math.cos(yaw)*u);
    shaft(mesh,point(0,-.12),point(0,h),wood ? .13 : .103,.071,mast);
    if(wood){
      shaft(mesh,point(0,h-.10),point(0,h+1.62),.086,.067,mast,8);
      shaft(mesh,point(-1.07,h+1.20),point(1.07,h+1.20),.074,.074,0x887252,6);
      for(const offset of [-.91,0,.91]){
        const a=point(offset,h+1.25),b=point(offset,h+1.47);
        shaft(mesh,a,b,.056,.049,0x82928a,6);
        shaft(mesh,point(offset,h+1.35),point(offset,h+1.40),.087,.080,0x91a298,6);
      }
    }
    if(!wood){
      shaft(mesh,point(0,-.06),point(0,.12),.235,.235,0xa7a69b,8);
      shaft(mesh,point(0,.10),point(0,.36),.17,.14,0x667377);
      shaft(mesh,point(0,.34),point(0,.39),.154,.154,0x909a97);
      for(const turn of [-1,1]){
        const foot=point(turn*.14,.12);
        shaft(mesh,foot,foot.clone().add(new THREE.Vector3(0,.048,0)),.023,.018,0x535e61,6);
      }
      shaft(mesh,point(.089,.56),point(.089,.82),.045,.045,0x515e62,6);
    }
    if(form===3||form===4){
      const lateral=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw));
      const fixture=(u,v,forward=0)=>point(forward,v).addScaledVector(lateral,u);
      shaft(mesh,point(0,-.08),point(0,.17),.37,.34,0xa6a69d,8);
      shaft(mesh,point(0,.17),point(0,h-.38),.20,.11,0x9caaa9,8);
      shaft(mesh,fixture(-1.44,h),fixture(1.44,h),.09,.09,0x687679,6);
      for(const offset of form===4?[-1.15,-.575,0,.575,1.15]:[-1.15,-.40,.40,1.15]){
        const back=fixture(offset,h+.17,.12),front=fixture(offset,h+.04,.40);
        shaft(mesh,back,front,.165,.265,0x606b70,8);
        shaft(mesh,front,fixture(offset,h+.024,.435),.245,.237,0xe4e6db,8);
      }
      return;
    }
    if(form===2) {
      shaft(mesh,point(0,h-.07),point(0,h+.33),.13,.29,0xf3f0dc);
      shaft(mesh,point(0,h+.33),point(0,h+.48),.34,.045,0x475862);
      return;
    }
    for(const side of form===1?[-1,1]:[1]){
      const p=(u,v)=>point(side*u,v);
      shaft(mesh,p(0,h-.84),p(.96,h-.06),.065,.053,mast,6);
      shaft(mesh,p(.96,h-.06),p(2.18,h+.13),.053,.048,mast,6);
      const tip=p(2.38,h+.09);
      crown(mesh,tip.x,tip.y,tip.z,.25,.135,.48,yaw,0x67767d);
      crown(mesh,tip.x,tip.y-.09,tip.z,.20,.064,.34,yaw,0xf7f1d9);
    }
  }
  const green=[0x739054,0x729053,0x97a460,0x7e9457,0x5c8055,0x8a9756,0x949b5c];
  const conifer=[0x466a51,0x4a7057,0x597b58,0x496e5b];
  function tree(mesh,[x,z,h,r,dbh,form,seed,family=form]){
    const y=network.groundAt(x,z),origin=new THREE.Vector3(x,y-.08,z);
    const barkTint=family===11?0xb4ab96:family===12?0x898875:family===14?0x939083:family===5?0x706453:0x796f5b;
    const splay=family===5?1.15:family===11?.79:family===8?.84:family===12?.70:1;
    const forkRatio=form===2?.63:form===6?.32:form===7?.55:.43;
    const fork=new THREE.Vector3(x,y+h*forkRatio,z);
    shaft(mesh,origin,fork,Math.max(.07,dbh),Math.max(.05,dbh*.65),barkTint,7,false,'municipal tree');
    if(form===10){
      const leader=new THREE.Vector3(x+.06*r,y+h*.93,z-.05*r);

      const phases=[0x86904e,0x98945c,0xa3996f,0x7e8459];
      const budded=seed%7<3;
      let joint=fork;
      for(let i=0;i<8;i++){
        const t=(i+.35)/8,a=seed*1.23+i*2.41+.55*Math.sin(seed*1.67+i*1.9);
        const reach=r*(1-.49*t)*(.70+.26*Math.cos(seed*.41+i));
        const start=fork.clone().lerp(leader,t*.87);
        const crotch=new THREE.Vector3(start.x+Math.sin(a)*reach*.37,start.y+h*(.055+.024*Math.cos(a)),start.z+Math.cos(a)*reach*.37);
        const tip=new THREE.Vector3(x+Math.sin(a+.22)*reach,crotch.y+h*(.12+.082*Math.sin(a)),z+Math.cos(a+.22)*reach);
        shaft(mesh,joint,start,dbh*(.66-.51*t),dbh*(.60-.49*t),0x726752,6);
        shaft(mesh,start,crotch,dbh*(.40-.18*t),dbh*.16,0x736958,5);
        shaft(mesh,crotch,tip,dbh*.16,.018,0x83765e,5);
        joint=start;
        for(const side of [-1,1]){
          const s=crotch.clone().lerp(tip,side<0?.30:.68),len=reach*(.48+.14*Math.sin(a+side));
          const angle=a+side*(.68+.43*Math.cos(seed+i));
          const end=new THREE.Vector3(s.x+Math.sin(angle)*len,s.y+h*(.054+.042*Math.cos(angle)),s.z+Math.cos(angle)*len);
          shaft(mesh,s,end,dbh*.107,.012,0x897d66,4);
          if(mesh){
            for(const split of [-1,1]){
              const dir=angle+.56*split,twig=new THREE.Vector3(end.x+Math.sin(dir)*len*.48,end.y+h*(.04+.035*Math.sin(dir)),end.z+Math.cos(dir)*len*.48);
              shaft(mesh,end,twig,.018,.0045,0x92816b,3);
              if(split>0)crown(mesh,twig.x,twig.y,twig.z,Math.max(.65,r*.44),Math.max(.7,h*.13),Math.max(.83,r*.52),dir,0x766750,4);
              else crown(mesh,end.x,end.y,end.z,Math.max(.60,r*.36),Math.max(.71,h*.12),Math.max(.68,r*.44),dir,0x877762,4);
              if(budded||((seed+i)%3===0&&split>0))crown(mesh,twig.x,twig.y,twig.z,.22+.33*r,.17+.094*h,.22+.27*r,dir,phases[(seed+i)%4],3);
            }
          }
        }
      }
      shaft(mesh,joint,leader,dbh*.13,.015,0x82745f,5);
      return;
    }
    if(form===1 || form===3){
      const tall=form===3;
      const layers=tall?7:6;
      const width=r*(tall ? .72 : 1);
      for(let level=0;level<layers;level++){
        const band=(level+.45)/layers,angle=seed+.85*level;
        const reach=width*(1-.78*band);
        const Y=y+h*(.23+.66*band);
        for(let lobe=0;lobe<3;lobe++){
          const a=angle+lobe*2.094;
          const X=x+Math.sin(a)*reach*.45, Z=z+Math.cos(a)*reach*.45;
          crown(mesh,X,Y,Z,reach*.74,h*.112,reach*.60,a,conifer[(seed+level+lobe)%conifer.length],2);
        }
      }
      crown(mesh,x,y+h*.90,z,width*.22,h*.11,width*.23,seed,conifer[2],2);
      return;
    }
    const pine=form===2, willow=form===4;
    const arms=form===7?9:form===6?6:7;
    for(let i=0;i<arms;i++){
      const crest=i===arms-1;
      const a=seed*1.67+i*2.4, d=crest ? .12*r : r*splay*(.46+.13*Math.sin(seed+i));
      const X=x+Math.sin(a)*d,Z=z+Math.cos(a)*d;
      const Y=y+h*(crest ? .83 : (pine || form===6 ? .76 : form===8 ? .61 : .66)+.055*Math.sin(1.13*i+seed));
      if(!crest){
        const elbow=new THREE.Vector3(x+(X-x)*.47,y+h*(forkRatio+.14+.045*Math.sin(a)),z+(Z-z)*.47);
        shaft(mesh,fork,elbow,Math.max(.055,dbh*.46),Math.max(.04,dbh*.28),0x6d6052,5);
        shaft(mesh,elbow,new THREE.Vector3(X,Y,Z),Math.max(.04,dbh*.28),.026,0x756a57,5);
      }
      const width=r*splay*(form===7?.42:crest?.62:.64+.07*Math.sin(a));
      const height=h*(pine ? .145 : willow || form===8 ? .27 : form===7 ? .15 : crest ? .19 : .218);
      const tint=pine?conifer[(seed+i)%conifer.length]:green[(seed+i)%green.length];
      crown(mesh,X,Y,Z,width,height,width*.93,a,tint,true);
      if(i%2===0 && !pine){
        crown(mesh,X+Math.sin(a)*width*.56,Y-height*.27,Z+Math.cos(a)*width*.56,
          width*.54,height*.60,width*.49,a+.4,tint,2);
      }
    }
  }
  function shrub(mesh,[x,z,h]){
    if((region.campusBoundary&&!region.campusBoundary.containsDisc(x,z,.75+.41*h))||!network.plantable(x,z))return;
    const y=network.groundAt(x,z);
    const width=.36+.27*h;
    for(let i=0;i<4;i++){
      const angle=x*.71+z*.17+i*2.4;
      const radius=i===3?0:width*.57;
      crown(mesh,x+Math.cos(angle)*radius,y+h*(i===3?.69:.43),z+Math.sin(angle)*radius,
        width*.79,h*.35,width*.75,angle,green[Math.abs(Math.round(angle*7))%green.length],true);
    }
  }
  function hedgePlants([line,height],bedWidth,finish){
    const plants=[];
    let offset=.42;
    for(let i=2;i<line.length;i+=2){
      const ax=line[i-2],az=line[i-1],dx=line[i]-ax,dz=line[i+1]-az,length=Math.hypot(dx,dz);
      if(length<.001)continue;
      while(offset<=length){
        const x=ax+dx*offset/length,z=az+dz*offset/length;
        const phase=Math.sin(x*1.7+z*.41),width=bedWidth?bedWidth*(.37+.06*phase):.57+.14*phase;
        const h=(bedWidth?height:.28+.39*Math.min(height,2.4))*(1+.18*phase);
        for(const scale of finish?[1,.72,.47]:[1]){
          const radius=width*scale;
          if(region.campusBoundary&&!region.campusBoundary.containsDisc(x,z,radius*1.6))continue;
          if(!network.plantable(x,z,radius)||!network.crownClear(x,network.groundAt(x,z)+h*.5,z,radius,h*.58))continue;
          plants.push([x,z,h,radius,Math.atan2(dx,dz),bedWidth&&bedWidth*scale,finish]);
          break;
        }
        offset+=.88+.12*phase;
      }
      offset-=length;
    }
    return plants;
  }
  const bedColors={evergreen:[0x526b48,0x566f4c,0x64794f],mixed:[0x85794d,0x7b854e,0x888957],russet:[0x947454,0x9a795d,0x805f4c],forsythia:[0xb7a04f,0xad9955,0xb6a360]};
  function hedge(mesh,[x,z,h,r,yaw,bedWidth,finish]){
    const y=network.groundAt(x,z),turn=x*.53+z*.86;
    const root=new THREE.Vector3(x,y-.04,z);
    const fork=new THREE.Vector3(x,y+h*.42,z);
    shaft(mesh,root,fork,.10+.065*r,.072,0x685643,6);
    for(let i=0;i<3;i++){
      const a=turn+i*2.4,spread=i===2?.12:.47;
      const end=new THREE.Vector3(x+Math.cos(a)*r*spread,y+h*(i===2?.68:.49),z+Math.sin(a)*r*spread);
      shaft(mesh,fork,end,.053,.024,0x655742,5);
      crown(mesh,end.x,end.y,end.z,r*(i===2?.65:.83),h*(i===2?.43:.49),r*.70,a,finish?bedColors[finish][Math.abs(Math.floor(turn+i))%3]:bedWidth?(h<.43?0xae9677:0x715746):conifer[Math.abs(Math.floor(turn+i))%4],true);
    }
    if(!mesh)return;
    const point=(a)=>{
      const dx=Math.cos(a)*(bedWidth?bedWidth*.55:r*1.33),dz=Math.sin(a)*.79;
      const px=x+dx*Math.cos(yaw)+dz*Math.sin(yaw),pz=z-dx*Math.sin(yaw)+dz*Math.cos(yaw);
      return [px,network.groundAt(px,pz)+.014,pz];
    };
    for(let i=0;i<8;i++)mesh.mulch.push(x,y+.014,z,...point((i+1)*Math.PI/4),...point(i*Math.PI/4));
  }
  function brush(mesh,[x,z,h,form,deadfall=form===2]){
    const y=network.groundAt(x,z),phase=x*.61+z*.37,root=new THREE.Vector3(x,y-.045,z);
    const fork=new THREE.Vector3(x+.04,y+h*.25,z-.03);
    const count=form===2?5:3;
    if(form===3){
      for(let i=0;i<7;i++){
        const a=phase+i*2.4,r=h*(.48+.22*Math.sin(a)),dy=h*(.46+.27*Math.cos(a));
        const target=new THREE.Vector3(x+Math.cos(a)*r,y+dy,z+Math.sin(a)*r);
        shaft(mesh,root,target,.036,.013,0x84775f,5);
        crown(mesh,target.x,target.y,target.z,r*.89,h*.46,r*.97,a,0x87785f,4);
        if(i%3===0)crown(mesh,target.x,target.y+r*.15,target.z,r*.43,h*.23,r*.38,a,0x918359,3);
      }
      return;
    }
    if(deadfall&&Math.abs(Math.round(x*3+z*7))%8===0){
      const length=1.72+.89*Math.sin(phase),dx=Math.sin(phase)*length,dz=Math.cos(phase)*length;
      if(network.plantable(x+dx,z+dz,.15)&&network.plantable(x-dx,z-dz,.15)){
        const base=new THREE.Vector3(x-dx,network.groundAt(x-dx,z-dz)+.11,z-dz);
        const tip=new THREE.Vector3(x+dx,network.groundAt(x+dx,z+dz)+.055,z+dz);
        shaft(mesh,base,tip,.105,.038,0x786851,6,true);
        const joint=base.clone().lerp(tip,.47),snag=joint.clone().add(new THREE.Vector3(-dz*.32,.25,dx*.32));
        shaft(mesh,joint,snag,.036,.014,0x816e57,5,true);
      }
    }
    if(mesh)for(let j=0;j<12;j++){
      const a=phase+j*2.39996,r=.22+Math.sqrt(j/12)*h*1.8;
      const px=x+Math.sin(a)*r,pz=z+Math.cos(a)*r;
      const size=.09+.10*Math.abs(Math.sin(a));
      crown(mesh,px,network.groundAt(px,pz)+.018,pz,size,.015,size*.42,a,[0x7c6e4d,0x978559,0x82725a][j%3],3);
    }
    if(form)shaft(mesh,root,fork,.029+h*.018,.022,0x71624d,5,true);
    for(let i=0;i<count;i++){
      const a=phase+i*2.40,reach=h*(.37+.14*Math.sin(a));
      const tip=new THREE.Vector3(x+Math.cos(a)*reach,y+h*(.64+.19*Math.sin(a*.6)),z+Math.sin(a)*reach);
      if(form)shaft(mesh,fork,tip,.022,.008,0x857450,4,true);
      const tint=[0x858047,0x8c895a,0x6d7852,0x5f704b,0x9b905c][Math.abs(Math.round(phase+i))%5];
      crown(mesh,tip.x,tip.y,tip.z,reach*.84,h*(form===2?.24:.17),reach*.49,a,tint,2);
    }
  }
  function raisedSurface(mesh,[ring,rise,finish]){
    const outline=[];
    for(let i=0;i<ring.length;i+=2)outline.push(new THREE.Vector2(ring[i],ring[i+1]));
    const center=outline.reduce((sum,p)=>sum.add(p),new THREE.Vector2()).multiplyScalar(1/outline.length);
    const inner=outline.map(p=>p.clone().addScaledVector(center.clone().sub(p).normalize(),.15));
    const apron=finish==='concrete',inset=apron?0:.045;
    const point=(p,h)=>[p.x,network.groundAt(p.x,p.y)+h,p.y];
    function face(points,hex){
      if(!mesh){network.addFace(points,apron?'equipment apron':'planter bed');return;}
      const start=mesh.positions.length/3,tint=color(hex);
      for(const pt of points)vertex(mesh,...pt,tint);
      for(let i=1;i<points.length-1;i++)mesh.indices.push(start,start+i,start+i+1);
    }
    function soil(a,b,c){
      const sides=[a.distanceToSquared(b),b.distanceToSquared(c),c.distanceToSquared(a)];
      const edge=sides.indexOf(Math.max(...sides));
      if(sides[edge]<.75){
        face([point(a,rise-inset),point(b,rise-inset),point(c,rise-inset)],apron?0xb5afa0:0x735e48);
        return;
      }
      const corners=[a,b,c],left=corners[edge],right=corners[(edge+1)%3],far=corners[(edge+2)%3],mid=left.clone().lerp(right,.5);
      soil(left,mid,far);soil(mid,right,far);
    }
    for(let i=0;i<outline.length;i++){
      const j=(i+1)%outline.length,steps=Math.ceil(outline[i].distanceTo(outline[j])/.68);
      for(let step=0;step<steps;step++){
        const t=step/steps,u=(step+1)/steps;
        const a=outline[i].clone().lerp(outline[j],t),b=outline[i].clone().lerp(outline[j],u);
        const c=inner[i].clone().lerp(inner[j],t),d=inner[i].clone().lerp(inner[j],u);
        face([point(a,-.02),point(b,-.02),point(b,rise),point(a,rise)],0xa19b8a);
        face([point(a,rise),point(b,rise),point(d,rise-inset),point(c,rise-inset)],0xb9b3a1);
      }
    }
    for(const [a,b,c] of THREE.ShapeUtils.triangulateShape(inner,[]))soil(inner[a],inner[b],inner[c]);
  }
  function conductors(mesh,[a,b]){
    const [ax,az,ah,aa]=a,[bx,bz,bh,ba]=b;
    const ay=network.groundAt(ax,az)+ah+1.46,by=network.groundAt(bx,bz)+bh+1.46;
    const distance=Math.hypot(bx-ax,bz-az),sag=Math.min(1.05,distance*.019);
    for(const offset of [-.91,0,.91]){
      const p=new THREE.Vector3(ax+Math.sin(aa)*offset,ay,az+Math.cos(aa)*offset);
      const q=new THREE.Vector3(bx+Math.sin(ba)*offset,by,bz+Math.cos(ba)*offset);
      let last=p;
      for(let k=1;k<=6;k++){
        const t=k/6,next=p.clone().lerp(q,t);
        next.y-=4*sag*t*(1-t);
        shaft(mesh,last,next,.015,.015,0x444542,4,true);
        last=next;
      }
    }
  }
  const plantsByTile=new Map();
  for(const tile of Object.values(tiles)){
    const plants=(tile.hedge??[]).flatMap(row=>hedgePlants(row));
    for(const [line,w,h,finish] of tile.beds??[])plants.push(...hedgePlants([line,h],w,finish));
    plantsByTile.set(tile,plants);
    if(tile.understory)tile.understory=tile.understory.filter(([x,z,h])=>region.campusBoundary.containsDisc(x,z,h*.8)&&network.plantable(x,z,.3)&&network.crownClear(x,network.groundAt(x,z)+h*.5,z,h*.59));
    for(const row of tile.understory??[])brush(null,row);
    for(const bed of tile.planters??[])raisedSurface(null,bed);
    for(const span of tile.conductors??[])conductors(null,span);
    for(const row of tile.lamps??[])lamp(null,row);
    for(const row of tile.trees??[])tree(null,row);
    for(const row of plants)hedge(null,row);
  }
  const mulch=new THREE.MeshStandardMaterial({color:0x66513c,roughness:1,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  function makeMesh(tile) {
    const buf=batch();
    for(const bed of tile.planters??[])raisedSurface(buf,bed);
    for(const span of tile.conductors??[])conductors(buf,span);
    for(const record of tile.lamps??[]) lamp(buf,record);
    buf.woody=1;
    for(const record of tile.trees??[]) tree(buf,record);
    for(const row of tile.shrubs??[])shrub(buf,row);
    for(const row of plantsByTile.get(tile)) hedge(buf,row);
    for(const row of tile.understory??[])brush(buf,row);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(buf.positions,3));
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(buf.colors,3));
    geometry.setAttribute('woody',new THREE.Float32BufferAttribute(buf.bark,1));
    geometry.setIndex(buf.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const structures=new THREE.Mesh(geometry,material);
    structures.castShadow=structures.receiveShadow=true;
    const group=new THREE.Group();
    group.add(structures);
    if(buf.mulch.length){
      const bed=new THREE.BufferGeometry();
      bed.setAttribute('position',new THREE.Float32BufferAttribute(buf.mulch,3));
      bed.computeVertexNormals();
      const soil=new THREE.Mesh(bed,mulch);
      soil.name='Hedge mulch';
      soil.userData.auditKind='field';
      soil.receiveShadow=true;
      group.add(soil);
    }
    for(const [detail,instances] of buf.foliage.entries()){
      if(!instances.length) continue;
      const clumps=new THREE.InstancedMesh(clusters[detail],foliage,instances.length);
      instances.forEach(([x,y,z,rx,ry,rz,yaw,tint],i)=>{
        transform.position.set(x,y,z);
        transform.rotation.set(0,yaw,0);
        transform.scale.set(rx,ry,rz);
        transform.updateMatrix();
        clumps.setMatrixAt(i,transform.matrix);
        clumps.setColorAt(i,color(tint));
      });
      if(detail===3)group.userData.twigSprays=clumps;
      clumps.computeBoundingSphere();
      clumps.receiveShadow=true;
      clumps.castShadow=detail<2;
      group.add(clumps);
    }
    return group;
  }
  const active=new Map();
  let last='';
  function update(x,z,distance){
    const tx=Math.floor(x/size),tz=Math.floor(z/size);
    const radius=distance>600?-1:distance>320?1:2;
    const key=Math.floor(x/32)+':'+Math.floor(z/32)+':'+radius;
    if(key===last) return false;
    last=key;
    const visible=new Set();
    for(let i=-radius;i<=radius;i++) for(let j=-radius;j<=radius;j++){
      const name=(tx+i)+':'+(tz+j);
      if(tiles[name]) visible.add(name);
    }
    for(const [name,mesh] of active) if(!visible.has(name)){
      group.remove(mesh);
      for(const part of mesh.children){
        if(part.isInstancedMesh) part.dispose();
        else part.geometry.dispose();
      }
      active.delete(name);
    }
    for(const name of visible){
      let mesh=active.get(name);
      if(!mesh){
        mesh=makeMesh(tiles[name]);
        mesh.name='Municipal '+name;
        group.add(mesh);active.set(name,mesh);
      }
      const twigs=mesh.userData.twigSprays;
      if(twigs){
        const [cx,cz]=name.split(':').map(Number);
        const nearest=Math.hypot(Math.max(0,Math.abs((cx+.5)*size-x)-size*.5),Math.max(0,Math.abs((cz+.5)*size-z)-size*.5));
        twigs.geometry=nearest>44?distantTwigs:clusters[3];
      }
    }
    return true;
  }
  return {group,update};
}


export function surveyConductors(municipal,network,boundary){
  const poles=Object.values(municipal.tiles).flatMap(tile=>(tile.lamps??[]).filter(row=>row[5]&&boundary.contains(row[0],row[1])));
  const built=new Set();
  for(const path of municipal.furniture?.poleRuns??[]){
    for(let j=1;j<path.length;j++){
      const [ax,az]=path[j-1],[bx,bz]=path[j],dx=bx-ax,dz=bz-az,len=Math.hypot(dx,dz);
      const row=[];
      for(const pole of poles){
        const [x,z]=pole,t=((x-ax)*dx+(z-az)*dz)/len;
        if(t< -6||t>len+6||Math.abs(dx*(z-az)-dz*(x-ax))/len>5.2)continue;
        row.push([t,pole]);
      }
      row.sort((a,b)=>a[0]-b[0]);
      for(let i=1;i<row.length;i++){
        const a=row[i-1][1],b=row[i][1],x=(a[0]+b[0])/2,z=(a[1]+b[1])/2;
        const distance=Math.hypot(b[0]-a[0],b[1]-a[1]),key=a.slice(0,2).join(',')+'/'+b.slice(0,2).join(',');
        if(built.has(key)||distance<6||distance>54||!boundary.contains(x,z)||!network.crownClear(x,network.groundAt(x,z)+Math.min(a[2],b[2]),z,1,1.5))continue;
        built.add(key);
        const tile=municipal.tiles[Math.floor(x/municipal.size)+':'+Math.floor(z/municipal.size)]??={};
        (tile.conductors??=[]).push([a,b]);
      }
    }
  }
}

export function fitSurveyedTrees(municipalData,boundary,network,offCourt){
  const measured=new Set(municipalData.furniture.datedTrees.map(([x,z])=>x+','+z));
  const fitted=[];
  for(const [tileKey,tile] of Object.entries(municipalData.tiles)){
    const others=[];
    for(const stem of tile.trees??[]){
      const [x,z,h,r,dbh]=stem;
      if(!measured.has(x+','+z)||!boundary.contains(x,z)){others.push(stem);continue;}
      function fit(X,Z){
        if(!boundary.contains(X,Z)||!network.plantable(X,Z,dbh)||!offCourt(X,Z))return false;
        const y=network.groundAt(X,Z)+h*.69;
        for(const fraction of [1,.82,.66,.52,.4]){
          if(!network.crownClear(X,y,Z,r*fraction*1.1,h*.33))continue;
          stem[0]=X;stem[1]=Z;stem[3]=r*fraction;
          return true;
        }
        return false;
      }
      let placed=fit(x,z);
      const limit=Math.min(2.4,.42*r+.43);
      for(let radius=.32;!placed&&radius<=limit+.01;radius+=.32){
        const samples=Math.ceil(Math.PI*radius*2/.34);
        for(let i=0;i<samples&&!placed;i++){
          const a=i*Math.PI*2/samples+stem[6];
          placed=fit(x+Math.cos(a)*radius,z+Math.sin(a)*radius);
        }
      }
      const dest=Math.floor(stem[0]/municipalData.size)+':'+Math.floor(stem[1]/municipalData.size);
      if(dest===tileKey)others.push(stem);
      else fitted.push([dest,stem]);
    }
    if(tile.trees)tile.trees=others;
  }
  for(const [key,stem] of fitted){
    const tile=municipalData.tiles[key]??={};
    (tile.trees??=[]).push(stem);
  }
}

export function reconcileTreeObservations(furniture,region,core,municipal,survey){
  if(!furniture?.datedTrees)return;
  const buckets=new Map(),size=8;
  function bin(x,z){return Math.floor(x/size)+':'+Math.floor(z/size);}
  for(const [x,z,r] of [...furniture.clearStems,...furniture.datedTrees.map(p=>[p[0],p[1],Math.min(3.6,Math.max(1.35,p[3]*.72))])]){
    const key=bin(x,z);
    if(!buckets.has(key))buckets.set(key,[]);
    buckets.get(key).push([x,z,r]);
  }
  function retain(x,z){
    for(const dx of [-size,0,size])for(const dz of [-size,0,size]){
      if(buckets.get(bin(x+dx,z+dz))?.some(([X,Z,r])=>Math.hypot(x-X,z-Z)<r))return false;
    }
    return true;
  }
  const seasonal=(municipal.woodlots?.dormantSurvey??[]).filter(([x,z])=>retain(x,z));
  const springRoots=new Set(seasonal.map(([x,z])=>x+','+z));
  for(const [x,z] of seasonal){
    const key=bin(x,z);
    if(!buckets.has(key))buckets.set(key,[]);
    buckets.get(key).push([x,z,.75]);
  }
  for(const layer of [core,region])layer.trees=layer.trees.filter(([x,,z])=>retain(x,z));
  for(const tile of Object.values(survey.tiles))if(tile.stems){
    tile.springReturns=tile.stems.filter(([x,z])=>springRoots.has(x+','+z));
    tile.stems=tile.stems.filter(([x,z])=>retain(x,z));
  }
  for(const tile of Object.values(municipal.tiles))if(tile.trees)tile.trees=tile.trees.filter(([x,z])=>retain(x,z));
  for(const [x,z,h,r,form] of [...seasonal,...furniture.datedTrees]){
    const key=Math.floor(x/municipal.size)+':'+Math.floor(z/municipal.size);
    const tile=municipal.tiles[key]??={};
    const seed=Math.abs(Math.round(x*7+z*13))%1009;
    (tile.trees??=[]).push([x,z,h,r,Math.max(.055,h*.014),form,seed]);
  }
}

export function addSurveyedGround(observed,municipal,features){
  function tile(data,size,x,z){
    const key=Math.floor(x/size)+':'+Math.floor(z/size);
    return data.tiles[key]??={};
  }
  const pickets=new Set(municipal.furniture?.ironFenceIds??[]);
  for(const [id,points] of municipal.surveyFences??[]){
    for(let i=2;i<points.length;i+=2){
      const x=points[i-2],z=points[i-1],X=points[i],Z=points[i+1];
      const mx=(x+X)/2,mz=(z+Z)/2;
      (tile(features,features.tileSize,mx,mz).l??=[]).push([pickets.has(id)?'iron_fence':'survey_fence',id,x,0,z,X,0,Z]);
    }
  }
  const fixture=municipal.furniture;
  if(fixture){
    const aprons=(fixture.equipmentAprons??[]).map(([ring,rise])=>[ring,rise,'concrete']);
    for(const bed of [...(fixture.planterBeds??[]),...aprons]){
      const [points]=bed;
      (tile(municipal,municipal.size,points[0],points[1]).planters??=[]).push(bed);
    }
    const removals=fixture.clearShrubs??[];
    observed.shrubs=observed.shrubs.filter(([x,z])=>!removals.some(([X,Z,r])=>Math.hypot(x-X,z-Z)<r));
    const removed=new Set((fixture.retiredProps??[]).map(([kind,id])=>kind+':'+id));
    const retiredLines=new Set((fixture.retiredLines??[]).map(([kind,id])=>kind+':'+id));
    const retiredHedges=new Set((fixture.retiredHedgeStarts??[]).map(p=>p.join(',')));
    features.retiredBarrierNodes=[];
    const oriented=new Map((fixture.reorientedProps??[]).map(([kind,id,yaw,width])=>[kind+':'+id,[yaw,width]]));
    for(const entry of Object.values(features.tiles)){
      for(const p of entry.p??[]){
        const measured=oriented.get(p[0]+':'+p[1]);
        if(measured)[p[5],p[6]]=measured;
      }
      if(entry.p)entry.p=entry.p.filter(([kind,id,x,,z])=>{
        if(!removed.has(kind+':'+id))return true;
        features.retiredBarrierNodes.push(kind+':'+x.toFixed(2)+':'+z.toFixed(2));
        return false;
      });
      if(entry.l)entry.l=entry.l.filter(([kind,id])=>!retiredLines.has(kind+':'+id));
    }
    for(const entry of Object.values(municipal.tiles))
      if(entry.hedge)entry.hedge=entry.hedge.filter(([line])=>!retiredHedges.has(line.slice(0,2).join(',')));
    for(const [line,h,w,finish] of [...(fixture.sitePlantings??[]),...(fixture.bedRows??[])])
      (tile(municipal,municipal.size,line[0],line[1]).beds??=[]).push([line,w,h,finish]);
    for(const [i,[kind,points]] of (fixture.siteWalls??[]).entries()){
      for(let j=2;j<points.length;j+=2){
        const [x,z,X,Z]=points.slice(j-2,j+2);
        (tile(features,features.tileSize,(x+X)/2,(z+Z)/2).l??=[]).push([kind,-30000-i,x,0,z,X,0,Z]);
      }
    }
    for(const [id,x,z,heading,count] of fixture.rackSurveys??[]){
      const rack=Object.values(features.tiles).flatMap(t=>t.p??[]).find(p=>p[0]==='bicycle_parking'&&p[1]===id);
      if(rack){rack[2]=x;rack[4]=z;rack[5]=heading;rack[8]=count;}
    }
    for(const [i,[kind,x,z,yaw,width,length,height]] of (fixture.siteStructures??[]).entries())
      (tile(features,features.tileSize,x,z).p??=[]).push([kind,-20000-i,x,0,z,yaw,width,length,height]);
    features.fixtureFinishes=new Map([...(fixture.seatFinishes??[]),...(fixture.equipmentFinishes??[])].map(([kind,x,z,finish])=>[kind+','+x+','+z,finish]));
    features.gardens=fixture.gardens;
    for(const garden of fixture.gardens??[]){
      const [cx,cz]=garden.center;
      for(const entry of Object.values(municipal.tiles))if(entry.hedge)entry.hedge=entry.hedge.filter(([line])=>Math.hypot(line[0]-cx,line[1]-cz)>garden.radius);
      for(const bed of garden.beds){
        const [line]=bed;
        (tile(municipal,municipal.size,line[0],line[1]).beds??=[]).push(bed);
      }
    }
    for(const [kind,id,x,z] of fixture.relocations??[]){
      for(const entry of Object.values(features.tiles)){
        const prop=entry.p?.find(p=>p[0]===kind&&p[1]===id);
        if(prop){prop[2]=x;prop[4]=z;break;}
      }
    }
    const lampCorrections=new Map((fixture.lampCorrections??[]).map(([x,z,X,Z])=>[[x,z].join(','),[X,Z]]));
    observed.lamps=observed.lamps.map(p=>lampCorrections.get(p.join(','))??p);
    for(const [x,z,X,Z] of fixture.cityMastShifts??[]){
      const lamps=tile(municipal,municipal.size,x,z).lamps??[];
      const index=lamps.findIndex(p=>Math.hypot(p[0]-x,p[1]-z)<.12);
      if(index<0)continue;
      const [mast]=lamps.splice(index,1);
      mast[0]=X;mast[1]=Z;
      (tile(municipal,municipal.size,X,Z).lamps??=[]).push(mast);
    }
    for(const [x,z,h,yaw] of fixture.woodStandards??[]){
      const lamps=tile(municipal,municipal.size,x,z).lamps??=[];
      const standing=lamps.find(p=>Math.hypot(p[0]-x,p[1]-z)<2.5);
      if(standing)standing[5]=true;
      else lamps.push([x,z,h,yaw,0,true]);
    }
    features.athleticMasts=fixture.lamps.filter(p=>p[4]>=3);
    const mappedLamps=Object.values(municipal.tiles).flatMap(t=>t.lamps??[]);
    mappedLamps.push(...observed.lamps,...Object.values(features.tiles).flatMap(t=>(t.p??[]).filter(p=>p[0]==='street_lamp').map(p=>[p[2],p[4]])));
    for(const [x,z,height=5.6,yaw=0,form=2] of fixture.lamps){
      if(mappedLamps.some(p=>Math.hypot(p[0]-x,p[1]-z)<2.4))continue;
      (tile(municipal,municipal.size,x,z).lamps??=[]).push([x,z,height,yaw,form,false]);
      mappedLamps.push([x,z]);
    }
    const existing=Object.values(features.tiles).flatMap(t=>t.p??[]);
    for(const [i,[kind,x,z,yaw,count=4]] of fixture.props.entries()){
      if(existing.some(p=>p[0]===kind&&Math.hypot(p[2]-x,p[4]-z)<1.6))continue;
      if(kind==='bench'&&observed.seats.some(p=>Math.hypot(p[0]-x,p[1]-z)<1.6))continue;
      (tile(features,features.tileSize,x,z).p??=[]).push([kind,-10000-i,x,0,z,yaw,2,1,count]);
    }
  }
  if(observed.sports){
    features.sports=observed.sports;
    for(const [i,[x,z,yaw]] of observed.sports.bleachers.entries())(tile(features,features.tileSize,x,z).p??=[]).push(['bleachers',-30-i,x,0,z,yaw,7.7,1,1]);
    let i=0;
    for(const row of features.macro)if(row[0]==='track'&&!observed.sports.laneBasis){
      [row[2],row[4],row[5],row[7]]=observed.sports.lanes[i++];
    }
  }
  const bare=new Set((municipal.woodlots?.bare??[]).map(p=>p.join(',')));
  for(const entry of Object.values(municipal.tiles)){
    for(const tree of entry.trees??[])if(bare.has(tree[0]+','+tree[1])){tree[7]=tree[5];tree[5]=10;}
  }
  for(const [x,z,h,r,form] of [...observed.trees,...(municipal.woodlots?.trees??[]),...(municipal.woodlots?.estates??[]),...(municipal.woodlots?.park??[]),...(municipal.woodlots?.recruits??[]),...(fixture?.conifers??[])]){
    const seed=Math.abs(Math.round(x*7+z*13))%1009;
    (tile(municipal,municipal.size,x,z).trees??=[]).push([x,z,h,r,Math.max(.055,h*.014),bare.has(x+','+z)?10:form,seed]);
  }
  for(const [x,z,rx,rz,height] of fixture?.dormantThickets??[]){
    for(let i=0;i<13;i++){
      const a=i*2.4,r=Math.sqrt(i/14),px=x+rx*Math.cos(a)*r,pz=z+rz*Math.sin(a)*r;
      const h=height*(1.19-.43*r+.16*Math.cos(a));
      (tile(municipal,municipal.size,px,pz).understory??=[]).push([px,pz,h,3]);
    }
  }
  for(const plant of [...(municipal.woodlots?.understory??[]),...(fixture?.datedShrubs??[])])
    (tile(municipal,municipal.size,plant[0],plant[1]).understory??=[]).push(plant);
  for(const [x,z,h] of observed.shrubs)(tile(municipal,municipal.size,x,z).shrubs??=[]).push([x,z,h]);
  for(const [x,z] of observed.lamps)(tile(municipal,municipal.size,x,z).lamps??=[]).push([x,z,5.6,0,2,false]);
  for(const [line,h] of observed.hedges)(tile(municipal,municipal.size,line[0],line[1]).hedge??=[]).push([line,h]);
  for(const [i,[x,z,yaw]] of observed.seats.entries())(tile(features,features.tileSize,x,z).p??=[]).push(['bench',-1-i,x,0,z,yaw,1.7,1,1]);
  for(const [i,[x,z,X,Z]] of observed.fences.entries())(tile(features,features.tileSize,(x+X)/2,(z+Z)/2).l??=[]).push(['fence',-1-i,x,0,z,X,0,Z]);
}


export function createContextTrees(THREE,records){
  const group=new THREE.Group(),cells=new Map(),size=125;
  const foliage=new THREE.MeshStandardMaterial({map:leafSprayTexture(),alphaTest:.39,side:THREE.DoubleSide,roughness:.94});
  foliage.onBeforeCompile=lightLeafBacks;
  const crown=foliageCluster(.44),bark=new THREE.CylinderGeometry(.62,1,1,6);
  const wood=new THREE.MeshStandardMaterial({color:0x736451,roughness:.93});
  wood.onBeforeCompile=barkFinish;
  for(let i=0;i<records.length;i+=4){
    const x=records[i],z=records[i+1],key=Math.floor(x/size)+','+Math.floor(z/size);
    if(!cells.has(key))cells.set(key,[]);
    cells.get(key).push(records.subarray(i,i+4));
  }
  const pose=new THREE.Object3D(),color=new THREE.Color(),up=new THREE.Vector3(0,1,0),axis=new THREE.Vector3();
  const tiles=[];
  for(const [key,trees] of cells){
    const branches=new THREE.InstancedMesh(bark,wood,trees.length*6);
    const leaves=new THREE.InstancedMesh(crown,foliage,trees.length*8);
    function branch(i,a,b,r){
      axis.subVectors(b,a);
      pose.position.copy(a).lerp(b,.5);
      pose.scale.set(r,axis.length(),r);
      pose.quaternion.setFromUnitVectors(up,axis.normalize());
      pose.updateMatrix();
      branches.setMatrixAt(i,pose.matrix);
    }
    for(const [i,[x,z,h,y]] of trees.entries()){
      const r=h*(.28+.035*Math.sin(x)),fork=new THREE.Vector3(x,y+h*.37,z);
      branch(i*6,new THREE.Vector3(x,y-.08,z),fork,h*.021);
      for(let j=0;j<8;j++){
        const yaw=x*.71+j*2.4,spread=r*(j<5?.49:.17);
        const X=x+Math.cos(yaw)*spread,Z=z+Math.sin(yaw)*spread,Y=y+h*(j<5?.65+.045*Math.sin(yaw):.82);
        if(j<5)branch(i*6+j+1,fork,new THREE.Vector3(X,Y,Z),h*.014);
        pose.position.set(X,Y,Z);pose.rotation.set(.13*Math.sin(yaw),yaw,.13*Math.cos(yaw));
        pose.scale.set(r*.73,h*(j<5?.245:.185),r*.66);
        pose.updateMatrix();
        leaves.setMatrixAt(i*8+j,pose.matrix);
        leaves.setColorAt(i*8+j,color.setHSL(.258+.018*Math.sin(x),.26+.045*Math.cos(yaw),.34+.032*Math.sin(yaw),THREE.SRGBColorSpace));
      }
    }
    branches.computeBoundingSphere();leaves.computeBoundingSphere();
    branches.castShadow=leaves.castShadow=true;
    branches.receiveShadow=leaves.receiveShadow=true;
    const cell=new THREE.Group();
    cell.add(branches,leaves);
    const [a,b]=key.split(',').map(Number);
    tiles.push([cell,(a+.5)*size,(b+.5)*size]);
    group.add(cell);
  }
  group.userData.update=(x,z)=>{
    for(const [cell,X,Z] of tiles)cell.visible=(x-X)**2+(z-Z)**2<610**2;
  };
  return group;
}
