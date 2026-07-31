#!/usr/bin/env python3
"""
Bakes the land/lake polygons into a grayscale PNG mask that the viewer drapes
over the surface as a map layer.

Why a raster rather than triangles: filled polygons with holes would need a
triangulator, and Japan at 10 m resolution is thousands of islands. A mask is one
texture, one draw call, and its opacity is a single uniform -- exactly what an
opacity slider wants. The vector coastline still draws on top, so edges stay
crisp when you zoom past the texture's resolution.

Only the Python standard library is used -- no pip install, no GDAL, no Pillow.
"""

from __future__ import annotations

import binascii
import json
import os
import struct
import zlib

LAND = 255
WATER = 0


# --------------------------------------------------------------------------- #
# PNG output
# --------------------------------------------------------------------------- #

def write_gray_png(path: str, width: int, height: int, rows: list[bytearray]) -> int:
    """
    Write an 8-bit grayscale PNG. Filter 0 (None) on every scanline.

    Writes straight to `path`; the caller stages and renames, so adding another
    temp file here would just nest one inside the other.
    """
    raw = bytearray()
    for row in rows:
        raw.append(0)                      # filter type: None
        raw += row

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)  # 8-bit, greyscale
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))

    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


# --------------------------------------------------------------------------- #
# scanline polygon fill
# --------------------------------------------------------------------------- #

def _rings(geojson: dict):
    """Yield every linear ring of every (Multi)Polygon feature."""
    for feature in geojson.get("features", []):
        geom = feature.get("geometry") or {}
        kind = geom.get("type")
        if kind == "Polygon":
            for ring in geom["coordinates"]:
                yield ring
        elif kind == "MultiPolygon":
            for poly in geom["coordinates"]:
                for ring in poly["coordinates"] if isinstance(poly, dict) else poly:
                    yield ring


def fill_polygons(geojson: dict, box, width: int, height: int,
                  rows: list[bytearray], value: int) -> int:
    """
    Rasterise all rings with the even-odd rule.

    Exteriors and holes go into one edge list: even-odd then punches holes and
    handles nesting (an island in a lake in an island) without tracking winding.
    An active-edge table keeps this O(edges + crossings) instead of testing every
    edge against every scanline -- the difference between seconds and minutes.
    """
    lon0, lat0, lon1, lat1 = box
    dlon = lon1 - lon0
    dlat = lat1 - lat0

    # Row 0 is the northern edge, matching the natural raster orientation (and
    # three.js's flipY, so v=1 ends up north).
    def to_px(lon, lat):
        return ((lon - lon0) / dlon * width,
                (lat1 - lat) / dlat * height)

    # Bucket each edge by the first scanline it touches.
    starts: dict[int, list] = {}
    edges = 0
    for ring in _rings(geojson):
        pts = [to_px(c[0], c[1]) for c in ring if len(c) >= 2]
        n = len(pts)
        if n < 3:
            continue
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            if y0 == y1:
                continue                   # horizontal edges contribute nothing
            if y0 > y1:
                x0, y0, x1, y1 = x1, y1, x0, y0
            y_start = max(0, int(y0 + 0.5))
            y_end = min(height - 1, int(y1 - 0.5))
            if y_end < y_start:
                continue
            slope = (x1 - x0) / (y1 - y0)
            starts.setdefault(y_start, []).append([y_end, x0 + (y_start + 0.5 - y0) * slope, slope])
            edges += 1

    active: list = []
    for y in range(height):
        if y in starts:
            active += starts.pop(y)
        if not active:
            continue

        xs = sorted(e[1] for e in active)
        row = rows[y]
        for i in range(0, len(xs) - 1, 2):
            a = int(xs[i] + 0.5)
            b = int(xs[i + 1] + 0.5)
            if b <= 0 or a >= width:
                continue
            a = max(a, 0)
            b = min(b, width)
            if b > a:
                row[a:b] = bytes([value]) * (b - a)

        # Advance and retire.
        keep = []
        for e in active:
            if e[0] > y:
                e[1] += e[2]
                keep.append(e)
        active = keep

    return edges


def build_land_mask(land_path: str, lakes_path: str | None, box,
                    width: int, height: int, out_path: str) -> dict:
    with open(land_path, "r", encoding="utf-8") as fh:
        land = json.load(fh)

    rows = [bytearray(width) for _ in range(height)]
    n_land = fill_polygons(land, box, width, height, rows, LAND)

    n_lake = 0
    if lakes_path and os.path.exists(lakes_path):
        with open(lakes_path, "r", encoding="utf-8") as fh:
            lakes = json.load(fh)
        # Lakes are cut back out so inland water reads as water, not land.
        n_lake = fill_polygons(lakes, box, width, height, rows, WATER)

    size = write_gray_png(out_path, width, height, rows)
    land_px = sum(1 for row in rows for v in row if v)
    return {
        "path": os.path.basename(out_path),
        "width": width, "height": height,
        "bytes": size,
        "land_edges": n_land, "lake_edges": n_lake,
        "land_fraction": round(land_px / (width * height), 4),
    }
