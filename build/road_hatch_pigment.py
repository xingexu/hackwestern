import numpy as np

from planting_verges import aerial_samples


def street_ink(line):
    ends=np.asarray([line.coords[0],line.coords[-1]])
    axis=(ends[1]-ends[0])/line.length
    normal=np.array([-axis[1],axis[0]])
    points=np.linspace(*ends,max(10,round(line.length*5)))[2:-2]
    cloud=points[:,None,:]+np.array([-.45,-.32,-.10,0,.10,.32,.45])[None,:,None]*normal
    rgb=aerial_samples(cloud.reshape(-1,2)).reshape(len(points),7,4,3)
    diff=rgb[:,2:5].mean(axis=1)-rgb[:,[0,1,5,6]].mean(axis=1)
    light=diff@np.array([.30,.54,.16])
    amber=diff@np.array([.50,.50,-1.])
    spectra=np.median(light,axis=0)
    clean=(light>7).mean(axis=0)
    if np.count_nonzero((spectra>6.5)&(clean>.48))<2:return None
    return int(np.count_nonzero((np.median(amber,axis=0)>2.)&(spectra>6.5))>=2)
