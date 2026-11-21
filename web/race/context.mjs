import courses from './courses.mjs'

const contexts = new Map()

export function createRaceContext(id) {
  if (!Object.hasOwn(courses,id)) throw new Error('Unknown race course')
  if (contexts.has(id)) return contexts.get(id)
  const {samples,tiles,cells} = courses[id]
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const data = new DataView(bytes.buffer)
  const key = (x,z) => z*65536+x
  const offsets = new Map(tiles.map((tile,i) => [key(...tile.split(',').map(Number)),i*320]))
  function address(x,z) {
    const tx=Math.floor(x/8), tz=Math.floor(z/8)
    const base=offsets.get(key(tx,tz))
    return base===undefined ? -1 : base+5*((z-tz*8)*8+x-tx*8)
  }
  function blocked(x,z) {
    const at=address(Math.round(x),Math.round(z))
    return at<0 || Boolean(bytes[at+4]&4)
  }
  function sample(x,z,previousY=0) {
    const ix=Math.floor(x),iz=Math.floor(z),u=x-ix,v=z-iz
    const at=address(Math.round(x),Math.round(z))
    if (at<0) return {x,z,y:previousY,surface:'grass',grade:0,tangentX:0,tangentZ:1,lateral:0,blocked:true}
    function height(column,row) {
      const index=address(column,row)
      return data.getInt16(index<0 ? at : index,true)/100
    }
    const y=(1-v)*((1-u)*height(ix,iz)+u*height(ix+1,iz))+v*((1-u)*height(ix,iz+1)+u*height(ix+1,iz+1))
    const gx=data.getInt8(at+2)/256,gz=data.getInt8(at+3)/256
    const grade=Math.sqrt(gx*gx+gz*gz)
    const flags=bytes[at+4]
    return {x,y,z,grade,tangentX:grade ? gx/grade : 0,tangentZ:grade ? gz/grade : 1,lateral:0,surface:['grass','path','road'][flags&3],blocked:Boolean(flags&4)}
  }
  const context={id,samples,network:{sample,blocked}}
  contexts.set(id,context)
  return context
}
