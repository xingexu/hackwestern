import assert from 'node:assert/strict'
import {measure} from './browser.mjs'
import {support} from './contacts.mjs'
import {traversableKerb} from './adapter.mjs'
import {Color,Float32BufferAttribute} from 'three'

const cell={id:'x0z0',x:0,z:0,samples:[[10.5,10.5,1]]}
const mesh={material:{depthWrite:true},name:'fixture'}
const hit=(kind,y,role)=>({kind,y,item:{kind:role,mesh},face:{normal:{y:1}}})
const ground=hit('road',0,'terrain')
const bridge=hit('road',7,'deck')
assert.equal(support([bridge,ground],0),ground)
assert.equal(support([bridge,ground],7),bridge)

const index={solid:()=>undefined,paintSamples:()=>[],objects:[]}
const position=(x,z)=>({x,y:0,z,surface:'road',blocked:false})
const game={
  inside:()=>true,blocked:()=>false,blockerKind:()=>false,sample:position,column:()=>[ground],
  buildings:{roof:()=>[],record:()=>undefined},anchors:()=>[],roadStarts:()=>[[10.5,10.5]],
  cameraRig:()=>()=>[10.5,3,10.5]
}
function checks(overrides,buildings=[]) {return measure({...game,...overrides},index,cell,buildings,['checks']).counts}
assert.deepEqual(checks({}),{})
assert.equal(checks({column:()=>[]})['missing-ground'],1)
assert.equal(checks({column:()=>[hit('road',1,'terrain')]})['ground-height'],1)
const parcel={id:'test-roof',present:true,footprint:[[9,9],[12,9],[12,12],[9,12]],holes:[]}
assert.equal(checks({},[parcel])['building-height'],1)
assert.deepEqual(checks({},[{...parcel,present:false}]),{})
const roof={...hit('building',8,'building'),owner:parcel.id}
const survey={...game.buildings,record:()=>({id:parcel.id}),allowed:()=>false}
assert.equal(checks({column:()=>[roof,ground],buildings:survey},[{...parcel,present:false}])['stray-building'],1)
assert.deepEqual(checks({column:()=>[roof,ground],buildings:{...survey,roof:()=>[{id:parcel.id,y:8,low:0,trusted:false}]}}),{})
assert.equal(checks({column:()=>[roof,ground],buildings:{...survey,roof:()=>[{id:parcel.id,y:11,low:0,trusted:false}]}})['building-height'],1)

function trials(yAt,drawAt){
  const simulate=(point,heading)=>{
    const state={...point,heading}
    let step=0
    return {state,step(){step++;state.x+=.1;state.y=yAt(step)}}
  }
  return measure({...game,simulate,column:()=>[hit('road',drawAt,'terrain')]},index,cell,[],['drive']).counts
}
assert.deepEqual(trials(()=>0,0),{})
const clipped={...cell,samples:[[11.5,13.5,.14]]}
const sparse={...game,roadStarts:()=>[],simulate:(point,heading)=>({state:{...point,heading},step(){}})}
assert.equal(measure(sparse,index,clipped,[],['drive']).driveRuns,4)
assert.equal(trials(()=>NaN,0)['fall-through'],4)
assert.equal(trials(step=>step*.51,0).launch,4)
assert.equal(trials(()=>-1,0).sinking,4)
assert.equal(trials(()=>-3,0)['fall-through'],4)
const stepCell={...cell,samples:[[10.5,10.5,1],[11.5,10.5,1]]}
const high=hit('road',1.1,'deck'),guard=hit('rail',1.3,'deck')
guard.item={...guard.item,mesh:{...mesh,name:'Bridge decks and approaches'}}
const jump=(withGuard)=>measure({...game,column:(_,x)=>x>=11?(withGuard?[guard,high]:[high]):[ground]},index,stepCell,[],['checks']).counts
assert.equal(jump(false)['height-step'],1)
assert.equal(jump(true)['height-step'],undefined)
const lawn=hit('grass',0,'terrain')
assert.equal(checks({column:()=>[lawn]})['surface-class'],1)
const transition=measure({...game,column:(_,x)=>x>=10.5?[lawn]:[ground]},index,cell,[],['checks'])
assert.equal(transition.counts['surface-class'],undefined)
assert.equal(transition.edgeObservations.length,1)
const shell={...hit('building',8,'building'),owner:'test-roof'}
const covered={...game,column:()=>[shell,ground],blockerKind:()=>'solid'}
const corridor=closed=>({...game.buildings,roof:()=>[{id:'test-roof',y:8,closed}],allowed:()=>true})
assert.equal(measure({...covered,buildings:corridor([])},index,cell,[],['checks']).counts['collision-parity'],1)
assert.equal(measure({...covered,buildings:corridor([8])},index,cell,[],['checks']).counts['collision-parity'],undefined)
function stalled(explained) {
  const simulate=(point,heading,onBlock)=>({state:{...point,heading},step(){onBlock?.(12,10,0,.9,'solid')}})
  const scene={...index,solid:(x)=>explained && x===12?{kind:'tree',mesh}:undefined}
  return measure({...game,simulate},scene,cell,[],['drive']).counts.stuck??0
}
assert.equal(stalled(false),4)
assert.equal(stalled(true),0)

const kerbColor=new Float32BufferAttribute(new Color(0xbcb8ac).toArray(),3)
const roadway={kind:'deck',mesh:{name:''},geometry:{attributes:{color:kerbColor}}}
const slope=x=>.8*x
const kerbFace=[{x:0,y:.105,z:0},{x:1,y:.905,z:.15},{x:1,y:.905,z:0}]
assert.equal(traversableKerb(roadway,kerbFace,0,slope),true)
assert.equal(traversableKerb(roadway,kerbFace,0,()=>0),false)
assert.equal(traversableKerb({...roadway,mesh:{name:'Bridge decks and approaches'}},kerbFace,0,slope),false)
for(const code of [11,12]) {
  const profile={...roadway,geometry:{attributes:{color:new Float32BufferAttribute([0,0,0],3),paving:new Float32BufferAttribute([0,0,code],3)}}}
  assert.equal(traversableKerb(profile,kerbFace,0,slope),true)
  assert.equal(traversableKerb(profile,kerbFace,0,()=>0),false)
}
