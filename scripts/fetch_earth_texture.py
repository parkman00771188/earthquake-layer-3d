#!/usr/bin/env python3
"""
Download the satellite basemap textures (NASA Blue Marble Next Generation).

    python scripts/fetch_earth_texture.py [--force]

Two JPEGs from the NASA GIBS WMS service (public domain):
    data/global/earth.jpg   whole Earth, 4096x2048 equirectangular
    data/earth-japan.jpg    the viewer's Japan region (22..48N, 120..152E)

Static artwork -- fetched once and committed; --force refetches.
"""

from __future__ import annotations

import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"

TEXTURES = [
    ("data/global/earth.jpg", "-90,-180,90,180", 4096, 2048),
    ("data/earth-japan.jpg", "22,120,48,152", 2560, 2080),
]


def main() -> int:
    force = "--force" in sys.argv
    for rel, bbox, w, h in TEXTURES:
        dst = os.path.join(ROOT, rel)
        if os.path.exists(dst) and not force:
            print(f"[earth] {rel} exists, skipping (--force to refetch)")
            continue
        qs = urllib.parse.urlencode({
            "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.3.0",
            "LAYERS": "BlueMarble_NextGeneration", "CRS": "EPSG:4326",
            "BBOX": bbox, "WIDTH": w, "HEIGHT": h,
            "FORMAT": "image/jpeg", "STYLES": "",
        })
        print(f"[earth] fetching {rel} ({w}x{h})…")
        with urllib.request.urlopen(f"{WMS}?{qs}", timeout=600) as r, \
                open(dst, "wb") as fh:
            fh.write(r.read())
        print(f"[earth] {rel}: {os.path.getsize(dst) / 1e3:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
