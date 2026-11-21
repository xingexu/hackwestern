import {Vector3} from 'three';

const reach=6.45;
export function nearPlaneClearance(camera){
  const halfHeight=Math.tan(camera.fov*Math.PI/360)/camera.zoom;
  return camera.near*Math.hypot(1,halfHeight,halfHeight*camera.aspect)+.035;
}

export function createCameraPlacement(collision,network,rig){
  const pivot=new Vector3(),end=new Vector3(),probe=new Vector3(),previous=new Vector3(Infinity,0,0);
  const ahead=new Vector3(),future=new Vector3(),lastEye=new Vector3(Infinity,0,0);
  let lastYaw=0;
  const volumePoint=new Vector3();
  function occupied(point,radius){
    return network.solidAt(point.x,point.z,point.y-radius,radius,2*radius);
  }
  function clearance(start,end,radius){
    let free=collision.sweep(start,end,radius);
    volumePoint.lerpVectors(start,end,free);
    if(occupied(volumePoint,radius)){
      let blocked=free;
      free=0;
      for(let i=0;i<9;i++){
        const t=(free+blocked)*.5;
        volumePoint.lerpVectors(start,end,t);
        if(occupied(volumePoint,radius)) blocked=t;
        else free=t;
      }
    }
    return free;
  }
  function open(point,radius){
    return !occupied(point,radius) && collision.sweep(point,point,radius)>0;
  }
  function preparePivot(pose,radius){
    pivot.y=Math.max(network.groundAt(pivot.x,pivot.z)+radius+.035,pivot.y);
    if(open(pivot,radius)) return;
    if(lastEye.distanceToSquared(pivot)<80 && open(lastEye,radius)){
      const fraction=clearance(lastEye,pivot,radius);
      pivot.lerpVectors(lastEye,pivot,Math.max(0,fraction-.012));
      return;
    }
    for(const lift of [-.45,.55,-.85,1.15,2,3.5,6]){
      for(const shift of [0,.65,-.65,1.25,-1.25]){
        probe.set(pivot.x+shift*Math.sin(pose.heading),pivot.y+lift,pivot.z+shift*Math.cos(pose.heading));
        if(probe.y<network.groundAt(probe.x,probe.z)+radius || !open(probe,radius)) continue;
        pivot.copy(probe);
        return;
      }
    }
    for(let lift=8;lift<512;lift*=2){
      probe.copy(pivot);
      probe.y+=lift;
      if(open(probe,radius)){pivot.copy(probe);return;}
    }
  }
  function clearArm(origin,sin,cos,slope,radius){
    const limit=network.chaseDistance(origin.x,origin.y-1.8,origin.z,sin,cos,slope);
    end.set(origin.x-sin*limit,origin.y+limit*(1.05/reach-slope),origin.z-cos*limit);
    const fraction=clearance(origin,end,radius);
    return fraction===1?limit:Math.max(0,limit*fraction-.025);
  }
  function finish(out,radius){
    if(lastEye.distanceToSquared(pivot)<(reach+2)**2 && open(lastEye,radius)){
      const fraction=collision.sweep(lastEye,out,radius);
      if(fraction<1){
        if(collision.sweep(lastEye,pivot,radius)===1){
          let clear=0,blocked=1;
          for(let i=0;i<8;i++){
            const t=(clear+blocked)*.5;
            probe.lerpVectors(pivot,out,t);
            if(collision.sweep(lastEye,probe,radius)===1) clear=t;
            else blocked=t;
          }
          out.lerpVectors(pivot,out,clear);
        }else out.lerpVectors(lastEye,out,Math.max(0,fraction-.006));
      }
    }
    lastEye.copy(out);
    return out;
  }
  return {
    reset(){previous.x=lastEye.x=Infinity;},
    chase(out,pose,view,dt,radius){
      const yaw=view.chaseYaw,sin=Math.sin(yaw),cos=Math.cos(yaw),slope=Math.tan(view.pitch*.65);
      pivot.set(pose.x,view.height+1.8,pose.z);
      preparePivot(pose,radius);
      const limit=clearArm(pivot,sin,cos,slope,radius);
      let target=limit;
      if(dt>0 && pivot.distanceToSquared(previous)<9){
        ahead.subVectors(pivot,previous).multiplyScalar(.48/dt).clampLength(0,4.5);
        const turn=Math.atan2(Math.sin(yaw-lastYaw),Math.cos(yaw-lastYaw));
        const predicted=yaw+Math.max(-.40,Math.min(.40,turn*.48/dt));
        if(ahead.lengthSq()>.01 || Math.abs(predicted-yaw)>.008){
          future.addVectors(pivot,ahead);
          target=Math.min(target,clearArm(future,Math.sin(predicted),Math.cos(predicted),slope,radius));
        }
      }
      previous.copy(pivot);
      lastYaw=yaw;
      const arm=rig.limitArm(limit,dt,target);
      out.set(pivot.x-sin*arm,pivot.y+arm*(1.05/reach-slope),pivot.z-cos*arm);
      return finish(out,radius);
    },
    driver(out,pose,view,radius){
      previous.x=Infinity;
      pivot.set(pose.x,view.height+1.18,pose.z);
      preparePivot(pose,radius);
      const fraction=clearance(pivot,out,radius);
      if(fraction<1) out.lerpVectors(pivot,out,Math.max(0,fraction-.015));
      return finish(out,radius);
    }
  };
}
