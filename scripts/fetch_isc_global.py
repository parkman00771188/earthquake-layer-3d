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

API = "https://www.isc.ac.uk/fdsnws/event/1/query"
MIN_MAG = 3.0
LIMIT = 20000
FIELDS = ["time", "latitude", "longitude", "depth", "mag", "id"]

# How far back the live tail is refetched on every run. ISC keeps inserting
# events behind "now" for days to weeks (network reports arrive late), so the
# last stretch is dropped and fetched again instead of trusted as final.
REWIND_DAYS = 14

# Two independently-resumable stretches; the ISS-era backfill (1904..1974,
# sparse but going back to the dawn of instrumental seismology) was added
# after the modern stretch finished, so it lives in its own files.
SEGMENTS = [
    ("1900-01-01T00:00:00", "1975-01-01T00:00:00",
     "isc_catalog_1900.csv", "isc_state_1900.json"),
    ("1975-01-01T00:00:00", None, "isc_catalog.csv", "isc_state.json"),
]

# Anthropogenic and non-seismic rows are not part of the picture we draw.
SKIP_TYPES = {
    "quarry blast", "explosion", "nuclear explosion", "mining explosion",
    "chemical explosion", "rock burst", "landslide", "sonic boom", "not existing",
}


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


def truncate_from(catalog: str, cutoff: datetime) -> tuple[int, dict[str, dict]]:
    """
    Drop rows at or after cutoff, rewriting in place. Returns the number of
    rows kept plus the dropped rows keyed by id, so the refetched tail can be
    diffed against what it replaced.
    """
    if not os.path.exists(catalog):
        return 0, {}
    tmp = catalog + ".tmp"
    kept = 0
    dropped: dict[str, dict] = {}
    with open(catalog, newline="", encoding="utf-8") as src, open(tmp, "w", newline="", encoding="utf-8") as dst:
        writer = csv.DictWriter(dst, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in csv.DictReader(src):
            t = row_time(row.get("time", ""))
            if t is not None and t >= cutoff:
                dropped[row.get("id", "")] = row
                continue
            writer.writerow(row)
            kept += 1
    os.replace(tmp, catalog)
    return kept, dropped


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


def run_segment(seg_start: str, seg_end: str | None,
                catalog_name: str, state_name: str) -> bool:
    """Fetch one stretch; True when it is (already) complete."""
    catalog = os.path.join(RAW, catalog_name)
    state_path = os.path.join(RAW, state_name)

    state = {"cursor": seg_start, "rows": 0, "window_days": 30, "done": False}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as fh:
            state.update(json.load(fh))
    # What the rewound tail held before vs. what this run writes back --
    # diffed at the end into a "what changed" report (open segment only).
    tail_dropped: dict[str, dict] = {}
    tail_appended: dict[str, dict] = {}
    if state.get("done"):
        if seg_end is not None:
            log(f"[isc] {catalog_name} already complete ({state['rows']:,} rows)")
            return True
        # The open-ended segment is never actually finished -- "done" only ever
        # meant it had caught up with the clock. Rewind past the live tail and
        # refetch it, or the catalogue would stay frozen at the old cursor.
        cutoff = max(
            datetime.fromisoformat(state["cursor"]).replace(tzinfo=timezone.utc)
            - timedelta(days=REWIND_DAYS),
            datetime.fromisoformat(seg_start).replace(tzinfo=timezone.utc))
        kept, tail_dropped = truncate_from(catalog, cutoff)
        state.update(cursor=iso(cutoff), rows=kept, done=False)
        log(f"[isc] live tail resumes at {iso(cutoff)[:10]} "
            f"({REWIND_DAYS}d rewind, {kept:,} rows kept)")

    fresh = not os.path.exists(catalog) or os.path.getsize(catalog) == 0
    out = open(catalog, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(out, fieldnames=FIELDS)
    if fresh:
        writer.writeheader()

    cursor = datetime.fromisoformat(state["cursor"]).replace(tzinfo=timezone.utc)
    window = float(state["window_days"])
    t0 = time.time()

    while True:
        limit = (datetime.fromisoformat(seg_end).replace(tzinfo=timezone.utc)
                 if seg_end else datetime.now(timezone.utc) - timedelta(minutes=10))
        if cursor >= limit:
            state["done"] = True
            break

        end = min(cursor + timedelta(days=window),
                  datetime.fromisoformat(seg_end).replace(tzinfo=timezone.utc)
                  if seg_end else datetime.now(timezone.utc))
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
                if seg_end is None:
                    tail_appended[row["id"]] = row
                kept += 1
        out.flush()

        state["rows"] += kept
        cursor = end
        state["cursor"] = iso(cursor)
        state["window_days"] = window
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        log(f"[isc] {state['rows']:>9,} rows  through {iso(end)[:10]}  "
            f"window {window:.0f}d  ({time.time() - t0:5.0f}s)")

        if len(lines) < LIMIT * 0.4:
            window = min(window * 1.3, 180)
        time.sleep(2)                        # the ISC asks for gentle clients

    out.close()
    with open(state_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    if state.get("done"):
        log(f"[isc] {catalog_name} complete: {state['rows']:,} rows")
        if seg_end is None:
            import global_changes
            c = global_changes.record("isc", tail_dropped, tail_appended)["counts"]
            log(f"[isc] changes: new={c['added']} revised={c['revised']} "
                f"removed={c['removed']}")
    return bool(state.get("done"))


def main() -> int:
    os.makedirs(RAW, exist_ok=True)
    ok = True
    for seg in SEGMENTS:
        ok = run_segment(*seg) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
