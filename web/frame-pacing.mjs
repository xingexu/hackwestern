const poseFields=['x','y','z','heading','pitch','roll','bodyPitch'];

export function snapshotPose(out,car){
  for(const key of poseFields) out[key]=car[key];
  return out;
}

export function interpolatePose(out,before,after,alpha){
  for(const key of poseFields){
    const delta=after[key]-before[key];
    out[key]=before[key]+(key==='heading'?Math.atan2(Math.sin(delta),Math.cos(delta)):delta)*alpha;
  }
  return out;
}

function dampedAxis(rate) {
  let position=0,velocity=0;
  return {
    reset(value){position=value;velocity=0;},
    follow(target,dt,frequency=rate){
      const error=position-target;
      const impulse=velocity+frequency*error;
      const decay=Math.exp(-frequency*dt);
      position=target+(error+impulse*dt)*decay;
      velocity=(velocity-frequency*impulse*dt)*decay;
      return position;
    }
  };
}

export function createCameraRig(){
  const height=dampedAxis(14),pitch=dampedAxis(8),body=dampedAxis(9),roll=dampedAxis(10);
  const view={height:0,pitch:0,bodyPitch:0,roll:0,chaseYaw:0,eyeYaw:0};
  const boom=dampedAxis(8);
  let arm=6.45;
  return {
    reset(pose){
      height.reset(pose.y);pitch.reset(pose.pitch);body.reset(0);roll.reset(0);
      view.chaseYaw=view.eyeYaw=pose.heading;
      arm=6.45;boom.reset(arm);
    },
    update(pose,dt){
      const y=height.follow(pose.y,dt);
      view.height=Math.max(pose.y-.23,Math.min(pose.y+.23,y));
      view.pitch=pitch.follow(pose.pitch,dt);
      view.bodyPitch=body.follow(pose.bodyPitch,dt);
      view.roll=roll.follow(pose.roll,dt);
      const turn=yaw=>Math.atan2(Math.sin(pose.heading-yaw),Math.cos(pose.heading-yaw));
      view.chaseYaw+=turn(view.chaseYaw)*(-Math.expm1(-8*dt));
      view.eyeYaw+=turn(view.eyeYaw)*(-Math.expm1(-25*dt));
      return view;
    },
    limitArm(clearance,dt,target=6.45){
      const desired=Math.min(clearance,target);
      arm=boom.follow(desired,dt,desired<arm?12:8);
      if(arm>clearance || arm<0){
        arm=Math.max(0,Math.min(clearance,arm));
        boom.reset(arm);
      }
      return arm;
    }
  };
}

export function adaptiveResolution(){
  let scale=1,seconds=0,frames=0,healthy=0;
  return {
    sample(interval){
      if(interval<=0||interval>1) return scale;
      seconds+=Math.min(.15,interval);
      frames++;
      if(seconds<1.8) return scale;
      const average=seconds/frames;
      if(average>1/43){scale=Math.max(.65,Math.round((scale-.1)*100)/100);healthy=0;}
      else if(average<1/57){
        healthy++;
        if(healthy>=3){scale=Math.min(1,Math.round((scale+.05)*100)/100);healthy=0;}
      }else healthy=0;
      frames=0;seconds=0;
      return scale;
    }
  };
}
