#!/usr/bin/env python3
"""
One-shot data refresh: pull new/revised events, then rebuild the web payload.

    python scripts/update.py              # incremental (normal use)
    python scripts/update.py --full       # rescan the whole configured range
    python scripts/update.py --resume     # continue an interrupted scan
    python scripts/update.py --build-only # rebuild from the existing catalog

Safe to run on a schedule -- see README.md for the Windows Task Scheduler line.
Every run appends a line to data/raw/update_history.log.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY = os.path.join(ROOT, "data", "raw", "update_history.log")
STATE = os.path.join(ROOT, "data", "raw", "fetch_state.json")
CHANGES = os.path.join(ROOT, "data", "raw", "last_changes.json")


def run(script: str, extra: list[str]) -> int:
    cmd = [sys.executable, os.path.join(ROOT, "scripts", script), *extra]
    print(f"\n$ {' '.join(cmd[1:])}\n", flush=True)
    return subprocess.call(cmd, cwd=ROOT)


def event_count() -> int | None:
    try:
        with open(STATE, "r", encoding="utf-8") as fh:
            return json.load(fh).get("event_count")
    except (OSError, ValueError):
        return None


def note(line: str) -> None:
    os.makedirs(os.path.dirname(HISTORY), exist_ok=True)
    with open(HISTORY, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def read_changes() -> dict | None:
    try:
        with open(CHANGES, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def show_changes() -> int:
    """Re-print the report from the most recent fetch."""
    data = read_changes()
    if not data:
        print("no change report yet -- run an update first")
        return 1

    c = data.get("counts", {})
    print(f"last run   : {data.get('run_utc')}  (mode={data.get('mode')})")
    win = data.get("window") or ["?", "?"]
    print(f"window     : {win[0]} .. {win[1]}")
    print(f"fetched    : {c.get('fetched', 0)} rows")
    print(f"new        : {c.get('added', 0)}")
    print(f"revised    : {c.get('revised', 0)}")
    print(f"removed    : {c.get('removed', 0)}  (superseded when the ISC/USGS boundary moved)")
    print(f"metadata   : {c.get('metadata_only', 0)}  (record touched, solution unchanged)")

    if data.get("initial_import"):
        print("\n(initial import -- nothing to diff against)")
        return 0

    for row in sorted(data.get("added", []), key=lambda r: r["time"]):
        print(f"  + {row['time'][:16].replace('T', ' ')}  M{row.get('mag', '?'):<4}"
              f"  {row.get('place', '')}  [{row['id']}]")

    for ev in sorted(data.get("revised", []), key=lambda r: r["time"]):
        print(f"  ~ {ev['time'][:16].replace('T', ' ')}  M{ev.get('mag', '?'):<4}"
              f"  {ev.get('place', '')}  [{ev['id']}]")
        for field, (before, after) in (ev.get("changes") or {}).items():
            if field == "updated":
                continue
            print(f"      {field:<10} {before or '(none)'}  ->  {after or '(none)'}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Refresh the catalog and rebuild the viewer payload.")
    ap.add_argument("--full", action="store_true", help="rescan the entire configured range")
    ap.add_argument("--resume", action="store_true", help="continue an interrupted scan")
    ap.add_argument("--build-only", action="store_true", help="skip fetching")
    ap.add_argument("--changes", action="store_true",
                    help="just re-print the report from the last run and exit")
    ap.add_argument("--detect-handoff", action="store_true",
                    help="re-probe the ISC/USGS boundary and extend ISC coverage")
    args = ap.parse_args()

    if args.changes:
        return show_changes()

    started = datetime.now(timezone.utc)
    before = event_count()

    if not args.build_only:
        extra = []
        if args.full:
            extra.append("--full")
        if args.resume:
            extra.append("--resume")
        if args.detect_handoff:
            extra.append("--detect-handoff")
        rc = run("fetch_quakes.py", extra)
        if rc != 0:
            note(f"{started.isoformat(timespec='seconds')}  FETCH FAILED rc={rc}")
            print("\n[update] fetch failed -- the previous payload is left untouched.")
            print("[update] rerun with --resume to continue from the last checkpoint.")
            return rc

    rc = run("build_data.py", [])
    if rc != 0:
        note(f"{started.isoformat(timespec='seconds')}  BUILD FAILED rc={rc}")
        return rc

    after = event_count()
    delta = "" if before is None or after is None else f" ({after - before:+d})"
    took = (datetime.now(timezone.utc) - started).total_seconds()
    mode = 'build-only' if args.build_only else ('full' if args.full else 'incremental')

    c = (read_changes() or {}).get("counts", {}) if not args.build_only else {}
    detail = (f"  new={c.get('added', 0)} revised={c.get('revised', 0)}"
              f" meta={c.get('metadata_only', 0)}" if c else "")
    note(f"{started.isoformat(timespec='seconds')}  ok  events={after}{delta}"
         f"  {took:.0f}s  mode={mode}{detail}")

    print(f"\n[update] done in {took:.0f}s -- catalog holds {after} events{delta}")
    if c:
        print(f"[update] {c.get('added', 0)} new | {c.get('revised', 0)} revised"
              f" | {c.get('metadata_only', 0)} metadata-only")
        print("[update] item-by-item report:  update.bat --changes")
    print("[update] reload the page (Ctrl+F5) to see the new data.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
