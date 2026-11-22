import json
import math
import numpy as np,shapely
from scipy.ndimage import binary_closing
from shapely.geometry import LineString
from shapely.ops import substring
from ortho_road_paint import survey_center
from planting_verges import aerial_samples
from campus_bounds import footprint
import campus_region as region

def repeated_center(guide):
    marks=survey_center(guide)
    if not marks:return []
    line=LineString(np.reshape(marks[0],(-1,2)))
    distances=np.linspace(0,line.length,math.ceil(line.length/.55)+1)
    points=shapely.get_coordinates(shapely.line_interpolate_point(line,distances))
    delta=np.gradient(points,axis=0)
    normals=delta[:,[1,0]]*[-1,1]/np.maximum(.01,np.linalg.norm(delta,axis=1))[:,None]
    offsets=np.arange(-.85,.86,.1)
    cross=points[:,None,:]+normals[:,None,:]*offsets[None,:,None]
    rgb=aerial_samples(cross.reshape(-1,2)).reshape(len(distances),len(offsets),4,3)
    light=rgb@np.array([.29,.55,.16])
    tint=rgb@np.array([.5,.5,-1.])
    contrast=light[:,4:-4]-(light[:,:-8]+light[:,8:])*.5
    pigment=tint[:,4:-4]-(tint[:,:-8]+tint[:,8:])*.5
    gold=(contrast>5)&(pigment>3.5)&(tint[:,4:-4]>12)
    recurring=gold.any(axis=1).sum(axis=1)>=2
    current=gold[:,:,0].any(axis=1)|gold[:,:,1].any(axis=1)
    support=recurring&current
    spans=binary_closing(support,structure=np.ones(9))
    spans|=support
    cuts=np.flatnonzero(np.diff(np.r_[False,spans,False])).reshape(-1,2)
    pieces=[]
    for start,stop in cuts:
        if distances[stop-1]-distances[start]<6 or support[start:stop].mean()<.53:continue
        part=substring(line,distances[start],distances[stop-1]).simplify(.07)
        pieces.append((part,round(float(support[start:stop].mean()),2)))
    return pieces

def survey():
    site=footprint()
    result=[]
    network=json.loads(region.OUT.with_name('drive-network.json').read_bytes())
    for way in network['ways']:
        if way['kind']!='road' or way['class']!='residential' or way['lanes']<2 or way['oneway'] or way['bridge'] or way['level']!=0:
            continue
        center=LineString([(x,z) for x,height,z in way['points']])
        if not center.intersects(site):
            continue
        for stroke,coverage in repeated_center(center):
            result.append([way['id'],np.asarray(stroke.coords).round(2).ravel().tolist(),coverage])
    path=region.OUT.parents[1]/'build/survey_residential_centers.json'
    path.write_text(json.dumps(result,separators=(',',':')))
    print(len(result),'residential centreline segments confirmed in repeated aerial photography.')


if __name__=='__main__':
    survey()
