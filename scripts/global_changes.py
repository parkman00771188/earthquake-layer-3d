#!/usr/bin/env python3
"""
Change tracking for the worldwide catalogues.

The global fetchers refetch a rewound live tail on every run; this module
diffs the refetched rows against what that tail held before, so an update
can say what actually arrived -- the same job last_changes.json does for
the Japan pipeline.

    python scripts/global_changes.py      # re-print the last run's report

Each fetcher writes data/raw/global/last_changes_<source>.json via record();
report() merges both files into one human-readable summary.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "global")

NOTABLE_MAG = 5.5          # added events at/above this are listed one by one
MAX_LISTED = 40


def _path(source: str) -> str:
    return os.path.join(RAW, f"last_changes_{source}.json")


def record(source: str, dropped: dict[str, dict], appended: dict[str, dict]) -> dict:
    """
    Diff the refetched tail against the rows it replaced and persist the result.

    dropped:  id -> row  (what truncate_from removed before refetching)
    appended: id -> row  (what the fetch loop wrote back for the same stretch)
    """
    added, revised = [], []
    for eid, row in appended.items():
        old = dropped.get(eid)
        if old is None:
            added.append(row)
        elif any(str(old.get(k)) != str(row.get(k))
                 for k in ("time", "latitude", "longitude", "depth", "mag")):
            revised.append(row)
    removed = [row for eid, row in dropped.items() if eid not in appended]

    out = {
        "run_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "counts": {"added": len(added), "revised": len(revised),
                   "removed": len(removed)},
        # Only notable rows are kept verbatim; the full lists would be huge.
        "added_notable": sorted(
            (r for r in added if float(r.get("mag") or 0) >= NOTABLE_MAG),
            key=lambda r: r["time"])[:MAX_LISTED],
    }
    with open(_path(source), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    return out


def report() -> int:
    """Print the merged summary from the most recent global fetches."""
    any_found = False
    notable = []
    for source in ("usgs", "isc"):
        try:
            with open(_path(source), encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        any_found = True
        c = data.get("counts", {})
        print(f"[global] {source.upper():<4} {data.get('run_utc', '?')} :"
              f"  new={c.get('added', 0)}  revised={c.get('revised', 0)}"
              f"  removed={c.get('removed', 0)}")
        for row in data.get("added_notable", []):
            notable.append((row["time"], source, row))
    if not any_found:
        print("[global] no change report yet -- run update_global.bat first")
        return 1
    if notable:
        print(f"[global] notable new events (M{NOTABLE_MAG}+):")
        for t, source, row in sorted(notable):
            print(f"  + {t[:16].replace('T', ' ')}  M{float(row['mag']):<4}"
                  f"  lat {float(row['latitude']):7.2f}  lon {float(row['longitude']):8.2f}"
                  f"  [{source} {row.get('id', '?')}]")
    return 0


if __name__ == "__main__":
    sys.exit(report())
