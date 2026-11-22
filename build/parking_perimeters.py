import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import LineString,Point,Polygon

from building_access import polygon
from campus_bounds import footprint
from city_streets import solid_ground_floors
from ground_observations import orthophoto
from parcel_surfaces import municipal_lines


def photographed_paving(extension):
    if extension.area<20:
        return False
    left,top,right,bottom=extension.bounds
    width=max(2,round((right-left)*2))
    height=max(2,round((bottom-top)*2))
    grid=Affine.translation(left,top)*Affine.scale((right-left)/width,(bottom-top)/height)
    mask=rasterize([extension],out_shape=(height,width),transform=grid,dtype='uint8').astype(bool)
    if not mask.any():
        return False
    photograph=orthophoto(extension.bounds,(width,height))
    red,green,blue=np.asarray(photograph,dtype=np.float32)[mask].T
    paving=(red-green<15)&(green-red<7)&(green-blue<30)&(red-blue<40)&(green>125)
    return np.count_nonzero(paving)>=max(22,mask.sum()*.25)


def surveyed_perimeters(network):
    mapped=shapely.union_all([polygon(area['rings']) for area in network['areas'] if area['kind']=='parking'])
    site=footprint()
    rims=[line for feature in municipal_lines('parking',site) for line in shapely.get_parts(feature)]
    islands=[Polygon(line.coords) for line in rims if line.is_closed and line.length>3]
    protected=[island for island in islands if island.is_valid]
    protected.extend(solid_ground_floors(network))
    protected.extend(polygon(area['rings']) for area in network['areas'] if area['kind'] not in ('parking','road'))
    protected.extend(polygon(rings) for rings in network['water'])
    exclusions=shapely.STRtree(protected)
    aprons=[]
    for line in rims:
        if len(line.coords)<4 or line.length<40:
            continue
        start,end=line.coords[0],line.coords[-1]
        opening=Point(start).distance(Point(end))
        if opening>min(68,line.length*.39):
            continue
        for boundary in shapely.get_parts(shapely.make_valid(Polygon(line.coords))):
            if boundary.geom_type!='Polygon' or not 65<boundary.area<120000:
                continue
            if mapped.intersection(boundary).area<boundary.area*.40:
                continue
            candidates=exclusions.geometries[exclusions.query(boundary)]
            holes=[feature for feature in candidates if not feature.equals(boundary)]
            apron=boundary.difference(shapely.union_all(holes)).intersection(site)
            if opening>.5:
                apron=apron.difference(LineString([start,end]).buffer(3))
            apron=apron.intersection(line.buffer(16))
            if photographed_paving(apron.difference(mapped)):
                aprons.extend(part for part in shapely.get_parts(apron) if part.geom_type=='Polygon' and part.area>=25)
    return aprons
