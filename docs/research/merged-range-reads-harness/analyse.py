#!/usr/bin/env python3
"""Bucket the stand-in's access log by the driver's phase windows.

Usage: analyse.py RUN_DIR [RUN_DIR ...]

For each run prints, per phase, the chunk range requests the backend saw,
the distinct shard objects they touched, the bytes moved, and requests per
second over the phase window. A chunk request is a 206 to a path under a
level directory (`/<level>/c/...`); everything else (the open's metadata
reads, the 404 probes) is counted apart. The last line per run is the
request-size distribution, which is where a merge shows: a single inner
chunk is a few kilobytes and a merged request is many of them.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CHUNK_PATH = re.compile(r"/\d+/c/")
PHASES = ["cold", "idle", "pan", "zoom", "warm"]


def load(run_dir: Path):
    summary = json.loads((run_dir / "rr-summary.json").read_text())
    windows = summary.get("windows", {})
    rows = []
    for line in (run_dir / "access.log").read_text().splitlines():
        ts, method, status, path, rng, size = line.split(" ", 5)
        rows.append((int(ts), method, int(status), path, rng, int(size)))
    return summary, windows, rows


def is_chunk(row):
    return row[2] == 206 and CHUNK_PATH.search(row[3]) is not None


def bucket(rows, windows):
    per = {}
    for phase in PHASES:
        w = windows.get(phase)
        if not w or "start" not in w or "end" not in w:
            continue
        start, end = w["start"], w["end"]
        inside = [r for r in rows if start <= r[0] <= end]
        chunk = [r for r in inside if is_chunk(r)]
        secs = max((end - start) / 1000.0, 1e-9)
        per[phase] = {
            "window_s": secs,
            "chunk_requests": len(chunk),
            "chunk_objects": len({r[3] for r in chunk}),
            "chunk_bytes": sum(r[5] for r in chunk),
            "chunk_rps": len(chunk) / secs,
            "other_requests": len(inside) - len(chunk),
        }
    return per


def main():
    for arg in sys.argv[1:]:
        run_dir = Path(arg)
        summary, windows, rows = load(run_dir)
        per = bucket(rows, windows)
        total_chunk = [r for r in rows if is_chunk(r)]
        ready = summary.get("ready", {})
        print(f"== {run_dir.name}  dpr={summary.get('dpr')}  "
              f"ready(cold)={ready.get('cold', {}).get('reason')}  "
              f"ready(warm)={ready.get('warm', {}).get('reason')}")
        print(f"   total chunk range requests: {len(total_chunk)}  bytes: {sum(r[5] for r in total_chunk)}  "
              f"all requests: {len(rows)}")
        print(f"   {'phase':6} {'window_s':>9} {'requests':>9} {'objects':>8} {'bytes':>10} {'req/s':>7} {'other':>6}")
        for phase, m in per.items():
            print(f"   {phase:6} {m['window_s']:9.1f} {m['chunk_requests']:9d} {m['chunk_objects']:8d} "
                  f"{m['chunk_bytes']:10d} {m['chunk_rps']:7.1f} {m['other_requests']:6d}")
        sizes = sorted(r[5] for r in total_chunk)
        if sizes:
            def pct(p):
                return sizes[min(len(sizes) - 1, int(p * len(sizes)))]
            print(f"   chunk request bytes p50={pct(0.5)} p90={pct(0.9)} max={sizes[-1]}")
        print()


if __name__ == "__main__":
    main()
