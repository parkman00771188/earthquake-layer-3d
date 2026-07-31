#!/usr/bin/env python3
"""
Build and maintain the master earthquake catalog for the configured region by
stitching two FDSN sources together.

    python scripts/fetch_quakes.py                  # incremental (USGS tail only)
    python scripts/fetch_quakes.py --full           # rebuild both windows
    python scripts/fetch_quakes.py --resume         # continue an interrupted scan
    python scripts/fetch_quakes.py --detect-handoff # re-find the ISC/USGS boundary
    python scripts/fetch_quakes.py --from 2020-01-01 --to 2021-01-01

Why two sources
---------------
USGS ComCat is current to yesterday but contains *nothing* below M3 around Japan
(its M2.0+, M2.5+ and M3.0+ counts for this box are identical). The small events
come from JMA, which reaches ISC's reviewed Bulletin with roughly a 20-month lag.
So the catalog is split at `catalog.handoff`:

    1975 ─────────── ISC (M2+, ~870k) ─────────── handoff ── USGS (M3+) ── now

Because the two windows do not overlap in time, the same earthquake can never be
counted twice under its ISC id and its USGS id.

The catalog lives at data/raw/catalog.csv, keyed by source-prefixed event id, and
is checkpointed after every yearly slice: an interrupted run loses at most one
year and --resume picks up exactly where it stopped.

Only the Python standard library is used -- no pip install required.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
CATALOG_PATH = os.path.join(ROOT, "data", "raw", "catalog.csv")
STATE_PATH = os.path.join(ROOT, "data", "raw", "fetch_state.json")
CHANGES_PATH = os.path.join(ROOT, "data", "raw", "last_changes.json")

# Columns kept in the master catalog.
FIELDS = ["id", "source", "time", "latitude", "longitude", "depth",
          "mag", "magType", "place", "updated"]

# A change in one of these means the event itself was revised. A change in only
# `updated` means the agency touched the record without altering the solution.
SIGNIFICANT = ("time", "latitude", "longitude", "depth", "mag", "magType", "place")

USER_AGENT = "japan-quake-4d/2.0 (local 3D catalog viewer; python stdlib urllib)"

SMALL_MAG = 3.0          # "small" for handoff detection: below USGS's floor here


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_config(cfg: dict) -> None:
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, CONFIG_PATH)


def parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 timestamp (with or without 'Z') as aware UTC."""
    value = value.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def log(msg: str) -> None:
    print(msg, flush=True)


def month_start(dt: datetime) -> datetime:
    return dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def add_months(dt: datetime, n: int) -> datetime:
    m = dt.month - 1 + n
    return dt.replace(year=dt.year + m // 12, month=m % 12 + 1)


# --------------------------------------------------------------------------- #
# source adapters
# --------------------------------------------------------------------------- #

class LimitExceeded(Exception):
    """The server refused the query because too many events matched."""


def parse_usgs_csv(body: str, eventtype: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(body)):
        if not r.get("id") or not r.get("time"):
            continue
        if not r.get("mag") or not r.get("depth"):
            continue
        if eventtype and (r.get("type") or eventtype) != eventtype:
            continue
        rows.append({
            "id": f"usgs:{r['id']}",
            "source": "usgs",
            "time": r["time"],
            "latitude": r["latitude"],
            "longitude": r["longitude"],
            "depth": r["depth"],
            "mag": r["mag"],
            "magType": r.get("magType", ""),
            "place": r.get("place", ""),
            "updated": r.get("updated", ""),
        })
    return rows


# ISC `format=text` is pipe-delimited with a leading '#' header line:
# EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|
# ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType
ISC_COLS = 14


def parse_isc_text(body: str, eventtype: str) -> list[dict]:
    rows = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        f = [c.strip() for c in line.split("|")]
        if len(f) < ISC_COLS:
            continue
        if eventtype and f[13] and f[13] != eventtype:
            continue
        if not f[0] or not f[1] or not f[10] or not f[4]:
            continue                       # need id, time, magnitude, depth
        rows.append({
            "id": f"isc:{f[0]}",
            "source": "isc",
            "time": f[1] if f[1].endswith("Z") else f[1] + "Z",
            "latitude": f[2],
            "longitude": f[3],
            "depth": f[4],
            "mag": f[10],
            "magType": f[9],
            "place": f[12],
            "updated": "",                 # ISC text output carries no mtime
        })
    return rows


PARSERS = {"usgs-csv": parse_usgs_csv, "isc-text": parse_isc_text}


def request_events(cfg: dict, src: dict, start: datetime, end: datetime,
                   limit: int, minmag: float | None = None) -> list[dict]:
    region = cfg["region"]
    params = {
        "starttime": iso(start),
        "endtime": iso(end),
        "minlatitude": region["minlatitude"],
        "maxlatitude": region["maxlatitude"],
        "minlongitude": region["minlongitude"],
        "maxlongitude": region["maxlongitude"],
        "minmagnitude": minmag if minmag is not None else src["minmagnitude"],
        "format": "csv" if src["format"] == "usgs-csv" else "text",
        "limit": limit,
    }
    if src["format"] == "usgs-csv":
        params["orderby"] = "time-asc"
        if cfg["catalog"].get("eventtype"):
            params["eventtype"] = cfg["catalog"]["eventtype"]

    url = src["endpoint"] + "?" + urllib.parse.urlencode(params)
    retries = int(cfg["update"].get("retries", 4))
    timeout = int(src.get("request_timeout_sec", 300))

    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
            break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            # 413 always means "your result set is too big" -- ISC returns it
            # with its own wording ("The number of events returned, 59692
            # exceeds 55000"), so match the status code rather than the prose.
            # Retrying a 413 is pointless; the window has to be split.
            if exc.code == 413 or (exc.code == 400 and (
                    "exceeds" in detail.lower() or "too many" in detail.lower())):
                raise LimitExceeded(f"HTTP {exc.code}: {detail.strip()[:160]}") from exc
            if exc.code == 204:            # no content == no events
                return []
            last_err = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_err = exc
        wait = 5 * (attempt + 1)
        log(f"    ! request failed ({last_err}); retrying in {wait}s")
        time.sleep(wait)
    else:
        raise RuntimeError(f"giving up on {iso(start)}..{iso(end)}: {last_err}")

    pause = float(src.get("pause_between_requests_sec", 0))
    if pause:
        time.sleep(pause)                  # be a courteous client
    return PARSERS[src["format"]](body, cfg["catalog"].get("eventtype", ""))


def fetch_range(cfg: dict, src: dict, start: datetime, end: datetime,
                depth: int = 0) -> list[dict]:
    """Fetch [start, end) from one source, halving the window if it is too big."""
    limit = int(src.get("max_events_per_request", 18000))
    indent = "  " * (depth + 1)

    try:
        rows = request_events(cfg, src, start, end, limit)
        too_many = len(rows) >= limit
    except LimitExceeded:
        rows, too_many = [], True

    if too_many:
        span = end - start
        if span <= timedelta(hours=1):
            log(f"{indent}! window {iso(start)}..{iso(end)} saturated; keeping {len(rows)}")
            return rows
        mid = start + span / 2
        log(f"{indent}~ {iso(start)}..{iso(end)} exceeds the server limit, splitting")
        return (fetch_range(cfg, src, start, mid, depth + 1)
                + fetch_range(cfg, src, mid, end, depth + 1))

    log(f"{indent}{iso(start)} .. {iso(end)}  ->  {len(rows):>7} events")
    return rows


# --------------------------------------------------------------------------- #
# handoff detection
# --------------------------------------------------------------------------- #

def detect_handoff(cfg: dict) -> datetime:
    """
    Find the first month where ISC has stopped carrying JMA's small events.

    Probes month-long windows counting events below M3 -- a magnitude USGS never
    reports here, so their presence is a reliable marker of JMA coverage. Binary
    search over the last `handoff_probe_months` keeps this to ~6 requests.
    """
    src = cfg["sources"]["isc"]
    threshold = int(cfg["update"].get("handoff_min_small_events", 100))
    months_back = int(cfg["update"].get("handoff_probe_months", 36))
    now = month_start(datetime.now(timezone.utc))

    def covered(m: datetime) -> bool:
        rows = request_events(cfg, src, m, add_months(m, 1), 20000, minmag=2.0)
        n = sum(1 for r in rows if float(r["mag"]) < SMALL_MAG)
        log(f"    probe {m:%Y-%m}: {n} events below M{SMALL_MAG}"
            f" -> {'JMA present' if n >= threshold else 'no JMA'}")
        return n >= threshold

    lo = add_months(now, -months_back)     # assumed covered
    hi = now                               # assumed not covered
    if not covered(lo):
        log(f"[handoff] even {lo:%Y-%m} lacks JMA data; leaving the boundary alone")
        return parse_iso(cfg["catalog"]["handoff"])
    if covered(add_months(hi, -1)):
        return hi                          # ISC has caught up to last month

    while add_months(lo, 1) < hi:
        mid = lo + (hi - lo) / 2
        mid = month_start(mid)
        if mid <= lo:
            break
        if covered(mid):
            lo = mid
        else:
            hi = mid
    return add_months(lo, 1)               # first uncovered month


# --------------------------------------------------------------------------- #
# catalog I/O
# --------------------------------------------------------------------------- #

def read_catalog() -> dict[str, dict]:
    if not os.path.exists(CATALOG_PATH):
        return {}
    out: dict[str, dict] = {}
    with open(CATALOG_PATH, "r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("id"):
                out[row["id"]] = {k: (row.get(k) or "") for k in FIELDS}
    return out


def write_catalog(events: dict[str, dict]) -> None:
    ordered = sorted(events.values(), key=lambda r: (r["time"], r["id"]))
    os.makedirs(os.path.dirname(CATALOG_PATH), exist_ok=True)
    tmp = CATALOG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(ordered)
    os.replace(tmp, CATALOG_PATH)


def drop_window(events: dict[str, dict], source: str,
                start: datetime, end: datetime) -> int:
    """Remove a source's rows inside [start, end) -- used when the handoff moves."""
    lo, hi = iso(start), iso(end)
    doomed = [k for k, r in events.items()
              if r["source"] == source and lo <= r["time"][:19] < hi]
    for k in doomed:
        del events[k]
    return len(doomed)


# --------------------------------------------------------------------------- #
# change tracking
# --------------------------------------------------------------------------- #

class ChangeLog:
    """
    Records what a run actually altered, so an update can report *which* events
    arrived and *which fields* moved -- not just how many.

    The per-event lists are capped: a first-time import would otherwise dump the
    whole catalogue into the report.
    """

    LIST_CAP = 400

    # Above this many additions the run was a bulk scan, not an update, and an
    # item-by-item "new events" list is noise rather than news.
    BULK_THRESHOLD = 10_000

    def __init__(self) -> None:
        self.added: list[dict] = []
        self.revised: list[dict] = []
        self.added_total = 0
        self.revised_total = 0
        self.removed_total = 0
        self.metadata_only = 0
        self.fetched = 0
        self.initial_import = False

    def record_add(self, row: dict) -> None:
        self.added_total += 1
        if len(self.added) < self.LIST_CAP:
            self.added.append(dict(row))

    def record_revision(self, prev: dict, row: dict) -> None:
        diff = {k: [prev.get(k, ""), row.get(k, "")]
                for k in FIELDS if prev.get(k, "") != row.get(k, "")}
        if not diff:
            return
        if not any(k in SIGNIFICANT for k in diff):
            self.metadata_only += 1
            return
        self.revised_total += 1
        if len(self.revised) < self.LIST_CAP:
            self.revised.append({
                "id": row["id"],
                "time": row["time"],
                "mag": row.get("mag", ""),
                "place": row.get("place", ""),
                "changes": diff,
            })

    @property
    def bulk(self) -> bool:
        """A first import or a wholesale rescan, rather than a routine update."""
        return self.initial_import or self.added_total >= self.BULK_THRESHOLD

    @property
    def truncated(self) -> bool:
        if self.bulk:
            return self.revised_total > len(self.revised)
        return (self.added_total > len(self.added)
                or self.revised_total > len(self.revised))

    def as_dict(self) -> dict:
        return {
            "counts": {
                "fetched": self.fetched,
                "added": self.added_total,
                "revised": self.revised_total,
                "removed": self.removed_total,
                "metadata_only": self.metadata_only,
            },
            # Revisions stay listed either way -- those are always interesting.
            "initial_import": self.bulk,
            "listed_cap": self.LIST_CAP,
            "truncated": self.truncated,
            "added": [] if self.bulk else self.added,
            "revised": self.revised,
        }


def merge(existing: dict[str, dict], incoming: list[dict],
          changes: ChangeLog) -> tuple[int, int]:
    added = revised = 0
    for row in incoming:
        prev = existing.get(row["id"])
        if prev is None:
            existing[row["id"]] = row
            changes.record_add(row)
            added += 1
        elif prev != row:
            changes.record_revision(prev, row)
            existing[row["id"]] = row
            revised += 1
    return added, revised


def write_changes(changes: ChangeLog, mode: str, start: datetime, end: datetime,
                  event_count: int) -> None:
    payload = {
        "run_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "mode": mode,
        "window": [iso(start), iso(end)],
        "event_count_after": event_count,
        **changes.as_dict(),
    }
    tmp = CHANGES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, CHANGES_PATH)


def stamp(t: str) -> str:
    return t[:16].replace("T", " ")


def report_changes(changes: ChangeLog) -> None:
    if changes.bulk:
        log(f"[changes] bulk scan: {changes.added_total} events added"
            f" -- per-event list omitted")
        if changes.revised_total:
            log(f"[changes] {changes.revised_total} existing events were also revised")
        else:
            return

    if not (changes.added_total or changes.revised_total
            or changes.metadata_only or changes.removed_total):
        log("[changes] nothing new or revised")
        return

    log(f"[changes] {changes.added_total} new | {changes.revised_total} revised"
        f" | {changes.removed_total} removed | {changes.metadata_only} metadata-only")

    if changes.added:
        more = (f" -- first {len(changes.added)} shown"
                if changes.added_total > len(changes.added) else "")
        log(f"\n  NEW ({changes.added_total}){more}")
        for row in sorted(changes.added, key=lambda r: r["time"]):
            depth = f"{float(row['depth']):.0f}km" if row.get("depth") else "?"
            log(f"    + {stamp(row['time'])}  M{row.get('mag', '?'):<4} {depth:>6}"
                f"  {row.get('place', '')}  [{row['id']}]")

    if changes.revised:
        more = (f" -- first {len(changes.revised)} shown"
                if changes.revised_total > len(changes.revised) else "")
        log(f"\n  REVISED ({changes.revised_total}){more}")
        for ev in sorted(changes.revised, key=lambda r: r["time"]):
            log(f"    ~ {stamp(ev['time'])}  M{ev.get('mag', '?'):<4}"
                f"  {ev.get('place', '')}  [{ev['id']}]")
            for field, (before, after) in ev["changes"].items():
                if field == "updated":
                    continue               # the revision timestamp is not the news
                log(f"        {field:<10} {before or '(none)'}  ->  {after or '(none)'}")


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #

def read_state() -> dict:
    if not os.path.exists(STATE_PATH):
        return {}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(cfg: dict, events: dict[str, dict], mode: str,
               plan_key: str, completed_through: datetime, finished: bool) -> None:
    times = [r["time"] for r in events.values()]
    per_source: dict[str, int] = {}
    for r in events.values():
        per_source[r["source"]] = per_source.get(r["source"], 0) + 1

    state = {
        "mode_of_last_run": mode,
        "last_run_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "event_count": len(events),
        "per_source": per_source,
        "catalog_start": min(times) if times else None,
        "catalog_end": max(times) if times else None,
        "handoff": cfg["catalog"]["handoff"],
        # Progress bookkeeping so an interrupted scan can be resumed.
        "plan_key": plan_key,
        "completed_through": iso(completed_through),
        "scan_finished": finished,
        "region": cfg["region"],
        "minmagnitude": {k: v["minmagnitude"] for k, v in cfg["sources"].items()},
    }
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, STATE_PATH)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def yearly_slices(start: datetime, end: datetime):
    cursor = start
    while cursor < end:
        nxt = min(cursor.replace(year=cursor.year + 1, month=1, day=1,
                                 hour=0, minute=0, second=0, microsecond=0), end)
        if nxt <= cursor:                  # start is already Jan 1
            nxt = min(cursor.replace(year=cursor.year + 1), end)
        yield cursor, nxt
        cursor = nxt


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Fetch/refresh the earthquake catalog.")
    ap.add_argument("--full", action="store_true",
                    help="scan both source windows end to end")
    ap.add_argument("--resume", action="store_true",
                    help="continue an interrupted scan from its checkpoint")
    ap.add_argument("--reset", action="store_true",
                    help="discard the existing catalog first (implies --full)")
    ap.add_argument("--detect-handoff", action="store_true",
                    help="re-probe the ISC/USGS boundary, then extend ISC coverage")
    ap.add_argument("--from", dest="start", help="explicit start date (YYYY-MM-DD)")
    ap.add_argument("--to", dest="end", help="explicit end date (YYYY-MM-DD)")
    args = ap.parse_args(argv)

    cfg = load_config()
    now = datetime.now(timezone.utc)
    state = read_state()
    existing = {} if args.reset else read_catalog()
    changes = ChangeLog()
    changes.initial_import = not existing

    catalog_start = parse_iso(cfg["catalog"]["starttime"])
    handoff = parse_iso(cfg["catalog"]["handoff"])
    isc, usgs = cfg["sources"]["isc"], cfg["sources"]["usgs"]

    # ── optionally move the boundary forward ───────────────────
    if args.detect_handoff:
        log("[handoff] probing ISC for JMA coverage")
        found = detect_handoff(cfg)
        if found > handoff:
            log(f"[handoff] boundary moves {handoff:%Y-%m-%d} -> {found:%Y-%m-%d}")
            gone = drop_window(existing, "usgs", handoff, found)
            changes.removed_total += gone
            log(f"[handoff] dropped {gone} USGS rows now superseded by ISC")
            cfg["catalog"]["handoff"] = found.strftime("%Y-%m-%d")
            save_config(cfg)
            handoff = found
        else:
            log(f"[handoff] unchanged at {handoff:%Y-%m-%d}")

    # ── decide what to fetch ───────────────────────────────────
    # A plan is a list of (source, start, end) windows walked in order.
    plan_key = f"isc<{handoff:%Y-%m-%d}|usgs>={handoff:%Y-%m-%d}"
    end_all = parse_iso(args.end) if args.end else now + timedelta(days=1)

    if args.start:
        mode = "manual"
        s = parse_iso(args.start)
        plan = ([("isc", s, min(end_all, handoff))] if s < handoff else []) \
             + ([("usgs", max(s, handoff), end_all)] if end_all > handoff else [])
    elif args.resume or (not args.full and not args.reset
                         and state.get("plan_key") == plan_key
                         and not state.get("scan_finished", True)):
        mode = "resume"
        through = parse_iso(state.get("completed_through") or cfg["catalog"]["starttime"])
        log(f"[fetch] resuming an incomplete scan from {iso(through)}")
        plan = ([("isc", through, handoff)] if through < handoff else []) \
             + [("usgs", max(through, handoff), end_all)]
    elif args.full or args.reset or not existing or state.get("plan_key") != plan_key:
        mode = "full"
        plan = [("isc", catalog_start, handoff), ("usgs", handoff, end_all)]
    else:
        # Routine update: only the USGS tail can have changed.
        mode = "incremental"
        overlap = int(cfg["update"].get("overlap_days", 45))
        newest = max((r["time"] for r in existing.values() if r["source"] == "usgs"),
                     default=None)
        tail_start = (parse_iso(newest) - timedelta(days=overlap)) if newest else handoff
        plan = [("usgs", max(tail_start, handoff), end_all)]

    log(f"[fetch] mode={mode}  region={cfg['region']['name']}")
    log(f"[fetch] handoff={handoff:%Y-%m-%d}  "
        f"ISC M{isc['minmagnitude']}+ before, USGS M{usgs['minmagnitude']}+ after")
    if existing:
        by_src = {}
        for r in existing.values():
            by_src[r["source"]] = by_src.get(r["source"], 0) + 1
        log(f"[fetch] existing catalog: {len(existing)} events {by_src}")
    for src_id, s, e in plan:
        log(f"[fetch]   plan: {src_id:5} {iso(s)} .. {iso(e)}")

    # ── walk the plan, checkpointing after each yearly slice ───
    total_rows = 0
    completed = plan[0][1] if plan else now
    for src_id, win_start, win_end in plan:
        src = cfg["sources"][src_id]
        if win_start >= win_end:
            continue
        for s, e in yearly_slices(win_start, win_end):
            log(f"  [{src_id} {s.year}]")
            rows = fetch_range(cfg, src, s, e)
            added, revised = merge(existing, rows, changes)
            total_rows += len(rows)
            completed = e

            write_catalog(existing)
            save_state(cfg, existing, mode, plan_key, completed,
                       finished=False)
            log(f"    checkpoint: {len(existing)} events"
                f" (+{added} new, ~{revised} revised)")

    save_state(cfg, existing, mode, plan_key, completed, finished=True)
    changes.fetched = total_rows
    write_changes(changes, mode, plan[0][1] if plan else now, end_all, len(existing))

    log(f"\n[fetch] fetched {total_rows} rows")
    log(f"[fetch] catalog now holds {len(existing)} events"
        f" -> {os.path.relpath(CATALOG_PATH, ROOT)}")
    log("")
    report_changes(changes)
    log(f"\n[changes] full report written to {os.path.relpath(CHANGES_PATH, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
