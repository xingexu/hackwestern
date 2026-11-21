const MAGIC=0x324d4357;

export function encodeChunks(chunks){
  let bytes=8;
  for(const chunk of chunks) bytes+=12+chunk.positions.byteLength+chunk.normals.byteLength+chunk.colors.byteLength+chunk.indices.byteLength+(4-chunk.indices.byteLength%4)%4;
  const out=new ArrayBuffer(bytes),header=new DataView(out),raw=new Uint8Array(out);
  header.setUint32(0,MAGIC,true);header.setUint32(4,chunks.length,true);
  let offset=8;
  for(const {positions,normals,colors,indices} of chunks){
    header.setUint32(offset,positions.length/3,true);
    header.setUint32(offset+4,indices.length,true);
    header.setUint32(offset+8,indices.BYTES_PER_ELEMENT,true);
    offset+=12;
    for(const attr of [positions,normals,colors,indices]){
      const stride=attr===indices?1:3;
      const deltas=new attr.constructor(out,offset,attr.length);
      deltas.set(attr);
      for(let i=deltas.length-1;i>=stride;i--) deltas[i]-=deltas[i-stride];
      offset+=attr.byteLength;
    }
    offset=Math.ceil(offset/4)*4;
  }
  return raw;
}

export function decodeChunks(buffer){
  const header=new DataView(buffer);
  if(header.byteLength<8||header.getUint32(0,true)!==MAGIC) throw new Error('Invalid campus mesh.');
  const count=header.getUint32(4,true),chunks=[];
  let offset=8;
  for(let i=0;i<count;i++){
    const vertices=header.getUint32(offset,true),elements=header.getUint32(offset+4,true),width=header.getUint32(offset+8,true);
    offset+=12;
    if((width!==2&&width!==4)||elements%3||vertices===0) throw new Error('Invalid campus mesh chunk.');
    function field(Type,n,stride=3){
      const array=new Type(buffer,offset,n);
      offset+=array.byteLength;
      for(let i=stride;i<array.length;i++) array[i]+=array[i-stride];
      return array;
    }
    chunks.push({positions:field(Int16Array,vertices*3),normals:field(Int8Array,vertices*3),colors:field(Uint8Array,vertices*3),indices:field(width===2?Uint16Array:Uint32Array,elements,1)});
    offset=Math.ceil(offset/4)*4;
  }
  if(buffer.byteLength!==offset) throw new Error('Incomplete campus mesh data.');
  return chunks;
}
