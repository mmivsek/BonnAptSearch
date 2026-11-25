#!/usr/bin/env python3
"""Build a link that opens the Bonn Apartment Map with the "New apartment"
form pre-filled. Used by Claude when you send it a listing screenshot.

Example:
  python3 scripts/add_link.py --addr "Kaiserstraße 20, 53113 Bonn" --cold 750 --warm 900 \
      --size 58 --rooms 2 --from 01.02.2027 --url https://www.immobilienscout24.de/expose/123
If the listing hides the street, give what it shows (e.g. "Beuel-Mitte, 53225 Bonn") and --approx.
"""
import argparse
import urllib.parse

BASE = "https://mmivsek.github.io/BonnAptSearch/"

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument("--addr", required=True, help="street + number, postcode, city")
p.add_argument("--label", help="short name, e.g. 'Südstadt 2-Zi Balkon'")
p.add_argument("--cold", type=float, help="Kaltmiete €/month")
p.add_argument("--warm", type=float, help="Warmmiete / Gesamtmiete €/month")
p.add_argument("--size", type=float, help="m²")
p.add_argument("--rooms", type=float)
p.add_argument("--from", dest="available", help="available from, e.g. 01.02.2027 or sofort")
p.add_argument("--url", help="listing link")
p.add_argument("--notes", help="short notes (balcony, floor, Kaution …)")
p.add_argument("--approx", action="store_true", help="address has no street (location approximate)")
p.add_argument("--base", default=BASE, help="site URL (default: %(default)s)")
a = p.parse_args()


def num(x):
    return None if x is None else (int(x) if float(x).is_integer() else x)


params = {"addr": a.addr, "label": a.label, "cold": num(a.cold), "warm": num(a.warm), "size": num(a.size),
          "rooms": num(a.rooms), "from": a.available, "url": a.url, "notes": a.notes, "approx": "1" if a.approx else None}
q = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
print(f"{a.base.rstrip('/')}/#add?{q}")
