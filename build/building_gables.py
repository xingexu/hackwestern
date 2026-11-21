import math
from collections import Counter

import shapely
from shapely import affinity
from shapely.geometry import Polygon, box


def eave_outline(shell,roof):
    depth=roof.get("overhang",0)
    if depth<=0:return shell
    rake=roof.get("rakeOverhang")
    if rake is None or not isinstance(roof.get("ridge"),(float,int)) or depth<=rake:
        return shell.buffer(depth,join_style=2)
    origin=shell.centroid.coords[0]
    angle=roof["ridge"]-90
    rotated=affinity.rotate(shell,-angle,origin)
    scale=depth/max(.001,rake)
    stretched=affinity.scale(rotated,xfact=scale,yfact=1,origin=origin).buffer(depth,join_style=2)
    return affinity.rotate(affinity.scale(stretched,xfact=1/scale,yfact=1,origin=origin),angle,origin)


def attic_aperture(surface,win,target,center):
    vertices,indices=surface
    edges=Counter(tuple(sorted((a,c))) for k in range(0,len(indices),3) for a,c in zip(indices[k:k+3],indices[k+1:k+3]+indices[k:k+1]))
    candidates=[]
    for apex,p in enumerate(vertices):
        if p[1]<win["height"]+.3:continue
        ends=[vertices[c if a==apex else a] for (a,c),count in edges.items() if count==1 and apex in (a,c) and min(vertices[a][1],vertices[c][1])<p[1]-.2]
        if len(ends)!=2:continue
        a,c=ends
        length=math.hypot(c[0]-a[0],c[2]-a[2])
        if length<=win["width"]+.22:continue
        tx,tz=(c[0]-a[0])/length,(c[2]-a[2])/length
        if abs((p[0]-a[0])*tz-(p[2]-a[2])*tx)>.01:continue
        if (p[0]-center[0])*tz-(p[2]-center[1])*tx<0:
            a,c=c,a
            tx,tz=-tx,-tz
        along=(p[0]-a[0])*tx+(p[2]-a[2])*tz
        sill=win.get("sill",.28)
        half=win["width"]/2
        cut=box(along-half,sill,along+half,sill+win["height"])
        panel=Polygon([(0,0),(length,0),(length,c[1]),(along,p[1]),(0,a[1])]).buffer(0)
        if not panel.contains(cut):continue
        pieces=shapely.constrained_delaunay_triangles(panel.difference(cut))
        mask=[list(tri.exterior.coords)[:3] for tri in shapely.get_parts(pieces)]
        skipped=[f"{i}:{j}" for (i,j),count in edges.items() if count==1 and apex in (i,j) and vertices[j if i==apex else i] in ends]
        candidates.append((math.hypot(target[0]-p[0],target[1]-p[2]),dict(a=[a[0],a[2]],b=[c[0],c[2]],u=round(along,4),panels=mask,edges=skipped,window=win)))
    return min(candidates,key=lambda row:row[0])[1] if candidates else None
