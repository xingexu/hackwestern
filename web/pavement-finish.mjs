import {kerbProfile,tableProfile} from './pavement-profile.mjs'

export function pavementMaterial(shader){
  shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
    if(pavementUV.z>6.5&&pavementUV.z<8.5)roughnessFactor=.73;`)
    .replace('#include <metalnessmap_fragment>',`#include <metalnessmap_fragment>
      if(pavementUV.z>6.5&&pavementUV.z<8.5)metalnessFactor=.45;`)
    .replace('#include <alphamap_fragment>',`#include <alphamap_fragment>
      float finishKind=pavementUV.z;
      if(finishKind>4.5&&finishKind<6.95 || (finishKind>9.5&&finishKind<10.5)){
        vec2 local=pavementUV.xy;
        vec2 row=vec2(local.x/.059,local.y/.059);
        float dome=length((fract(row+.5)-.5)*.059);
        float foot=length(fwidth(local));
        float dotRaised=(1.-smoothstep(.010-max(.001,foot*.45),.012+foot*.45,dome))*(1.-smoothstep(.017,.065,foot));
        vec3 clay=finishKind>9.5?vec3(.208,.168,.139):finishKind>5.5?vec3(.60,.423,.105):vec3(.358,.159,.114);
        diffuseColor.rgb=clay*(.91+dotRaised*.26);
      }else if(finishKind>6.95&&finishKind<8.5){
        vec2 local=pavementUV.xy;
        float foot=max(.001,length(fwidth(local)));
        float grid;
        if(finishKind<7.5){
          float ring=abs(fract(length(local)*23.)-.5)/23.;
          vec2 diamond=mat2(.707,.707,-.707,.707)*local*29.;
          float ribs=min(abs(fract(diamond.x)-.5),abs(fract(diamond.y)-.5))/29.;
          grid=1.-smoothstep(.0015,.0035+foot,min(ring,ribs));
        }else{
          vec2 slot=abs(fract(local/vec2(.071,.23)+.5)-.5);
          grid=smoothstep(.13,.25+foot*2.,slot.x)*(1.-smoothstep(.34,.47,slot.y));
        }
        float resolved=1.-smoothstep(.016,.06,foot);
        diffuseColor.rgb=mix(vec3(.084,.084,.078),vec3(.045,.045,.043),mix(.4,grid,resolved));
      }else if(finishKind>10.5){
        float variation=.15*(grain-.5)*close+.045*(coarse-.5);
        vec2 p=roadPoint.xz*.039+vec2(sin(roadPoint.z*.023),cos(roadPoint.x*.027));
        float dry=.48+.17*sin(p.x+p.y*1.3)+.11*sin(p.y*1.6-p.x*.51);
        vec3 lawn=mix(vec3(.065,.170,.062),vec3(.148,.209,.076),dry);
        diffuseColor.rgb=(finishKind<11.5?lawn:vec3(.337,.329,.299))*(1.+variation);
      }else if(finishKind>8.5&&finishKind<9.5){
        diffuseColor.rgb=vec3(.51,.382,.13)*(.92+.06*grain);
      }`)
}

export function placePavementFinishes(records,network,tileAt,quad,colors){
  function add(row,kind,nominalW,nominalH){
    const [x,z,dx,dz,width,depth]=row
    if(network.isDeck(x,z))return
    const ground=(u,v)=>{
      const px=x+dx*u-dz*v,pz=z+dz*u+dx*v
      return [px,network.groundAt(px,pz)+(kind===9?tableProfile(row,px,pz):0)+.008,pz]
    }
    tileAt(x,z).parts.push(batch=>{
      const w=nominalW??width,h=nominalH??depth
      if(kind===7){
        const count=16,r=(w+h)*.25
        for(let i=0;i<count;i+=2){
          const p=[i,i+1,i+2].map(n=>[r*Math.cos(n*2*Math.PI/count),r*Math.sin(n*2*Math.PI/count)])
          const local=[[0,0],...p]
          quad(batch,...local.map(([u,v])=>ground(u,v)),colors.asphalt,local.map(([u,v])=>[u,v,kind]))
        }
        return
      }
      const rows=kind===9?8:2,columns=kind===9?Math.ceil(w/.65):2
      for(let i=0;i<columns;i++)for(let j=0;j<rows;j++){
        const l=w*(i/columns-.5),r=w*((i+1)/columns-.5),t=h*(j/rows-.5),b=h*((j+1)/rows-.5)
        const local=[[l,t],[l,b],[r,b],[r,t]]
        quad(batch,...local.map(([u,v])=>ground(u,v)),kind<=6||kind===10?colors.path:colors.asphalt,local.map(([u,v])=>[u,v,kind]))
      }
    })
  }
  for(const island of records?.islands??[]){
    const kind=island.kind===3?12:11
    for(const [ax,az,bx,bz,cx,cz] of island.triangles){
      const surface=(x,z)=>[x,network.groundAt(x,z)+.105,z]
      const a=surface(ax,az),b=surface(bx,bz),c=surface(cx,cz)
      tileAt((ax+bx+cx)/3,(az+bz+cz)/3).parts.push(batch=>{
        const start=batch.positions.length/3
        for(const point of [a,c,b]){
          batch.positions.push(...point)
          batch.colors.push(1,1,1)
          batch.paving.push(point[0],point[2],kind)
        }
        batch.indices.push(start,start+1,start+2)
      })
    }
    addKerbLine([...island.ring,island.ring[0]],1)
  }
  function addKerbLine(ring,side){
    for(let i=1;i<ring.length;i++){
      const [x,z]=ring[i-1],[u,v]=ring[i]
      const length=Math.hypot(u-x,v-z)
      if(length<.02)continue
      const dx=(v-z)/length*side,dz=(x-u)/length*side
      const steps=Math.ceil(length/1.1)
      for(let s=0;s<steps;s++){
        const a=s/steps,b=(s+1)/steps
        const ax=x+(u-x)*a,az=z+(v-z)*a,bx=x+(u-x)*b,bz=z+(v-z)*b
        const lo=network.kerbFactor(ax,az),hi=network.kerbFactor(bx,bz)
        network.addKerb(ax,az,bx,bz,dx,dz,lo,hi,.003)
        const edge=(px,pz,offset,factor)=>[px+dx*offset,network.groundAt(px+dx*offset,pz+dz*offset)+kerbProfile(offset,factor)+.003,pz+dz*offset]
        tileAt((ax+bx)/2,(az+bz)/2).parts.push(batch=>{
          for(const [outer,inner,material] of [[-.16,.005,colors.curb],[.005,.031,colors.curb],[.031,.055,colors.curbSide],[.055,.26,colors.gutter]]){
            quad(batch,edge(ax,az,outer,lo),edge(bx,bz,outer,hi),edge(bx,bz,inner,hi),edge(ax,az,inner,lo),material)
          }
        })
      }
    }
  }
  for(const [flat,side] of records?.kerbs??[]){
    const ring=[]
    for(let i=0;i<flat.length;i+=2)ring.push([flat[i],flat[i+1]])
    addKerbLine(ring,side)
  }
  for(const row of records?.pads??[])add(row,row[6]==='red'?5:row[6]==='yellow'?6:10)
  for(const row of records?.covers??[])add(row,row[6]==='cover'?7:8)
  for(const row of records?.tables??[])add(row,9)
}
