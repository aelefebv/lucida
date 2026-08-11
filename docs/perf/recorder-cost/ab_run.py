#!/usr/bin/env python3
"""Run one arm of the recorder A/B (issue #928, ADR 0049).

Boots lucida-server from this tree against a pre-built web bundle, opens a
local fixture, and drives the viewer at devicePixelRatio 2 over a warm re-open,
counting rendered frames for a fixed window.

    python3 docs/perf/recorder-cost/ab_run.py OUT_DIR FIXTURE ARM

ARM is a label only ("real" / "noop"); which sink the page uses is decided by
the bundle in AB_WEB_DIST, not by anything at runtime. There is no toggle at
any scope — that is the whole point of ADR 0049 — so the no-op arm is a
separate build with `noop-sink.patch` applied. See README.md.

Environment:
    AB_SERVER_BIN   lucida-server binary            (default: target/release/lucida-server)
    AB_WEB_DIST     built SPA for this arm          (default: lucida-web/dist)
    AB_WINDOW_MS    measurement window              (default: 10000, #888's shape)
    AB_SETTLE_MS    post-first-render settle        (default: 8000)
    AB_MODE         'frames' or 'heap'              (default: frames)

`AB_MODE=heap` adds a post-GC live-heap reading at the end of the same drive,
for the net non-regression ledger's measurement 2 (the debug-surface teardown,
[#919]).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "extras" / "tryout"))

from tryout.server import ServerProcess  # noqa: E402
from tryout.surfaces.python_client import create_workspace_and_open  # noqa: E402
from tryout.surfaces.web_surface import _ensure_playwright, _system_browser_path  # noqa: E402
from tryout.surfaces._subproc import run_group  # noqa: E402

if len(sys.argv) < 4:
    print(__doc__)
    sys.exit(2)

OUT = Path(sys.argv[1])
FIXTURE = sys.argv[2]
ARM = sys.argv[3]
DRIVER = str(Path(__file__).resolve().parent / "ab_driver.cjs")
SERVER_BIN = Path(os.environ.get("AB_SERVER_BIN", str(REPO / "target" / "release" / "lucida-server")))
WEB_DIST = Path(os.environ.get("AB_WEB_DIST", str(REPO / "lucida-web" / "dist")))

OUT.mkdir(parents=True, exist_ok=True)


def log(*a):
    print("[ab]", *a, flush=True)


# A service account with no access to the fixture would fail the open in a way
# that looks like a viewer bug; fall through to the user's ADC instead.
for _k in ("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT",
           "GOOGLE_SERVICE_ACCOUNT_PATH", "GOOGLE_SERVICE_ACCOUNT_KEY"):
    os.environ.pop(_k, None)

for p in (SERVER_BIN, WEB_DIST, Path(DRIVER)):
    if not p.exists():
        log("FATAL missing:", p)
        sys.exit(2)

node = shutil.which("node")
node_path = _ensure_playwright(log=log)
browser = _system_browser_path()
if browser is None:
    # The bundled Chromium has no WebGPU; the system Chrome does.
    log("FATAL no system chrome")
    sys.exit(2)

result = {"ok": False, "arm": ARM, "out_dir": str(OUT), "fixture": FIXTURE, "web_dist": str(WEB_DIST)}
with ServerProcess(out_dir=OUT, binary=SERVER_BIN, web_dist=WEB_DIST, health_timeout_s=180.0, log=log) as server:
    handle = server.start()
    log("server up:", handle.base_url)
    ws = create_workspace_and_open(
        base_url=handle.base_url, workspace_name=f"ab-{ARM}", fixture=FIXTURE,
        config_path=OUT / f"client-config-{ARM}.json",
        open_timeout=900.0, subprocess_timeout=960.0, log=log,
    )
    viewer_url = f"{handle.base_url}/w/{ws.workspace_id}?viewer_profile=default"
    result.update(workspace_id=ws.workspace_id, dataset_id=ws.dataset_id, viewer_url=viewer_url)
    log("dataset opened:", ws.dataset_id, "->", viewer_url)

    req = {
        "url": viewer_url, "executable_path": browser, "out_dir": str(OUT), "arm": ARM,
        "width": 1600, "height": 1000, "device_scale_factor": 2,
        "ready_wait_ms": int(os.environ.get("AB_READY_WAIT_MS", "240000")),
        "settle_ms": int(os.environ.get("AB_SETTLE_MS", "8000")),
        "window_ms": int(os.environ.get("AB_WINDOW_MS", "10000")),
        "mode": os.environ.get("AB_MODE", "frames"),
    }
    env = dict(os.environ)
    existing = env.get("NODE_PATH")
    env["NODE_PATH"] = f"{node_path}{os.pathsep}{existing}" if existing else str(node_path)
    env.setdefault("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
    log(f"driving arm '{ARM}' at DPR2 ...")
    completed = run_group([node, DRIVER, json.dumps(req)], cwd=str(OUT), env=env,
                          capture_output=True, text=True, timeout=1200.0)
    driver_out = None
    for line in (completed.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                driver_out = json.loads(line)
            except Exception:
                pass
    if driver_out is None:
        log("driver produced no JSON; stderr tail:")
        log("\n".join((completed.stderr or "").splitlines()[-25:]))
    else:
        result["ok"] = bool(driver_out.get("ok"))
        result["driver"] = driver_out

(OUT / f"{ARM}-run.json").write_text(json.dumps(result, indent=2))
d = result.get("driver") or {}
if result["ok"]:
    log(f"arm {ARM}: {d.get('frames')} frames in {d.get('elapsed_ms')} ms "
        f"({d.get('fps', 0):.1f} fps) at DPR {d.get('dpr')}")
    if d.get("heap"):
        log(f"arm {ARM}: live heap {d['heap']['used_bytes'] / 1e6:.3f} MB post-GC "
            f"(samples {[round(s / 1e6, 3) for s in d['heap']['samples']]})")
print(json.dumps({k: result[k] for k in ("ok", "arm", "out_dir", "viewer_url") if k in result}))
