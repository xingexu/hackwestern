"""Passenger-car routes in the campus OSM extract. World X is east, Z is south."""
import heapq
import math
from collections import defaultdict
from functools import lru_cache

import numpy as np
from scipy.ndimage import gaussian_filter1d
import shapely
from shapely.geometry import Polygon


@lru_cache(maxsize=1)
def surveyed_streets():
    from city_streets import survey
    pavement=shapely.union_all([Polygon(np.reshape(s,(-1,2)),[np.reshape(h,(-1,2)) for h in holes]) for s,*holes in survey()])
    shapely.prepare(pavement)
    return pavement


def surveyed_offsets(axis, right, nominal):
    # OSM centre lines can run through a splitter island. Locate the right-hand
    # carriageway between the city's surveyed kerbs, not through its median.
    spans=np.arange(-14,14.01,.5)
    samples=axis[:,None,:]+spans[None,:,None]*right
    on_road=shapely.contains_xy(surveyed_streets(),samples[:,:,0],samples[:,:,1])
    result=np.full(len(axis),nominal,dtype=float)
    for i,row in enumerate(on_road):
        ends=np.flatnonzero(np.diff(np.r_[False,row,False]))
        lanes=[(spans[a],spans[b-1]) for a,b in zip(ends[::2],ends[1::2]) if spans[b-1]-spans[a]>=2.5]
        candidates=[(l,r) for l,r in lanes if l<=nominal+5 and r>=nominal-5]
        if not candidates: continue
        l,r=min(candidates,key=lambda s:(max(0,s[0]-nominal,nominal-s[1]),-s[0]))
        if nominal and len(candidates)>1 and candidates[-1][0]<nominal+3.5: l,r=candidates[-1]
        # At a junction stay on the OSM trajectory rather than following a side street.
        if r-l>18: continue
        divided=len(lanes)>1 and nominal and l>-3 and any(b<l and l-b<7 for a,b in lanes)
        goal=(l+r)/2 if divided or not nominal else (l+3*r)/4
        result[i]=np.clip(goal,l+1.2,r-1.2)
    return result


def direction(tags):
    value = tags.get("oneway:motorcar", tags.get("oneway", "yes" if tags.get("junction") == "roundabout" else "no"))
    return -1 if value == "-1" else int(value in ("yes", "true", "1"))


def accessible(tags):
    access = next((tags[k] for k in ("motorcar", "motor_vehicle", "vehicle", "access") if k in tags), "yes")
    return access in ("yes", "permissive", "designated", "official")


def lane_offset(width, one_way):
    return 0 if one_way else max(0, min(width * .25, width * .5 - 1.2, 3.2))


def driving_line(points, offsets, closed):
    # Offset each directed segment BEFORE rounding the corner. A northbound lane is east of its median.
    parts = []
    for a, b, offset in zip(points, points[1:], offsets):
        delta = b - a
        length = np.linalg.norm(delta)
        if length < .02:
            continue
        right = np.array([-delta[1], delta[0]]) / length
        axis=np.linspace(a,b,math.ceil(length/.5),endpoint=False)
        parts.append(axis+surveyed_offsets(axis,right,offset)[:,None]*right)
    line = np.vstack(parts)
    if not closed:
        line = np.vstack((line, points[-1] + parts[-1][-1]-axis[-1]))
    rounded = gaussian_filter1d(line, 8, axis=0, mode="wrap" if closed else "nearest")
    return np.vstack((rounded, rounded[0])) if closed else rounded


class CarNetwork:
    def __init__(self, elements, nodes, roads):
        self.edges = defaultdict(list)
        self.rules = defaultdict(list)
        self.via_ways = []
        for way, tags, ids, _, name in roads:
            if not accessible(tags):
                continue
            order = direction(tags)
            for a, b in zip(ids, ids[1:]):
                length = math.dist(nodes[a], nodes[b])
                if a == b or length < .02:
                    continue
                if order >= 0:
                    self.edges[a].append((b, way["id"], length, name))
                if order <= 0:
                    self.edges[b].append((a, way["id"], length, name))
        for e in elements:
            t = e.get("tags", {})
            if e.get("type") != "relation" or t.get("type") != "restriction" or {"motorcar","motor_vehicle","vehicle"} & set(t.get("except", "").split(";")):
                continue
            rule = t.get("restriction:motorcar", t.get("restriction:motor_vehicle", t.get("restriction", "")))
            if not rule.startswith(("no_", "only_")):
                continue
            members = e.get("members", [])
            vias = [m for m in members if m["role"] == "via"]
            for start in [m["ref"] for m in members if m["role"] == "from"]:
                for end in [m["ref"] for m in members if m["role"] == "to"]:
                    if len(vias) == 1 and vias[0]["type"] == "node":
                        self.rules[vias[0]["ref"], start].append((rule, end))
                    elif vias and all(m["type"]=="way" for m in vias):
                        self.via_ways.append((rule, (start, *(m["ref"] for m in vias)), end))
        self.memory = max((len(prefix) for _,prefix,_ in self.via_ways),default=1)

    def allowed(self, node, incoming, outgoing):
        rules = self.rules.get((node, incoming[-1] if incoming else None), ())
        if incoming and incoming[-1]!=outgoing:
            rules = [*rules,*((rule,end) for rule,prefix,end in self.via_ways if incoming[-len(prefix):]==prefix)]
        only = {w for rule, w in rules if rule.startswith("only_")}
        return (not only or outgoing in only) and not any(
            rule.startswith("no_") and w == outgoing for rule, w in rules)

    def path(self, anchors, preferred):
        legs = []
        history = ()
        for a, b in zip(anchors, anchors[1:] + anchors[:1]):
            start = (a, history)
            queue, costs, parents = [(0, start)], {start: 0}, {}
            while queue:
                cost, state = heapq.heappop(queue)
                node, incoming = state
                if costs[state] != cost:
                    continue
                if node == b:
                    break
                for nxt, way, length, name in self.edges[node]:
                    if not self.allowed(node, incoming, way):
                        continue
                    key = (nxt, incoming if incoming and incoming[-1]==way else (*incoming,way)[-self.memory:])
                    score = cost + length * (1 if name in preferred else 15)
                    if score < costs.get(key, math.inf):
                        costs[key], parents[key] = score, state
                        heapq.heappush(queue, (score, key))
            else:
                raise ValueError(f"No car route from {a} to {b}")
            leg = []
            history = state[1]
            while state != start:
                prev = parents[state]
                leg.append((prev[0], state[0], state[1][-1]))
                state = prev
            legs.extend(reversed(leg))
        if len({a for a, _, _ in legs}) != len(legs):
            raise ValueError(f"Circuit retraces a road at {anchors}")
        for node, _, way in legs:
            if not self.allowed(node,history,way):
                raise ValueError(f"Restricted turn at {node}")
            if history[-1:]!=(way,):
                history=(*history,way)[-self.memory:]
        return legs
