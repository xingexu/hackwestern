import json
import math
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import LineString,Point


capture=Path(sys.argv[1])/'cells'


@lru_cache(maxsize=48)
def image(column,row):
    with Image.open(capture/f'x{column}z{row}'/'views/ground.png') as source:
        return np.asarray(source.convert('RGB'),dtype=np.int16)


def swatch(x,z):
    column,row=math.floor(x/50),math.floor(z/50)
    rgb=image(column,row)
    u=round((x/50-column)*rgb.shape[1])
    v=round((z/50-row)*rgb.shape[0])
    return np.median(rgb[max(0,v-1):v+2,max(0,u-1):u+2],axis=(0,1))


hard=[(-55,-235),(-52.5,-234.5),(-57,-225),(-63,1231),(-60.5,1236),(-125,118),(-264,135),(-266,134),(-254,130),(-257,129),(-270,330),(-276,331),(12,-32),(606,44),(610,42),(619,38),(145,1345),(143.8,1357),(142.4,1365),(141.8,1369),(141,1373),(217,-9),(210,-7),(203,-1),(232,75),(219,79),(211,641),(204,639),(216,644),(242,1430),(238,1433),(212,1440),(274,85),(270,85),(272,90),(293,-140),(265,603),(277,605),(278,611),(282,1121),(272,1116),(286,1124),(288,1177),(289,1179),(274,1368),(278,1372),(282,1385)]
for x,z in hard:
    r,g,b=swatch(x,z)
    assert r>141 and r>=g-2 and r-b<38,(x,z,r,g,b)
planting=[(-120,118),(-115,116),(-180,596),(-291,574),(-286,340),(10,-32),(615,30),(224,63),(232,1436),(266,-147),(294,-131),(255,1120),(259,1120),(265,1121),(302.3,-501.1)]
for x,z in planting:
    r,g,b=swatch(x,z)
    assert g>r+5 and g>b+19,(x,z,r,g,b)
for x,z in [(152,612),(154,614),(163,615),(169,616),(175,617),(227.15,-480.958),(228.4,-481.3),(230,-480.3),(281.6,-130.2),(287,-141)]:
    r,g,b=swatch(x,z)
    assert r>=g-3 and r-b<34,(x,z,r,g,b)
for road,lot in [((-184,591),(-185,582)),((-282,577),(-275,575)),((242,834.1),(218,820))]:
    assert swatch(*lot).mean()>swatch(*road).mean()+12,(road,lot,swatch(*road),swatch(*lot))
web=Path(__file__).resolve().parents[1]/'web'
pack=json.loads((web/'surface-tiles.json').read_bytes())
lines=[LineString(np.asarray(p).reshape(-1,2)) for p,_ in pack['pavementSurvey']['kerbs']]
for x,z in [(300.5,-505.192),(616.033,37.055),(246.029,-475.735)]:
    assert min(line.distance(Point(x,z)) for line in lines)>.40,(x,z)
for x,z in [(10.62,-26.04),(155.6,617.52),(302.76,-497.4),(608.32,37.48)]:
    assert min(line.distance(Point(x,z)) for line in lines)<.15,(x,z)
print(len(hard),'surveyed mineral swatches,',len(planting),'planting swatches, ten service-road controls, three road-to-parking contrasts and seven kerb locations passed.')
