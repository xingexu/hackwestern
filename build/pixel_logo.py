"""Generate the pixel-art Formula Western logo, FW mark and favicon used by web/ui.
Usage: .venv/bin/python build/pixel_logo.py [source.png web/ui preview.png]"""

import sys
from PIL import Image
src,out,prev=(sys.argv[1:4]+[None]*3)[:3] if len(sys.argv)>1 else ("build/assets/formula-western-logo.png","web/ui",None)
im=Image.open(src).convert('RGBA')
im=im.crop(im.split()[3].point(lambda v:255 if v>60 else 0).getbbox())
# split mark (FW) from wordmark: find widest fully-transparent row gap in lower half
a=im.split()[3].point(lambda v:255 if v>60 else 0)
rows=[any(a.crop((0,y,im.width,y+1)).get_flattened_data()) for y in range(im.height)]
gap=[y for y in range(im.height//2,im.height) if not rows[y]]
cut=gap[len(gap)//2] if gap else int(im.height*.66)
mark=im.crop((0,0,im.width,cut)); mark=mark.crop(mark.split()[3].point(lambda v:255 if v>60 else 0).getbbox())
def pixel(img,w,colors=10):
    h=round(img.height*w/img.width)
    s=img.resize((w,h),Image.LANCZOS)
    al=s.split()[3].point(lambda v:255 if v>110 else 0)
    rgb=s.convert('RGB').quantize(colors,method=Image.Quantize.MEDIANCUT).convert('RGB'); rgb.putalpha(al); return rgb
full=pixel(im,176); full.save(out+'/logo-pixel.png',optimize=True)
m=pixel(mark,72,8); m.save(out+'/mark-pixel.png',optimize=True)
fav=pixel(mark,32,8); c=Image.new('RGBA',(32,32)); c.paste(fav,(0,(32-fav.height)//2),fav); c.save(out+'/favicon.png',optimize=True)
if prev: full.resize((full.width*3,full.height*3),Image.NEAREST).save(prev)
print('cut',cut,'full',full.size,'mark',m.size)
