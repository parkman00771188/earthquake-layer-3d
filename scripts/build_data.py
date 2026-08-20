#!/usr/bin/env python3
"""
Turn the raw catalog + reference geometry into the compact binary payload the
web viewer loads.

    python scripts/build_data.py

Inputs
    data/raw/catalog.csv          master event catalog (fetch_quakes.py)
    data/raw/ne_coastline.geojson Natural Earth coastline
    data/raw/plates.json          PB2002 tectonic plate boundaries
    data/raw/last_changes.json    what the last fetch altered (optional)

Outputs
    data/quakes.bin               header + parallel arrays, sorted by time
    data/meta.json                layout, extents, sources, monthly histogram
    data/labels.json              place-name dictionary + external id table
    data/basemap.json             coastline / plate polylines clipped to region
    data/changes.json             last update's diff, ids resolved to indices

Place names are dictionary-encoded: the catalog holds ~900k events but only a few
thousand distinct location names, so storing an index per event turns ~40 MB of
repeated strings into a 2-byte column plus a small dictionary.

Only the Python standard library is used -- no pip install required.
"""

from __future__ import annotations

import csv
import json
import math
import os
import struct
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(DATA, "raw")

CATALOG = os.path.join(RAW, "catalog.csv")
COASTLINE = os.path.join(RAW, "ne_coastline.geojson")
PLATES = os.path.join(RAW, "plates.json")
FAULTS = os.path.join(RAW, "gem_active_faults.geojson")
LAST_CHANGES = os.path.join(RAW, "last_changes.json")

# Map layer inputs (optional -- the viewer degrades gracefully without them).
LAND = os.path.join(RAW, "ne_10m_land.geojson")
LAKES = os.path.join(RAW, "ne_10m_lakes.geojson")
ADMIN1 = os.path.join(RAW, "ne_10m_admin_1_states_provinces_lines.geojson")
BORDERS = os.path.join(RAW, "ne_10m_admin_0_boundary_lines_land.geojson")

# Land-mask texture width; height follows the region's aspect in degrees so the
# texture maps linearly onto the surface plane.
LAND_TEXTURE_WIDTH = 4096

MAGIC = b"JQ4D"
VERSION = 2
HEADER_BYTES = 16

CHANGES_WEB_CAP = 200

# Reference-geometry detail: ~0.008 deg is under 1 km, well below what the
# 3D view can resolve, and keeps basemap.json small.
SIMPLIFY_TOLERANCE = 0.008
MIN_STRIP_POINTS = 2

csv.field_size_limit(1 << 20)


def log(msg: str) -> None:
    print(msg, flush=True)


class Staged:
    """
    Collect every generated file under a temp name, then rename them together.

    The viewer cross-checks quakes.bin's header count against meta.json, so a
    build interrupted between the two (Ctrl+C, a full disk, a crash) leaves
    data/ in a state the page refuses to load -- and the previous, perfectly
    good payload is already destroyed. Staging makes the whole output set
    all-or-nothing: an aborted build changes nothing on disk.
    """

    SUFFIX = ".new"

    def __init__(self, directory: str) -> None:
        self.dir = directory
        self.pending: list[tuple[str, str]] = []
        self.sweep()

    def sweep(self) -> None:
        """
        Delete temp files orphaned by an earlier run.

        abort() handles Ctrl+C, but a hard kill (Windows TerminateProcess, power
        loss) never runs Python cleanup, so stale temps have to be cleared on the
        way in rather than only on the way out.
        """
        stale = [f for f in os.listdir(self.dir) if f.endswith(self.SUFFIX)]
        for name in stale:
            try:
                os.remove(os.path.join(self.dir, name))
            except OSError:
                pass
        if stale:
            log(f"[build] cleared {len(stale)} orphaned temp file(s) from a previous run")

    def path(self, name: str) -> str:
        """Reserve `name` and return the temp path to write instead."""
        final = os.path.join(self.dir, name)
        tmp = final + self.SUFFIX
        self.pending.append((tmp, final))
        return tmp

    def discard(self, tmp: str) -> None:
        """Un-reserve a file a writer chose to skip, leaving the old one in place."""
        self.pending = [(t, f) for t, f in self.pending if t != tmp]

    def commit(self) -> None:
        # os.replace is atomic per file on both POSIX and Windows. There is no
        # atomic multi-file rename, but the writes are already done by now, so
        # the window where a reader could see a mix is microseconds instead of
        # the tens of seconds the build itself takes.
        for tmp, final in self.pending:
            os.replace(tmp, final)
        self.pending.clear()

    def abort(self) -> None:
        for tmp, _ in self.pending:
            try:
                os.remove(tmp)
            except OSError:
                pass
        self.pending.clear()


def load_config() -> dict:
    with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def parse_iso(value: str) -> datetime:
    value = value.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# --------------------------------------------------------------------------- #
# events
# --------------------------------------------------------------------------- #

def read_events() -> list[dict]:
    if not os.path.exists(CATALOG):
        sys.exit(f"missing {CATALOG} -- run scripts/fetch_quakes.py first")

    events = []
    skipped = 0
    with open(CATALOG, "r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                ev = {
                    "id": row["id"],
                    "source": row.get("source") or "usgs",
                    "t": parse_iso(row["time"]),
                    "lat": float(row["latitude"]),
                    "lon": float(row["longitude"]),
                    "depth": max(0.0, float(row["depth"])),
                    "mag": float(row["mag"]),
                    "magType": row.get("magType", ""),
                    "place": row.get("place", ""),
                }
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            events.append(ev)

    if skipped:
        log(f"[build] skipped {skipped} unparseable rows")
    events.sort(key=lambda e: (e["t"], e["id"]))
    return events


def build_labels(events: list[dict]) -> dict:
    """
    Dictionary-encode place names, magnitude types and event ids.

    ISC ids are numeric so they fit a Uint32 column directly. USGS ids are short
    strings, and there are only a few thousand of them (the recent tail), so they
    go into a lookup table that the same column indexes.
    """
    places: dict[str, int] = {}
    mag_types: dict[str, int] = {}
    usgs_ids: list[str] = []

    place_idx, magtype_idx, ext_id, src_flag = [], [], [], []

    for e in events:
        p = e["place"]
        if p not in places:
            places[p] = len(places)
        place_idx.append(places[p])

        mt = e["magType"]
        if mt not in mag_types:
            mag_types[mt] = len(mag_types)
        magtype_idx.append(mag_types[mt])

        raw = e["id"]
        if e["source"] == "isc" and raw.startswith("isc:") and raw[4:].isdigit():
            n = int(raw[4:])
            if n < 2 ** 32:
                src_flag.append(0)
                ext_id.append(n)
                continue
        # Anything else (USGS, or an oversized ISC id) goes in the string table.
        src_flag.append(1)
        ext_id.append(len(usgs_ids))
        usgs_ids.append(raw.split(":", 1)[-1])

    if len(places) >= 2 ** 16 or len(mag_types) >= 2 ** 16:
        sys.exit(f"dictionary overflow: {len(places)} places, {len(mag_types)} types")

    return {
        "place_idx": place_idx,
        "magtype_idx": magtype_idx,
        "ext_id": ext_id,
        "src_flag": src_flag,
        "tables": {
            "places": sorted(places, key=places.get),
            "magTypes": sorted(mag_types, key=mag_types.get),
            "usgsIds": usgs_ids,
        },
    }


def write_binary(events: list[dict], epoch: datetime, labels: dict, path: str) -> dict:
    """
    Layout (little-endian), all arrays index-aligned and sorted by origin time:

        header  : "JQ4D" + version u32 + count u32 + reserved u32
        lon     : Float32 * N   degrees
        lat     : Float32 * N   degrees
        depth   : Float32 * N   km
        mag     : Float32 * N
        t       : Uint32  * N   seconds since meta.epoch
        place   : Uint16  * N   index into labels.tables.places
        magType : Uint16  * N   index into labels.tables.magTypes
        extId   : Uint32  * N   ISC numeric id, or index into labels.tables.usgsIds
        src     : Uint8   * N   0 = ISC, 1 = USGS  (last: keeps 4-byte alignment)
    """
    n = len(events)
    blocks = [
        ("lon", 4, "Float32", struct.pack(f"<{n}f", *(e["lon"] for e in events))),
        ("lat", 4, "Float32", struct.pack(f"<{n}f", *(e["lat"] for e in events))),
        ("depth", 4, "Float32", struct.pack(f"<{n}f", *(e["depth"] for e in events))),
        ("mag", 4, "Float32", struct.pack(f"<{n}f", *(e["mag"] for e in events))),
        ("t", 4, "Uint32", struct.pack(
            f"<{n}I", *(int((e["t"] - epoch).total_seconds()) for e in events))),
        ("place", 2, "Uint16", struct.pack(f"<{n}H", *labels["place_idx"])),
        ("magType", 2, "Uint16", struct.pack(f"<{n}H", *labels["magtype_idx"])),
        ("extId", 4, "Uint32", struct.pack(f"<{n}I", *labels["ext_id"])),
        ("src", 1, "Uint8", struct.pack(f"<{n}B", *labels["src_flag"])),
    ]

    with open(path, "wb") as fh:
        fh.write(MAGIC + struct.pack("<III", VERSION, n, 0))
        for _name, _stride, _kind, blob in blocks:
            fh.write(blob)

    off = HEADER_BYTES
    layout = {}
    for name, stride, kind, _blob in blocks:
        layout[name] = {"offset": off, "type": kind, "length": n}
        off += stride * n

    size = os.path.getsize(path)
    log(f"[build] quakes.bin: {n} events, {size / 1e6:.2f} MB")
    return {"bytes": size, "header_bytes": HEADER_BYTES, "arrays": layout}


def monthly_histogram(events: list[dict]) -> dict:
    """Per-month event counts, used to draw the timeline density strip."""
    if not events:
        return {"start_year": 0, "start_month": 0, "counts": []}
    first, last = events[0]["t"], events[-1]["t"]
    base = first.year * 12 + (first.month - 1)
    span = last.year * 12 + (last.month - 1) - base + 1
    counts = [0] * span
    for e in events:
        counts[e["t"].year * 12 + (e["t"].month - 1) - base] += 1
    return {"start_year": first.year, "start_month": first.month, "counts": counts}


def source_spans(events: list[dict]) -> list[dict]:
    """First/last time and count per source, for the completeness note."""
    agg: dict[str, dict] = {}
    for e in events:
        a = agg.setdefault(e["source"], {"count": 0, "first": e["t"], "last": e["t"],
                                         "mag_min": e["mag"]})
        a["count"] += 1
        a["first"] = min(a["first"], e["t"])
        a["last"] = max(a["last"], e["t"])
        a["mag_min"] = min(a["mag_min"], e["mag"])
    return [{
        "source": k,
        "count": v["count"],
        "first": v["first"].isoformat().replace("+00:00", "Z"),
        "last": v["last"].isoformat().replace("+00:00", "Z"),
        "mag_min": round(v["mag_min"], 2),
    } for k, v in sorted(agg.items())]


# --------------------------------------------------------------------------- #
# change report
# --------------------------------------------------------------------------- #

def write_changes(events: list[dict], out: str) -> dict:
    """
    Translate the fetcher's change report into something the viewer can use.

    fetch_quakes.py records changes by event id; the viewer addresses events by
    their index in the time-sorted arrays, so the ids are resolved here.
    """
    if not os.path.exists(LAST_CHANGES):
        with open(out, "w", encoding="utf-8") as fh:
            json.dump({"available": False}, fh)
        return {"available": False}

    with open(LAST_CHANGES, "r", encoding="utf-8") as fh:
        raw = json.load(fh)

    index_of = {e["id"]: i for i, e in enumerate(events)}

    def entry(ev_id: str, extra: dict) -> dict | None:
        i = index_of.get(ev_id)
        if i is None:
            return None                    # superseded or removed since the fetch
        e = events[i]
        return {
            "i": i,
            "id": ev_id,
            "time": e["t"].isoformat().replace("+00:00", "Z"),
            "mag": round(e["mag"], 1),
            "depth": round(e["depth"], 1),
            "place": e["place"],
            **extra,
        }

    added = [x for x in (entry(r["id"], {})
                         for r in raw.get("added", [])[:CHANGES_WEB_CAP]) if x]
    revised = []
    for r in raw.get("revised", [])[:CHANGES_WEB_CAP]:
        fields = {k: v for k, v in (r.get("changes") or {}).items() if k != "updated"}
        row = entry(r["id"], {"fields": fields})
        if row:
            revised.append(row)

    added.sort(key=lambda r: r["time"], reverse=True)
    revised.sort(key=lambda r: r["time"], reverse=True)

    payload = {
        "available": True,
        "run_utc": raw.get("run_utc"),
        "mode": raw.get("mode"),
        "window": raw.get("window"),
        "counts": raw.get("counts", {}),
        "initial_import": raw.get("initial_import", False),
        "truncated": raw.get("truncated", False),
        "added": added,
        "revised": revised,
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"), ensure_ascii=False)

    c = payload["counts"]
    log(f"[build] changes.json: {c.get('added', 0)} new, {c.get('revised', 0)} revised"
        f" (listed {len(added)}/{len(revised)})")
    return {k: payload[k] for k in ("available", "run_utc", "mode", "counts",
                                    "initial_import")}


# --------------------------------------------------------------------------- #
# reference geometry
# --------------------------------------------------------------------------- #

def simplify(points: list[list[float]], tol: float) -> list[list[float]]:
    """Iterative Douglas-Peucker (recursion-free, so long coastlines are safe)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = points[lo]
        bx, by = points[hi]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_d = -1, -1.0
        for i in range(lo + 1, hi):
            px, py = points[i]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > best_d:
                best, best_d = i, d
        if best_d > tol:
            keep[best] = True
            stack.append((lo, best))
            stack.append((best, hi))
    return [p for p, k in zip(points, keep) if k]


def clip_segment(x0, y0, x1, y1, box):
    """Liang-Barsky clip of one segment to box=(xmin, ymin, xmax, ymax)."""
    xmin, ymin, xmax, ymax = box
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - xmin), (dx, xmax - x0), (-dy, y0 - ymin), (dy, ymax - y0)):
        if p == 0:
            if q < 0:
                return None                # parallel and outside
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    if t0 > t1:
        return None
    return (x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy)


def clip_line(points: list[list[float]], box) -> list[list[float]]:
    """Clip a polyline to the box, returning a list of flat [lon,lat,...] strips."""
    strips, current = [], []
    for i in range(len(points) - 1):
        (x0, y0), (x1, y1) = points[i], points[i + 1]
        seg = clip_segment(x0, y0, x1, y1, box)
        if seg is None:
            if len(current) >= MIN_STRIP_POINTS * 2:
                strips.append(current)
            current = []
            continue
        cx0, cy0, cx1, cy1 = seg
        if not current:
            current = [cx0, cy0]
        elif abs(current[-2] - cx0) > 1e-9 or abs(current[-1] - cy0) > 1e-9:
            # The previous segment was clipped short: start a new strip.
            if len(current) >= MIN_STRIP_POINTS * 2:
                strips.append(current)
            current = [cx0, cy0]
        current.extend((cx1, cy1))
    if len(current) >= MIN_STRIP_POINTS * 2:
        strips.append(current)
    return strips


def iter_linestrings(geojson: dict):
    for feature in geojson.get("features", []):
        geom = feature.get("geometry") or {}
        kind = geom.get("type")
        if kind == "LineString":
            yield feature, geom["coordinates"]
        elif kind == "MultiLineString":
            for part in geom["coordinates"]:
                yield feature, part


def build_polylines(path: str, box, tol: float) -> list[list[float]]:
    if not os.path.exists(path):
        log(f"[build] ! {os.path.relpath(path, ROOT)} not found -- skipping")
        return []
    with open(path, "r", encoding="utf-8") as fh:
        gj = json.load(fh)

    xmin, ymin, xmax, ymax = box
    out: list[list[float]] = []
    for _feature, coords in iter_linestrings(gj):
        pts = [[float(c[0]), float(c[1])] for c in coords if len(c) >= 2]
        if len(pts) < 2:
            continue
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        if max(lons) < xmin or min(lons) > xmax or max(lats) < ymin or min(lats) > ymax:
            continue                       # cheap reject
        for strip in clip_line(simplify(pts, tol), box):
            out.append([round(v, 4) for v in strip])
    return out


def write_basemap(cfg: dict, path: str) -> dict:
    r = cfg["region"]
    box = (r["minlongitude"], r["minlatitude"], r["maxlongitude"], r["maxlatitude"])

    coast = build_polylines(COASTLINE, box, SIMPLIFY_TOLERANCE)
    plates = build_polylines(PLATES, box, SIMPLIFY_TOLERANCE * 2)
    faults = build_polylines(FAULTS, box, SIMPLIFY_TOLERANCE)
    admin = build_polylines(ADMIN1, box, SIMPLIFY_TOLERANCE * 1.5)
    borders = build_polylines(BORDERS, box, SIMPLIFY_TOLERANCE * 1.5)

    payload = {"bbox": list(box), "coast": coast, "plates": plates,
               "admin": admin, "borders": borders, "faults": faults}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    def pts(strips):
        return sum(len(s) // 2 for s in strips)

    log(f"[build] basemap.json: coast {len(coast)}/{pts(coast)}pts, "
        f"plates {len(plates)}/{pts(plates)}pts, admin {len(admin)}/{pts(admin)}pts, "
        f"borders {len(borders)}/{pts(borders)}pts, "
        f"faults {len(faults)}/{pts(faults)}pts, "
        f"{os.path.getsize(path) / 1e6:.2f} MB")
    return {"coast_strips": len(coast), "coast_points": pts(coast),
            "plate_strips": len(plates), "plate_points": pts(plates),
            "admin_strips": len(admin), "admin_points": pts(admin),
            "border_strips": len(borders), "border_points": pts(borders)}


def write_land_mask(cfg: dict, path: str) -> dict | None:
    """Bake the filled-land map layer. Skipped if the source data is absent."""
    if not os.path.exists(LAND):
        log(f"[build] ! {os.path.relpath(LAND, ROOT)} not found -- no map layer")
        return None

    from rasterize import build_land_mask       # local: only needed here

    r = cfg["region"]
    box = (r["minlongitude"], r["minlatitude"], r["maxlongitude"], r["maxlatitude"])
    w = LAND_TEXTURE_WIDTH
    h = round(w * (r["maxlatitude"] - r["minlatitude"])
              / (r["maxlongitude"] - r["minlongitude"]))

    info = build_land_mask(LAND, LAKES if os.path.exists(LAKES) else None,
                           box, w, h, path)
    log(f"[build] land.png: {info['width']}x{info['height']}, "
        f"{info['bytes'] / 1e3:.0f} KB, land {info['land_fraction'] * 100:.1f}% "
        f"({info['land_edges']} land + {info['lake_edges']} lake edges)")
    return info


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main() -> int:
    cfg = load_config()
    events = read_events()
    if not events:
        sys.exit("catalog is empty")

    staged = Staged(DATA)
    try:
        return build(cfg, events, staged)
    except BaseException:
        # BaseException so Ctrl+C is covered too -- that is the interruption most
        # likely to hit a build that takes tens of seconds.
        staged.abort()
        log("[build] aborted -- previous data/ payload left untouched")
        raise


def build(cfg: dict, events: list[dict], staged: Staged) -> int:
    # Fixed epoch shared with the worldwide build, so both views live on the
    # same day axis and the timeline can drive either without conversion.
    epoch = datetime(1900, 1, 1, tzinfo=timezone.utc)
    labels = build_labels(events)
    binary = write_binary(events, epoch, labels, staged.path("quakes.bin"))

    labels_path = staged.path("labels.json")
    with open(labels_path, "w", encoding="utf-8") as fh:
        json.dump(labels["tables"], fh, separators=(",", ":"), ensure_ascii=False)
    t = labels["tables"]
    log(f"[build] labels.json: {len(t['places'])} places, {len(t['magTypes'])} mag types,"
        f" {len(t['usgsIds'])} usgs ids, {os.path.getsize(labels_path) / 1e6:.2f} MB")

    basemap = write_basemap(cfg, staged.path("basemap.json"))

    land_tmp = staged.path("land.png")
    land = write_land_mask(cfg, land_tmp)
    if land is None:
        staged.discard(land_tmp)          # no source polygons; nothing was written
    else:
        # The mask is written under the staging name, but the viewer loads it by
        # the committed name -- recording the temp name 404s the whole map layer.
        land["path"] = "land.png"

    changes = write_changes(events, staged.path("changes.json"))

    mags = [e["mag"] for e in events]
    depths = [e["depth"] for e in events]
    meta = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {k: {"name": v["name"], "minmagnitude": v["minmagnitude"],
                        "attribution": v.get("attribution", "")}
                    for k, v in cfg["sources"].items()},
        "handoff": cfg["catalog"]["handoff"],
        "source_spans": source_spans(events),
        "region": cfg["region"],
        "projection": cfg["projection"],
        "minmagnitude": min(mags),
        "count": len(events),
        "epoch": epoch.isoformat().replace("+00:00", "Z"),
        "time_start": events[0]["t"].isoformat().replace("+00:00", "Z"),
        "time_end": events[-1]["t"].isoformat().replace("+00:00", "Z"),
        "t_max_seconds": int((events[-1]["t"] - epoch).total_seconds()),
        "mag_min": min(mags), "mag_max": max(mags),
        "depth_min": min(depths), "depth_max": max(depths),
        "binary": binary,
        "basemap": basemap,
        "land": land,
        "last_update": changes,
        "histogram": monthly_histogram(events),
    }
    with open(staged.path("meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    # Nothing in data/ has changed until this line.
    staged.commit()

    log(f"[build] meta.json: {len(events)} events, "
        f"{meta['time_start'][:10]} .. {meta['time_end'][:10]}, "
        f"M{meta['mag_min']:.1f}-{meta['mag_max']:.1f}, "
        f"depth 0-{meta['depth_max']:.0f} km")
    for s in meta["source_spans"]:
        log(f"[build]   {s['source']:5} {s['count']:>7} events  "
            f"{s['first'][:10]} .. {s['last'][:10]}  M{s['mag_min']}+")
    log(f"[build] committed {len(meta['binary']['arrays'])}-array payload atomically")
    return 0


if __name__ == "__main__":
    sys.exit(main())
