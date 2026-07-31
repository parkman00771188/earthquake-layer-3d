#!/usr/bin/env python3
"""
Build the globe-view payload from the fetched worldwide catalogue.

    python scripts/build_global.py

Reads data/raw/global/catalog.csv (from fetch_global.py) and writes
data/global/:

    quakes-m2.bin      M2.0-2.9      one file per magnitude band, so the
    quakes-m3.bin      M3.0-3.9      viewer can stream the heavy small-quake
    quakes-m4.bin      M4.0-4.9      files separately from the light big-quake
    quakes-m5.bin      M5.0+         ones instead of one monolithic blob
    basemap.json       worldwide coastline + plate boundaries (downsampled)
    meta.json          band index, counts, time range

Binary layout per file: u32 magic 'GQ1\\0', u32 count, then contiguous arrays
Float32 lon | Float32 lat | Float32 depth | Float32 mag | Uint32 t(sec since
1975-01-01). Events are time-ascending inside each band.
"""

from __future__ import annotations

import csv
import json
import os
import struct
import sys
from array import array
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "data", "raw", "global", "catalog.csv")
COAST = os.path.join(ROOT, "data", "raw", "ne_coastline.geojson")
PLATES = os.path.join(ROOT, "data", "raw", "plates.json")
OUT = os.path.join(ROOT, "data", "global")

EPOCH = datetime(1975, 1, 1, tzinfo=timezone.utc)
MAGIC = 0x00315147                      # 'GQ1\0' little-endian
BANDS = [("m2", 2.0, 3.0), ("m3", 3.0, 4.0), ("m4", 4.0, 5.0), ("m5", 5.0, 99.0)]
COAST_TOL_DEG = 0.12                    # min spacing between kept coast points


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_time(s: str) -> float:
    # "2024-01-31T12:34:56.789Z" -> seconds since EPOCH
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (dt - EPOCH).total_seconds()


def read_events() -> dict[str, list[tuple[float, float, float, float, float]]]:
    bands: dict[str, list] = {k: [] for k, _, _ in BANDS}
    bad = 0
    with open(CATALOG, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            try:
                t = parse_time(row["time"])
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                mag = float(row["mag"])
                depth = float(row["depth"] or 0.0)
            except (ValueError, KeyError):
                bad += 1
                continue
            if t < 0 or not (-90 <= lat <= 90) or mag < 2.0:
                bad += 1
                continue
            depth = min(max(depth, 0.0), 700.0)
            for key, lo, hi in BANDS:
                if lo <= mag < hi:
                    bands[key].append((t, lon, lat, depth, mag))
                    break
    if bad:
        log(f"[global] skipped {bad} malformed rows")
    return bands


def write_band(key: str, events: list) -> dict:
    events.sort(key=lambda e: e[0])
    n = len(events)
    lon = array("f", (e[1] for e in events))
    lat = array("f", (e[2] for e in events))
    depth = array("f", (e[3] for e in events))
    mag = array("f", (e[4] for e in events))
    t = array("I", (int(e[0]) for e in events))

    path = os.path.join(OUT, f"quakes-{key}.bin")
    with open(path, "wb") as fh:
        fh.write(struct.pack("<II", MAGIC, n))
        for arr in (lon, lat, depth, mag, t):
            fh.write(arr.tobytes())
    size = os.path.getsize(path)
    log(f"[global] quakes-{key}.bin: {n:,} events, {size / 1e6:.1f} MB")
    return {"key": key, "path": f"quakes-{key}.bin", "count": n, "bytes": size}


def strips_from_geojson(path: str, tol: float) -> list[list[float]]:
    with open(path, encoding="utf-8") as fh:
        gj = json.load(fh)
    strips: list[list[float]] = []
    for ft in gj.get("features", []):
        g = ft.get("geometry") or {}
        lines = g.get("coordinates", [])
        if g.get("type") == "LineString":
            lines = [lines]
        elif g.get("type") != "MultiLineString":
            continue
        for line in lines:
            out: list[float] = []
            px = py = 1e9
            for lon, lat, *_ in line:
                if abs(lon - px) + abs(lat - py) < tol:
                    continue
                out.extend((round(lon, 3), round(lat, 3)))
                px, py = lon, lat
            if len(out) >= 4:
                strips.append(out)
    return strips


def main() -> int:
    if not os.path.exists(CATALOG):
        sys.exit("run scripts/fetch_global.py first")
    os.makedirs(OUT, exist_ok=True)

    bands = read_events()
    infos = [write_band(k, bands[k]) for k, _, _ in BANDS]

    coast = strips_from_geojson(COAST, COAST_TOL_DEG)
    plates = strips_from_geojson(PLATES, 0.0)
    basemap = {"coast": coast, "plates": plates}
    with open(os.path.join(OUT, "basemap.json"), "w", encoding="utf-8") as fh:
        json.dump(basemap, fh, separators=(",", ":"))
    npts = sum(len(s) // 2 for s in coast)
    log(f"[global] basemap.json: {len(coast)} coast strips ({npts:,} pts), "
        f"{len(plates)} plate strips")

    # Monthly histogram across every band, for the timeline seek bar.
    from datetime import timedelta
    counts: dict[int, int] = {}
    for k, _, _ in BANDS:
        for e in bands[k]:
            d = EPOCH + timedelta(seconds=e[0])
            counts[d.year * 12 + (d.month - 1)] = counts.get(d.year * 12 + (d.month - 1), 0) + 1
    first = min(counts) if counts else 1975 * 12
    last = max(counts) if counts else first
    histogram = {
        "start_year": first // 12,
        "start_month": first % 12 + 1,
        "counts": [counts.get(m, 0) for m in range(first, last + 1)],
    }

    total = sum(i["count"] for i in infos)
    times = [e[0] for k, _, _ in BANDS for e in bands[k][-1:]]
    meta = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "USGS ANSS ComCat, M2.0+, worldwide",
        "epoch": "1975-01-01T00:00:00Z",
        "count": total,
        "time_end_seconds": int(max(times)) if times else 0,
        "bands": infos,
        "histogram": histogram,
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    log(f"[global] meta.json: {total:,} events across {len(infos)} band files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
