#!/usr/bin/env python3
"""Build data/pois.json from OpenStreetMap.

Categories: discount stores, other supermarkets, gyms, pharmacies and
Stadtbahn/tram stops. Gym prices are NOT added here: the web app matches gyms
against data/gym_prices.json at load time, so price edits need no rebuild.

Usage:
  python3 scripts/build_pois.py --pbf koeln-regbez-latest.osm.pbf   # Geofabrik extract (needs: pip install osmium)
  python3 scripts/build_pois.py                                     # Overpass API (stdlib only)

The GitHub Action uses the Geofabrik extract: it is updated daily and, unlike
the shared Overpass servers, does not time out or rate-limit.
"""
import datetime
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
BBOX = "50.62,6.98,50.83,7.25"  # south,west,north,east: Bonn + surroundings
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
QUERY = f"""
[out:json][timeout:180][bbox:{BBOX}];
(
  nwr["shop"~"^(supermarket|discount)$"];
  nwr["leisure"="fitness_centre"];
  nwr["amenity"="gym"];
  nwr["leisure"="sports_centre"]["sport"~"fitness"];
  nwr["amenity"="pharmacy"];
  node["railway"="tram_stop"];
  node["railway"="station"]["station"~"^(light_rail|subway)$"];
  node["railway"="halt"]["station"~"^(light_rail|subway)$"];
);
out center tags;
"""
DISCOUNTERS = re.compile(r"\b(aldi|lidl|penny|netto|norma)\b", re.I)
UA = "BonnAptSearch/1.0 (personal apartment-search map; github.com/mmivsek/bonnaptsearch)"


def wanted(t, is_node):
    """Same selection as QUERY, for elements read from a .pbf file."""
    if t.get("shop") in ("supermarket", "discount"):
        return True
    if t.get("leisure") == "fitness_centre" or t.get("amenity") in ("gym", "pharmacy"):
        return True
    if t.get("leisure") == "sports_centre" and "fitness" in t.get("sport", ""):
        return True
    if is_node and (t.get("railway") == "tram_stop" or
                    (t.get("railway") in ("station", "halt") and t.get("station") in ("light_rail", "subway"))):
        return True
    return False


def read_pbf(path):
    import osmium  # pip install osmium

    s, w, n, e = map(float, BBOX.split(","))
    out = []

    class H(osmium.SimpleHandler):
        def node(self, o):
            t = dict(o.tags)
            if t and wanted(t, True) and o.location.valid():
                lat, lon = o.location.lat, o.location.lon
                if s <= lat <= n and w <= lon <= e:
                    out.append({"type": "node", "id": o.id, "lat": lat, "lon": lon, "tags": t})

        def way(self, o):
            t = dict(o.tags)
            if not t or not wanted(t, False):
                return
            pts = [(nd.lat, nd.lon) for nd in o.nodes if nd.location.valid()]
            if not pts:
                return
            lat = sum(p[0] for p in pts) / len(pts)
            lon = sum(p[1] for p in pts) / len(pts)
            if s <= lat <= n and w <= lon <= e:
                out.append({"type": "way", "id": o.id, "center": {"lat": lat, "lon": lon}, "tags": t})

    H().apply_file(path, locations=True)
    print(f"read {len(out)} elements from {path}")
    return out


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for attempt in range(2):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = json.load(r)
                print(f"fetched {len(data['elements'])} elements from {url}")
                return data["elements"]
            except Exception as e:  # noqa: BLE001 - try the next mirror
                last = e
                print(f"  {url} failed: {e}", file=sys.stderr)
        time.sleep(20 * (attempt + 1))
    raise SystemExit(f"all Overpass endpoints failed: {last}")


def address(t):
    street = " ".join(x for x in (t.get("addr:street"), t.get("addr:housenumber")) if x)
    city = " ".join(x for x in (t.get("addr:postcode"), t.get("addr:city")) if x)
    return ", ".join(x for x in (street, city) if x) or None


def category(t):
    if t.get("shop") in ("supermarket", "discount"):
        label = " ".join(filter(None, (t.get("brand"), t.get("name"))))
        return "discounter" if DISCOUNTERS.search(label) or t.get("shop") == "discount" else "supermarket"
    if t.get("amenity") == "pharmacy":
        return "pharmacy"
    if t.get("railway") in ("tram_stop", "station", "halt"):
        return "tram"
    return "gym"


def main():
    if "--pbf" in sys.argv:
        elements = read_pbf(sys.argv[sys.argv.index("--pbf") + 1])
        source = "© OpenStreetMap contributors (ODbL), Geofabrik extract"
    else:
        elements = fetch()
        source = "© OpenStreetMap contributors (ODbL), via Overpass API"

    out = {k: [] for k in ("discounter", "supermarket", "gym", "pharmacy", "tram")}
    seen_tram = set()
    for el in elements:
        t = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None:
            continue
        cat = category(t)
        name = t.get("name") or t.get("brand")
        if not name:
            if cat in ("tram", "gym"):
                continue
            name = {"discounter": "Discounter", "supermarket": "Supermarket", "pharmacy": "Apotheke"}[cat]
        if t.get("disused") or t.get("shop") == "vacant":
            continue
        if cat == "tram":
            key = (name, round(lat, 3), round(lon, 3))  # one marker per stop, not per platform
            if key in seen_tram:
                continue
            seen_tram.add(key)
        p = {"name": name, "lat": round(lat, 6), "lon": round(lon, 6),
             "osm": f"https://www.openstreetmap.org/{el['type']}/{el['id']}"}
        for src, dst in (("brand", "brand"), ("opening_hours", "hours"),
                         ("website", "website"), ("contact:website", "website"), ("phone", "phone")):
            if t.get(src) and dst not in p:
                p[dst] = t[src]
        if address(t):
            p["address"] = address(t)
        out[cat].append(p)

    for v in out.values():
        v.sort(key=lambda p: p["name"])
    res = {"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "source": source,
           "bbox": BBOX, "categories": out}
    with open(os.path.join(ROOT, "data", "pois.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))
    print({k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
