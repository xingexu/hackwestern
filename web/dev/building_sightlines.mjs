function inside(ring,x,z){
  let covered=false;
  for(let j=ring.length-1,i=0;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])covered=!covered;
  }
  return covered;
}

export function campusSightlines(building,neighbors,street=false){
  const volumes=[];
  for(const record of [building,...neighbors]){
    if(record.spec.present===false)continue;
    for(const part of record.parts){
      const rings=part.solidRings??part.rings;
      const xs=rings[0].map(p=>p[0]),zs=rings[0].map(p=>p[1]);
      const bounds=[Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)];
      volumes.push({rings,bounds,bottom:part.low===0?record.foundation:record.ground+part.low,top:record.ground+part.high+Math.max(0,...part.surface[0].map(v=>v[1]))});
    }
  }
  let targets=[];
  for(const part of building.parts){
    const ring=(part.solidRings??part.rings)[0],y=building.ground+part.low+(part.high-part.low)*.53;
    for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if(length>.8){
        const count=street?Math.max(1,Math.ceil(length/7)):1;
        for(let k=0;k<count;k++){
          const t=(k+.5)/count;
          targets.push([a[0]+(b[0]-a[0])*t,y,a[1]+(b[1]-a[1])*t]);
        }
      }
    }
  }
  const limit=street?144:80;
  if(targets.length>limit)targets=Array.from({length:limit},(_,i)=>targets[Math.floor(targets.length*i/limit)]);
  function obstructs(volume,eye,target){
    const [x,y,z]=eye,dx=target[0]-x,dy=target[1]-y,dz=target[2]-z;
    let lo=0,hi=.997;
    const [l,t,r,b]=volume.bounds;
    for(const [a,delta,minimum,maximum] of [[x,dx,l,r],[z,dz,t,b],[y,dy,volume.bottom,volume.top]]){
      if(Math.abs(delta)<1e-7){if(a<minimum||a>maximum)return false;continue;}
      const f=(minimum-a)/delta,g=(maximum-a)/delta;
      lo=Math.max(lo,Math.min(f,g));hi=Math.min(hi,Math.max(f,g));
      if(hi<lo)return false;
    }
    const cuts=[lo,hi];
    for(const ring of volume.rings)for(let i=0;i<ring.length;i++){
      const a=ring[i],c=ring[(i+1)%ring.length],ex=c[0]-a[0],ez=c[1]-a[1],det=dx*ez-dz*ex;
      if(Math.abs(det)<1e-7)continue;
      const f=((a[0]-x)*ez-(a[1]-z)*ex)/det,u=((a[0]-x)*dz-(a[1]-z)*dx)/det;
      if(f>lo && f<hi && u>=0 && u<=1)cuts.push(f);
    }
    cuts.sort((a,b)=>a-b);
    for(let i=1;i<cuts.length;i++){
      const f=(cuts[i]+cuts[i-1])*.5,xx=x+dx*f,zz=z+dz*f;
      if(inside(volume.rings[0],xx,zz)&&!volume.rings.slice(1).some(r=>inside(r,xx,zz)))return true;
    }
    return false;
  }
  return (eye,heading=null,fov=64,bins=null)=>{
    const angle=heading*Math.PI/180,threshold=Math.cos(fov*Math.PI/360);
    for(const volume of volumes){
      const [x,y,z]=eye,[l,t,r,b]=volume.bounds;
      if(y<volume.bottom || y>volume.top || x<l || x>r || z<t || z>b)continue;
      if(inside(volume.rings[0],x,z) && !volume.rings.slice(1).some(r=>inside(r,x,z)))return 0;
    }
    let visible=0;
    for(const target of targets){
      const dx=target[0]-eye[0],dz=target[2]-eye[2];
      if(heading!==null && (dx*Math.sin(angle)-dz*Math.cos(angle))/Math.max(.01,Math.hypot(dx,dz))<threshold)continue;
      if(!volumes.some(vol=>obstructs(vol,eye,target))){
        visible++;
        if(bins){
          const across=dx*Math.cos(angle)+dz*Math.sin(angle),forward=dx*Math.sin(angle)-dz*Math.cos(angle);
          const column=.5+.5*across/(forward*Math.tan(fov*Math.PI/360));
          bins[Math.max(0,Math.min(bins.length-1,Math.floor(column*bins.length)))]++;
        }
      }
    }
    return visible;
  };
}

export function gradePhotoPose(f,y0,visibility){
  const bins=Array(8).fill(0),visible=visibility([f.x,y0,f.z],f.heading,f.hfov,bins);
  const observed=f.photoBuildings;
  const mismatch=observed && Math.max(...observed)>.35 && bins.every((count,i)=>count===0 || Math.max(...observed.slice(Math.max(i-1,0),i+2))<.06);
  const result=f.poseRejected??(!visible?'occluded or outside photo frustum':mismatch?'target projects outside observed photo facade':'paired');
  return {id:f.id,x:f.x,y:y0,z:f.z,heading:f.heading,horizontalFov:f.hfov,pitch:f.elevationAngle,roll:f.roll,calibration:f.calibration,groundRegistration:f.registrationScore??null,laneDisplacement:f.laneDisplacement??0,visibleFacadeSamples:visible,result};
}
