"""Print the phase table, findings, and long tasks of cold.py runs.

Usage: python3 phases.py <out dir> <tag> [<tag> ...]
"""

import json
import sys

out = sys.argv[1]
for tag in sys.argv[2:]:
    r = json.load(open(f"{out}/{tag}.json"))
    d = json.load(open(f"{out}/{tag}.diagnostic.json"))
    f = r["facts"]
    start = d["run"]["startedAtEpochMs"] - f["timeOrigin"]
    print(f"{tag}: cause {r['cause'] and r['cause']['source']}; run starts {start:.0f} ms after timeOrigin, wall {r['wallMs']} ms; nav {f['nav']}; canvas {f['canvas']}")
    print(f"  verdict: {r['verdict']['kind']}: {r['verdict']['text'][:150]}")
    print("  findings:", [(x["severity"], x["rule"], x["subject"], x["observed"].get("ms")) for x in r["findings"]][:6])
    for t in f["longTasks"] or []:
        print(f"  longtask start {t['start']:7.1f} dur {t['dur']:6.1f} (run-relative {t['start'] - start:7.1f}) {t['attr']}")
    ph = {p["id"]: p for p in d["phases"]}
    for k in ("browser.plan", "browser.queue", "browser.wire", "browser.decode", "browser.upload", "browser.present"):
        p = ph.get(k)
        if p:
            print(f"  {k:16s} p50 {p['p50Ms']:7.1f} p95 {p['p95Ms']:7.1f} max {p['maxMs']:7.1f} n={p['n']}")
    rt = d.get("renderTiming") or {}
    print("  render:", {k: rt.get(k) for k in ("mainThread", "gpu", "gpuAbsence") if k in rt})
    print()
