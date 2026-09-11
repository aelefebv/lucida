"""List GPU-process tasks and main-thread events around a window of a cold.py trace.

Usage: python3 gputasks.py <trace.json> START_MS END_MS
"""

import json
import sys
from collections import defaultdict

events = json.load(open(sys.argv[1]))["traceEvents"]
w0, w1 = float(sys.argv[2]) * 1000, float(sys.argv[3]) * 1000
names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
pnames = {e["pid"]: e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "process_name"}
nav = sorted((e for e in events if e.get("name") == "navigationStart"), key=lambda e: e["ts"])[-1]
lo, hi = nav["ts"] + w0, nav["ts"] + w1

print("== GPU process main thread, X events in window ==")
gpu = [e for e in events if e.get("ph") == "X" and names.get((e["pid"], e["tid"])) == "CrGpuMain" and lo <= e["ts"] <= hi]
for e in sorted(gpu, key=lambda e: e["ts"])[:60]:
    print(f"at {(e['ts'] - nav['ts']) / 1000:7.1f} dur {e.get('dur', 0) / 1000:6.1f} {e['name']} {json.dumps(e.get('args'))[:160]}")

print("\n== every thread, self time by (process, thread, name) in window ==")
agg = defaultdict(float)
cnt = defaultdict(int)
for e in events:
    if e.get("ph") == "X" and lo <= e["ts"] <= hi:
        k = (pnames.get(e["pid"]), names.get((e["pid"], e["tid"])), e["name"])
        agg[k] += e.get("dur", 0) / 1000
        cnt[k] += 1
for k, v in sorted(agg.items(), key=lambda kv: -kv[1])[:30]:
    print(f"{v:8.1f} n={cnt[k]:4d} {k}")

print("\n== main thread events in window (first 80) ==")
main = [e for e in events if e.get("ph") in ("X", "I", "i") and e["pid"] == nav["pid"] and e["tid"] == nav["tid"] and lo <= e["ts"] <= hi]
for e in sorted(main, key=lambda e: e["ts"])[:80]:
    data = e.get("args", {}).get("data", e.get("args", {}))
    print(f"at {(e['ts'] - nav['ts']) / 1000:7.1f} dur {e.get('dur', 0) / 1000:6.1f} {e['name']} {json.dumps(data)[:110]}")
