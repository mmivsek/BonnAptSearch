#!/usr/bin/env python3
"""Build data/pois.json from OpenStreetMap via the Overpass API.

Categories: discount stores, other supermarkets, gyms, pharmacies and
Stadtbahn/tram stops. Gym prices are NOT added here: the web app matches gyms
against data/gym_prices.json at load time, so price edits need no rebuild.

Usage: python3 scripts/build_pois.py
Stdlib only, so it runs as-is in GitHub Actions.
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


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=240) as r:
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
    out = {k: [] for k in ("discounter", "supermarket", "gym", "pharmacy", "tram")}
    seen_tram = set()
    for el in fetch():
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
           "source": "© OpenStreetMap contributors (ODbL), via Overpass API",
           "bbox": BBOX, "categories": out}
    with open(os.path.join(ROOT, "data", "pois.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))
    print({k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
