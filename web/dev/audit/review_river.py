import re

import cv2
import numpy as np
import shapely
from shapely.geometry import box
from PIL import Image

from review_land import read,region

from river_banks import surveyed_channels


def survey():
    return shapely.union_all(surveyed_channels()).buffer(-.70)


def reaches(views,water,west,north,sites=None,runs=()):
    cell=box(west,north,west+50,north+50)
    if not water.intersects(cell):return
    xy=(np.arange(500)+.5)*.1
    x,z=np.meshgrid(west+xy,north+xy)
    interior=shapely.contains_xy(water.intersection(cell),x,z)
    if interior.sum()<300:return
    rgb=views[2].astype('float32')
    band=.27*rgb[:,:,0]+.60*rgb[:,:,1]+.13*rgb[:,:,2]
    mean=cv2.blur(band,(11,11))
    spread=np.sqrt(np.maximum(0,cv2.blur(band*band,(11,11))-mean*mean))
    r,g,b=rgb.transpose(2,0,1)
    native=(g-b>9)&(g-b<44)&(np.abs(r-g)<13)&(spread<4.8)&(g>45)&(g<165)
    sample=interior&native
    if sample.sum()<800 or sample.sum()<interior.sum()*.36:return
    rendered=[]
    for im in views[:2]:
        r,g,b=im.astype(float).transpose(2,0,1)
        wet=(g-r>4)&(g-r<20)&(g-b>10)&(g-b<35)&(r<108)&(g>73)&(g<121)&(b>58)
        rendered.append(round(float(wet[sample].mean()),3))
    driver=[]
    if sites is not None:
        sparse=sample[::13,::13]
        px=x[::13,::13][sparse]
        pz=z[::13,::13][sparse]
        positions=np.c_[px,region.sample(sites[1],px,pz)-sites[2],pz]
        for folder in runs:
            observed={}
            for camera in read(folder/'metrics.json')['views']:
                if not camera['name'].startswith(('eye-','chase-')):continue
                eye=np.array(camera['eye'])
                forward=np.array(camera['at'])-eye;forward/=np.linalg.norm(forward)
                right=np.cross(forward,[0.,1.,0.]);right/=np.linalg.norm(right)
                up=np.cross(right,forward)
                with Image.open(folder/'views'/(camera['name']+'.png')) as raw:im=np.asarray(raw.convert('RGB')).astype('float32')
                h,w=im.shape[:2];f=h*.5/np.tan(np.deg2rad(camera['fov']*.5))
                delta=positions-eye;depth=np.sum(delta*forward,axis=1)
                u=w*.5+f*np.sum(delta*right,axis=1)/np.maximum(.1,depth)
                v=h*.5-f*np.sum(delta*up,axis=1)/np.maximum(.1,depth)
                visible=(depth>2)&(depth<72)&(u>1)&(u<w-2)&(v>h*.47)&(v<h-2)
                if visible.sum()<12:continue
                r,g,b=im[v[visible].astype(int),u[visible].astype(int)].T
                rippled=(g>r+6)&(g-r<30)&(g-b<20)&(b-r>-1)&(g<187)&(g>48)
                observed[camera['name']]=[int(visible.sum()),round(float(rippled.mean()),3)]
            driver.append(observed)
    return dict(confirmedWater=round(float(sample.sum()/100),2),municipalWater=round(float(interior.sum()/100),2),coverage=rendered,driver=driver)


def judge(row,signals):
    if not signals:return
    text=(row.get('note2') or row['description']).lower()
    if not re.search(r'thames|river|channel',text) or not re.search(r'missing|no (?:river|water)|dry|no ground|blurr|featureless|void|slab|wavy|water should|flat .*terrain|rendered as grass|is drawn as grass',text):return
    if re.search(r'barrier|point bar|cobble|woodland|different elevation|gravel|vertical box edge|drivable|drives?|roadway|sidewalk|creek|bridge|jog|near x|a thin|\d+.{0,10}(?:square metres|m²)|west edge also|falls? through',text):return
    if signals['confirmedWater']<60 or signals['coverage'][1]<.95:return
    driver=signals.get('driver',[])
    if len(driver)!=2:return
    directions=[f'{mode.lower()}-{name.upper()}' for mode,name in re.findall(r'(eye|chase)-([nesw])\b',text,re.I)]
    def wet_at_eye(data):
        visible=[v[1] for key,v in data.items() if not directions or key in directions]
        return bool(visible) and max(visible)>.66
    if not wet_at_eye(driver[1]):return
    old,new=signals['coverage']
    if old>.95 and wet_at_eye(driver[0]):return 'already-fixed','river-view-and-surveyed-waterline'
    if new-old>.07:return 'fixed','river-view-and-surveyed-waterline'
