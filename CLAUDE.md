# Bonn Apartment Map

Static web app (plain HTML/JS + Leaflet, no build step) for comparing apartments in Bonn.
Served by GitHub Pages from this branch: https://mmivsek.github.io/BonnAptSearch/
See README.md for features and data sources.

## Adding an apartment from a screenshot or listing text

When the user sends a screenshot, the text of a listing (ImmoScout24, Kleinanzeigen, Immowelt, WG-Gesucht …),
or asks to "add this apartment":

1. Read from it: address, Kaltmiete (cold rent), Warmmiete/Gesamtmiete (warm rent), Wohnfläche (m²),
   Zimmer (rooms), availability date (Bezugsfrei ab / frei ab / verfügbar ab), the listing URL if visible,
   and a few short notes worth keeping (floor, balcony, Kaution, EBK, pets …).
   - If only warm rent and Nebenkosten are given, cold = warm − Nebenkosten (− Heizkosten if listed separately).
   - If the street is hidden (ImmoScout: "Die vollständige Adresse … vom Anbieter"), use what is shown,
     e.g. "Beuel-Mitte, 53225 Bonn", and pass `--approx`.
   - Never guess numbers that are not in the listing; leave them out.
2. Build the link with the script (do not hand-encode it):
   ```bash
   python3 scripts/add_link.py --addr "Kaiserstraße 20, 53113 Bonn" --label "Südstadt 2-Zi Balkon" \
     --cold 750 --warm 900 --size 58 --rooms 2 --from 01.02.2027 --url "https://…" --notes "3. OG, Balkon"
   ```
3. Reply with a short summary of what you read (so the user can spot mistakes) and the link.
   Opening the link shows the "New apartment" form pre-filled; the user checks it and presses Save.

Do NOT write apartment data into this repository: the repo is public. Apartments live in the user's
browser and their private sync gist, and the link is how they get there.

## Development notes

- Data files in `data/` are rebuilt weekly by `.github/workflows/refresh-data.yml`
  (POIs + transport lines from the Geofabrik OSM extract, stations from gtfs.de GTFS).
  Hand-curated: `data/gym_prices.json`, `data/rents.json`.
- Test locally with `python3 -m http.server 8000`.
- Pushing changes to `scripts/**` or `data/gym_prices.json` triggers the data workflow.
