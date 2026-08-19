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

API = "https://earthquake.usgs.gov/fdsnws/event/1/query"
MIN_MAG = 2.0
PAGE = 20000
FIELDS = ["time", "latitude", "longitude", "depth", "mag", "id"]

# How far back the live tail is refetched on every run. ComCat keeps revising
# recent solutions and late arrivals land days after the event, so the last
# stretch of the catalogue is dropped and fetched again rather than trusted.
REWIND_DAYS = 7

# Two independently-resumable stretches. The historic one (centennial/PDE-era
# solutions, sparse) was added after the modern one finished, so it lives in
# its own files rather than forcing a refetch of everything.
SEGMENTS = [
    ("1900-01-01T00:00:00", "1975-01-01T00:00:00", "catalog_1900.csv", "state_1900.json"),
    ("1975-01-01T00:00:00", None, "catalog.csv", "state.json"),
]


def log(msg: str) -> None:
    print(msg, flush=True)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def row_time(raw: str) -> datetime | None:
    """Timestamp of a cached CSV row, or None when it cannot be read."""
    try:
        dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def truncate_from(catalog: str, cutoff: datetime) -> int:
    """Drop rows at or after cutoff, rewriting in place; returns rows kept."""
    if not os.path.exists(catalog):
        return 0
    tmp = catalog + ".tmp"
    kept = 0
    with open(catalog, newline="", encoding="utf-8") as src,             open(tmp, "w", newline="", encoding="utf-8") as dst:
        writer = csv.DictWriter(dst, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in csv.DictReader(src):
            t = row_time(row.get("time", ""))
            if t is not None and t >= cutoff:
                continue
            writer.writerow(row)
            kept += 1
    os.replace(tmp, catalog)
    return kept


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


def run_segment(seg_start: str, seg_end: str | None,
                catalog_name: str, state_name: str) -> bool:
    """Fetch one stretch; True when it is (already) complete."""
    catalog = os.path.join(RAW, catalog_name)
    state_path = os.path.join(RAW, state_name)

    state = {"cursor": seg_start, "rows": 0, "window_days": 120, "done": False}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as fh:
            state.update(json.load(fh))
    if state.get("done"):
        if seg_end is not None:
            log(f"[global] {catalog_name} already complete ({state['rows']:,} rows)")
            return True
        # The open-ended segment is never actually finished -- "done" only ever
        # meant it had caught up with the clock. Rewind past the live tail and
        # refetch it, or the catalogue would stay frozen at the old cursor.
        cutoff = max(
            datetime.fromisoformat(state["cursor"]).replace(tzinfo=timezone.utc)
            - timedelta(days=REWIND_DAYS),
            datetime.fromisoformat(seg_start).replace(tzinfo=timezone.utc))
        kept = truncate_from(catalog, cutoff)
        state.update(cursor=iso(cutoff), rows=kept, done=False)
        log(f"[global] live tail resumes at {iso(cutoff)[:10]} "
            f"({REWIND_DAYS}d rewind, {kept:,} rows kept)")

    fresh_file = not os.path.exists(catalog) or os.path.getsize(catalog) == 0
    out = open(catalog, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(out, fieldnames=FIELDS, extrasaction="ignore")
    if fresh_file:
        writer.writeheader()

    cursor = datetime.fromisoformat(state["cursor"]).replace(tzinfo=timezone.utc)
    window = float(state["window_days"])
    t0 = time.time()

    while True:
        # A bounded segment ends at its end date; the open one trails the clock
        # by a few minutes or it would chase "now" with zero-row queries forever.
        limit = (datetime.fromisoformat(seg_end).replace(tzinfo=timezone.utc)
                 if seg_end else datetime.now(timezone.utc) - timedelta(minutes=10))
        if cursor >= limit:
            state["done"] = True
            break

        end = min(cursor + timedelta(days=window),
                  datetime.fromisoformat(seg_end).replace(tzinfo=timezone.utc)
                  if seg_end else datetime.now(timezone.utc))
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
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        log(f"[global] {state['rows']:>9,} rows  through {iso(end)[:10]}  "
            f"window {window:.0f}d  ({time.time() - t0:5.0f}s)")

        if len(rows) < PAGE * 0.4:
            window = min(window * 1.3, 365)
        time.sleep(0.7)

    out.close()
    with open(state_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    if state.get("done"):
        log(f"[global] {catalog_name} complete: {state['rows']:,} rows")
    return bool(state.get("done"))


def main() -> int:
    os.makedirs(RAW, exist_ok=True)
    ok = True
    for seg in SEGMENTS:
        ok = run_segment(*seg) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
