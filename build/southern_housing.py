import json

import numpy as np
from scipy import ndimage
from shapely import contains_xy, transform
from shapely.geometry import Polygon, shape
from shapely.strtree import STRtree


SITES={1314955:123525237,1314960:123525214,1316182:123525198}


def extend_housing(region):
    import campus_region as survey
    import geo
    from architecture import hip_roof
    parcels=json.loads(survey.retrieve('southern-housing.json',survey.CITY+'Buildings/MapServer/0/query',
        dict(objectIds=','.join(map(str,SITES)),outFields='OBJECTID',outSR=4326,f='geojson')).read_bytes())['features']
    if {f['properties']['OBJECTID'] for f in parcels}!=set(SITES):raise ValueError('Incomplete municipal footprints for southern campus housing')
    terrain,surface=[np.load(survey.CACHE/('horizon-heights-'+kind+'.npy')) for kind in ('dtm','dsm')]
    datum=ndimage.gaussian_filter(geo.lidar_surfaces()[0],1.2).min()-4
    outlines=[Polygon(np.reshape(r,(-1,2)),[np.reshape(h,(-1,2)) for h in hs]).buffer(0) for r,hs,*_ in region['blocks']]
    spatial=STRtree(outlines)
    housing=[]
    for feature in parcels:
        oid=feature['properties']['OBJECTID']
        footprint=transform(shape(feature['geometry']),lambda lon,lat:geo.to_grid(lat,lon),interleaved=False).buffer(0).simplify(.14,preserve_topology=True)
        candidates=spatial.query(footprint,predicate='intersects')
        matches=[int(i) for i in candidates if outlines[i].intersection(footprint).area>30]
        x0,z0,x1,z1=footprint.bounds
        x,z=np.meshgrid(np.arange(x0,x1,1),np.arange(z0,z1,1))
        inside=contains_xy(footprint,x,z);x,z=x[inside],z[inside]
        u=(x-survey.X0+1350)/(survey.X1-survey.X0+2700)*(terrain.shape[1]-1)
        v=(z-survey.Z0+1350)/(survey.Z1-survey.Z0+2700)*(terrain.shape[0]-1)
        floor=ndimage.map_coordinates(terrain,[v,u],order=1,mode='nearest')
        heights=ndimage.map_coordinates(surface,[v,u],order=1,mode='nearest')-floor
        ring=survey.ring_data(footprint.exterior)
        base=round(float(np.median(floor)-datum),2)
        height=round(float(np.percentile(heights,65)),2)
        block=[ring,[],base,height,[109,102,95],'']
        existing=max(matches,key=lambda i:outlines[i].intersection(footprint).area) if matches else None
        if existing is not None:
            region['blocks'][existing]=block
        hip=hip_roof(footprint,height)
        housing.append(dict(way=SITES[oid],objectId=oid,index=existing,block=block,hip=hip))
    region['southernHousing']=housing
