import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {kerbProfile,streetProfiles,tableProfile} from '../pavement-profile.mjs'

import {inflateSync} from 'node:zlib'
import {packLandClasses} from '../campus-terrain.mjs'

const {landcover}=JSON.parse(readFileSync(new URL('../ground-materials.json',import.meta.url)))
const classes=inflateSync(Buffer.from(landcover.samples,'base64')),transitions=inflateSync(Buffer.from(landcover.transitions,'base64'))
const packed=packLandClasses(classes,Uint8Array.from(transitions))
for(let i=0;i<classes.length;i++){
  const cell=4*i,first=transitions[cell],kind=classes[i]
  assert.ok((kind<15 || kind===255) && (first<15 || first===255))
  assert.equal(packed[cell]>>4,kind===255?15:kind)
  assert.equal(packed[cell]&15,first===255?15:first)
  assert.equal(packed[cell+1],transitions[cell+1])
  assert.equal(packed[cell+2],transitions[cell+2])
  assert.equal(packed[cell+3],transitions[cell+3])
}
const {pavementSurvey}=JSON.parse(readFileSync(new URL('../surface-tiles.json',import.meta.url)))
const surface=streetProfiles(pavementSurvey)
for(const row of pavementSurvey.ramps){
  const [x,z]=row
  assert.ok(surface.kerbFactor(x,z)<.065)
  assert.ok(kerbProfile(0,surface.kerbFactor(x,z))<.008)
}
for(const row of pavementSurvey.tables){
  const [x,z,dx,dz,width,depth,rise]=row
  assert.ok(Math.abs(surface.tableAt(x,z)-rise)<1e-8)
  assert.ok(surface.tableAt(x+dx*width,z+dz*width)<.001)
  for(let i=0;i<60;i++){
    const v=depth*i/100
    const a=tableProfile(row,x-dz*v,z+dx*v)
    const b=tableProfile(row,x-dz*(v+.02),z+dx*(v+.02))
    assert.ok(b<=a+.000001 && a-b<.007)
  }
}
for(const [x,z] of [[-35,225],[280,977]])assert.equal(surface.islandAt(x,z),1)
assert.equal(surface.islandAt(-262,31),0)
const levels=[-.16,-.09,.005,.031,.055,.15,.26].map(x=>kerbProfile(x))
assert.equal(levels[0],.105)
assert.equal(levels.at(-1),0)
assert.ok(levels.slice(1).every((value,i)=>value<=levels[i]))
console.log('Surveyed openings, bevels, median interiors and speed-table tyre profiles agree.')
