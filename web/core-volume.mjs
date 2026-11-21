export function removeGround(volume,columns) {
  const voxels=new Uint8Array(volume);
  const stride=columns.length;
  if(voxels.length%stride!==0) throw new Error('Invalid ground removal mask.');
  for(let i=0;i<stride;i++) {
    for(let cell=i,y=0;y<columns[i];y++,cell+=stride) voxels[cell]=0;
  }
}

export function removeFoliage(volume,bitmap) {
  const voxels=new Uint8Array(volume);
  if(bitmap.length!==Math.ceil(voxels.length/8)) throw new Error('The canopy mask does not fit the campus model.');
  for(let i=0;i<bitmap.length;i++) {
    let mask=bitmap[i];
    for(let bit=0;mask;bit++,mask>>>=1) if(mask&1) voxels[8*i+bit]=0;
  }
}

export function recessVoxelWalls(volume,world,facades) {
  const voxels=new Uint8Array(volume),stride=world.width*world.depth;
  for(const [,base,segments] of facades){
    for(const [ax,az,bx,bz,top,nx,nz] of segments){
      const length=Math.hypot(bx-ax,bz-az),tx=(bx-ax)/length,tz=(bz-az)/length;
      const normalRadius=(Math.abs(nx)+Math.abs(nz))*.5;
      const startY=Math.max(0,Math.floor(base)-1),endY=Math.min(world.height,Math.floor(top));
      const x0=Math.max(0,Math.floor(Math.min(ax,bx)-2)),x1=Math.min(world.width-1,Math.ceil(Math.max(ax,bx)+2));
      const z0=Math.max(0,Math.floor(Math.min(az,bz)-2)),z1=Math.min(world.depth-1,Math.ceil(Math.max(az,bz)+2));
      for(let z=z0;z<=z1;z++) for(let x=x0;x<=x1;x++){
        const dx=x+.5-ax,dz=z+.5-az,along=dx*tx+dz*tz,depth=dx*nx+dz*nz;
        if(along<-.1||along>length+.1||depth+normalRadius<-.045||depth-normalRadius>1.16) continue;
        for(let idx=startY*stride+z*world.width+x,y=startY;y<endY;y++,idx+=stride) voxels[idx]=0;
      }
    }
  }
}
