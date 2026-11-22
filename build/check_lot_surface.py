import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import label


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

perimeters=[(-182.0,75.0),(-182.2,63.4),(-186.1,85.8),(-67.0,90.1),(-172.2,1302.3)]
for x,z in perimeters:
    i,j=int(x//50),int(z//50)
    view=Path(sys.argv[1])/'cells'/f'x{i}z{j}'/'views'
    u,v=int((x-50*i)*10),int((z-50*j)*10)
    swatches=[]
    for name in ('city-2025','ground'):
        with Image.open(view/(name+'.png')) as image:
            pixels=np.asarray(image.convert('RGB').resize((500,500),Image.Resampling.BOX))
            swatches.append(np.median(pixels[v-2:v+3,u-2:u+3],axis=(0,1)))
    original,drawn=swatches
    assert abs(original-drawn).max()<39 and drawn[0]>=drawn[1]-1,(x,z,swatches)
for x,z in [(-184.2,66.4),(-173.0,87.0)]:
    view=Path(sys.argv[1])/'cells/x-4z1/views/ground.png'
    with Image.open(view) as image:
        pixels=np.asarray(image.convert('RGB').resize((500,500),Image.Resampling.BOX))
    u,v=int((x+200)*10),int((z-50)*10)
    red,green,blue=np.median(pixels[v-2:v+3,u-2:u+3],axis=(0,1))
    assert green>red+8 and green>blue+18,(x,z,red,green,blue)
print('Five surveyed parking apron samples match the municipal photograph and two planting areas remain green.')

verge_samples=[(-176.,1312.5),(-174.,1311.6),(-172.,1311.),(-170.,1310.),(-168.,1309.1),(-166.,1308.1)]
view=Path(sys.argv[1])/'cells/x-4z26/views'
for name in ('city-2025','ground'):
    with Image.open(view/f'{name}.png') as image:
        pixels=np.asarray(image.convert('RGB').resize((500,500),Image.Resampling.BOX))
    for x,z in verge_samples:
        u,v=int((x+200)*10),int((z-1300)*10)
        red,green,blue=np.median(pixels[v-3:v+4,u-3:u+4],axis=(0,1))
        assert green>red+1 and green>blue+22,(name,x,z,red,green,blue)
print('Six sampled points on the photographed lawn beside the stadium parking lot remain grass.')

with Image.open(Path(sys.argv[1])/'cells/x8z10/views/ground.png') as image:
    paving=np.asarray(image.convert('RGB').resize((500,500),Image.Resampling.BOX),float)
drive=np.median(paving[278:283,218:223],axis=(0,1))
components,_=label(np.max(np.abs(paving-drive),axis=2)<32)
aisle=components[280,220]
assert aisle and all(components[z,x]==aisle for z,x in [(235,220),(250,300)])
print('Both surveyed pickup bays connect to their aisle in the finished ground view.')


shaded_pavement=[(-174.25,57.25),(-175.25,64.25),(-173.75,71.25),(-70.25,73.25),(-64.25,80.25),(349.25,106.25),(323.75,115.75)]
for x,z in shaded_pavement:
    i,j=int(x//50),int(z//50)
    with Image.open(Path(sys.argv[1])/'cells'/f'x{i}z{j}'/'views/ground.png') as image:
        pixels=np.asarray(image.convert('RGB').resize((500,500),Image.Resampling.BOX),float)
    u,v=int((x-50*i)*10),int((z-50*j)*10)
    red,green,blue=np.median(pixels[v-1:v+2,u-1:u+2],axis=(0,1))
    assert red>145 and red>green-2 and green-blue<21,(x,z,red,green,blue)
print('Seven sidewalk samples follow the concrete visible before the frontage fell into shadow in the 2025 flight.')

def ground_patch(x,z,radius):
    west,north=int(x//50)*50,int(z//50)*50
    key=f'x{west//50}z{north//50}'
    with Image.open(Path(sys.argv[1])/'cells'/key/'views/ground.png') as image:
        density=image.width/50
        u,v=(x-west)*density,(z-north)*density
        bounds=[round(q) for q in [u-radius*density,v-radius*density,u+radius*density,v+radius*density]]
        return np.asarray(image.convert('RGB').crop(bounds),dtype=float).reshape(-1,3)


for x,z in [(-70,-238.5),(-57,-228.5),(-61,1234.5),(-447,957),(131,1135)]:
    source=ground_patch(x,z,.45)
    red,green,blue=np.median(source,axis=0)
    assert red>150 and green>143 and red-blue<40,(x,z,red,green,blue)
red,green,blue=ground_patch(240.73,1338.8,.35).T
assert ((green>red+5)&(green>blue+18)).mean()<.005
assert np.median(red)>np.median(green)+12 and np.median(blue)>np.median(green)+12
print('Five private mineral surfaces match exposed historical paving and the track remains rubber beneath the photographed equipment.')
