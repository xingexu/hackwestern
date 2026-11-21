export function createBuildingContacts(){
  const cells=new Map();
  let shapes=[];
  function key(x,z){return x*65536+z;}
  function add(x0,z0,x1,z1,row){
    const id=shapes.length;
    shapes.push(...row);
    for(let j=Math.floor(z0/6);j<=Math.floor(z1/6);j++)for(let i=Math.floor(x0/6);i<=Math.floor(x1/6);i++){
      const k=key(i,j);
      if(!cells.has(k))cells.set(k,[]);
      cells.get(k).push(id);
    }
  }
  const sink={
    ceiling:Infinity,
    box(x,y,z,w,h,d,angle){
      if(y-h*.5>this.ceiling)return;
      const c=Math.cos(angle),s=Math.sin(angle),hw=w/2,hd=d/2;
      const ex=Math.abs(c)*hw+Math.abs(s)*hd,ez=Math.abs(s)*hw+Math.abs(c)*hd;
      add(x-ex,z-ez,x+ex,z+ez,[1,y-h*.5,y+h*.5,x,z,c,s,hw,hd,0,0]);
    },
    face(points){
      for(let j=2;j<points.length;j++){
        const [a,b,c]=[points[0],points[j-1],points[j]];
        const lo=Math.min(a[1],b[1],c[1]);
        if(lo>this.ceiling)continue;
        add(Math.min(a[0],b[0],c[0]),Math.min(a[2],b[2],c[2]),Math.max(a[0],b[0],c[0]),Math.max(a[2],b[2],c[2]),[0,...a,...b,...c,Math.max(a[1],b[1],c[1])]);
      }
    }
  };
  function clip(points,limit,sign){
    const out=[];
    for(let i=0,j=points.length-1;i<points.length;j=i++){
      const a=points[j],b=points[i],da=(a[1]-limit)*sign,db=(b[1]-limit)*sign;
      if((da<0)!==(db<0)){const t=da/(da-db);out.push([a[0]+t*(b[0]-a[0]),limit,a[2]+t*(b[2]-a[2])]);}
      if(db>=0)out.push(b);
    }
    return out;
  }
  function hits(id,x,z,lo,hi,r){
    const p=shapes;
    if(p[id]){
      if(lo>p[id+2]||hi<p[id+1])return false;
      const dx=x-p[id+3],dz=z-p[id+4],c=p[id+5],s=p[id+6];
      const u=Math.abs(dx*c+dz*s)-p[id+7],v=Math.abs(-dx*s+dz*c)-p[id+8];
      if(Math.max(0,u)**2+Math.max(0,v)**2>r*r)return false;
      return lo<=p[id+1] || hi>=p[id+2] || u>=-r || v>=-r;
    }
    if(p[id+10]<lo || Math.min(p[id+2],p[id+5],p[id+8])>hi)return false;
    const poly=clip(clip([[p[id+1],p[id+2],p[id+3]],[p[id+4],p[id+5],p[id+6]],[p[id+7],p[id+8],p[id+9]]],lo,1),hi,-1);
    let inside=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const a=poly[j],b=poly[i],dx=b[0]-a[0],dz=b[2]-a[2];
      const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[2])*dz)/(dx*dx+dz*dz||1)));
      if((x-a[0]-dx*t)**2+(z-a[2]-dz*t)**2<=r*r)return true;
      if((a[2]>z)!==(b[2]>z) && a[0]+dx*(z-a[2])/dz>x)inside=!inside;
    }
    return inside;
  }
  return {sink,finish(){shapes=Float32Array.from(shapes);},touches(x,z,lo,hi,r){
    for(let j=Math.floor((z-r)/6);j<=Math.floor((z+r)/6);j++)for(let i=Math.floor((x-r)/6);i<=Math.floor((x+r)/6);i++){
      const bin=cells.get(key(i,j));
      if(bin)for(const id of bin)if(hits(id,x,z,lo,hi,r))return true;
    }
    return false;
  }};
}
