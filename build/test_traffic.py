"""Regression checks for passenger-car turns and the campus roundabout."""
import json
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, MultiLineString, Polygon
from shapely.ops import linemerge

from traffic import CarNetwork, accessible, direction, surveyed_streets


class RoadRules(unittest.TestCase):
    def test_directed_turns(self):
        self.assertEqual(direction({"junction":"roundabout"}),1)
        self.assertEqual(direction({"oneway":"-1"}),-1)
        self.assertFalse(accessible({"motor_vehicle":"no"}))
        def restriction(rule,start,via,end):
            return {"type":"relation","tags":{"type":"restriction","restriction":rule},
                    "members":[{"type":"way","role":"from","ref":start},
                               {"type":via[0],"role":"via","ref":via[1]},
                               {"type":"way","role":"to","ref":end}]}
        net=CarNetwork([restriction("only_right_turn",1,("node",8),2),
                        restriction("no_left_turn",1,("way",2),3)],{},[])
        self.assertTrue(net.allowed(8,(1,),2))
        self.assertFalse(net.allowed(8,(1,),4))
        self.assertFalse(net.allowed(9,(1,2),3))
        self.assertTrue(net.allowed(9,(4,2),3))

    def test_campus_roundabout(self):
        data=json.loads(Path(__file__).resolve().parents[1].joinpath("web/drive-network.json").read_bytes())
        ways=[w for w in data["ways"] if w.get("roundabout")]
        self.assertTrue(ways and all(w["oneway"] for w in ways))
        segments=[np.asarray(w["points"])[:,[0,2]] for w in ways]
        ring=linemerge(MultiLineString(segments))
        self.assertTrue(ring.is_ring)
        center=Polygon(ring.coords).centroid
        island=next(Polygon(h) for p in surveyed_streets().geoms for h in p.interiors if Polygon(h).contains(center))
        used=set()
        for c in data["circuits"]:
            pts=np.asarray(c["points"])
            self.assertGreater(LineString(pts).distance(island),.9,c["id"])
            r=pts[:-1]-center.coords[0]
            near=np.linalg.norm(r,axis=1)<24
            if near.any():
                used.add(c["id"])
                step=np.diff(pts,axis=0)
                # East/south coordinates: counterclockwise circulation has negative signed area.
                self.assertTrue(np.all((r[:,0]*step[:,1]-r[:,1]*step[:,0])[near]<0),c["id"])
        self.assertEqual(used,{"college","stadium"})


if __name__=="__main__":
    unittest.main()
