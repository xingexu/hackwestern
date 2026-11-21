import {sin,cos} from './math.mjs'

export const zoneHalfWidth = gate => Math.max(3,gate.halfWidth ?? 4.3)+2.5
const depth=3.5

export function circuitGates(samples) {
  const last=samples.length-1,indices=[]
  let previous=0
  for (let i=1;i<last;i++) {
    if (samples[i].distance-previous>=24 && samples[last].distance-samples[i].distance>=12) {
      indices.push(i)
      previous=samples[i].distance
    }
  }
  indices.push(last)
  return indices
}

export function zoneProgress(passed=0) {
  return {passed,near:true,missed:false}
}

function swept(gate,a,b,margin=0) {
  const s=sin(gate.heading),c=cos(gate.heading)
  const dx=b.x-a.x,dz=b.z-a.z
  const advance=dx*s+dz*c
  if (advance<=0 || advance*advance<.02*(dx*dx+dz*dz)) return false
  const along=(a.x-gate.x)*s+(a.z-gate.z)*c
  const entry=Math.max(0,(-depth-along)/advance)
  const exit=Math.min(1,(depth-along)/advance)
  if (entry>exit) return false
  const lateral=(a.x-gate.x)*c-(a.z-gate.z)*s
  const drift=dx*c-dz*s
  const t=Math.min(exit,Math.max(entry,drift ? -lateral/drift : entry))
  return Math.abs(lateral+t*drift)<=zoneHalfWidth(gate)+margin && Math.abs(a.y+(b.y-a.y)*t-gate.y)<=2.2
}

function nearCourse(samples,start,end,point) {
  for (let i=start;i<end;i++) {
    const a=samples[i],b=samples[i+1],dx=b.x-a.x,dz=b.z-a.z
    const t=Math.min(1,Math.max(0,((point.x-a.x)*dx+(point.z-a.z)*dz)/(dx*dx+dz*dz || 1)))
    const ex=point.x-a.x-t*dx,ez=point.z-a.z-t*dz
    const width=zoneHalfWidth(a)+3
    if (ex*ex+ez*ez<=width*width && Math.abs(point.y-a.y-t*(b.y-a.y))<2.5) return true
  }
  return false
}

export function advanceZones(samples,gates,progress,from,to) {
  const i=progress.passed
  if (i>=gates.length) return 0
  const dx=to.x-from.x,dz=to.z-from.z
  if (dx*dx+dz*dz>144) {progress.near=false;progress.missed=false;return 0}
  const gate=samples[gates[i]]
  let credit=0
  if (swept(gate,from,to)) credit=1
  else if (i+1<gates.length && progress.near) {
    const end=progress.missed?gates[i+1]:gates[i]
    progress.near=nearCourse(samples,i?gates[i-1]:0,end,to)
    if (progress.near && swept(gate,from,to,3)) progress.missed=true
    if (progress.near && progress.missed && swept(samples[gates[i+1]],from,to)) credit=2
  }
  if (credit) {
    progress.passed+=credit
    progress.near=true
    progress.missed=false
  }
  return credit
}
