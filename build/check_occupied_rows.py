import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image


folder=Path(sys.argv[1])/'cells'
segments=[('x-3z10',[-130.75,524.8,-135.48,526.5]),('x-2z10',[-81.1,526.84,-84.79,528.1]),('x4z14',[224.91,725.94,227.03,726.68]),('x6z19',[320.36,976.13,319.73,980.01])]
segments.extend([('x6z14',[312.30,701.81,307.67,700.23]),('x6z14',[332.19,702.68,327.54,701.15]),
                 ('x-7z11',[-339.19,552.52,-344.15,554.48]),('x-7z11',[-318.41,553.25,-322.48,554.78])])
def material(cell):
    with Image.open(folder/cell/'views/ground.png') as image:return np.asarray(image.convert('RGB').resize((500,500),Image.Resampling.BOX)).astype(float)
for cell,segment in segments:
    w,n=[50*int(k) for k in re.fullmatch('x(-?\\d+)z(-?\\d+)',cell).groups()]
    a,b=np.reshape(segment,(2,2))-[w,n]
    line=b-a
    side=np.array([-line[1],line[0]])/np.linalg.norm(line)
    frame=material(cell)
    steps=a+np.linspace(.11,.89,35)[:,None]*line
    def sample(s):
        u,v=np.rint((steps+s*side)*10-.5).astype(int).T
        return frame[v,u]
    outer=(sample(-.4)+sample(.4))*.5
    def seen(s):
        light=(sample(s)-outer)@np.array([.29,.55,.16])
        gold=(sample(s)-outer)@np.array([.5,.5,-1.])
        return ((light>11)|((gold>12)&(light>2))).mean()
    assert max(seen(s) for s in [-.10,-.05,0,.05,.10])>.75,cell
field=material('x7z14')
for z in np.arange(708.5,741,.5):
    x=364.7-(z-725)*.324
    u,v=np.rint(np.array([x-350,z-700])*10-.5).astype(int)
    middle=field[v,u-2:u+3].mean(axis=1)
    outer=field[v,[u-6,u+6]].mean()
    assert middle.max()-outer<12,(x,z)
park=material('x10z-7')
centre=park[270:310,280:320]
assert np.mean(centre[:,:,1]>centre[:,:,0]+13)>.94
print(len(segments),'surveyed parking dividers, 65 field-edge controls and the isolated-canopy lawn passed in rendered pixels.')
