# Bonn Apartment Map

A web map for apartment hunting in Bonn. Add an apartment and see what's in walking distance, how long the commute is, and whether the rent is fair.

## Features

**Per apartment**
- Walking areas (5 / 10 / 15 min) and real walking times to the nearest discounter, gym (with approx. price), train station with direct trains to Köln/Düsseldorf, Stadtbahn stop, supermarket and pharmacy
- *More nearby*: bakery, family doctor, park, Packstation/post office, kiosk
- Commute to work by public transport (arrive by 09:00 on a weekday), bike and on foot; tap a line in the journey to see it on the map
- Evening/weekend: last direct train back from Köln, weekend frequency, and the connection home from Köln Hbf after 00:30 on a Friday night
- Rent check: cold €/m² vs. typical asking rents in the Stadtteil (below typical / typical / above typical)
- A 0–100 score weighted by your priorities (⋯ → Settings), and a compare table

**Map**
- Layers: discounters (filter by chain), gyms (studios hidden by default, filter by known price / max price), train stations, supermarkets, Stadtbahn stops, pharmacies, bakeries, family doctors, parks, Packstation & post, kiosks
- Transport lines: trains/S-Bahn/Stadtbahn and buses; tap a line to highlight it with its stops
- Neighbourhood heatmap: Bonn coloured by your priorities, to see which districts to search in

**Quick add from a listing**
- *📋 Paste listing text*: copy the ad text from ImmoScout24, Kleinanzeigen, Immowelt or WG-Gesucht and paste it; address, cold/warm rent, m², rooms and availability are filled in.
- *Screenshot → Claude → link*: send a listing screenshot to Claude (Claude Code on this repo, or a Claude Project set up with [docs/claude-project-instructions.md](docs/claude-project-instructions.md)); it replies with a link like `…/#add?addr=…&cold=750&size=58` that opens the pre-filled form. `scripts/add_link.py` builds such links.

**Sync** between laptop and phone through a secret GitHub Gist (⋯ → Sync between devices). Without it, apartments stay in the browser; ⋯ → Export/Import also works.

## Data

| What | Source | Updated |
|---|---|---|
| Shops, gyms, doctors, parks, stops, … | OpenStreetMap (Geofabrik extract) → `data/pois.json` | weekly (GitHub Action) |
| Transport lines | OpenStreetMap route relations → `data/lines_rail.json`, `data/lines_bus.json` | weekly |
| Stations + direct trains, weekend, last trains | [gtfs.de](https://gtfs.de) regional + long-distance GTFS (DELFI) → `data/stations.json` | weekly |
| Gym prices | hand-curated `data/gym_prices.json` | by hand |
| Typical asking rents | hand-curated `data/rents.json` | by hand |
| Address search | [Photon](https://photon.komoot.io), fallback Nominatim | live |
| Walking areas / walking & bike times | [FOSSGIS Valhalla](https://valhalla1.openstreetmap.de) | live |
| Public transport journeys, heatmap commute | [Transitous](https://transitous.org) | live |

Missing or wrong place? Fix it on [openstreetmap.org](https://www.openstreetmap.org); the map picks it up after the next weekly refresh.

## Updating gym prices

OSM has no prices. `data/gym_prices.json` maps gym chains to their cheapest plan:

```json
{"chain": "FitX", "match": "fit ?x", "monthly_eur": 29.0, "joining_fee_eur": 29.0,
 "min_term_months": 12, "website": "https://www.fitx.de", "note": "…", "source": "https://…", "checked": "2026-11"}
```

- `match` is a case-insensitive regular expression tested against the gym's brand + name.
- When you check a price, update `monthly_eur` and `checked`. Edit the file directly on GitHub (pencil icon); the site updates in about a minute, no rebuild needed.
- To add a gym, copy an entry and change `chain`, `match` and the prices.

## Updating rents

`data/rents.json` holds typical asking rents (Kaltmiete €/m²) per Stadtteil from several portals. Area names must match the OSM Stadtteil name (as shown in the app, e.g. "Beuel-Mitte"). Add values as `{"v": 13.5, "s": "is24"}`.

## Development

Static site, no build step, no API keys.

```bash
python3 -m http.server 8000                                  # open http://localhost:8000
pip install osmium
python3 scripts/build_pois.py --pbf koeln-regbez-latest.osm.pbf
python3 scripts/build_lines.py koeln-regbez-latest.osm.pbf
python3 scripts/build_stations.py <rv-gtfs-dir> <fv-gtfs-dir>
```

The workflow `.github/workflows/refresh-data.yml` runs these every Monday and commits the results.
