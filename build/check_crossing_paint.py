import base64
import json

import numpy as np
import shapely
from shapely.geometry import Point,Polygon

import campus_region as region
from ladder_crossings import registered
from ortho_road_paint import pigment


def polygon(ring):
    return Polygon(np.reshape(ring,(-1,2)))


def paint_index(channel=0):
    terrain=json.loads(region.OUT.read_bytes())
    strokes=json.loads(region.OUT.with_name('surface-tiles.json').read_bytes())['strokes']
    triangles=[]
    for key,channels in strokes.items():
        i,j=map(int,key.split(','))
        vertices=np.frombuffer(base64.b64decode(channels[channel]),'<u2').reshape(-1,3,2)/128
        triangles.extend(shapely.polygons(vertices+[terrain['xs'][i],terrain['zs'][j]]))
    return shapely.STRtree(triangles)


def sampled_stripe(part):
    edges=np.diff(np.asarray(part.exterior.coords),axis=0)
    lengths=np.linalg.norm(edges,axis=1)
    longest=lengths.argmax()
    axis=edges[longest]/lengths[longest]
    flank=np.array([-axis[1],axis[0]])*(lengths.min()*.5+.25)
    center=np.asarray(part.centroid.coords[0])
    samples=center+np.linspace(-.34,.34,15)[:,None]*lengths[longest]*axis
    weights=np.array([.30,.52,.18])
    contrast=(pigment(samples)-(pigment(samples+flank)+pigment(samples-flank))*.5)@weights
    return axis,np.median(contrast)


index=paint_index()
groups=[([polygon(p) for p in row['bars']],[polygon(p) for p in row['rails']]) for row in registered()]
controls=[(134,533,13,[0,1]),(128,527,6,[.53,.85]),(79,-122,5,[.93,.37]),(-47,1378,7,[.11,.99]),(-23,593,20,[1,-.08])]
for x,z,minimum,heading in controls:
    bars,rails=min(groups,key=lambda g:shapely.union_all(g[0]).centroid.distance(Point(x,z)))
    assert len(bars)>=minimum and len(rails)==2,(x,z)
    pigment_gain=[]
    coverages=[]
    rail_coverage=[]
    for part in bars+rails:
        axis,lift=sampled_stripe(part)
        if part in bars:
            assert abs(axis@heading)>.94,(x,z,axis)
            pigment_gain.append(lift)
        else:
            assert abs(axis@heading)<.21,(x,z,axis)
        triangles=index.geometries[index.query(part)]
        coverage=shapely.union_all(triangles).intersection(part).area/part.area
        coverages.append(coverage)
        if part in bars:
            assert any(g.covers(part.centroid) for g in triangles),(x,z,part.centroid.coords[:])
        else:
            rail_coverage.append(coverage)
    assert np.mean(rail_coverage)>.87 and min(rail_coverage)>.72,(x,z,rail_coverage)
    assert np.median(coverages)>.97 and np.mean(coverages)>.93,(x,z,coverages)
    assert np.median(pigment_gain)>10,(x,z,pigment_gain)
print('Photographed crossing angles, painted rails and bar coverage passed at five campus junctions.')


from painted_gores import markings as channelizing_paint

gold=paint_index(1)
center=Point(-72,609)
bars=[line for line,ink in channelizing_paint()[0] if line.distance(center)<25 and line.length<10]
assert len(bars)>=8
for line in bars:
    mark=line.buffer(.055,cap_style='flat')
    covered=shapely.union_all(gold.geometries[gold.query(mark)]).intersection(mark)
    assert covered.area>.88*mark.area,(line.centroid.coords[:],covered.area/mark.area)
    assert sampled_stripe(mark)[1]>6,line.centroid.coords[:]
print(len(bars),'yellow road hatches traced to the source and present in the compiled roadway.')
