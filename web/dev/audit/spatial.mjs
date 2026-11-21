import {Box3, Matrix4, Ray, Vector3} from 'three'
import {MeshBVH} from 'three-mesh-bvh'

const trees = new WeakMap()
const instances = new WeakMap()

function indexFor(geometry) {
  if (!trees.has(geometry)) trees.set(geometry, new MeshBVH(geometry, {indirect:true}))
  return trees.get(geometry)
}

function entries(mesh) {
  const geometry = mesh.geometry
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const stamp = mesh.instanceMatrix?.version ?? 0
  const cached = instances.get(mesh)
  if (cached && cached.geometry === geometry && cached.stamp === stamp && cached.world.equals(mesh.matrixWorld)) return cached.rows
  const rows = []
  for (let i=0; i<(mesh.isInstancedMesh ? mesh.count : 1); i++) {
    const matrix = mesh.matrixWorld.clone()
    if (mesh.isInstancedMesh) {
      const local = new Matrix4()
      mesh.getMatrixAt(i,local)
      matrix.multiply(local)
    }
    const box = geometry.boundingBox.clone().applyMatrix4(matrix)
    rows.push({mesh,geometry,box,matrix,inverse:matrix.clone().invert(),instance:i})
  }
  instances.set(mesh,{geometry,stamp,world:mesh.matrixWorld.clone(),rows})
  return rows
}

export function spatialIndex(roots,cell,classify,traversableFace) {
  const bins = new Map(), objects = []
  const x0=cell.x-10, z0=cell.z-10, size=7, count=10
  const floor=v=>Math.floor(v/size)
  for (const root of roots) root.traverseVisible(mesh=>{
    if (!mesh.isMesh || !mesh.geometry.attributes.position?.count || mesh.material.visible === false) return
    const kind=classify(mesh)
    if (!kind) return
    for (const row of entries(mesh)) {
      const {min,max}=row.box
      const left=Math.max(0,floor(min.x-x0)), right=Math.min(count-1,floor(max.x-x0))
      const top=Math.max(0,floor(min.z-z0)), bottom=Math.min(count-1,floor(max.z-z0))
      if (right<left || bottom<top) continue
      const item={...row,kind}
      objects.push(item)
      for (let j=top;j<=bottom;j++) for (let i=left;i<=right;i++) {
        const key=j*count+i
        if (!bins.has(key)) bins.set(key,[])
        bins.get(key).push(item)
      }
    }
  })
  const ray=new Ray(), down=new Vector3(0,-1,0), local=new Ray()
  const probe=new Box3()
  function column(x,z) {
    ray.origin.set(x,600,z)
    ray.direction.copy(down)
    const hits=[]
    for (const item of bins.get(floor(x-x0)+count*floor(z-z0))??[]) {
      const {min,max}=item.box
      if (x<min.x || x>max.x || z<min.z || z>max.z) continue
      local.copy(ray).applyMatrix4(item.inverse)
      for (const hit of indexFor(item.geometry).raycast(local,item.mesh.material)) {
        hits.push({item,face:hit.face,uv:hit.uv,y:hit.point.applyMatrix4(item.matrix).y})
      }
    }
    return hits.sort((a,b)=>b.y-a.y)
  }
  function nearby(box,visit) {
    const visited=new Set()
    for(let j=floor(box.min.z-z0);j<=floor(box.max.z-z0);j++) for(let i=floor(box.min.x-x0);i<=floor(box.max.x-x0);i++) {
      if(i<0 || j<0 || i>=count || j>=count) continue
      for(const item of bins.get(i+j*count)??[]) {
        if(visited.has(item) || !item.box.intersectsBox(box)) continue
        visited.add(item)
        if(visit(item)) return item
      }
    }
  }
  function triangles(item,box,visit) {
    const local=box.clone().applyMatrix4(item.inverse)
    return indexFor(item.geometry).shapecast({
      intersectsBounds:bounds=>bounds.intersectsBox(local),
      intersectsTriangle:(tri,id)=>visit([tri.a,tri.b,tri.c].map(p=>p.clone().applyMatrix4(item.matrix)),item.geometry.index?.getX(id*3)??id*3)
    })
  }
  function clip(points,key,limit,sign) {
    const clipped=[]
    for(let i=0,j=points.length-1;i<points.length;j=i++) {
      const a=points[j],b=points[i],da=(a[key]-limit)*sign,db=(b[key]-limit)*sign
      if((da<0)!==(db<0)) clipped.push(a.clone().lerp(b,da/(da-db)))
      if(db>=0) clipped.push(b)
    }
    return clipped
  }
  function solid(x,y,z,r=.90,h=1.5,vehicle=false) {
    probe.min.set(x-r,y,z-r)
    probe.max.set(x+r,y+h,z+r)
    return nearby(probe,item=>{
      if(['terrain','estate','water','paint','leaves','field'].includes(item.kind)) return false
      return triangles(item,probe,(tri,vertex)=>{
        if(item.kind==='tree' && item.geometry.attributes.leaf?.getX(vertex)>.5)return false
        if(vehicle && item.kind==='deck' && !item.mesh.name && (Math.max(...tri.map(p=>p.y))<y+.22 || traversableFace(item,tri,vertex))) return false
        const slice=clip(clip(tri,'y',y,1),'y',y+h,-1)
        let inside=false
        for(let i=0,j=slice.length-1;i<slice.length;j=i++) {
          const a=slice[j],b=slice[i],dx=b.x-a.x,dz=b.z-a.z
          const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/(dx*dx+dz*dz||1)))
          if((x-a.x-dx*t)**2+(z-a.z-dz*t)**2<=r*r) return true
          if((a.z>z)!==(b.z>z) && a.x+(z-a.z)*dx/dz>x) inside=!inside
        }
        return inside
      })
    })
  }
  function base(x,z,y,kind,r,owner) {
    probe.min.set(x-r,y-12,z-r)
    probe.max.set(x+r,y+30,z+r)
    let lowest=Infinity
    nearby(probe,item=>{
      if(item.kind!==kind) return false
      triangles(item,probe,(tri,vertex)=>{
        const data=item.mesh.userData
        if(owner && data.buildingRanges){
          const id=data.boxIds?.[item.instance]??vertex
          if(data.buildingRanges.find(row=>id<row[data.boxIds?2:1])?.[0]!==owner)return false
        }
        let part=tri
        for(const key of ['x','z']) part=clip(clip(part,key,probe.min[key],1),key,probe.max[key],-1)
        for(const p of part) lowest=Math.min(lowest,p.y)
        return false
      })
      return false
    })
    return lowest
  }
  function trunkBase(x,z,kind) {
    const box=new Box3(new Vector3(x-.025,-300,z-.025),new Vector3(x+.025,300,z+.025))
    let lowest=Infinity
    nearby(box,item=>{
      if(item.kind!==kind)return false
      const m=item.matrix.elements
      if(Math.hypot(m[12]-.5*m[4]-x,m[14]-.5*m[6]-z)<.022)lowest=Math.min(lowest,m[13]-.5*m[5])
      return false
    })
    return lowest
  }
  function paintSamples() {
    const locations=new Map(),box=new Box3(new Vector3(cell.x,-600,cell.z),new Vector3(cell.x+50,600,cell.z+50))
    nearby(box,item=>{
      if(item.kind!=='paint') return false
      triangles(item,box,tri=>{
        const [a,b,c]=tri,center=a.clone().add(b).add(c).divideScalar(3)
        for(const p of [center,...tri.map(v=>v.lerp(center,.1))]) {
          if(p.x<cell.x || p.x>=cell.x+50 || p.z<cell.z || p.z>=cell.z+50) continue
          locations.set(Math.floor(p.x*4)+','+Math.floor(p.z*4),[p.x,p.z])
        }
        return false
      })
      return false
    })
    return locations.values()
  }
  return {column,solid,base,trunkBase,paintSamples,objects}
}
