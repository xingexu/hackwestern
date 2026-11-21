import {Box3,Matrix4,Vector3} from 'three';
import {MeshBVH} from 'three-mesh-bvh';

const edge=new Vector3(),axis=new Vector3();

function sweptCameraBox(start,delta,radius,triangle,maxTime=1){
  let enter=0,exit=maxTime;
  const {a,b,c}=triangle;
  function overlap(nx,ny,nz){
    const pad=radius*(Math.abs(nx)+Math.abs(ny)+Math.abs(nz));
    const origin=nx*start.x+ny*start.y+nz*start.z;
    const v=nx*delta.x+ny*delta.y+nz*delta.z;
    const p=nx*a.x+ny*a.y+nz*a.z;
    const q=nx*b.x+ny*b.y+nz*b.z;
    const r=nx*c.x+ny*c.y+nz*c.z;
    const low=Math.min(p,q,r)-pad-origin,high=Math.max(p,q,r)+pad-origin;
    if(Math.abs(v)<1e-10) return low<=0 && high>=0;
    enter=Math.max(enter,v>0?low/v:high/v);
    exit=Math.min(exit,v>0?high/v:low/v);
    return enter<=exit;
  }
  if(!overlap(1,0,0)||!overlap(0,1,0)||!overlap(0,0,1)) return Infinity;
  function edgeAxes(from,to){
    edge.subVectors(to,from);
    return overlap(0,-edge.z,edge.y) && overlap(edge.z,0,-edge.x) && overlap(-edge.y,edge.x,0);
  }
  if(!edgeAxes(a,b) || !edgeAxes(b,c) || !edgeAxes(c,a)) return Infinity;
  edge.subVectors(b,a);
  axis.subVectors(c,a).cross(edge);
  return overlap(axis.x,axis.y,axis.z)?enter:Infinity;
}

const tileSize=16;
function tileRange(box,visit){
  for(let x=Math.floor(box.min.x/tileSize);x<=Math.floor(box.max.x/tileSize);x++){
    for(let z=Math.floor(box.min.z/tileSize);z<=Math.floor(box.max.z/tileSize);z++) visit(x+','+z);
  }
}

export function cameraGeometry(roots,onHierarchyChange=()=>{}){
  const acceleration=new WeakMap(),instanceTiles=new WeakMap(),instanceBounds=new WeakMap();
  const area=new Box3(),query=new Box3(),localQuery=new Box3(),bounds=new Box3();
  const matrix=new Matrix4(),inverse=new Matrix4(),instance=new Matrix4();
  const delta=new Vector3(),center=new Vector3();
  let dirty=true;
  let nearby=[],crowns=[];
  function instances(mesh){
    const stamp=mesh.instanceMatrix.version;
    const cached=instanceTiles.get(mesh);
    if(cached && cached.stamp===stamp && cached.geometry===mesh.geometry && cached.count===mesh.count && cached.world.equals(mesh.matrixWorld)) return cached.bins;
    const bins=new Map();
    for(let i=0;i<mesh.count;i++){
      mesh.getMatrixAt(i,instance);
      matrix.multiplyMatrices(mesh.matrixWorld,instance);
      bounds.copy(mesh.geometry.boundingBox).applyMatrix4(matrix);
      tileRange(bounds,key=>{
        if(!bins.has(key)) bins.set(key,[]);
        bins.get(key).push(i);
      });
    }
    instanceTiles.set(mesh,{stamp,count:mesh.count,world:mesh.matrixWorld.clone(),geometry:mesh.geometry,bins});
    return bins;
  }
  function surveyCrowns(mesh,g){
    localQuery.copy(area).applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
    if(!g.boundingSphere.intersectsBox(localQuery))return;
    const positions=g.attributes.crownCenter,radii=g.attributes.crownRadius;
    const scale=mesh.matrixWorld.getMaxScaleOnAxis();
    for(let i=0;i<g.instanceCount;i++){
      center.fromBufferAttribute(positions,i);
      const r=radii.getX(i)*1.22;
      if(localQuery.distanceToPoint(center)>r)continue;
      crowns.push({center:center.clone().applyMatrix4(mesh.matrixWorld),radius:r*scale});
    }
  }
  function collect(mesh){
    const g=mesh.geometry;
    if(!mesh.isMesh || !g.attributes.position?.count || mesh.material.visible===false)return;
    if(g.attributes.crownCenter){surveyCrowns(mesh,g);return;}
    const solid=g.attributes.cameraSolid;
    if(mesh.material.alphaTest>0 && !g.attributes.leaf && !solid)return;
    if(!g.boundingBox) g.computeBoundingBox();
    if(mesh.isInstancedMesh){
      const stamp=mesh.instanceMatrix.version,cached=instanceBounds.get(mesh);
      if(!cached || cached.geometry!==g || cached.count!==mesh.count || cached.stamp!==stamp){
        mesh.computeBoundingBox();
        instanceBounds.set(mesh,{stamp,count:mesh.count,geometry:g});
      }
    }
    bounds.copy(mesh.isInstancedMesh?mesh.boundingBox:g.boundingBox).applyMatrix4(mesh.matrixWorld);
    if(!area.intersectsBox(bounds)) return;
    function add(transform){
      inverse.copy(transform).invert();
      localQuery.copy(area).applyMatrix4(inverse);
      if(!localQuery.intersectsBox(g.boundingBox)) return;
      let tree=acceleration.get(g);
      if(!tree){tree=new MeshBVH(g,{indirect:true});acceleration.set(g,tree);}
      const leaf=g.attributes.leaf;
      tree.shapecast({
        intersectsBounds:box=>box.intersectsBox(localQuery),
        intersectsTriangle:(triangle,index)=>{
          const vertex=g.index?.getX(index*3)??index*3;
          if(!solid && leaf && leaf.getX(vertex)>.5)return false;
          const a=triangle.a.clone().applyMatrix4(transform),b=triangle.b.clone().applyMatrix4(transform),c=triangle.c.clone().applyMatrix4(transform);
          bounds.setFromPoints([a,b,c]);
          if(area.intersectsBox(bounds)) nearby.push({a,b,c,box:bounds.clone()});
          return false;
        }
      });
    }
    if(!mesh.isInstancedMesh){add(mesh.matrixWorld);return;}
    const bins=instances(mesh),ids=new Set();
    tileRange(area,key=>{for(const id of bins.get(key)??[]) ids.add(id);});
    for(const id of ids){
      mesh.getMatrixAt(id,instance);
      add(matrix.multiplyMatrices(mesh.matrixWorld,instance));
    }
  }
  const watched=new WeakSet();
  function invalidate(){dirty=true;}
  function hierarchyChanged(){
    invalidate();
    onHierarchyChange();
  }
  function watch(object){
    if(watched.has(object)) return;
    watched.add(object);
    object.addEventListener('childadded',({child})=>{hierarchyChanged();watch(child);});
    object.addEventListener('childremoved',hierarchyChanged);
    for(const child of object.children) watch(child);
  }
  for(const root of roots) watch(root);
  return {
    invalidate,
    sweep(start,end,radius){
      query.makeEmpty().expandByPoint(start).expandByPoint(end).expandByScalar(radius+.001);
      if(dirty || !area.containsBox(query)){
        query.getCenter(center);
        area.min.copy(center).addScalar(-12);
        area.max.copy(center).addScalar(12);
        area.min.y=center.y-3;
        area.max.y=center.y+3;
        area.union(query);

        nearby=[];crowns=[];
        for(const root of roots){
          root.updateWorldMatrix(true,true);
          root.traverseVisible(collect);
        }
        dirty=false;
      }
      delta.subVectors(end,start);
      let time=1;
      const travel=delta.lengthSq();
      for(const crown of crowns){
        const offset=center.subVectors(start,crown.center);
        const gap=offset.lengthSq()-(radius+crown.radius)**2;
        if(gap<=0)return 0;
        const toward=offset.dot(delta);
        const disc=toward*toward-travel*gap;
        if(toward<0 && disc>=0)time=Math.min(time,gap/(-toward+Math.sqrt(disc)));
      }
      for(const tri of nearby){
        if(!tri.box.intersectsBox(query)) continue;
        time=Math.min(time,sweptCameraBox(start,delta,radius,tri,time));
        if(time===0) break;
      }
      return time;
    }
  };
}
