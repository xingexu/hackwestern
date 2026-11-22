import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image


folder=Path(sys.argv[1])/'cells'
segments=[('x-3z10',[-130.75,524.8,-135.48,526.5]),('x-2z10',[-81.1,526.84,-84.79,528.1]),('x4z14',[224.91,725.94,227.03,726.68]),('x6z19',[320.36,976.13,319.73,980.01])]
segments.extend([('x6z14',[312.30,701.81,307.67,700.23]),('x6z14',[332.19,702.68,327.54,701.15]),
                 ('x-7z11',[-339.19,552.52,-344.15,554.48]),('x-7z11',[-318.41,553.25,-322.48,554.78])])
segments.extend([('x-2z3',[-73.33,178.55,-72.67,183.26]),('x-2z3',[-70.09,182.51,-70.69,178.14]),
                 ('x6z19',[345.87,970.02,341.87,969.44]),('x11z8',[572.15,446.5,571.98,449.0])])
segments.extend([('x-3z10',[-132.51,521.97,-136.36,523.32]),('x-4z1',[-184.29,85.7,-186.06,81.0]),
                 ('x-4z26',[-198.17,1301.83,-195.21,1306.56]),('x11z8',[578.51,419.66,573.36,419.24])])
segments.extend([('x-4z-5',[-192.71,-241.89,-187.56,-243.96]),('x-4z-5',[-190.69,-236.86,-185.54,-238.93]),
                 ('x4z-7',[206.66,-334.35,201.72,-332.49]),('x4z-7',[207.53,-332.03,202.59,-330.17]),
                 ('x-3z10',[-135.4,512.14,-139.99,513.82]),('x5z-6',[282.81,-288.73,286.95,-290.3])])
segments.extend([('x-2z-3',[-78.01,-130.50,-62.28,-127.60]),('x-2z-4',[-57.55,-180.62,-56.49,-185.72]),
                 ('x0z3',[23.36,153.07,28.44,153.97]),('x8z-3',[403.59,-146.10,401.61,-141.34]),
                 ('x-5z-2',[-238.66,-73.70,-236.84,-69.43]),('x-5z-4',[-239.87,-198.00,-244.71,-196.11])])
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

wellington=material('x-3z0')
profile=wellington@np.array([.5,.5,-1.])
for x,z in [(-140,16.65),(-136,15.65),(-132,14.85),(-128,14.05),(-124,13.35),(-116,11.95),(-112,11.35),(-108,10.95),(-104,10.55)]:
    column,row=np.rint([(x+150)*10-.5,z*10-.5]).astype(int)
    section=profile[row-7:row+8,column]
    crest=int(np.argmax(section))
    gain=section[crest]-np.mean(section[[0,1,-2,-1]])
    assert abs(crest-7)<=2 and gain>25,(x,z,crest,gain)
print('Nine independent aerial cross-sections locate the yellow centreline along Wellington Drive within 20 cm.')
