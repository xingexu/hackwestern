import base64
import json

import numpy as np

from canopy_survey import OUT,RECORD,TILE,crown_clear,travel_clearance


def reconcile(path):
    canopy=json.loads(path.read_bytes())
    floor=travel_clearance(json.loads(path.with_name('drive-network.json').read_bytes()))
    removed=0
    for key,tile in list(canopy['tiles'].items()):
        column,row=map(int,key.split(','))
        records=np.frombuffer(base64.b64decode(tile['data']),RECORD)
        keep=crown_clear(records,column*TILE+records['x']/32,row*TILE+records['z']/32,floor)
        if keep.all():continue
        removed+=int(np.count_nonzero(~keep))
        starts=np.concatenate(([0],np.cumsum(keep)))
        stems=[]
        for x,z,height,first,count,base in tile['stems']:
            size=int(starts[first+count]-starts[first])
            if size:stems.append([x,z,height,int(starts[first]),size,base])
        if not stems:
            del canopy['tiles'][key]
            continue
        tile.update(count=int(starts[-1]),stems=stems,data=base64.b64encode(records[keep].tobytes()).decode())
    if removed:
        staged=path.with_suffix('.building')
        staged.write_text(json.dumps(canopy,separators=(',',':')))
        staged.replace(path)
    return removed


if __name__=='__main__':
    print(reconcile(OUT),'lidar crown samples within the updated travel clearance envelope removed.')
