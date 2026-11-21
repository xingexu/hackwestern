import {campusFootprint} from '../web/campus-clip.js';

export function campusAssets(boundary,region){
  const site=campusFootprint(boundary);
  const cut=(rows,keep)=>Object.fromEntries(Object.entries(rows).filter(([key])=>keep(...key.split(/[:,]/).map(Number))));
  function terrainTile(i,j){
    const {xs,zs}=region;
    return site.intersects(xs[i],zs[j],xs[Math.min(i+24,xs.length-1)],zs[Math.min(j+24,zs.length-1)]);
  }
  function crosses(points,pad=0){
    return points.some(([x,,z],i)=>{
      const [ax,,az]=points[Math.max(0,i-1)];
      return site.intersects(Math.min(x,ax)-pad,Math.min(z,az)-pad,Math.max(x,ax)+pad,Math.max(z,az)+pad);
    });
  }
  return function scope(name,data){
    if(name==='surface-tiles'){
      data.walkways=data.walkways.filter(t=>site.intersects(...t.bounds));
      for(const part of ['tiles','finishes','strokes'])if(data[part])data[part]=cut(data[part],terrainTile);
    }else if(['canopy-survey','municipal-detail','region-detail'].includes(name)){
      const step=data.tileSize??data.size;
      data.tiles=cut(data.tiles,(i,j)=>site.intersects(i*step,j*step,(i+1)*step,(j+1)*step));
    }else if(name==='drive-network'){
      data.ways=data.ways.filter(way=>crosses(way.points,way.width*.5+2));
      data.bounds=boundary.bounds;
    }else if(name==='campus-region'){
      data.labels=data.labels.filter(p=>site.contains(p.x,p.z));
      data.trees=data.trees.filter(([x,,z])=>site.contains(x,z));
    }
    return data;
  };
}
