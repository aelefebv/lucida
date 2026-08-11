#!/usr/bin/env python3
"""Read both arms of a recorder A/B run and state the verdict (issue #928).

    python3 docs/perf/recorder-cost/ab_compare.py OUT_DIR

The number to beat comes from #888, which ran this exact shape — same warm
re-open, same ten-second window, at devicePixelRatio 2 — against the debug
panel and measured **1,148 rendered frames either way**. ADR 0049's claim is
that the recorder is unrepresentable at a 100 microsecond clock, so the two
arms should be indistinguishable; a real difference is the claim failing, not
the harness being imprecise.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# #888's precedent: the same shape measured against the debug panel.
PRECEDENT_FRAMES = 1148

# What counts as indistinguishable. Frame counts over a ten-second drive swing
# by a few percent between identical runs on the same machine, so a tighter
# band would report noise as a regression and a looser one would miss a real
# per-frame cost.
TOLERANCE = 0.05

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(2)

OUT = Path(sys.argv[1])
arms = {}
for arm in ("real", "noop"):
    path = OUT / f"{arm}-run.json"
    if not path.exists():
        print(f"missing {path} — run ab_run.py for the '{arm}' arm first")
        sys.exit(2)
    arms[arm] = json.loads(path.read_text())

print(f"{'arm':<6} {'frames':>7} {'window':>9} {'fps':>7}  dpr  warm first render")
for arm, run in arms.items():
    d = run.get("driver") or {}
    if not run.get("ok"):
        print(f"{arm:<6} FAILED: {d.get('reason') or run.get('reason')}")
        sys.exit(1)
    print(f"{arm:<6} {d['frames']:>7} {d['elapsed_ms']:>8}ms {d['fps']:>7.1f}  "
          f"{d['dpr']}    {d.get('warm_first_render_ms')}ms")

real = (arms["real"].get("driver") or {})["frames"]
noop = (arms["noop"].get("driver") or {})["frames"]
delta = (real - noop) / noop if noop else float("nan")
print()
print(f"precedent (#888, debug panel, same shape): {PRECEDENT_FRAMES} frames either way")
print(f"real vs no-op sink: {real} vs {noop} frames  ({delta:+.1%})")

if abs(delta) <= TOLERANCE:
    print(f"PASS — indistinguishable within {TOLERANCE:.0%}; the recorder is not "
          f"visible in frame throughput")
    sys.exit(0)
print(f"FAIL — {abs(delta):.1%} apart, outside the {TOLERANCE:.0%} band. ADR 0049's "
      f"observer-effect bound does not hold as built.")
sys.exit(1)
