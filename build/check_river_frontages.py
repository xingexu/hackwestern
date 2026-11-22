import sys
from pathlib import Path

import numpy as np
from PIL import Image


views=Path(sys.argv[1])/'cells'
bridge=np.asarray(Image.open(views/'x7z-7/views/ground.png').convert('RGB'),float)
height,width=bridge.shape[:2]
for x,z in [(358,-327),(364,-318),(364,-315)]:
    col=int((x-350)*width/50)
    row=int((z+350)*height/50)
    red,green,blue=bridge[row-4:row+5,col-4:col+5].mean(axis=(0,1))
    assert green>red+2 and green>blue+22,(x,z,red,green,blue)
bank=np.asarray(Image.open(views/'x8z26/views/eye-S.png').convert('RGB'),float).mean(axis=2)
height,width=bank.shape
shore=bank[round(.72*height):round(.91*height),round(.26*width):round(.76*width)]
steps=[float((np.abs(np.diff(shore,axis=axis))>10).mean()) for axis in (0,1)]
assert steps[0]<.009 and steps[1]<.005,steps
print('Three photographed footbridge shoulders remain planted. Riverbank strong luminance steps by axis:',steps)
