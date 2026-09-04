#!/usr/bin/env python3
"""Was the source-read cap binding? A floor on in-flight reads at the stand-in.

Each request holds the stand-in for at least LATENCY_MS, so the requests that
started in the LATENCY_MS before a given start were still in flight then.
Compared with the server's permit cap (16 by default) this says whether reads
queued at all, which is the condition under which anything merges.

Usage: concurrency.py RUN_DIR [LATENCY_MS]
"""
import re
import sys
from pathlib import Path

run = Path(sys.argv[1])
latency = int(sys.argv[2]) if len(sys.argv) > 2 else 80
chunk_path = re.compile(r"/\d+/c/")
starts = []
for line in (run / "access.log").read_text().splitlines():
    ts, method, status, path, rng, size = line.split(" ", 5)
    if status == "206" and chunk_path.search(path):
        starts.append(int(ts))
starts.sort()
inflight = []
j = 0
for i, t in enumerate(starts):
    while starts[j] < t - latency:
        j += 1
    inflight.append(i - j + 1)
ordered = sorted(inflight)


def pct(p):
    return ordered[min(len(ordered) - 1, int(p * len(ordered)))] if ordered else 0


print(f"{run.name}: chunk requests={len(starts)} in-flight floor p50={pct(0.5)} "
      f"p90={pct(0.9)} max={max(inflight) if inflight else 0}")
