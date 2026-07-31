#!/usr/bin/env python3
"""
Fetch the worldwide ISC Bulletin (M3.0+, 1975..now) into a local CSV.

    python scripts/fetch_isc_global.py

The ISC aggregates ~130 seismic networks, so below M4.5 it carries far more of
the world than USGS ComCat (which is essentially US networks + NEIC M4.5+).
M3.0 is the practical floor: below that even the ISC is nowhere near globally
complete, and the volume explodes.

Same shape as fetch_global.py: bounded windows walked forward, adaptive window
size, checkpointed cursor for resume. The ISC service is slow and single-lane;
windows stay modest and every request is followed by a polite pause. Output
columns match the USGS cache so the builder parses both identically. Note the
reviewed ISC bulletin trails real time by roughly two years -- recent events
come from the USGS feed, which is exactly why the two sources are merged.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "global")
CATALOG = os.path.join(RAW, "isc_catalog.csv")
STATE = os.path.join(RAW, "isc_state.json")

API = "https://www.isc.ac.uk/fdsnws/event/1/query"
START = "1975-01-01T00:00:00"
MIN_MAG = 3.0
LIMIT = 20000
FIELDS = ["time", "latitude", "longitude", "depth", "mag", "id"]

# Anthropogenic and non-seismic rows are not part of the picture we draw.
SKIP_TYPES = {
    "quarry blast", "explosion", "nuclear explosion", "mining explosion",
    "chemical explosion", "rock burst", "landslide", "sonic boom", "not existing",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def fetch_window(a: datetime, b: datetime) -> list[str] | None:
    """Pipe-separated event lines in [a, b), or None if the server keeps failing."""
    qs = urllib.parse.urlencode({
        "starttime": iso(a), "endtime": iso(b),
        "minmagnitude": MIN_MAG, "format": "text", "limit": LIMIT,
    })
    for attempt in range(5):
        try:
            req = urllib.request.Request(f"{API}?{qs}",
                                         headers={"User-Agent": "earthquake-layer-3d"})
            with urllib.request.urlopen(req, timeout=420) as r:
                if r.status == 204:
                    return []
                text = r.read().decode("utf-8", errors="replace")
            return [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
        except Exception as exc:
            wait = 20 * (attempt + 1)
            log(f"[isc] retry in {wait}s ({type(exc).__name__})")
            time.sleep(wait)
    return None


def parse(line: str) -> dict | None:
    # EventID|Time|Lat|Lon|Depth/km|Author|Catalog|Contributor|ContribID|
    # MagType|Magnitude|MagAuthor|LocationName|EventType
    p = line.split("|")
    if len(p) < 11:
        return None
    if len(p) >= 14 and p[13].strip().lower() in SKIP_TYPES:
        return None
    try:
        return {
            "time": p[1].strip(),
            "latitude": float(p[2]),
            "longitude": float(p[3]),
            "depth": float(p[4]) if p[4].strip() else 0.0,
            "mag": float(p[10]),
            "id": f"isc{p[0].strip()}",
        }
    except ValueError:
        return None


def main() -> int:
    os.makedirs(RAW, exist_ok=True)

    state = {"cursor": START, "rows": 0, "window_days": 30, "done": False}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as fh:
            state.update(json.load(fh))
    if state.get("done"):
        log(f"[isc] already complete ({state['rows']:,} rows); "
            "delete isc_state.json to refetch")
        return 0

    fresh = not os.path.exists(CATALOG) or os.path.getsize(CATALOG) == 0
    out = open(CATALOG, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(out, fieldnames=FIELDS)
    if fresh:
        writer.writeheader()

    cursor = datetime.fromisoformat(state["cursor"]).replace(tzinfo=timezone.utc)
    window = float(state["window_days"])
    t0 = time.time()

    while True:
        now = datetime.now(timezone.utc)
        if cursor >= now - timedelta(minutes=10):
            state["done"] = True
            break

        end = min(cursor + timedelta(days=window), now)
        lines = fetch_window(cursor, end)
        if lines is None:
            log("[isc] server unavailable -- stopping; rerun to resume")
            break
        if len(lines) >= LIMIT:
            window = max(window / 2, 1)
            log(f"[isc] window too dense, shrinking to {window:.0f}d")
            continue

        kept = 0
        for ln in lines:
            row = parse(ln)
            if row:
                writer.writerow(row)
                kept += 1
        out.flush()

        state["rows"] += kept
        cursor = end
        state["cursor"] = iso(cursor)
        state["window_days"] = window
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        log(f"[isc] {state['rows']:>9,} rows  through {iso(end)[:10]}  "
            f"window {window:.0f}d  ({time.time() - t0:5.0f}s)")

        if len(lines) < LIMIT * 0.4:
            window = min(window * 1.3, 90)
        time.sleep(2)                        # the ISC asks for gentle clients

    out.close()
    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    if state.get("done"):
        log(f"[isc] complete: {state['rows']:,} rows in {CATALOG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
