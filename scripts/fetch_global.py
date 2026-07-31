#!/usr/bin/env python3
"""
Fetch the worldwide USGS ComCat catalogue (M2.0+, 1975..now) into a local CSV.

    python scripts/fetch_global.py

Walks forward through bounded time windows. An open-ended query (no endtime)
makes the ComCat database sort its entire multi-million-row result before
returning the first page -- which is exactly what falls over with
"temp table full" 503s. Bounded windows of a few months are cheap; the window
shrinks when a slice hits the 20k page limit and grows back when traffic is
light. Progress checkpoints to state.json, so an interrupted run resumes.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "global")
CATALOG = os.path.join(RAW, "catalog.csv")
STATE = os.path.join(RAW, "state.json")

API = "https://earthquake.usgs.gov/fdsnws/event/1/query"
START = "1975-01-01T00:00:00"
MIN_MAG = 2.0
PAGE = 20000
FIELDS = ["time", "latitude", "longitude", "depth", "mag", "id"]


def log(msg: str) -> None:
    print(msg, flush=True)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def fetch_window(a: datetime, b: datetime) -> list[dict] | None:
    """Rows in [a, b), or None when the server keeps refusing."""
    qs = urllib.parse.urlencode({
        "format": "csv", "starttime": iso(a), "endtime": iso(b),
        "minmagnitude": MIN_MAG, "orderby": "time-asc", "limit": PAGE,
    })
    for attempt in range(5):
        try:
            with urllib.request.urlopen(f"{API}?{qs}", timeout=180) as r:
                text = r.read().decode("utf-8", errors="replace")
            return list(csv.DictReader(io.StringIO(text)))
        except Exception as exc:
            wait = 10 * (attempt + 1)
            log(f"[global] retry in {wait}s ({type(exc).__name__})")
            time.sleep(wait)
    return None


def main() -> int:
    os.makedirs(RAW, exist_ok=True)

    state = {"cursor": START, "rows": 0, "window_days": 120, "done": False}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as fh:
            state.update(json.load(fh))
    if state.get("done"):
        log(f"[global] already complete ({state['rows']:,} rows); "
            "delete state.json to refetch")
        return 0

    fresh_file = not os.path.exists(CATALOG) or os.path.getsize(CATALOG) == 0
    out = open(CATALOG, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(out, fieldnames=FIELDS, extrasaction="ignore")
    if fresh_file:
        writer.writeheader()

    cursor = datetime.fromisoformat(state["cursor"]).replace(tzinfo=timezone.utc)
    window = float(state["window_days"])
    t0 = time.time()

    while True:
        # A few minutes of slack, or the loop chases the advancing clock with
        # endless zero-row queries and never declares itself finished.
        now = datetime.now(timezone.utc)
        if cursor >= now - timedelta(minutes=10):
            state["done"] = True
            break

        end = min(cursor + timedelta(days=window), now)
        rows = fetch_window(cursor, end)
        if rows is None:
            log("[global] server unavailable -- stopping; rerun to resume")
            break
        if len(rows) >= PAGE:
            # Slice overflowed the page: halve and retry the same cursor.
            window = max(window / 2, 1)
            log(f"[global] window too dense, shrinking to {window:.0f}d")
            continue

        for r in rows:
            writer.writerow(r)
        out.flush()

        state["rows"] += len(rows)
        cursor = end
        state["cursor"] = iso(cursor)
        state["window_days"] = window
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        log(f"[global] {state['rows']:>9,} rows  through {iso(end)[:10]}  "
            f"window {window:.0f}d  ({time.time() - t0:5.0f}s)")

        if len(rows) < PAGE * 0.4:
            window = min(window * 1.3, 365)
        time.sleep(0.7)

    out.close()
    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    if state.get("done"):
        log(f"[global] complete: {state['rows']:,} rows in {CATALOG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
