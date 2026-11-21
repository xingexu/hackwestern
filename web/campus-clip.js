export function campusFootprint(data){
  const {bounds,polygons}=data;
  const [west,north,east,south]=bounds;
  const density=Math.min(1.5,4093/Math.max(east-west,south-north));
  const width=Math.ceil((east-west)*density)+2,height=Math.ceil((south-north)*density)+2;
  const textureBounds=[west-1/density,north-1/density,west+(width-1)/density,north+(height-1)/density];
  const [x0,z0]=textureBounds;
  const pixels=new Uint8Array(width*height);
  function intervals(rings,z){
    const hits=[];
    for(const ring of rings){
      for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
        const a=ring[j+1],b=ring[i+1];
        if((a>z)!==(b>z))hits.push(ring[j]+(z-a)*(ring[i]-ring[j])/(b-a));
      }
    }
    return hits.sort((a,b)=>a-b);
  }
  for(const polygon of polygons){
    for(let row=1;row<height-1;row++){
      const z=z0+(row+.5)/density;
      const hits=intervals(polygon,z);
      for(let k=0;k+1<hits.length;k+=2){
        const lo=Math.ceil((hits[k]-x0)*density-.5),hi=Math.ceil((hits[k+1]-x0)*density-.5);
        pixels.fill(255,row*width+lo,row*width+hi);
      }
    }
  }
  const edgePixels=pixels.slice(),segments=[];
  for(const part of polygons)for(const [ringIndex,ring] of part.entries()){
    let signedArea=0;
    for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2)signedArea+=ring[j]*ring[i+1]-ring[i]*ring[j+1];
    const reverse=(signedArea<0)!==(ringIndex>0);
    for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
      const ax=ring[j],az=ring[j+1],bx=ring[i],bz=ring[i+1];
      segments.push(...(reverse?[bx,bz,ax,az]:[ax,az,bx,bz]));
      const steps=Math.max(1,Math.ceil(Math.hypot(bx-ax,bz-az)*density*1.5));
      for(let n=0;n<=steps;n++){
        const u=Math.floor((ax+(bx-ax)*n/steps-x0)*density),v=Math.floor((az+(bz-az)*n/steps-z0)*density);
        for(let row=Math.max(0,v-1);row<=Math.min(height-1,v+1);row++)
          edgePixels.fill(128,row*width+Math.max(0,u-1),row*width+Math.min(width,u+2));
      }
    }
  }
  const integral=new Uint32Array((width+1)*(height+1));
  for(let row=0;row<height;row++){
    let n=0;
    for(let col=0;col<width;col++){
      if(pixels[row*width+col])n++;
      integral[(row+1)*(width+1)+col+1]=integral[row*(width+1)+col+1]+n;
    }
  }
  function contains(x,z){
    if(x<west||x>east||z<north||z>south)return false;
    return polygons.some(part=>{
      const hits=intervals(part,z);
      for(let i=0;i<hits.length;i+=2)if(x>=hits[i]&&x<=hits[i+1])return true;
      return false;
    });
  }
  function containsDisc(x,z,radius){
    if(!contains(x,z))return false;
    const rr=radius*radius;
    for(let i=0;i<segments.length;i+=4){
      const ax=segments[i],az=segments[i+1],bx=segments[i+2],bz=segments[i+3];
      if(x<Math.min(ax,bx)-radius||x>Math.max(ax,bx)+radius||z<Math.min(az,bz)-radius||z>Math.max(az,bz)+radius)continue;
      const dx=bx-ax,dz=bz-az;
      const t=Math.min(1,Math.max(0,((x-ax)*dx+(z-az)*dz)/(dx*dx+dz*dz||1)));
      if((x-ax-dx*t)**2+(z-az-dz*t)**2<rr)return false;
    }
    return true;
  }
  function intersects(l,t,r,b){
    const u=Math.max(0,Math.floor((l-x0)*density)-1),v=Math.max(0,Math.floor((t-z0)*density)-1);
    const e=Math.min(width,Math.ceil((r-x0)*density)+1),s=Math.min(height,Math.ceil((b-z0)*density)+1);
    if(u>=e||v>=s)return false;
    const stride=width+1;
    return integral[s*stride+e]-integral[s*stride+u]-integral[v*stride+e]+integral[v*stride+u]>0;
  }
  return {bounds,polygons,textureBounds,pixels,edgePixels,segments,width,height,contains,containsDisc,intersects};
}

export function campusClip(THREE,data){
  const footprint=campusFootprint(data);
  const mask=new THREE.DataTexture(footprint.edgePixels,footprint.width,footprint.height,THREE.RedFormat);
  mask.minFilter=mask.magFilter=THREE.NearestFilter;mask.needsUpdate=true;
  const count=footprint.segments.length/4;
  const edges=new THREE.DataTexture(new Float32Array(footprint.segments),count,1,THREE.RGBAFormat,THREE.FloatType);
  edges.needsUpdate=true;
  const extent=new THREE.Vector4(...footprint.textureBounds),offset=new THREE.Vector2();
  const visitedObjects=new WeakSet(),visitedMaterials=new WeakSet();
  function coat(material,exterior=false){
    if(!material||visitedMaterials.has(material))return;
    visitedMaterials.add(material);
    const original=material.onBeforeCompile,key=material.customProgramCacheKey.bind(material);
    const suffix=key();
    material.customProgramCacheKey=()=>suffix+(exterior?'-campus-exterior':'-campus-footprint');
    material.onBeforeCompile=function(shader,renderer){
      original.call(this,shader,renderer);
      shader.uniforms.campusEdges={value:edges};shader.uniforms.campusStencil={value:mask};shader.uniforms.campusExtent={value:extent};shader.uniforms.campusOffset={value:offset};
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 parcelXZ; uniform vec2 campusOffset;')
        .replace('#include <project_vertex>',`vec4 parcelPosition=vec4(transformed,1.);
          #ifdef USE_BATCHING
            parcelPosition=batchingMatrix*parcelPosition;
          #endif
          #ifdef USE_INSTANCING
            parcelPosition=instanceMatrix*parcelPosition;
          #endif
          parcelXZ=(modelMatrix*parcelPosition).xz+campusOffset;
          #include <project_vertex>`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 parcelXZ; uniform sampler2D campusStencil; uniform highp sampler2D campusEdges; uniform vec4 campusExtent;')
        .replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
          vec2 parcelUV=(parcelXZ-campusExtent.xy)/(campusExtent.zw-campusExtent.xy);
          bool within=all(greaterThanEqual(parcelUV,vec2(0.))) && all(lessThanEqual(parcelUV,vec2(1.)));
          float parcelCode=within?texture2D(campusStencil,parcelUV).r:0.;
          if(${exterior?'parcelCode>.75':'parcelCode<.25'})discard;
          if(parcelCode>=.25 && parcelCode<=.75){
            int winding=0;
            for(int i=0;i<${count};i++){
              vec4 e=texelFetch(campusEdges,ivec2(i,0),0);
              float side=(e.z-e.x)*(parcelXZ.y-e.y)-(e.w-e.y)*(parcelXZ.x-e.x);
              if(e.y<=parcelXZ.y&&e.w>parcelXZ.y&&side>0.)winding++;
              if(e.y>parcelXZ.y&&e.w<=parcelXZ.y&&side<0.)winding--;
            }
            if(${exterior?'winding!=0':'winding==0'})discard;
          }`);
    };
    material.needsUpdate=true;
  }
  const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  coat(depth);
  function attach(object){
    if(!object||object.userData.parcelRootedCanopy||visitedObjects.has(object))return;
    visitedObjects.add(object);
    if(object.isMesh){
      for(const m of [object.material].flat())coat(m);
      if(object.castShadow){object.customDepthMaterial??=depth;coat(object.customDepthMaterial);}
      const before=object.onBeforeRender;
      object.onBeforeRender=function(renderer,scene,camera,geometry,material,group){
        before.call(this,renderer,scene,camera,geometry,material,group);
        coat(material);
      };
    }
    object.addEventListener('childadded',e=>attach(e.child));
    for(const child of object.children)attach(child);
  }
  return {...footprint,attach,coatExterior:material=>coat(material,true),setOrigin:(x,z)=>offset.set(x,z)};
}

export function campusCanopyFilter(boundary,anchors){
  const bins=new Map(),size=16;
  for(const [x,y,z,h] of anchors){
    const key=Math.floor(x/size)+','+Math.floor(z/size);
    if(!bins.has(key))bins.set(key,[]);
    bins.get(key).push([x,y,z,h]);
  }
  return (x,y,z,r)=>{
    if(!boundary.containsDisc(x,z,r+.4))return false;
    const i=Math.floor(x/size),j=Math.floor(z/size);
    for(let col=i-1;col<=i+1;col++)for(let row=j-1;row<=j+1;row++){
      for(const [tx,ty,tz,h] of bins.get(col+','+row)??[]){
        if(y<ty+h*.37||y>ty+h*1.05+r*.35)continue;
        const reach=Math.min(7.2,h*.34)+r*.12;
        if((x-tx)**2+(z-tz)**2<=reach*reach)return true;
      }
    }
    return false;
  };
}

