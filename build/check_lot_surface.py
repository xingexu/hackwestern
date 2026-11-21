import sys
from pathlib import Path

import numpy as np
from PIL import Image


def samples(path):
    with Image.open(path) as img:
        rgb=np.asarray(img.convert('RGB').resize((500,500),Image.Resampling.BOX))
    pairs=[((322.3,1054.8),(324.5,1054.8)),((316.3,1055.8),(316.3,1058.0)),((318.8,1083.8),(321.0,1083.8)),((311.3,1097.8),(313.5,1097.8))]
    def group(x,z):
        u,v=round((x-300)*10),round((z-1050)*10)
        return np.median(rgb[v-2:v+3,u-2:u+3],axis=(0,1))
    return np.asarray([[group(*a),group(*b)] for a,b in pairs])


views=Path(sys.argv[1])/'cells/x6z21/views'
native=samples(views/'city-2025.png')
rendered=samples(views/'ground.png')
assert np.abs(native[:,0]-native[:,1]).max()<=7
changes=np.abs(rendered[:,0]-rendered[:,1]).max(axis=1)
assert changes.max()<9 and np.abs(native-rendered).mean()<15,(changes,native,rendered)
print('Four surveyed parking aisle transitions',changes.tolist(),'RGB levels')

controls=[(305.9,1322.7,'concrete'),(324.3,121.7,'concrete'),(127.7,159.9,'concrete'),(-230.7,917.5,'grass'),(-232.5,912.7,'grass')]
for x,z,material in controls:
    i,j=int(x//50),int(z//50)
    path=Path(sys.argv[1])/'cells'/f'x{i}z{j}'/'views/ground.png'
    with Image.open(path) as image:
        colors=np.asarray(image.convert('RGB').resize((500,500),Image.Resampling.BOX))
    u,v=int((x-50*i)*10),int((z-50*j)*10)
    red,green,blue=np.median(colors[v-1:v+2,u-1:u+2],axis=(0,1))
    if material=='concrete':assert red>135 and red>=green-2 and red-blue<32,(x,z,red,green,blue)
    else:
        nearby=np.median(colors[v-36:v-33,u-1:u+2],axis=(0,1))
        assert np.abs([red,green,blue]-nearby).max()<16 and green-blue>25 and red-blue>16,(x,z,red,green,blue,nearby)
print('Three photographed paved forecourts and two shaded lawn patches passed in rendered pixels.')
