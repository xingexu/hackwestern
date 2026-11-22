export async function rasterBytes({url,height,channels}) {
  const response=await fetch(url);
  if(!response.ok)throw new Error('Could not load campus raster '+url);
  const image=await createImageBitmap(await response.blob(),{colorSpaceConversion:'none'});
  const width=image.width;
  try{
    const rows=channels===1?height:Math.ceil(height*channels/3);
    if(image.height!==rows)throw new Error('Invalid campus raster dimensions');
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=rows;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(image,0,0);
    const rgba=context.getImageData(0,0,width,rows).data;
    canvas.width=canvas.height=0;
    const pixels=new Uint8Array(width*height*channels);
    for(let channel=0;channel<channels;channel++)for(let y=0;y<height;y++){
      const row=channel*height+y;
      let src=channels===1?y*width*4:Math.floor(row/3)*width*4+row%3;
      let dst=y*width*channels+channel;
      for(let x=0;x<width;x++,src+=4,dst+=channels)pixels[dst]=rgba[src];
    }
    return pixels.buffer;
  }finally{image.close();}
}

export async function surveyTexture(THREE,source,width,height,bounds,unpack){
  if(!source?.tiles)return new THREE.DataTexture(new Uint8Array(await unpack(source)),width,height);
  const {overview,channels,tileSize,tiles}=source;
  const smallW=Math.ceil(width/8),smallH=Math.ceil(height/8);
  const base=new Uint32Array(await rasterBytes({url:overview,height:smallH,channels}));
  const pixels=new Uint32Array(width*height);
  for(let y=0;y<height;y++){
    const row=Math.floor(y*smallH/height)*smallW;
    for(let x=0;x<width;x++)pixels[y*width+x]=base[row+Math.floor(x*smallW/width)];
  }
  const texture=new THREE.DataTexture(new Uint8Array(pixels.buffer),width,height);
  const cols=Math.ceil(width/tileSize);
  const loaded=new Map();
  function load(index){
    if(!loaded.has(index)){
      const x=index%cols*tileSize,y=Math.floor(index/cols)*tileSize,w=Math.min(tileSize,width-x),h=Math.min(tileSize,height-y);
      const ready=rasterBytes({url:tiles[index],height:h,channels}).then(buffer=>{
        const tile=new Uint32Array(buffer);
        for(let j=0;j<h;j++)pixels.set(tile.subarray(j*w,(j+1)*w),(y+j)*width+x);
        texture.needsUpdate=true;
      }).catch(error=>{loaded.delete(index);throw error;});
      loaded.set(index,ready);
    }
    return loaded.get(index);
  }
  texture.userData.focus=(x,z)=>{
    return Promise.all(nearbyRasterTiles(source,bounds,x,z).map(load));
  };
  return texture;
}

export function nearbyRasterTiles({width,height,tileSize},bounds,x,z){
  const [left,top,right,bottom]=bounds,radius=200;
  const col=px=>Math.floor((px-left)*width/(right-left)/tileSize);
  const row=pz=>Math.floor((pz-top)*height/(bottom-top)/tileSize);
  const cols=Math.ceil(width/tileSize),rows=Math.ceil(height/tileSize),indices=[];
  for(let j=Math.max(0,row(z-radius));j<=Math.min(rows-1,row(z+radius));j++){
    for(let i=Math.max(0,col(x-radius));i<=Math.min(cols-1,col(x+radius));i++)indices.push(j*cols+i);
  }
  return indices;
}
