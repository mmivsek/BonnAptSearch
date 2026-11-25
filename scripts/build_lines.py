#!/usr/bin/env python3
"""Build data/lines_rail.json and data/lines_bus.json: public-transport lines
(train, S-Bahn, Stadtbahn/tram, bus) around Bonn with their route geometry and
stops, from OpenStreetMap route relations.

Usage: python3 scripts/build_lines.py <extract.osm.pbf>      (pip install osmium)
"""
import collections
import datetime
import json
import os
import sys

import osmium

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
# Lines are kept if they touch the core box, and drawn within the wider box.
CORE = (50.64, 7.02, 50.80, 7.22)      # south, west, north, east (Bonn)
CLIP = (50.55, 6.90, 50.90, 7.35)
MODES = {"train": "train", "light_rail": "tram", "tram": "tram", "subway": "tram", "bus": "bus", "trolleybus": "bus"}
DEFAULT_COLOUR = {"train": "#12355e", "tram": "#c4121a", "bus": "#7a5c00"}
SIMPLIFY = 0.00006  # degrees (~5 m)


def inside(box, lat, lon):
    return box[0] <= lat <= box[2] and box[1] <= lon <= box[3]


class Relations(osmium.SimpleHandler):
    """Pass 1: route relations, their ways and stop nodes."""

    def __init__(self):
        super().__init__()
        self.rels = []
        self.way_ids = set()
        self.node_ids = set()

    def relation(self, r):
        t = r.tags
        if t.get("type") != "route" or t.get("route") not in MODES:
            return
        ways, stops = [], []
        for m in r.members:
            if m.type == "w" and not m.role.startswith("platform"):
                ways.append(m.ref)
            elif m.type == "n" and (m.role.startswith("stop") or m.role.startswith("platform")):
                stops.append((m.ref, m.role.startswith("stop")))
        if not ways:
            return
        self.rels.append({
            "id": r.id, "mode": MODES[t["route"]], "ref": t.get("ref") or t.get("name", "?"),
            "name": t.get("name", ""), "from": t.get("from", ""), "to": t.get("to", ""),
            "colour": t.get("colour", ""), "operator": t.get("operator", ""), "network": t.get("network", ""),
            "ways": ways, "stops": stops,
        })
        self.way_ids.update(ways)
        self.node_ids.update(s for s, _ in stops)


class Geometry(osmium.SimpleHandler):
    """Pass 2: coordinates of the needed ways and stop nodes."""

    def __init__(self, way_ids, node_ids):
        super().__init__()
        self.way_ids, self.node_ids = way_ids, node_ids
        self.ways, self.nodes = {}, {}

    def node(self, n):
        if n.id in self.node_ids and n.location.valid():
            self.nodes[n.id] = (round(n.location.lat, 5), round(n.location.lon, 5), n.tags.get("name", ""))

    def way(self, w):
        if w.id in self.way_ids:
            pts = [(nd.lat, nd.lon) for nd in w.nodes if nd.location.valid()]
            if len(pts) >= 2:
                self.ways[w.id] = pts


def simplify(pts, tol):
    """Douglas-Peucker on (lat, lon) tuples."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (y1, x1), (y2, x2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, idx = 0.0, None
        for i in range(a + 1, b):
            y, x = pts[i]
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def merge_chains(segs):
    """Join segments that share endpoints into longer polylines."""
    segs = [list(s) for s in segs]
    merged = True
    while merged:
        merged = False
        ends = collections.defaultdict(list)
        for i, s in enumerate(segs):
            ends[s[0]].append(i)
            ends[s[-1]].append(i)
        used = set()
        out = []
        for i, s in enumerate(segs):
            if i in used:
                continue
            used.add(i)
            cur = s
            grown = True
            while grown:
                grown = False
                for end, at_start in ((cur[-1], False), (cur[0], True)):
                    cand = [j for j in ends[end] if j not in used]
                    if len(ends[end]) == 2 and cand:  # simple joint only, not junctions
                        j = cand[0]
                        o = segs[j]
                        used.add(j)
                        if not at_start:
                            cur = cur + (o[1:] if o[0] == end else o[::-1][1:])
                        else:
                            cur = (o[:-1] if o[-1] == end else o[::-1][:-1]) + cur
                        grown = merged = True
                        break
            out.append(cur)
        segs = out
    return segs


def main(pbf):
    rel = Relations()
    rel.apply_file(pbf)
    geo = Geometry(rel.way_ids, rel.node_ids)
    geo.apply_file(pbf, locations=True)
    print(f"{len(rel.rels)} route relations, {len(geo.ways)} ways, {len(geo.nodes)} stop nodes")

    # Group route variants (both directions, branches) by mode + ref.
    groups = collections.OrderedDict()
    for r in rel.rels:
        pts = [p for w in r["ways"] for p in geo.ways.get(w, [])]
        if not any(inside(CORE, *p) for p in pts):
            continue
        key = (r["mode"], r["ref"].strip())
        g = groups.setdefault(key, {"mode": r["mode"], "ref": r["ref"].strip(), "names": [], "ways": set(),
                                    "stops": collections.OrderedDict(), "colour": "", "operator": r["operator"],
                                    "osm": []})
        g["names"].append(r["name"] or f'{r["from"]} → {r["to"]}')
        g["osm"].append(r["id"])
        g["colour"] = g["colour"] or r["colour"]
        g["ways"].update(r["ways"])
        for nid, is_stop in r["stops"]:
            n = geo.nodes.get(nid)
            if n and n[2] and inside(CLIP, n[0], n[1]):
                # one marker per stop name (stop positions and platforms collapse)
                g["stops"].setdefault(n[2], (n[0], n[1]))

    out = {"rail": [], "bus": []}
    for (mode, ref), g in groups.items():
        segs = []
        for w in g["ways"]:
            pts = [p for p in geo.ways.get(w, []) if inside(CLIP, *p)]
            if len(pts) >= 2:
                segs.append(tuple((round(a, 5), round(b, 5)) for a, b in pts))
        segs = [simplify(s, SIMPLIFY) for s in merge_chains(list(dict.fromkeys(segs)))]
        if not segs:
            continue
        names = sorted(set(g["names"]), key=len)
        line = {
            "id": f"{mode}:{ref}", "mode": mode, "ref": ref, "name": names[0] if names else ref,
            "variants": names[:4],
            "colour": g["colour"] or DEFAULT_COLOUR[mode], "operator": g["operator"],
            "stops": [[lat, lon, name] for name, (lat, lon) in g["stops"].items()],
            "segs": [[[a, b] for a, b in s] for s in segs],
            "osm": g["osm"][:3],
        }
        out["bus" if mode == "bus" else "rail"].append(line)

    def sort_key(l):
        num = "".join(ch for ch in l["ref"] if ch.isdigit())
        return ({"train": 0, "tram": 1, "bus": 2}[l["mode"]], int(num) if num else 9999, l["ref"])

    meta = {"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "source": "© OpenStreetMap contributors (ODbL), route relations"}
    for kind, lines in out.items():
        lines.sort(key=sort_key)
        with open(os.path.join(ROOT, "data", f"lines_{kind}.json"), "w", encoding="utf-8") as f:
            json.dump({**meta, "lines": lines}, f, ensure_ascii=False, separators=(",", ":"))
        size = os.path.getsize(os.path.join(ROOT, "data", f"lines_{kind}.json"))
        print(f"{kind}: {len(lines)} lines, {size / 1024:.0f} KB:", ", ".join(l["ref"] for l in lines))


if __name__ == "__main__":
    main(sys.argv[1])
