export const PROTOCOL=3
export const HZ=60
export const CAPACITY=8
export const BYTES=64
export const RULES=3

const bits=new DataView(new ArrayBuffer(4))
function half(x){
  bits.setFloat32(0,x)
  const n=bits.getUint32(0), sign=(n>>>16)&32768, exponent=(n>>>23)&255
  if(exponent<103)return sign
  if(exponent<113)return sign+Math.round(Math.abs(x)*16777216)
  if(exponent>142)return sign+31744
  return sign+((exponent-112)<<10)+Math.round((n&8388607)/8192)
}
function unhalf(n){
  const e=(n>>10)&31, m=n&1023, s=n&32768?-1:1
  return e===31?NaN:s*(e?(1+m/1024)*2**(e-15):m/16777216)
}
export function packRotation(q){
  let k=0
  for(let i=1;i<4;i++)if(Math.abs(q[i])>Math.abs(q[k]))k=i
  let n=k, sign=q[k]<0?-1:1
  for(let i=0;i<4;i++)if(i!==k)n=(n<<10)|Math.round(Math.min(1,Math.max(0,.5+q[i]*sign/Math.SQRT2))*1023)
  return n>>>0
}
export function unpackRotation(n){
  const k=n>>>30,q=[0,0,0,0]
  let sum=0
  for(let i=3;i>=0;i--)if(i!==k){
    q[i]=((n&1023)/1023-.5)*Math.SQRT2
    n>>>=10;sum+=q[i]**2
  }
  q[k]=Math.sqrt(Math.max(0,1-sum))
  return q
}
export function frameState(car,input,previous,stamp,slot,seq,epoch){
  const h=car.heading,p=-(car.pitch+car.bodyPitch),r=car.roll
  const s=Math.sin(h),c=Math.cos(h),vx=s*car.speed+c*car.lateralSpeed,vz=c*car.speed-s*car.lateralSpeed
  const dt=previous && previous.epoch===epoch?(stamp-previous.stamp)/1000:0
  const y=car.y+(car.lift??0)
  const vy=dt>0?(y-previous.y)/dt:0
  const acceleration=(v,old)=>dt>0?Math.max(-35,Math.min(35,(v-old)/dt)):0
  const sh=Math.sin(h/2),ch=Math.cos(h/2),sp=Math.sin(p/2),cp=Math.cos(p/2),sr=Math.sin(r/2),cr=Math.cos(r/2)
  return {x:car.x,y,z:car.z,vx,vy,vz,ax:acceleration(vx,previous?.vx),ay:acceleration(vy,previous?.vy),az:acceleration(vz,previous?.vz),turn:car.yawRate,
    q:[ch*sp*cr+sh*cp*sr,sh*cp*cr-ch*sp*sr,ch*cp*sr-sh*sp*cr,ch*cp*cr+sh*sp*sr],slot,seq,epoch,stamp,steer:input.steer||0,gas:input.throttle||0,brake:input.brake||0,rpm:car.rpm,flags:Number(!!car.contact)}
}
const axes=['vx','vy','vz','ax','ay','az','turn']
export function encode(s){
  const data=new ArrayBuffer(BYTES),v=new DataView(data)
  v.setUint8(0,PROTOCOL);v.setUint8(1,s.slot);v.setUint16(2,s.epoch);v.setUint32(4,s.seq)
  v.setFloat64(8,s.stamp)
  for(const [i,k] of ['x','y','z'].entries())v.setFloat64(16+8*i,s[k])
  v.setUint32(40,packRotation(s.q))
  axes.forEach((k,i)=>v.setUint16(44+2*i,half(s[k])))
  v.setInt8(58,Math.round(s.steer*127));v.setUint8(59,Math.round(s.gas*255));v.setUint8(60,Math.round(s.brake*255))
  v.setUint8(61,s.flags);v.setUint16(62,s.rpm)
  return data
}
export function decode(data){
  if(!(data instanceof ArrayBuffer) || data.byteLength!==BYTES)return null
  const v=new DataView(data)
  if(v.getUint8(0)!==PROTOCOL || v.getUint8(1)>=CAPACITY)return null
  const q=unpackRotation(v.getUint32(40)),[a,b,c,d]=q
  const s={slot:v.getUint8(1),epoch:v.getUint16(2),seq:v.getUint32(4),stamp:v.getFloat64(8),x:v.getFloat64(16),y:v.getFloat64(24),z:v.getFloat64(32),q,heading:Math.atan2(2*(a*c+d*b),1-2*(a*a+b*b)),steer:v.getInt8(58)/127,gas:v.getUint8(59)/255,brake:v.getUint8(60)/255,flags:v.getUint8(61),rpm:v.getUint16(62)}
  axes.forEach((k,i)=>s[k]=unhalf(v.getUint16(44+2*i)))
  return [s.stamp,s.x,s.y,s.z,...axes.map(k=>s[k])].every(Number.isFinite)?s:null
}
export const newer=(a,b)=>a!==b && ((a-b)>>>0)<0x80000000
export class Cadence{
  due=null
  take(now){
    this.due??=now
    if(now+.001<this.due)return false
    this.due+=(1+Math.floor(Math.max(0,now-this.due+.001)*HZ/1000))*1000/HZ
    return true
  }
}
