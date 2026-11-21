import json

import numpy as np
from scipy.ndimage import binary_closing

import campus_region as region
from ortho_road_paint import pigment


def measured_borders():
    data=json.loads(region.OUT.with_name('region-detail.json').read_bytes())
    result=[]
    for tile in data['tiles'].values():
        for kind,identity,x,y,z,X,Y,Z,*rest in (line for line in tile.get('l',[]) if line[0]=='field_edge'):
            a,b=np.array([x,z]),np.array([X,Z])
            distance=np.linalg.norm(b-a)
            if distance<1.2:continue
            axis=(b-a)/distance
            side=np.array([-axis[1],axis[0]])
            stations=np.linspace(0,distance,max(12,round(distance*8)))
            path=a+stations[:,None]*axis
            offsets=np.arange(-.6,.61,.1)
            probes=path+offsets[:,None,None]*side
            def sample(d):return pigment((probes+d*side).reshape(-1,2)).reshape(probes.shape[:2]+(3,))
            stripe=sample(0);left,right=sample(-.26),sample(.26)
            signal=np.minimum(stripe-left,stripe-right)@np.array([.32,.50,.18])
            white=(signal>13)&(stripe[:,:,1]>130)&(np.ptp(stripe,axis=2)<36)
            k=white.mean(axis=1).argmax()
            if white[k].mean()<.4:continue
            runs=binary_closing(white[k],structure=np.ones(5,bool))
            limits=np.flatnonzero(np.diff(np.r_[False,runs,False])).reshape(-1,2)
            for begin,end in limits:
                if stations[end-1]-stations[begin]<1.2:continue
                result.append(np.round(path[[begin,end-1]]+offsets[k]*side,2).ravel().tolist())
    return result
