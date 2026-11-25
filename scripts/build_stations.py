#!/usr/bin/env python3
"""Build data/stations.json: rail stations around Bonn and their *direct*
(no-transfer) train connections to Köln, Düsseldorf and the airport.

Inputs are the free German GTFS feeds from gtfs.de (data by DELFI e.V., CC BY 4.0):
  regional rail  https://download.gtfs.de/germany/rv_free/latest.zip
  long distance  https://download.gtfs.de/germany/fv_free/latest.zip

Usage:
  python3 scripts/build_stations.py <gtfs-dir> [<gtfs-dir> ...] [--day YYYYMMDD]

Without --day the script picks, per feed, the Tuesday on which the most trains
serve the Bonn area. Feeds often begin during temporary construction closures
(e.g. the right-bank Rhine line), so "busiest local Tuesday" is a good proxy
for the normal timetable.
"""
import collections
import csv
import datetime
import json
import math
import os
import sys

DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
BBOX = (50.62, 6.98, 50.83, 7.25)  # Bonn + Siegburg/Troisdorf/Königswinter (lat, lon, lat, lon)
TARGETS = {
    "koeln": ("Köln Hbf", {"Köln Hbf"}),
    "koeln_deutz": ("Köln Messe/Deutz", {"Köln Messe/Deutz Bf", "Köln Messe/Deutz"}),
    "duesseldorf": ("Düsseldorf Hbf", {"Düsseldorf Hbf"}),
    "airport": ("Köln/Bonn Flughafen", {"Köln/Bonn Flughafen"}),
}
RAIL_TYPES = {"0", "1", "2"} | {str(t) for t in range(100, 120)} | {str(t) for t in range(400, 420)}

args = [a for a in sys.argv[1:]]
forced_day = None
if "--day" in args:
    i = args.index("--day")
    forced_day = datetime.datetime.strptime(args[i + 1], "%Y%m%d").date()
    del args[i:i + 2]
FEEDS = args
if not FEEDS:
    sys.exit(__doc__)


def secs(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def dist_m(a, b):
    dy = (a[0] - b[0]) * 111_320
    dx = (a[1] - b[1]) * 111_320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


def clean(name):
    for suf in (" Bf", " Bahnhof", " (S)"):
        name = name.replace(suf, "")
    return name.replace("Bonn-", "Bonn ").strip()


# Stations merged across feeds by position (within 400 m).
stations = []  # dicts with name, lat, lon, agg


def station_for(name, lat, lon):
    for s in stations:
        if dist_m((s["lat"], s["lon"]), (lat, lon)) < 400:
            if len(clean(name)) < len(s["name"]):
                s["name"] = clean(name)
            return s
    s = {"name": clean(name), "lat": lat, "lon": lon, "departures": 0, "lines": set(),
         "to": {k: {"trips": 0, "fastest": None, "lines": set(), "first": None, "last": None}
                for k in TARGETS}, "days": set(),
         # extra days: trains TO the target on Sat/Sun, and trains BACK from the target
         "wk": collections.defaultdict(lambda: collections.defaultdict(lambda: {"trips": 0, "last": None})),
         "back": collections.defaultdict(lambda: collections.defaultdict(lambda: {"trips": 0, "last": None, "fastest": None}))}
    stations.append(s)
    return s


def process(feed):
    def rows(name):
        with open(os.path.join(feed, name), encoding="utf-8-sig", newline="") as f:
            yield from csv.DictReader(f)

    stops = {r["stop_id"]: r for r in rows("stops.txt")}

    def parent(sid):
        return stops[sid].get("parent_station") or sid

    local, target_of = {}, {}
    for sid, r in stops.items():
        p = parent(sid)
        for key, (_, names) in TARGETS.items():
            if r["stop_name"] in names or stops[p]["stop_name"] in names:
                target_of[p] = key
        pr = stops[p]
        lat, lon = float(pr["stop_lat"]), float(pr["stop_lon"])
        if BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3] and p not in target_of:
            local[p] = (pr["stop_name"], lat, lon)

    routes = {r["route_id"]: r for r in rows("routes.txt")}
    trips = list(rows("trips.txt"))
    rail_trip = {t["trip_id"]: t for t in trips
                 if routes.get(t["route_id"], {}).get("route_type", "2") in RAIL_TYPES}

    # One pass over stop_times, keeping only stops we care about.
    by_trip = collections.defaultdict(list)
    for r in rows("stop_times.txt"):
        tid = r["trip_id"]
        if tid not in rail_trip:
            continue
        p = parent(r["stop_id"])
        if p in local or p in target_of:
            by_trip[tid].append((int(r["stop_sequence"]), p,
                                 r["departure_time"] or r["arrival_time"],
                                 r["arrival_time"] or r["departure_time"],
                                 r.get("pickup_type", ""), r.get("drop_off_type", "")))

    cal = list(rows("calendar.txt"))
    cal_dates = list(rows("calendar_dates.txt")) if os.path.exists(os.path.join(feed, "calendar_dates.txt")) else []

    def active_on(day):
        ds = day.strftime("%Y%m%d")
        act = {r["service_id"] for r in cal
               if r["start_date"] <= ds <= r["end_date"] and r[DAYS[day.weekday()]] == "1"}
        for r in cal_dates:
            if r["date"] == ds:
                (act.add if r["exception_type"] == "1" else act.discard)(r["service_id"])
        return act

    if forced_day:
        day = forced_day
    else:
        local_svc = collections.Counter(
            rail_trip[t]["service_id"] for t, seq in by_trip.items() if any(p in local for _, p, *_ in seq))
        starts = [r["start_date"] for r in cal] + [r["date"] for r in cal_dates]
        ends = [r["end_date"] for r in cal] + [r["date"] for r in cal_dates]
        d0 = datetime.datetime.strptime(min(starts), "%Y%m%d").date()
        d1 = datetime.datetime.strptime(max(ends), "%Y%m%d").date()
        tues = [d0 + datetime.timedelta(days=i) for i in range((d1 - d0).days + 1)
                if (d0 + datetime.timedelta(days=i)).weekday() == 1]
        day = max(tues, key=lambda d: (sum(local_svc[s] for s in active_on(d)), d))
    active = active_on(day)

    for tid, seq in by_trip.items():
        trip = rail_trip[tid]
        if trip["service_id"] not in active:
            continue
        seq.sort()
        rt = routes.get(trip["route_id"], {})
        line = (rt.get("route_short_name") or rt.get("route_long_name") or "?").strip()
        if line[:-1].isdigit() and line.endswith("N"):
            continue  # night-bus replacement services mislabelled as rail
        for i, (_, p, dep, _, pick, _) in enumerate(seq):
            if p not in local or pick == "1":
                continue
            st = station_for(*local[p])
            st["days"].add(day.isoformat())
            st["departures"] += 1
            st["lines"].add(line)
            seen = set()
            for _, q, _, arr, _, drop in seq[i + 1:]:
                k = target_of.get(q)
                if not k or k in seen or drop == "1":
                    continue
                seen.add(k)
                dur = (secs(arr) - secs(dep)) // 60
                t = st["to"][k]
                t["trips"] += 1
                t["lines"].add(line)
                t["fastest"] = dur if t["fastest"] is None else min(t["fastest"], dur)
                hhmm = dep[:5]
                t["first"] = hhmm if t["first"] is None or hhmm < t["first"] else t["first"]
                t["last"] = hhmm if t["last"] is None or hhmm > t["last"] else t["last"]

    # Evening / weekend: Tue (weekday), Fri (Friday night), Sat, Sun of the same week.
    d0 = min(r["start_date"] for r in cal) if cal else day.strftime("%Y%m%d")
    d1 = max([r["end_date"] for r in cal] + [r["date"] for r in cal_dates])
    for key, offset in (("wd", 0), ("fri", 3), ("sat", 4), ("sun", 5)):
        dd = day + datetime.timedelta(days=offset)
        if not (d0 <= dd.strftime("%Y%m%d") <= d1):
            continue
        act = active if offset == 0 else active_on(dd)
        for tid, seq in by_trip.items():
            trip = rail_trip[tid]
            if trip["service_id"] not in act:
                continue
            seq.sort()
            rt = routes.get(trip["route_id"], {})
            line = (rt.get("route_short_name") or "").strip()
            if line[:-1].isdigit() and line.endswith("N"):
                continue
            for i, (_, p, dep, _, pick, _) in enumerate(seq):
                if pick == "1":
                    continue
                if p in local and key in ("sat", "sun"):
                    seen = set()
                    for _, q, _, _, _, drop in seq[i + 1:]:
                        k = target_of.get(q)
                        if k and k not in seen and drop != "1":
                            seen.add(k)
                            w = station_for(*local[p])["wk"][key][k]
                            w["trips"] += 1
                            w["last"] = max(w["last"] or "", dep[:5])
                k = target_of.get(p)
                if k:
                    seen = set()
                    for _, q, _, arr, _, drop in seq[i + 1:]:
                        if q in local and q not in seen and drop != "1":
                            seen.add(q)
                            b = station_for(*local[q])["back"][key][k]
                            b["trips"] += 1
                            b["last"] = max(b["last"] or "", dep[:5])
                            dur = (secs(arr) - secs(dep)) // 60
                            b["fastest"] = dur if b["fastest"] is None else min(b["fastest"], dur)
    return day


days = [process(f) for f in FEEDS]

out = []
for s in stations:
    if s["departures"] == 0:
        continue
    direct = {k: {"label": TARGETS[k][0], "trips_per_day": t["trips"], "fastest_min": t["fastest"],
                  "lines": sorted(t["lines"]), "first": t["first"], "last": t["last"]}
              for k, t in s["to"].items() if t["trips"]}
    for k in direct:
        for key in ("sat", "sun"):
            w = s["wk"].get(key, {}).get(k)
            direct[k][key] = {"trips": w["trips"], "last": w["last"]} if w else {"trips": 0, "last": None}
        direct[k]["back"] = {key: dict(s["back"][key][k]) for key in ("wd", "fri", "sat", "sun")
                             if key in s["back"] and k in s["back"][key]}
    out.append({"name": s["name"], "lat": round(s["lat"], 6), "lon": round(s["lon"], 6),
                "departures_per_day": s["departures"], "lines": sorted(s["lines"]), "direct": direct})
out.sort(key=lambda s: -s["departures_per_day"])

res = {
    "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
    "sample_days": sorted({d.isoformat() for d in days}),
    "source": "gtfs.de (regional + long-distance), data by DELFI e.V., CC BY 4.0",
    "note": "trips_per_day/first/last: Tuesday, trains FROM the station TO the target. sat/sun: same on the weekend. back.*: trains FROM the target TO the station (wd=Tue, fri=Friday incl. after midnight, sat, sun); times after midnight are shown as 24:xx/25:xx.",
    "stations": out,
}
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "stations.json")
with open(dst, "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
print(f"{len(out)} stations; sample days {res['sample_days']}")
for s in out:
    print(f'{s["name"]:36} dep={s["departures_per_day"]:4} {",".join(s["lines"]):40} '
          + "  ".join(f'{k}:{v["trips_per_day"]}x/{v["fastest_min"]}m' for k, v in s["direct"].items()))
