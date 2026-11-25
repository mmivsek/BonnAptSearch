# Bonn Apartment Map

A small web map for apartment hunting in Bonn. Add an apartment address and it shows:

- **Walking areas** (5 / 10 / 15 min) around the apartment
- Real walking time to the nearest **discounter** (Aldi, Lidl, Penny, Netto, Norma), **gym** (with approx. monthly price), **pharmacy**, **Stadtbahn stop**
- The nearest **train station with direct trains to Köln / Düsseldorf**, with trains per day and fastest travel time
- **Commute to work** by public transport (arrive by 09:00 on a weekday), bike and on foot
- A 0–100 **score** weighted by your priorities, and a **compare table** of all saved apartments

Toggle map layers for discounters, other supermarkets, gyms, train stations, Stadtbahn/tram stops and pharmacies.
Every place links to its website, Google Maps (ratings/reviews) and OpenStreetMap.

Apartments are saved in your browser (localStorage). Use *⋯ → Export/Import* to move them between devices.

## How it works

Static site (plain HTML/JS + [Leaflet](https://leafletjs.com)), no build step, no API keys.

| What | Source | When |
|---|---|---|
| Shops, gyms, pharmacies, tram stops | OpenStreetMap via Overpass → `data/pois.json` | weekly (GitHub Action) |
| Stations + direct trains | [gtfs.de](https://gtfs.de) regional + long-distance GTFS (DELFI) → `data/stations.json` | weekly (GitHub Action) |
| Gym prices | hand-curated `data/gym_prices.json` | edit any time |
| Address search | [Photon](https://photon.komoot.io) | live |
| Walking areas, walking/bike times | [FOSSGIS Valhalla](https://valhalla1.openstreetmap.de) | live |
| Public transport journeys | [Transitous](https://transitous.org) | live |

### Update data locally

```bash
python3 scripts/build_pois.py                      # needs access to overpass-api.de
python3 scripts/build_stations.py <rv-gtfs-dir> <fv-gtfs-dir>
python3 -m http.server 8000                        # open http://localhost:8000
```

### Gym prices

OSM has no prices, so `data/gym_prices.json` maps gym chains (regex on name/brand) to their cheapest advertised plan.
The values come from comparison portals (Nov 2026) and are approximate: always verify on the gym's site.

## Ideas / next steps

- Rent levels per district (Bonn Mietspiegel 2026)
- Heatmap: which neighbourhoods score best for your priorities
- More POI categories (bakery, doctor, park, Rhine promenade)
