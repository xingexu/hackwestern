export const presets={
  low:{pixelRatio:.8,mapSize:1024,reach:58,ao:0,bloom:0},
  medium:{pixelRatio:1,mapSize:1536,reach:70,ao:0,bloom:0},
  high:{pixelRatio:1,mapSize:2048,reach:82,ao:.34,bloom:.055},
  ultra:{pixelRatio:1.5,mapSize:4096,reach:105,ao:.48,bloom:.08}
};

export function selectQuality(preference,mobile,threads){
  if(Object.hasOwn(presets,preference)) return preference;
  return mobile?'low':threads && threads<=4?'medium':'high';
}

export function qualityControl(driving=false){
  const select=document.querySelector('#look-quality');
  const mobile=matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints>1;
  let preference;
  try{preference=localStorage.getItem('campus.graphics');}catch{}
  select.value=Object.hasOwn(presets,preference)?preference:'auto';
  let name=selectQuality(select.value,mobile,navigator.hardwareConcurrency);
  const blur=document.querySelector('#motion-blur');
  let enabled=!matchMedia('(prefers-reduced-motion: reduce)').matches;
  try{
    const saved=localStorage.getItem('campus.motionBlur');
    if(saved!==null)enabled=saved==='on';
  }catch{}
  document.querySelector('#blur-control').hidden=!driving;
  function updateBlur(){
    const available=name==='high' || name==='ultra';
    blur.disabled=!available;
    blur.checked=available && enabled;
    blur.parentElement.title=available?'':'Available with High or Ultra graphics';
  }
  updateBlur();
  blur.addEventListener('change',()=>{
    enabled=blur.checked;
    try{localStorage.setItem('campus.motionBlur',enabled?'on':'off');}catch{}
    blur.blur();
  });
  const callbacks=[];
  select.addEventListener('change',()=>{
    try{localStorage.setItem('campus.graphics',select.value);}catch{}
    name=selectQuality(select.value,mobile,navigator.hardwareConcurrency);
    updateBlur();
    for(const callback of callbacks) callback(presets[name]);
    select.blur();
  });
  return {get motionBlur(){return driving && blur.checked;},get name(){return name;},get current(){return presets[name];},onChange(fn){callbacks.push(fn);}};
}
