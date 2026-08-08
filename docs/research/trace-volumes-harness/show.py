import json, sys
d = json.load(open(sys.argv[1] + "/tv-summary.json"))
print("canvas_box:", d.get("canvas_box"), "ready:", json.dumps(d["ready"]))
print("heap:", json.dumps(d["heap"]))
print("debug_panel:", d.get("debug_panel_opened"), "v3d_err:", d.get("volume3d_error"))
keys = sys.argv[2:] if len(sys.argv) > 2 else None
for ph, v in d["phases"].items():
    t = v.get("totals", {})
    print("=" * 24, ph, "elapsed_ms=%.0f" % v["elapsed_ms"], "first_render_ms=", v.get("first_render_ms"))
    if not t:
        print("  (no events)"); continue
    p = v.get("peak_per_sec", {}); ss = v.get("sample_stats", {})
    names = sorted(set(list(t) + list(p)))
    base = sorted({n.rsplit(".", 1)[0] if n.endswith((".sum", ".n")) else n for n in names})
    for n in base:
        if n in ss:
            s = ss[n]
            print(f"  {n:34s} n={s['n']:<7d} sum={s['sum']:<12d} p50={s['p50']:<8} p95={s['p95']:<8} max={s['max']:<8} peak_sum/s={p.get(n+'.sum','-')}")
        else:
            print(f"  {n:34s} total={t.get(n,0):<10d} peak/s={p.get(n,'-')}")
