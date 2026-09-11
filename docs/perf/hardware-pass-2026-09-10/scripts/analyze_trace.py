"""Read a DevTools trace taken by cold.py and name the main thread's costs.

Usage: python3 analyze_trace.py <tag>.trace.json <tag>.json [--window START_MS END_MS]

Finds the page's renderer main thread, takes the window from the last
navigation start to the `run-closed-observed` mark (or the run's own start
and end, when the run json gives them), and prints:
  1. self time by timeline event name inside the window,
  2. the longest top-level tasks inside the window, with what they ran,
  3. the sampling profiler's self time by function and by script URL.
"""

import json
import sys
from collections import defaultdict

trace_path = sys.argv[1]
run_path = sys.argv[2] if len(sys.argv) > 2 else None
events = json.load(open(trace_path))["traceEvents"]
run = json.load(open(run_path)) if run_path else None

# --- find the renderer main thread with the page's navigation -----------------
thread_names = {}
for e in events:
    if e.get("ph") == "M" and e.get("name") == "thread_name":
        thread_names[(e["pid"], e["tid"])] = e["args"]["name"]
main_threads = [k for k, v in thread_names.items() if v == "CrRendererMain"]

nav_starts = [e for e in events if e.get("name") == "navigationStart" and (e["pid"], e["tid"]) in main_threads]
marks = [e for e in events if e.get("name") == "run-closed-observed" and e.get("cat", "").find("user_timing") >= 0]
if not nav_starts:
    print("no navigationStart on a renderer main thread; threads:", sorted(set(thread_names.values())))
    sys.exit(1)
# The last navigation is the workspace page (about:blank and the root came before it).
nav = sorted(nav_starts, key=lambda e: e["ts"])[-1]
pid, tid = nav["pid"], nav["tid"]
start_ts = nav["ts"]
end_ts = max((m["ts"] for m in marks if m["pid"] == pid), default=None)
if end_ts is None:
    end_ts = max(e["ts"] + e.get("dur", 0) for e in events if e.get("pid") == pid and e.get("tid") == tid)
print(f"main thread pid={pid} tid={tid}; window {(end_ts - start_ts) / 1000:.0f} ms after navigationStart")
if "--window" in sys.argv:
    i = sys.argv.index("--window")
    w0, w1 = float(sys.argv[i + 1]), float(sys.argv[i + 2])
    start_ts, end_ts = nav["ts"] + w0 * 1000, nav["ts"] + w1 * 1000
    print(f"restricted to {w0:.0f}..{w1:.0f} ms after navigationStart")


def inside(e):
    return e.get("pid") == pid and e.get("tid") == tid and e.get("ph") == "X" and start_ts <= e["ts"] <= end_ts


# --- 1. self time by event name ----------------------------------------------
xs = sorted((e for e in events if inside(e)), key=lambda e: (e["ts"], -e.get("dur", 0)))
# Self time: an X event's duration minus the durations of X events nested inside it.
stack = []
self_by_name = defaultdict(float)
count_by_name = defaultdict(int)
for e in xs:
    dur = e.get("dur", 0)
    while stack and stack[-1]["ts"] + stack[-1].get("dur", 0) <= e["ts"]:
        stack.pop()
    if stack:
        stack[-1]["_child"] = stack[-1].get("_child", 0) + dur
    stack.append(e)
for e in xs:
    self_by_name[e["name"]] += (e.get("dur", 0) - e.get("_child", 0)) / 1000
    count_by_name[e["name"]] += 1
print("\n== self time by event name (ms) ==")
for name, ms in sorted(self_by_name.items(), key=lambda kv: -kv[1])[:18]:
    print(f"  {ms:8.1f}  n={count_by_name[name]:5d}  {name}")

# --- 2. the longest top-level tasks ------------------------------------------
tops = [e for e in xs if e["name"] == "RunTask"]


def describe(task):
    t0, t1 = task["ts"], task["ts"] + task.get("dur", 0)
    kids = [e for e in xs if e["ts"] >= t0 and e["ts"] + e.get("dur", 0) <= t1 and e is not task]
    by = defaultdict(float)
    detail = defaultdict(float)
    for k in kids:
        self_ms = (k.get("dur", 0) - k.get("_child", 0)) / 1000
        by[k["name"]] += self_ms
        d = k.get("args", {}).get("data", {})
        label = None
        if k["name"] == "FunctionCall":
            label = f"fn {d.get('functionName') or '?'}@{(d.get('url') or '').rsplit('/', 1)[-1]}:{d.get('lineNumber')}"
        elif k["name"] == "EvaluateScript":
            label = f"eval {(d.get('url') or '').rsplit('/', 1)[-1]}"
        elif k["name"] == "EventDispatch":
            label = f"event {d.get('type')}"
        elif k["name"] == "TimerFire":
            label = f"timer {d.get('timerId')}"
        elif k["name"] in ("Layout", "UpdateLayoutTree", "Paint", "PrePaint", "Layerize", "HitTest", "Commit", "ParseHTML", "v8.compile", "V8.CompileCode"):
            label = k["name"]
        if label:
            detail[label] += k.get("dur", 0) / 1000
    top = ", ".join(f"{n} {ms:.1f}" for n, ms in sorted(by.items(), key=lambda kv: -kv[1])[:5])
    det = "; ".join(f"{n} {ms:.1f}" for n, ms in sorted(detail.items(), key=lambda kv: -kv[1])[:4])
    return top, det


print("\n== longest top-level tasks (ms after navigationStart) ==")
for task in sorted(tops, key=lambda e: -e.get("dur", 0))[:14]:
    at = (task["ts"] - nav["ts"]) / 1000
    top, det = describe(task)
    print(f"  at {at:7.1f}  dur {task.get('dur', 0) / 1000:6.1f}  {top}")
    if det:
        print(f"              {det}")

# --- 3. the sampling profiler --------------------------------------------------
profiles = [e for e in events if e.get("name") == "ProfileChunk" and e.get("pid") == pid]
nodes = {}
samples = []
for chunk in sorted(profiles, key=lambda e: e["ts"]):
    data = chunk["args"]["data"]
    prof = data.get("cpuProfile", {})
    for n in prof.get("nodes", []):
        nodes[n["id"]] = n
    ts = data.get("timeDeltas", [])
    ids = prof.get("samples", [])
    t = chunk.get("ts", 0)
    # timeDeltas are relative to the previous sample; the first is relative to the chunk start.
    for sid, dt in zip(ids, ts):
        t += dt
        samples.append((t, sid))
# The Profile event carries startTime; chunk ts is close enough for windowing at this granularity.
if samples:
    self_fn = defaultdict(float)
    self_url = defaultdict(float)
    interval = 0
    prev = None
    inside_n = 0
    for t, sid in samples:
        if prev is not None:
            interval = t - prev
        prev = t
        if not (start_ts <= t <= end_ts):
            continue
        inside_n += 1
        node = nodes.get(sid)
        if not node:
            continue
        cf = node.get("callFrame", {})
        name = cf.get("functionName") or "(anonymous)"
        url = (cf.get("url") or "").rsplit("/", 1)[-1] or "(no url)"
        self_fn[f"{name} @ {url}:{cf.get('lineNumber')}"] += interval / 1000
        self_url[url] += interval / 1000
    print(f"\n== profiler: {inside_n} samples in window; self time by script URL (ms) ==")
    for url, ms in sorted(self_url.items(), key=lambda kv: -kv[1])[:8]:
        print(f"  {ms:8.1f}  {url}")
    print("\n== profiler: self time by function (ms) ==")
    for fn, ms in sorted(self_fn.items(), key=lambda kv: -kv[1])[:25]:
        print(f"  {ms:8.1f}  {fn}")
else:
    print("\n(no profiler samples in the trace)")

if run:
    lt = (run.get("facts") or {}).get("longTasks") or []
    print(f"\n== long tasks reported by the page: {len(lt)} ==")
    for t in lt[:30]:
        print(f"  start {t['start']:7.1f}  dur {t['dur']:6.1f}  {t.get('attr')}")
