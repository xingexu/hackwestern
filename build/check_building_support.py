import json
import sys

import numpy as np
from shapely.geometry import Polygon
from shapely.strtree import STRtree


def verify(records):
    polygons=[]
    for item in records:
        rs=item["rings"]
        polygons.append(Polygon(np.reshape(rs[0],(-1,2)),[np.reshape(r,(-1,2)) for r in rs[1:]]).buffer(.11))
    tree=STRtree(polygons)
    parent=list(range(len(records)))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]]
            i=parent[i]
        return i
    for i,(p,a) in enumerate(zip(polygons,records)):
        for j in tree.query(p,predicate="intersects"):
            if j>i:
                b=records[j]
                if a["high"]+.26>=b["low"] and b["high"]+.26>=a["low"]:
                    if a.get("roof") or b.get("roof"):
                        intersection=p.intersection(polygons[j])
                        corners=list(intersection.envelope.exterior.coords) if intersection.envelope.geom_type=="Polygon" else list(intersection.envelope.coords)
                        def touch(row,required):
                            if not row.get("roof"):return True
                            tri=np.asarray(row["roof"])
                            normal=np.cross(tri[1]-tri[0],tri[2]-tri[0])
                            if abs(normal[1])<1e-6:return False
                            return max(tri[0,1]-((x-tri[0,0])*normal[0]+(z-tri[0,2])*normal[2])/normal[1] for x,z in corners)+.26>=required
                        if not touch(a,b["low"]) or not touch(b,a["low"]):continue
                    parent[root(j)]=root(i)
    grounded={root(i) for i,r in enumerate(records) if r["low"]<=r["terrain"]+.30}
    detached=[(r["id"],round(r["low"],2),round(r["high"],2),r["rings"][0][:2]) for i,r in enumerate(records) if root(i) not in grounded]
    assert not detached, f"Detached volumes/roof supports: {detached[:30]}"
    print(f"{len(records)} building solids connected to terrain directly or through a supporting volume")


if __name__=="__main__":
    verify(json.load(sys.stdin))
