import * as THREE from 'three';

const openCover=Object.freeze({2:2,3:0,5:3,6:1});

export function surfaceCoverage(classes,width,height){
  const w=Math.ceil(width/2),h=Math.ceil(height/2),samples=new Uint8Array(w*h*4);
  for(let z=0;z<height;z++)for(let x=0;x<width;x++){
    const channel=openCover[classes[z*width+x]];
    if(channel===undefined)continue;
    const index=4*((z>>1)*w+(x>>1))+channel;
    samples[index]=Math.min(255,samples[index]+64);
  }
  const texture=new THREE.DataTexture(samples,w,h);
  texture.generateMipmaps=true;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;
  texture.needsUpdate=true;
  return texture;
}

const lightParking=new Set([142286129,126668541,147379466,142216973]);

function extendLotFinish(mapped,tone,mineral,width,height){
  const visited=new Uint8Array(mapped.length),queue=new Int32Array(mapped.length);
  let end=0;
  for(let z=1;z<height-1;z++)for(let x=1;x<width-1;x++){
    const i=z*width+x;
    if(mapped[i]<128)continue;
    visited[i]=1;
    if(mapped[i-1]<128 || mapped[i+1]<128 || mapped[i-width]<128 || mapped[i+width]<128)queue[end++]=i;
  }
  let start=0;
  function copy(from,to){
    if(visited[to])return;
    visited[to]=1;
    tone[to]=tone[from];
    mineral[4*to]=mineral[4*from];
    queue[end++]=to;
  }
  for(let radius=0;radius<5 && start<end;radius++){
    const ring=end;
    while(start<ring){
      const i=queue[start++],x=i%width;
      if(x>0)copy(i,i-1);
      if(x+1<width)copy(i,i+1);
      if(i>=width)copy(i,i-width);
      if(i+width<mapped.length)copy(i,i+width);
    }
  }
}

export function surveyedPavingTone(samples,field,bounds,areas,coveredCourts,mineral){
  const w=field.width,h=field.height,[l,t,r,b]=bounds;
  const mapped=new Uint8Array(samples.length);
  const covered=new Uint8Array(samples.length);
  if(mineral)for(let i=0;i<samples.length;i++)mineral[4*i]=mineral[4*i+1];
  const surfaces=[...areas.filter(area=>area.kind==='parking'),...coveredCourts.map(ring=>({kind:'covered',rings:[ring]}))];
  for(const area of surfaces){
    const rings=area.rings.map(ring=>ring.map((v,i)=>i%2?(v-t)*h/(b-t):(v-l)*w/(r-l)));
    const rows=rings[0].filter((_,i)=>i%2),top=Math.max(0,Math.floor(Math.min(...rows))),end=Math.min(h,Math.ceil(Math.max(...rows)));
    const spans=[],histogram=new Uint32Array(256),aggregate=new Uint32Array(256);
    let count=0;
    const mask=area.kind==='covered'?covered:mapped;
    for(let row=top;row<end;row++)for(let sample=0;sample<3;sample++){
      const cuts=[],y=row+(sample+.5)/3;
      for(const ring of rings)for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
        const z0=ring[j+1],z1=ring[i+1];
        if((z0>y)!==(z1>y))cuts.push(ring[j]+(y-z0)*(ring[i]-ring[j])/(z1-z0));
      }
      cuts.sort((a,b)=>a-b);
      for(let k=1;k<cuts.length;k+=2){
        const left=Math.max(0,cuts[k-1]),right=Math.min(w,cuts[k]);
        for(let x=Math.floor(left);x<Math.ceil(right);x++){
          const pixel=row*w+x;
          const coverage=Math.max(0,Math.min(x+1,right)-Math.max(x,left));
          mask[pixel]=Math.min(255,mask[pixel]+Math.round(85*coverage));
        }
        if(sample===1 && area.kind==='parking'){
          const a=row*w+Math.ceil(left-.5),b=row*w+Math.ceil(right-.5);
          if(b<=a)continue;
          spans.push(a,b);count+=b-a;
          for(let i=a;i<b;i++){
            histogram[samples[i]]++;
            if(mineral)aggregate[mineral[4*i+1]]++;
          }
        }
      }
    }
    if(count){
      let middle=0,seen=histogram[0];
      while(seen<count*.5)seen+=histogram[++middle];
      const tone=lightParking.has(area.id)?248:middle;
      let gravel=0,support=aggregate[0];
      if(mineral)while(support<count*.67)support+=aggregate[++gravel];
      for(let i=0;i<spans.length;i+=2){
        samples.fill(tone,spans[i],spans[i+1]);
        if(mineral)for(let at=spans[i];at<spans[i+1];at++){
          const k=4*at;
          mineral[k]=Math.round(.88*gravel+.12*mineral[k+1]);
        }
      }
    }
  }
  if(mineral)extendLotFinish(mapped,samples,mineral,w,h);
  const data=new Uint8Array(samples.length*4);
  for(let i=0;i<samples.length;i++){data[4*i]=samples[i];data[4*i+1]=mapped[i];data[4*i+2]=covered[i];}
  return data;
}

export const edgeGLSL=`
  float coverageEdge(float v){
    float aa=clamp(fwidth(v)*.64,.007,.48);
    return smoothstep(.5-aa,.5+aa,v);
  }`;

export function walkwayGuide(tiles,coordinates,ways=[]){
  const pavedPaths=ways.filter(w=>w.kind!=='road' && !w.bridge && !w.level && w.material==='asphalt').map(way=>{
    const x=way.points.map(p=>p[0]),z=way.points.map(p=>p[2]),r=way.width/2;
    return {way,left:Math.min(...x)-r,right:Math.max(...x)+r,top:Math.min(...z)-r,bottom:Math.max(...z)+r};
  });
  const table=new Map(tiles.map(([left,top,start,length])=>[left+':'+top,[start,length]]));
  return ({left,top,right,bottom})=>{
    const tile=table.get(left+':'+top);
    if(!tile || !tile[1])return null;
    const w=Math.max(1,Math.ceil((right-left)*3)),h=Math.max(1,Math.ceil((bottom-top)*3));
    const ctx=new OffscreenCanvas(w,h).getContext('2d',{willReadFrequently:true});
    const [start,length]=tile,sx=w/32767,sz=h/32767;
    ctx.fillStyle='black';ctx.fillRect(0,0,w,h);
    ctx.fillStyle='red';ctx.beginPath();
    for(let i=start;i<start+length;){
      const count=coordinates[i++];
      ctx.moveTo(coordinates[i++]*sx,coordinates[i++]*sz);
      for(let j=1;j<count;j++)ctx.lineTo(coordinates[i++]*sx,coordinates[i++]*sz);
      ctx.closePath();
    }
    ctx.fill('evenodd');
    const local=pavedPaths.filter(path=>path.left<right && path.right>left && path.top<bottom && path.bottom>top);
    if(local.length){
      ctx.globalCompositeOperation='lighter';
      const scaleX=w/(right-left),scaleZ=h/(bottom-top);
      ctx.setTransform(scaleX,0,0,scaleZ,-left*scaleX,-top*scaleZ);
      ctx.strokeStyle='#00ff00';ctx.lineJoin='round';ctx.lineCap='round';
      for(const {way} of local){
        ctx.lineWidth=way.width;ctx.beginPath();ctx.moveTo(way.points[0][0],way.points[0][2]);
        for(let j=1;j<way.points.length;j++)ctx.lineTo(way.points[j][0],way.points[j][2]);
        ctx.stroke();
      }
    }
    const rgba=ctx.getImageData(0,0,w,h).data;
    const stride=pavedPaths.length?2:1,data=new Uint8Array(w*h*stride);
    for(let i=0;i<w*h;i++){
      data[stride*i]=rgba[4*i];
      if(stride===2)data[2*i+1]=rgba[4*i+1];
    }
    const guide=new THREE.DataTexture(data,w,h,stride===2?THREE.RGFormat:THREE.RedFormat);
    guide.generateMipmaps=true;guide.magFilter=THREE.LinearFilter;guide.minFilter=THREE.LinearMipmapLinearFilter;
    guide.anisotropy=4;guide.needsUpdate=true;
    return guide;
  };
}
