"""Self time by function on the renderer main thread over a window of a cold.py trace.

Usage: python3 profile_window.py <tag>.trace.json START_MS END_MS [top]

START and END are milliseconds after the last navigationStart on the main
thread. Reads the sampling profiler's chunks for that thread alone, walks
sample times from the profile's own start time, and prints self time by
function and a bottom-up of the heaviest frames with their callers.
"""

import json
import sys
from collections import defaultdict

events = json.load(open(sys.argv[1]))["traceEvents"]
w0, w1 = float(sys.argv[2]) * 1000, float(sys.argv[3]) * 1000
top = int(sys.argv[4]) if len(sys.argv) > 4 else 30

thread_names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
mains = [k for k, v in thread_names.items() if v == "CrRendererMain"]
nav = sorted((e for e in events if e.get("name") == "navigationStart" and (e["pid"], e["tid"]) in mains), key=lambda e: e["ts"])[-1]
pid, tid = nav["pid"], nav["tid"]
start_ts, end_ts = nav["ts"] + w0, nav["ts"] + w1

profiles = {}
# A Profile event sits on the sampled thread; its chunks arrive on the
# profiler's own thread, matched by pid and id.
main_ids = {e["id"] for e in events if e.get("name") == "Profile" and e.get("pid") == pid and e.get("tid") == tid}
for e in events:
    if e.get("pid") != pid:
        continue
    if e.get("name") == "Profile" and e.get("tid") == tid:
        profiles.setdefault(e["id"], {"start": e["args"]["data"]["startTime"], "chunks": []})
    elif e.get("name") == "ProfileChunk" and e.get("id") in main_ids:
        profiles.setdefault(e["id"], {"start": None, "chunks": []})["chunks"].append(e)

nodes = {}
samples = []
for pid_, prof in profiles.items():
    t = prof["start"]
    for chunk in sorted(prof["chunks"], key=lambda e: e["ts"]):
        data = chunk["args"]["data"]
        cpu = data.get("cpuProfile", {})
        for n in cpu.get("nodes", []):
            nodes[n["id"]] = n
        if t is None:
            t = chunk["ts"]
        for sid, dt in zip(cpu.get("samples", []), data.get("timeDeltas", [])):
            t += dt
            samples.append((t, sid))
samples.sort()


def frame(node):
    cf = node.get("callFrame", {})
    url = (cf.get("url") or "").rsplit("/", 1)[-1]
    return f"{cf.get('functionName') or '(anonymous)'} @ {url}:{cf.get('lineNumber')}"


def stack(sid):
    out = []
    node = nodes.get(sid)
    while node:
        out.append(frame(node))
        parent = node.get("parent")
        node = nodes.get(parent) if parent is not None else None
    return out


self_time = defaultdict(float)
callers = defaultdict(lambda: defaultdict(float))
inclusive = defaultdict(float)
prev = None
n_in = 0
for t, sid in samples:
    dt = (t - prev) / 1000 if prev is not None else 0
    prev = t
    if not (start_ts <= t <= end_ts):
        continue
    n_in += 1
    st = stack(sid)
    if not st:
        continue
    self_time[st[0]] += dt
    if len(st) > 1:
        callers[st[0]][st[1]] += dt
    for f in set(st):
        inclusive[f] += dt

print(f"main thread pid={pid} tid={tid}; {n_in} samples in {w0 / 1000:.0f}..{w1 / 1000:.0f} ms; {sum(self_time.values()):.1f} ms sampled")
print("\n== self time by function (ms) ==")
for f, ms in sorted(self_time.items(), key=lambda kv: -kv[1])[:top]:
    who = ", ".join(f"{c} {v:.1f}" for c, v in sorted(callers[f].items(), key=lambda kv: -kv[1])[:2])
    print(f"  {ms:7.1f}  {f}    <- {who}")
print("\n== inclusive time by function (ms) ==")
for f, ms in sorted(inclusive.items(), key=lambda kv: -kv[1])[:top]:
    print(f"  {ms:7.1f}  {f}")
