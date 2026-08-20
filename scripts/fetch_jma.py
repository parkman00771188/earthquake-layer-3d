#!/usr/bin/env python3
"""
Fetch the JMA quick-report quake list into a local CSV.

    python scripts/fetch_jma.py

The JMA bosai feed (list.json) carries roughly the last month of events felt
in Japan, down to about M1.3 -- far below anything USGS ComCat holds for this
region (its practical floor here is ~M4). The feed is a rolling window, so
each run folds the current window into data/raw/jma_catalog.csv, which
accumulates: new event ids are appended, ids seen before are updated in place
when JMA revises the solution.

Rows use the exact column layout of catalog.csv so the builder can parse both
with the same reader. Ids are "jma:<eid>", source "jma", magnitude type "Mj".
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
CATALOG = os.path.join(RAW, "jma_catalog.csv")
CONFIG = os.path.join(ROOT, "config.json")

URL = "https://www.jma.go.jp/bosai/quake/data/list.json"
MIN_MAG = 1.5
FIELDS = ["id", "source", "time", "latitude", "longitude", "depth",
          "mag", "magType", "place", "updated"]

# ISO 6709 coordinate string: "+32.2+130.4-10000/" (lat, lon, depth in metres)
COD = re.compile(r"^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?))?/")


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_event(e: dict, box: tuple) -> dict | None:
    """One feed entry -> a catalog row, or None when it cannot be used."""
    eid = e.get("eid")
    cod = e.get("cod") or ""
    mag = e.get("mag") or ""
    at = e.get("at") or ""
    m = COD.match(cod)
    if not (eid and m and at):
        return None
    try:
        magf = float(mag)
    except ValueError:
        return None                     # "M不明" and friends
    if magf < MIN_MAG:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    xmin, ymin, xmax, ymax = box
    if not (xmin <= lon <= xmax and ymin <= lat <= ymax):
        return None                     # JMA also reports far foreign quakes
    depth_km = abs(float(m.group(3))) / 1000.0 if m.group(3) else 0.0
    t = datetime.fromisoformat(at).astimezone(timezone.utc)
    return {
        "id": f"jma:{eid}",
        "source": "jma",
        "time": t.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "depth": f"{depth_km:.1f}",
        "mag": f"{magf:.2f}",
        "magType": "Mj",
        "place": e.get("en_anm") or e.get("anm") or "",
        "updated": e.get("rdt") or "",
    }


def main() -> int:
    with open(CONFIG, encoding="utf-8") as fh:
        r = json.load(fh)["region"]
    box = (r["minlongitude"], r["minlatitude"], r["maxlongitude"], r["maxlatitude"])

    req = urllib.request.Request(URL, headers={"User-Agent": "earthquake-layer-3d"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        feed = json.load(resp)

    # The feed repeats an event once per bulletin; the largest serial wins.
    latest: dict[str, dict] = {}
    for e in feed:
        eid = e.get("eid")
        if not eid:
            continue
        prev = latest.get(eid)
        if prev is None or (e.get("ser") or "") >= (prev.get("ser") or ""):
            latest[eid] = e

    existing: dict[str, dict] = {}
    if os.path.exists(CATALOG):
        with open(CATALOG, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                existing[row["id"]] = row

    added = revised = 0
    for e in latest.values():
        row = parse_event(e, box)
        if row is None:
            continue
        old = existing.get(row["id"])
        if old is None:
            added += 1
        elif any(old.get(k) != row[k] for k in
                 ("time", "latitude", "longitude", "depth", "mag")):
            revised += 1
        else:
            continue
        existing[row["id"]] = row

    rows = sorted(existing.values(), key=lambda r: r["time"])
    os.makedirs(RAW, exist_ok=True)
    tmp = CATALOG + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, CATALOG)

    log(f"[jma] catalog holds {len(rows):,} events (M{MIN_MAG}+)"
        f"  new={added} revised={revised}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:                      # feed down: not fatal
        log(f"[jma] ! fetch failed ({type(exc).__name__}: {exc}) -- skipped")
        sys.exit(0)
