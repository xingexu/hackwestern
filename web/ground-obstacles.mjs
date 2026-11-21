const faces=[[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]]
const key=(x,z)=>Math.floor(z/8)*16384+Math.floor(x/8)

function slice(points,y,above){
  const out=[]
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[j],b=points[i],inA=above?a[1]>=y:a[1]<=y,inB=above?b[1]>=y:b[1]<=y
    if(inA!==inB){
      const t=(y-a[1])/(b[1]-a[1])
      out.push([a[0]+(b[0]-a[0])*t,y,a[2]+(b[2]-a[2])*t])
    }
    if(inB)out.push(b)
  }
  return out
}

function intersects(points,x,z,r){
  let inside=false
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[j],b=points[i],dx=b[0]-a[0],dz=b[2]-a[2]
    const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[2])*dz)/(dx*dx+dz*dz||1)))
    if((x-a[0]-t*dx)**2+(z-a[2]-t*dz)**2<=r*r)return true
    if((a[2]>z)!==(b[2]>z)&&x<a[0]+dx*(z-a[2])/dz)inside=!inside
  }
  return inside
}

export function groundObstacles(){
  const bins=new Map()
  function add(points,polygons,owner,branch,box){
    const min=points[0].slice(),max=min.slice()
    for(const p of points)for(let i=0;i<3;i++){min[i]=Math.min(min[i],p[i]);max[i]=Math.max(max[i],p[i])}
    const shape={min,max,polygons,owner,branch,box}
    for(let j=Math.floor((min[2]-2)/8);j<=Math.floor((max[2]+2)/8);j++){
      for(let i=Math.floor((min[0]-2)/8);i<=Math.floor((max[0]+2)/8);i++){
        const k=j*16384+i
        if(!bins.has(k))bins.set(k,[])
        bins.get(k).push(shape)
      }
    }
  }
  function addBox(m,owner){
    const p=[]
    for(const z of [-.5,.5])for(const y of [-.5,.5])for(const x of [-.5,.5]){
      p.push([0,1,2].map(i=>m[12+i]+x*m[i]+y*m[4+i]+z*m[8+i]))
    }
    const axes=[0,4,8].map(i=>{
      const lengthSq=m[i]**2+m[i+1]**2+m[i+2]**2;
      return [m[i]/lengthSq,m[i+1]/lengthSq,m[i+2]/lengthSq];
    });
    add(p,faces.map(f=>f.map(i=>p[i])),owner,null,{center:[m[12],m[13],m[14]],axes})
  }
  function addFace(points,owner){add(points,[points],owner)}
  function addBranch(a,b,base,tip,owner,height=0){
    const radius=Math.max(base,tip),low=[0,1,2].map(i=>Math.min(a[i],b[i])-radius),high=[0,1,2].map(i=>Math.max(a[i],b[i])+radius);
    high[1]+=height;
    add([low,high],[],owner,{a,b,base,tip,height});
  }
  function contact(x,z,y,r,height){
    const top=y+height
    for(const p of bins.get(key(x,z))??[]){
      if(y>p.max[1]||top<p.min[1]||x<p.min[0]-r||x>p.max[0]+r||z<p.min[2]-r||z>p.max[2]+r)continue
      if(p.branch){
        const {a,b,base,tip,height:rise}=p.branch,dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
        const horizontal=Math.hypot(dx,dz),cap=rise?0:Math.max(base,tip)*horizontal/(Math.hypot(horizontal,dy)||1);
        let lo=0,hi=1;
        if(dy){
          const t1=(y-rise-cap-a[1])/dy,t2=(top+cap-a[1])/dy;
          lo=Math.max(0,Math.min(t1,t2));hi=Math.min(1,Math.max(t1,t2));
        }else if(y>a[1]+rise+cap||top+cap<a[1])continue;
        if(lo>hi)continue;
        const t=Math.max(lo,Math.min(hi,((x-a[0])*dx+(z-a[2])*dz)/(dx*dx+dz*dz||1)));
        if((x-a[0]-t*dx)**2+(z-a[2]-t*dz)**2<=(r+base+(tip-base)*t)**2)return p;
        continue;
      }
      if(p.box){
        const {center,axes}=p.box,dx=x-center[0],dy=(y+top)*.5-center[1],dz=z-center[2];
        if(axes.every(a=>Math.abs(dx*a[0]+dy*a[1]+dz*a[2])<=.5))return p;
      }
      for(let poly of p.polygons){
        if(y>p.min[1])poly=slice(poly,y,true)
        if(top<p.max[1])poly=slice(poly,top,false)
        if(intersects(poly,x,z,r))return p
      }
    }
  }
  return {addBox,addFace,addBranch,addShell:add,contact}
}
