#!/usr/bin/env python3
"""
Snapshot the raw source catalogues into data/raw-archive/ as gzip files.

    python scripts/archive_raw.py

The live CSVs under data/raw/ are the product of hours of API fetching, but
the largest exceeds GitHub's 100 MB per-file cap, so data/raw/ stays out of
the repository. Compressed snapshots go in instead -- they are the disaster
copy. To restore on a fresh machine, gunzip each file back to the path in
ITEMS and rerun update.bat / update_global.bat; the fetchers resume from the
bundled state files.
"""

from __future__ import annotations

import gzip
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "raw-archive")

# (live path, archive name)
ITEMS = [
    ("data/raw/catalog.csv", "japan-catalog.csv.gz"),
    ("data/raw/global/catalog.csv", "global-usgs-catalog.csv.gz"),
    ("data/raw/global/catalog_1900.csv", "global-usgs-catalog-1900.csv.gz"),
    ("data/raw/global/isc_catalog.csv", "global-isc-catalog.csv.gz"),
    ("data/raw/global/isc_catalog_1900.csv", "global-isc-catalog-1900.csv.gz"),
]
STATES = [
    ("data/raw/fetch_state.json", "japan-fetch_state.json"),
    ("data/raw/global/state.json", "global-usgs-state.json"),
    ("data/raw/global/state_1900.json", "global-usgs-state-1900.json"),
    ("data/raw/global/isc_state.json", "global-isc-state.json"),
    ("data/raw/global/isc_state_1900.json", "global-isc-state-1900.json"),
]


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for rel, name in ITEMS:
        src = os.path.join(ROOT, rel)
        if not os.path.exists(src):
            print(f"[archive] - {rel} (absent, skipped)")
            continue
        dst = os.path.join(OUT, name)
        with open(src, "rb") as fi, gzip.open(dst, "wb", compresslevel=6) as fo:
            shutil.copyfileobj(fi, fo, 1 << 20)
        print(f"[archive] {name}: {os.path.getsize(src) / 1e6:.0f} MB "
              f"-> {os.path.getsize(dst) / 1e6:.1f} MB")
    for rel, name in STATES:
        src = os.path.join(ROOT, rel)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(OUT, name))
    print("[archive] done: data/raw-archive/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
