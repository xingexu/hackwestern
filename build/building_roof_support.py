import math

from shapely.affinity import rotate, translate
from shapely.geometry import Point, Polygon, box
from shapely.ops import nearest_points, unary_union


def seat_roof_plant(record):
    plates = [(part["high"], Polygon(part["rings"][0], part["rings"][1:]).buffer(0)) for part in record["parts"]]
    adjusted = set()
    for part in record["parts"]:
        for row in part["roof"].get("features", []):
            if id(row) in adjusted:
                continue
            adjusted.add(id(row))
            center = row.get("at", row.get("center"))
            size = row.get("size")
            if not center or not size or row.get("count", 1) != 1 or row["type"] not in ("penthouse", "hvac", "stair-tower", "skylight", "clerestory", "green-roof", "solar-panels"):
                continue
            point = Point(center)
            levels = [h for h, p in plates if p.covers(point)]
            if not levels:
                continue
            h = max(levels)
            roof = unary_union([p for y, p in plates if abs(y-h)<.22]).buffer(.045)
            angle = math.radians(row.get("rotation", 0))
            c, s = math.cos(angle), math.sin(angle)
            w, d = size[:2]
            for scale in (1, .94, .86, .77, .67, .55, .43, .32):
                corners = [(scale*(a*w*c-b*d*s)/2, scale*(a*w*s+b*d*c)/2) for a,b in ((1,1),(-1,1),(-1,-1),(1,-1))]
                shape = Polygon(corners)
                if roof.covers(translate(shape, *center)) and scale == 1:
                    break
                possible = roof
                for dx, dz in corners:
                    possible = possible.intersection(translate(roof, -dx, -dz))
                    if possible.is_empty:
                        break
                if possible.is_empty:
                    continue
                target = nearest_points(possible, point)[0]
                if target.distance(point)>max(2.5,min(w,d)*.8) or not roof.buffer(.002).covers(translate(shape,target.x,target.y)):
                    continue
                row["at"] = [round(target.x, 3), round(target.y, 3)]
                if scale!=1:
                    row["size"] = [round(w*scale,3), round(d*scale,3), *size[2:]]
                break


def measured_plant(record,surface,origin,ortho):
    import numpy as np
    import shapely
    from scipy import ndimage

    if record["spec"].get("lidarTrusted") is False or record["spec"]["style"] in ("house","parking-structure") or record["spec"]["roof"].get("suspension"):
        return
    plates=[Polygon(p["rings"][0],p["rings"][1:]).buffer(0) for p in record["parts"]]
    occupied=[]
    for part in record["parts"]:
        for row in part["roof"].get("features",[]):
            center=row.get("at",row.get("center"))
            if center:
                width,depth=row.get("size",[2,2])[:2]
                pad=rotate(box(-width/2,-depth/2,width/2,depth/2),row.get("rotation",0),origin=(0,0))
                occupied.append(translate(pad,*center).buffer(.65))
    candidates=[]
    ox,oz=origin
    for i,(part,poly) in enumerate(zip(record["parts"],plates)):
        if poly.area<180 or part["roof"]["form"] not in ("flat","lidar") or part.get("absoluteSoffit") is not None:
            continue
        for other,mask in zip(record["parts"],plates):
            if other["high"]>part["high"]+.15:
                poly=poly.difference(mask)
        poly=poly.buffer(-1.5)
        if poly.is_empty or poly.area<90:
            continue
        l,t,r,b=poly.bounds
        x0=max(math.floor(l-ox),0);z0=max(math.floor(t-oz),0)
        x1=min(math.ceil(r-ox)+1,surface.shape[1]);z1=min(math.ceil(b-oz)+1,surface.shape[0])
        if x1<=x0 or z1<=z0:
            continue
        z,x=np.mgrid[z0:z1,x0:x1]
        x=x+ox+.5;z=z+oz+.5
        field=surface[z0:z1,x0:x1]
        valid=np.isfinite(field)&shapely.contains_xy(poly,x,z)
        if np.sum(valid)<32:
            continue
        nearest=ndimage.distance_transform_edt(~valid,return_distances=False,return_indices=True)
        clean=ndimage.median_filter(field[tuple(nearest)],size=3)
        rise=clean-ndimage.grey_opening(clean,size=(9,9))
        units,num=ndimage.label(valid&(rise>.73)&(rise<4.9))
        for label,sl in enumerate(ndimage.find_objects(units),1):
            if sl is None:
                continue
            mask=units[sl]==label
            n=int(mask.sum())
            if n<5 or n>130:
                continue
            xx=x[sl][mask];zz=z[sl][mask]
            footprint=shapely.MultiPoint(np.stack([xx,zz],axis=1)).minimum_rotated_rectangle
            if footprint.geom_type!='Polygon' or footprint.area<1.4:
                continue
            pts=list(footprint.exterior.coords);a,v,c=pts[:3]
            w=math.dist(a,v)+.7;d=math.dist(v,c)+.7
            if max(w,d)/min(w,d)>8 or n/(w*d)<.58 or not poly.covers(footprint):
                continue
            point=footprint.centroid;px,pz=point.coords[0]
            if any(item.intersects(footprint) for item in occupied):
                continue
            height=float(np.median(rise[sl][mask]))
            if np.percentile(clean[sl][mask],85)-np.percentile(clean[sl][mask],15)>1.05:
                continue
            rgb=ortho(px,pz)
            if rgb is None or rgb[1]>rgb[0]*1.12+5 and rgb[1]>rgb[2]*1.25:
                continue
            tx,tz=(v[0]-a[0])/math.dist(a,v),(v[1]-a[1])/math.dist(a,v)
            adjacent=[]
            for along,across in [(w/2+.8,0),(-w/2-.8,0),(0,d/2+.8),(0,-d/2-.8)]:
                qx,qz=px+tx*along-tz*across,pz+tz*along+tx*across
                if poly.covers(Point(qx,qz)):
                    sample=ortho(qx,qz)
                    if sample is not None:adjacent.append(sample)
            if len(adjacent)<2 or np.max(np.abs(np.median(adjacent,axis=0)-rgb))<9:
                continue
            tone='#'+''.join(f'{round(float(np.clip(q,65,195))):02x}' for q in rgb)
            turn=math.degrees(math.atan2(v[1]-a[1],v[0]-a[0]))
            row=dict(type="hvac",at=[round(px,3),round(pz,3)],size=[round(w,2),round(d,2),round(height,2)],rotation=round(turn,2),style="measured roof plant",material=tone)
            if max(w,d)>min(w,d)*2.6:
                row["housing"]="duct"
            else:
                body=np.median([ortho(px+tx*t,pz+tz*t) for t in (-w*.30,w*.30)],axis=0)
                if np.mean(body)-np.mean(rgb)>18 and min(w,d)>2.2:
                    row["housing"]="fan"
            candidates.append((n*height,i,footprint,row))
    limit=max(6,min(24,math.ceil(unary_union(plates).area/350)))
    accepted=0
    for _,i,shape,row in sorted(candidates,key=lambda e:-e[0]):
        if accepted>=limit:
            break
        if any(geom.intersects(shape) for geom in occupied):
            continue
        accepted+=1
        occupied.append(shape.buffer(.5))
        roof=record["parts"][i]["roof"]
        roof["features"]=[*roof.get("features",[]),row]
