import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import Point,Polygon

import campus_region as region
from streetview_frames import CACHE


OUT=region.OUT.with_name('street-signs.json')
OBSERVATIONS=Path(__file__).with_name('street_sign_observations.json')


def campus_posts():
    limits=json.loads(OUT.with_name('campus-boundary.json').read_bytes())
    land=[Polygon(np.reshape(rows[0],(-1,2)),[np.reshape(h,(-1,2)) for h in rows[1:]]) for rows in limits['polygons']]
    details=json.loads(region.OUT.with_name('region-detail.json').read_bytes())
    return {str(p[1]):p for tile in details['tiles'].values() for p in tile.get('p',[]) if p[0]=='bus_stop' and any(a.covers(Point(p[2],p[4])) for a in land)}


def observations(crops,frames,kind):
    evidence=[]
    hues=[]
    for fid,rect in crops:
        frame=frames[fid]
        with Image.open(CACHE/frame['path']) as photo:
            width,height=photo.size
            panel=photo.crop([round(n*p) for n,p in zip(rect,(width,height,width,height))]).convert('RGB')
            rgb=np.asarray(panel,dtype=float)
            r,g,b=np.moveaxis(rgb,-1,0)
            blue=(b>r*1.22+4)&(b>g*1.03+2)&(b>32)
            assert min(panel.size)>=12 and blue.mean()>.32 and kind=='bus_stop',(fid,panel.size,blue.mean())
            hues.append(float(np.median((g[blue]-r[blue])/np.maximum(1,b[blue]-r[blue]))))
        fov=frame.get('fov') or 72
        fx=.5/math.tan(math.radians(fov)/2)
        u=(rect[0]+rect[2])*.5
        bearing=math.radians(frame['heading'])+math.atan((u-.5)/fx)
        evidence.append(dict(frame=fid,source=f"https://kartaview.org/details/{frame['sequence']}/{frame['index']}",
                             author=frame['author'],station=[frame['x'],frame['z']],bearing=round(bearing,7)))
    return evidence,'lake' if np.mean(hues)>.52 else 'navy'


def intersection(a,b):
    x,z=a['station']
    xx,zz=b['station']
    dx,dz=xx-x,zz-z
    angle,other=a['bearing'],b['bearing']
    gap=math.sin(other-angle)
    assert math.hypot(dx,dz)>2.5 and abs(gap)>.045,'Poor triangulation geometry'
    dist=(-dx*math.cos(other)-dz*math.sin(other))/gap
    ix,iz=x+dist*math.sin(angle),z-dist*math.cos(angle)
    assert dist>0 and (ix-xx)*math.sin(other)-(iz-zz)*math.cos(other)>0,'Observation points away from the sign'
    return ix,iz


def generate():
    props=campus_posts()
    frames={f['id']:f for f in json.loads((CACHE/'frames.json').read_bytes())}
    tags={str(e['id']):e.get('tags',{}) for e in json.loads((region.CACHE/'map.json').read_bytes())['elements'] if e['type']=='node'}
    observations_by_post=json.loads(OBSERVATIONS.read_bytes())
    records={}
    for key,p in props.items():
        if p[0]!='bus_stop':
            continue
        t=tags.get(key,{})
        ref=t.get('ref','')
        record=dict(ref=ref if ref.isdigit() and len(ref)<=5 else '')
        if key in observations_by_post:
            evidence,tone=observations(observations_by_post[key],frames,p[0])
            ix,iz=intersection(*evidence)
            assert math.hypot(ix-p[2],iz-p[4])<4.5
            dirs=np.array([np.array(obs['station'])-[p[2],p[4]] for obs in evidence])
            dirs/=np.linalg.norm(dirs,axis=1)[:,None]
            direction=np.mean(dirs,axis=0)
            normal=np.array([math.sin(p[5]),math.cos(p[5])])
            dot=normal@direction
            yaw=p[5]+(math.pi if dot<0 else 0) if abs(dot)>.48 else math.atan2(direction[0],direction[1])
            record.update(tone=tone,face=round(yaw,5),evidence=evidence)
        records[key]=record
    payload=dict(records=records)
    tmp=OUT.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload,separators=(',',':')))
    tmp.replace(OUT)


def check():
    data=json.loads(OUT.read_bytes())
    refs=json.loads(OBSERVATIONS.read_bytes())
    props=campus_posts()
    assert set(data)=={'records'} and set(data['records'])==set(props)
    records={k:r for k,r in data['records'].items() if 'evidence' in r}
    assert records.keys()==refs.keys() and records
    for key,r in records.items():
        assert set(r)=={'ref','tone','face','evidence'}
        evidence=r['evidence']
        assert [v['frame'] for v in evidence]==[v[0] for v in refs[key]]
        assert all(v['source'].startswith('https://kartaview.org/details/') and v['author'] for v in evidence)
        ix,iz=intersection(*evidence)
        p=props[key]
        assert math.hypot(ix-p[2],iz-p[4])<4.5
        assert r['tone'] in ('lake','navy') and r['ref'].isdigit()
        assert all((v['station'][0]-p[2])*math.sin(r['face'])+(v['station'][1]-p[4])*math.cos(r['face'])>0 for v in evidence)
    print(f'{len(records)} transit posts corroborated by {2*len(records)} camera observations; {sum(bool(r["ref"]) for r in data["records"].values())} mapped transit stop identifiers.')


if __name__=='__main__':
    if '--check' not in sys.argv:
        generate()
    check()
