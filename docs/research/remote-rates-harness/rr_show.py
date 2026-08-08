#!/usr/bin/env python3
"""Issue #899 — summarise one `rr_run.py` output directory.

Joins the client-side `rr-summary.json` counters with the server-side
`RRGET` / `RRBAK` / `RRSRV` lines in `server.log`, bucketing the server lines
into the driver's per-phase wall-clock windows.

Usage: python3 rr_show.py OUT_DIR
"""
from __future__ import annotations
import json, sys
from pathlib import Path

OUT = Path(sys.argv[1])
summary = json.loads((OUT / "rr-summary.json").read_text())
windows = summary.get("windows", {})


def pct(sorted_vals, p):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, int(p * len(sorted_vals)))
    return sorted_vals[i]


def dist(vals, scale=1.0, unit=""):
    if not vals:
        return "n=0"
    s = sorted(vals)
    f = lambda v: f"{v * scale:.1f}"
    return (f"n={len(s)} min={f(s[0])} p50={f(pct(s,.5))} p90={f(pct(s,.9))} "
            f"p95={f(pct(s,.95))} p99={f(pct(s,.99))} max={f(s[-1])}{unit}")


# ---- server side ------------------------------------------------------------
gets, baks, srvs = [], [], []
for line in (OUT / "server.log").read_text(errors="replace").splitlines():
    p = line.split()
    if not p:
        continue
    if p[0] == "RRGET" and len(p) == 5:
        gets.append((int(p[1]), p[2], int(p[3]), int(p[4])))
    elif p[0] == "RRBAK" and len(p) == 8:
        baks.append((int(p[1]), int(p[2]), int(p[3]), int(p[4]), int(p[5]), int(p[6]), p[7]))
    elif p[0] == "RRSRV" and len(p) == 6:
        srvs.append((int(p[1]), int(p[2]), int(p[3]), int(p[4]), int(p[5])))


def in_window(t_us, w):
    return w["start"] * 1000 <= t_us <= w["end"] * 1000


phase_names = list(windows.keys())
print("=" * 78)
print("SERVER-SIDE SOURCE READS (lucida-store), per phase")
print("=" * 78)
for name in ["(all)"] + phase_names:
    w = windows.get(name)
    g = [x for x in gets if w is None or in_window(x[0], w)]
    b = [x for x in baks if w is None or in_window(x[0], w)]
    s = [x for x in srvs if w is None or in_window(x[0], w)]
    outcomes = {}
    for x in g:
        outcomes[x[1]] = outcomes.get(x[1], 0) + 1
    print(f"\n-- {name}: get_bytes={len(g)} {outcomes}  backend_reads={len(b)} serves={len(s)}")
    if b:
        print(f"   permit wait ms : {dist([x[1] for x in b], 1e-3)}")
        print(f"   TTFB ms        : {dist([x[2] for x in b], 1e-3)}")
        print(f"   body ms        : {dist([x[3] for x in b], 1e-3)}")
        print(f"   full read ms   : {dist([x[2] + x[3] for x in b], 1e-3)}")
        print(f"   wire+permit ms : {dist([x[1] + x[2] + x[3] for x in b], 1e-3)}")
        print(f"   bytes          : {dist([x[4] for x in b], 1/1024, ' KiB')}")
        print(f"   inflight       : {dist([float(x[5]) for x in b])}")
        print(f"   errors         : {sum(1 for x in b if x[6] != 'ok')}")
        span = (max(x[0] for x in b) - min(x[0] for x in b)) / 1e6
        if span > 0:
            print(f"   backend reads/s: {len(b)/span:.1f} over {span:.1f}s")
    hits = [x for x in g if x[1] == "hit"]
    if hits:
        print(f"   cache-hit us   : {dist([float(x[2]) for x in hits])}")
        print(f"   hit <100us     : {sum(1 for x in hits if x[2] < 100)}/{len(hits)}")
    if s:
        print(f"   serve total ms : {dist([x[3] for x in s], 1e-3)}")
        print(f"   decode ms      : {dist([x[2] for x in s], 1e-3)}")
        print(f"   decode <100us  : {sum(1 for x in s if x[2] < 100)}/{len(s)}")

# ---- client side ------------------------------------------------------------
print()
print("=" * 78)
print("CLIENT-SIDE PIPELINE (window.__tv), per phase")
print("=" * 78)
KEYS = ["plan.chunk_emitted", "cache.request", "cache.hit", "fetch.issued",
        "fetch.completed", "decode.completed", "upload.posted", "cache.evict",
        "loop.tick", "loop.render_frame", "plan.full_rebuild", "plan.served_cached",
        "sched.cap_blocked", "fetch.retry_scheduled", "fetch.retry_attempt",
        "fetch.error.transient", "fetch.error.permanent", "fetch.error.abort",
        "fetch.error.pending", "fetch.error.server_reported"]
for name, ph in summary["phases"].items():
    print(f"\n-- {name}: elapsed={ph.get('elapsed_ms',0)/1000:.1f}s "
          f"first_render_ms={ph.get('first_render_ms')}")
    tot, peak = ph.get("totals", {}), ph.get("peak_per_sec", {})
    for k in KEYS:
        if k in tot:
            print(f"   {k:<32} total={tot[k]:<10} peak/s={peak.get(k,0)}")
    for k, v in sorted(ph.get("sample_stats", {}).items()):
        print(f"   [dist] {k:<26} n={v['n']:<7} p50={v['p50']:.4g} p95={v['p95']:.4g} "
              f"p99={v.get('p99',float('nan')):.4g} max={v['max']:.4g} "
              f"<0.1ms={v.get('under_0_1ms')}")
