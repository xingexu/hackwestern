import argparse
import base64
import concurrent.futures as futures
import io
import json
import math
import os
import threading
import time
from collections import defaultdict
from pathlib import Path

import requests
from PIL import Image
from shapely import contains_xy

from campus_bounds import footprint

import campus_region as region
import geo

CACHE = geo.DATA / 'streetview'
API = 'https://api.kartaview.org/2.0/photo/'
WEST, SOUTH, EAST, NORTH = region.BBOX


def page(number):
    path = CACHE / 'pages' / f'{number}.json'
    if not path.exists():
        options = dict(nwLat=NORTH, nwLng=WEST, seLat=SOUTH, seLng=EAST, itemsPerPage=150, page=number)
        for attempt in range(8):
            try:
                response = requests.get(API, params=options, timeout=35)
                if response.status_code == 429:
                    time.sleep(max(65,int(response.headers.get('Retry-After') or 65)))
                    continue
                response.raise_for_status()
                result = response.json()['result']
                path.write_text(json.dumps(result))
                break
            except (requests.RequestException, KeyError):
                if attempt == 7:
                    raise
                time.sleep(2 ** attempt)
    return json.loads(path.read_bytes())


def inventory():
    rows = {}
    (CACHE / 'pages').mkdir(parents=True, exist_ok=True)
    with futures.ThreadPoolExecutor(6) as pool:
        for start in range(1, 1000, 6):
            batch = list(pool.map(page, range(start, start + 6)))
            for result in batch:
                for row in result['data']:
                    if WEST <= float(row['lng']) <= EAST and SOUTH <= float(row['lat']) <= NORTH:
                        rows[row['id']] = row
            if not batch[-1]['hasMoreData']:
                break
    print(f'{len(rows)} geolocated frames in region', flush=True)
    sequences = defaultdict(list)
    for row in rows.values():
        sequences[row['sequenceId']].append(row)
    frames = []
    unposed = []
    authors = {}
    near = geo.DATA / 'street' / 'near.json'
    nearby = CACHE / 'nearby.json'
    if not nearby.exists():
        r = requests.post('https://api.kartaview.org/1.0/list/nearby-photos/', data=dict(lat=(NORTH+SOUTH)/2,lng=(WEST+EAST)/2,radius=2400,ipp=100000,page=1),timeout=90)
        r.raise_for_status()
        nearby.write_bytes(r.content)
    for index in [near, nearby]:
        if index.exists():
            authors.update({r['sequence_id']:r['username'] for r in json.loads(index.read_bytes())['currentPageItems']})
    for seq, track in sequences.items():
        track.sort(key=lambda r:int(r['sequenceIndex']))
        for i, row in enumerate(track):
            if row.get('visibility') != 'public' or row.get('projection') != 'PLANE':
                continue
            x,z = geo.to_grid(float(row['lat']),float(row['lng']))
            directions = []
            for side in (-1,1):
                for j in range(i+side,max(-1,min(len(track),i+side*7)),side):
                    other=track[j]
                    if abs(int(other['sequenceIndex'])-int(row['sequenceIndex'])) > 8:
                        break
                    xx,zz=geo.to_grid(float(other['lat']),float(other['lng']))
                    dx,dz=(xx-x)*side,(zz-z)*side
                    length=math.hypot(dx,dz)
                    if 4<=length<=45:
                        directions.append((dx/length,dz/length))
                        break
            reported=float(row.get('headers') or row.get('heading') or 0)
            dx,dz=map(sum,zip(*directions)) if directions else (0,0)
            reliable=math.hypot(dx,dz)>=.4
            heading=math.degrees(math.atan2(dx,-dz))%360 if reliable else reported or None
            value=float(row.get('fieldOfView') or 0)
            selected=frames if heading is not None else unposed
            selected.append(dict(id=row['id'],sequence=seq,index=int(row['sequenceIndex']),lat=float(row['lat']),lon=float(row['lng']),x=round(x,2),z=round(z,2),heading=round(heading,2) if heading is not None else None,headingSource='track' if reliable else 'reported' if heading is not None else 'unknown',fov=value if 30<value<140 else None,pitch=None,projection='PLANE',author=authors.get(seq),date=row['shotDate'][:10],path='photos/'+row['id']+'.jpg',url=row['imageProcUrl']))
    (CACHE/'unposed.json').write_text(json.dumps(unposed,separators=(',',':')))
    (CACHE/'inventory.json').write_text(json.dumps(frames,separators=(',',':')))
    return frames


_connections=threading.local()


def fetch_image(url):
    if not hasattr(_connections,'session'):
        _connections.session=requests.Session()
    return _connections.session.get(url,timeout=20)


def download(frame):
    path=CACHE/frame['path']
    if path.exists():
        return frame
    local=geo.DATA/'street'/(frame['id']+'-full.jpg')
    for attempt in range(2):
        try:
            if local.exists():
                original=local.read_bytes()
            else:
                r=fetch_image(frame.get('previewUrl') or frame['url'])
                r.raise_for_status()
                original=r.content
            with Image.open(io.BytesIO(original)) as image:
                image.load()
                if min(image.size)<160:
                    return
                if max(image.size)>2304:
                    image.thumbnail((2304,2304),Image.Resampling.LANCZOS)
                    temp=io.BytesIO()
                    image.convert('RGB').save(temp,'JPEG',quality=91)
                    original=temp.getvalue()
            tmp=path.with_suffix(f'.{os.getpid()}.{threading.get_ident()}.part')
            tmp.write_bytes(original)
            tmp.replace(path)
            return frame
        except (requests.RequestException, OSError):
            if attempt==0:
                time.sleep(.5)


def save_downloads(frames):
    ready=[r for r in frames if (CACHE/r['path']).exists()]
    tmp=CACHE/f'frames-{os.getpid()}.tmp'
    tmp.write_text(json.dumps(ready,separators=(',',':')))
    tmp.replace(CACHE/'frames.json')
    return len(ready)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--additional',action='store_true')
    parser.add_argument('--recover',action='store_true')
    parser.add_argument('--spatial-only',action='store_true')
    parser.add_argument('--spacing',type=int,default=14)
    args=parser.parse_args()
    file=CACHE/'inventory.json'
    frames=json.loads(file.read_bytes()) if file.exists() and (CACHE/'unposed.json').exists() else inventory()
    site=footprint()
    def on_campus(rows):
        return [r for r in rows if contains_xy(site,r['x'],r['z'])]
    frames=on_campus(frames)
    if args.recover:
        pages={r['id']:r for path in (CACHE/'pages').glob('*.json') for r in json.loads(path.read_bytes())['data']}
        public=frames+on_campus(json.loads((CACHE/'unposed.json').read_bytes()))
        missing=[r for r in public if not (CACHE/r['path']).exists()]
        def recover(r):
            meta=pages[r['id']]
            if not meta.get('filepathLTh') and not meta.get('filepathProc'):
                return
            def archived(name):
                location=f"https://{meta['storage']}.openstreetcam.org/files/photo/{meta[name]}"
                return 'https://cdn.kartaview.org/pr:sharp/'+base64.urlsafe_b64encode(location.encode()).decode().rstrip('=')
            for url in dict.fromkeys((archived('filepathLTh'),meta['imageLthUrl'],archived('filepathProc'),meta['imageProcUrl'])):
                if download(dict(r,previewUrl=url)):
                    return
        with futures.ThreadPoolExecutor(8) as pool:
            list(pool.map(recover,missing))
        available=save_downloads(frames)
        absent=[r['id'] for r in public if not (CACHE/r['path']).exists()]
        receipt=dict(public=len(public),available=available,withoutPose=len(public)-len(frames),unavailable=absent)
        (CACHE/'campus-acquisition.json').write_text(json.dumps(receipt))
        print('Available posed photos',available,'unavailable photos',len(absent),'unposed',len(public)-len(frames),flush=True)
        return
    buckets=defaultdict(list)
    for r in frames:
        key=(math.floor(r['x']/args.spacing),math.floor(r['z']/args.spacing),round(r['heading']/32)%11)
        buckets[key].append(r)
    for group in buckets.values():
        group.sort(key=lambda r: (r['date'][5:7] not in ('04','05','09','10'),r['date']),reverse=False)
    order=sorted(buckets,key=lambda k:(k[0]*73856093 ^ k[1]*19349663 ^ k[2]*83492791)%10000019)
    selection=[buckets[key][0] for key in order]
    if not args.spatial_only:
        previews={r['id']:r['imageLthUrl'] for path in (CACHE/'pages').glob('*.json') for r in json.loads(path.read_bytes())['data']}
        extra=[dict(r,previewUrl=previews[r['id']]) for group in buckets.values() for r in group[1:]]
        selection=extra if args.additional else selection+extra
    (CACHE/'photos').mkdir(exist_ok=True,parents=True)
    print(f'{len(frames)} posed public frames, {len(selection)} selected camera views',flush=True)
    with futures.ThreadPoolExecutor(12) as pool:
        for i,_ in enumerate(pool.map(download,selection),1):
            if i%100==0:
                print(i,save_downloads(frames),'cached',flush=True)
    print(save_downloads(frames),'usable downloads',flush=True)


if __name__=='__main__':
    main()
