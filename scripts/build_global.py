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
1900-01-01). Events are time-ascending inside each band.
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
RAW = os.path.join(ROOT, "data", "raw", "global")
# Each source may have a historic backfill file alongside the modern one.
USGS_CATALOGS = ["catalog_1900.csv", "catalog.csv"]
ISC_CATALOGS = ["isc_catalog_1900.csv", "isc_catalog.csv"]
CATALOG = os.path.join(RAW, "catalog.csv")     # existence gate for main()
COAST = os.path.join(ROOT, "data", "raw", "ne_coastline.geojson")
PLATES = os.path.join(ROOT, "data", "raw", "plates.json")
FAULTS = os.path.join(ROOT, "data", "raw", "gem_active_faults.geojson")
LAND = os.path.join(ROOT, "data", "raw", "ne_10m_land.geojson")
LAKES = os.path.join(ROOT, "data", "raw", "ne_10m_lakes.geojson")
OUT = os.path.join(ROOT, "data", "global")

EPOCH = datetime(1900, 1, 1, tzinfo=timezone.utc)   # shared with the Japan build
MAGIC = 0x00315147                      # 'GQ1\0' little-endian
BANDS = [("m2", 2.0, 3.0), ("m3", 3.0, 4.0), ("m4", 4.0, 5.0), ("m5", 5.0, 99.0)]
COAST_TOL_DEG = 0.12                    # min spacing between kept coast points


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_time(s: str) -> float:
    # "2024-01-31T12:34:56.789Z" -> seconds since EPOCH. ISC timestamps come
    # without a zone suffix; both catalogues are UTC.
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt - EPOCH).total_seconds()


def read_catalog(path: str, src: int) -> list[tuple]:
    """(t, lon, lat, depth, mag, src) rows; malformed lines are dropped."""
    out = []
    bad = 0
    with open(path, newline="", encoding="utf-8") as fh:
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
            out.append((t, lon, lat, min(max(depth, 0.0), 700.0), mag, src))
    if bad:
        log(f"[global] {os.path.basename(path)}: skipped {bad} malformed rows")
    return out


DUP_SECONDS = 12.0                    # same quake if within this and ~0.8 deg
SRC_USGS, SRC_ISC = 0, 1


def _near(a: tuple, b: tuple) -> bool:
    import math
    if abs(a[2] - b[2]) > 0.8:
        return False
    d = abs(a[1] - b[1])
    if d > 180:
        d = 360 - d
    lim = min(8.0, 0.8 / max(0.15, math.cos(math.radians(a[2]))))
    return d <= lim


def dedup(events: list[tuple]) -> tuple[list[tuple], int]:
    """
    Collapse cross-catalogue duplicates: both the ISC Bulletin and ComCat carry
    most significant quakes, as slightly different solutions. Events closer
    than DUP_SECONDS and ~0.8 deg are treated as one; the ISC solution wins
    (it is the reviewed, multi-network one).
    """
    events.sort(key=lambda e: e[0])
    dropped = [False] * len(events)
    win: list[int] = []                # indices of kept events in the time window
    removed = 0
    for i, e in enumerate(events):
        while win and e[0] - events[win[0]][0] > DUP_SECONDS:
            win.pop(0)
        hit = next((j for j in win if _near(e, events[j])), None)
        if hit is None:
            win.append(i)
            continue
        removed += 1
        if e[5] == SRC_ISC and events[hit][5] == SRC_USGS:
            dropped[hit] = True        # the ISC solution replaces the USGS one
            win.remove(hit)
            win.append(i)
        else:
            dropped[i] = True
    return [e for i, e in enumerate(events) if not dropped[i]], removed


def read_events() -> tuple[dict[str, list[tuple]], dict]:
    usgs = []
    for name in USGS_CATALOGS:
        path = os.path.join(RAW, name)
        if os.path.exists(path):
            usgs.extend(read_catalog(path, SRC_USGS))
    isc = []
    for name in ISC_CATALOGS:
        path = os.path.join(RAW, name)
        if os.path.exists(path):
            isc.extend(read_catalog(path, SRC_ISC))
    log(f"[global] catalogues: USGS {len(usgs):,} rows, ISC {len(isc):,} rows")

    merged, removed = dedup(usgs + isc)
    log(f"[global] merged: {len(merged):,} events "
        f"({removed:,} cross-catalogue duplicates collapsed)")

    bands: dict[str, list] = {k: [] for k, _, _ in BANDS}
    for e in merged:
        for key, lo, hi in BANDS:
            if lo <= e[4] < hi:
                bands[key].append(e[:5])
                break
    sources = {"usgs_rows": len(usgs), "isc_rows": len(isc),
               "duplicates_removed": removed}
    return bands, sources


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


def write_land_mask() -> dict | None:
    """Equirectangular worldwide land/water mask for the globe's fill layer."""
    if not os.path.exists(LAND):
        log("[global] ! ne_10m_land.geojson not found -- no land fill")
        return None
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from rasterize import build_land_mask

    path = os.path.join(OUT, "land.png")
    info = build_land_mask(LAND, LAKES if os.path.exists(LAKES) else None,
                           (-180.0, -90.0, 180.0, 90.0), 4096, 2048, path)
    info["path"] = "land.png"
    log(f"[global] land.png: {info['width']}x{info['height']}, "
        f"{info['bytes'] / 1e3:.0f} KB, land {info['land_fraction'] * 100:.1f}%")
    return info


def main() -> int:
    if not os.path.exists(CATALOG):
        sys.exit("run scripts/fetch_global.py first")
    os.makedirs(OUT, exist_ok=True)

    bands, sources = read_events()
    infos = [write_band(k, bands[k]) for k, _, _ in BANDS]

    coast = strips_from_geojson(COAST, COAST_TOL_DEG)
    plates = strips_from_geojson(PLATES, 0.0)
    # GEM Global Active Faults; a light tolerance keeps the added weight small.
    faults = (strips_from_geojson(FAULTS, 0.05)
              if os.path.exists(FAULTS) else [])
    basemap = {"coast": coast, "plates": plates, "faults": faults}
    with open(os.path.join(OUT, "basemap.json"), "w", encoding="utf-8") as fh:
        json.dump(basemap, fh, separators=(",", ":"))
    npts = sum(len(s) // 2 for s in coast)
    log(f"[global] basemap.json: {len(coast)} coast strips ({npts:,} pts), "
        f"{len(plates)} plate strips, {len(faults)} fault strips")

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
        "source": "USGS ANSS ComCat (M2.0+) + ISC Bulletin (M3.0+), worldwide, deduplicated",
        "sources": sources,
        "epoch": "1900-01-01T00:00:00Z",
        "count": total,
        "time_end_seconds": int(max(times)) if times else 0,
        "bands": infos,
        "histogram": histogram,
        "land": write_land_mask(),
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    log(f"[global] meta.json: {total:,} events across {len(infos)} band files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
