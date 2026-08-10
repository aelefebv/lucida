#!/usr/bin/env python3
"""Issue #897 — measure the real `performance.now()` floor in the lucida SPA,
and test whether cross-origin isolation breaks a REMOTE dataset open.

Two arms, same fixture, same DPR2 driver:

  * `baseline`  — server sends no COOP/COEP (what lucida ships today)
  * `isolated`  — server sends `COOP: same-origin` + `COEP: require-corp`
                  (LUCIDA_COI=1, a throwaway patch to `static_serve.rs`)

Usage:
    python3 tr_run.py OUT_DIR FIXTURE [baseline|isolated|both]

FIXTURE may be a gs:// URL or a local path. The remote one is the case that
matters: COEP's cost is only real if it blocks the data path.
"""
from __future__ import annotations
import json, os, shutil, subprocess, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
HARNESS = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "extras" / "tryout"))

from tryout.server import ServerProcess  # noqa: E402
from tryout.surfaces.python_client import create_workspace_and_open  # noqa: E402
from tryout.surfaces.web_surface import _ensure_playwright, _system_browser_path  # noqa: E402
from tryout.surfaces._subproc import run_group  # noqa: E402

OUT = Path(sys.argv[1])
FIXTURE = sys.argv[2]
ARMS = sys.argv[3] if len(sys.argv) > 3 else "both"
ARMS = ["baseline", "isolated"] if ARMS == "both" else [ARMS]

DRIVER = str(HARNESS / "tr_driver.cjs")
SERVER_BIN = Path(os.environ.get("TR_SERVER_BIN", "/tmp/tr-target/release/lucida-server"))
WEB_DIST = Path(os.environ.get("TR_WEB_DIST", str(REPO / "lucida-web" / "dist")))

OUT.mkdir(parents=True, exist_ok=True)
def log(*a): print("[tr]", *a, flush=True)

# Fall through to the operator's ADC rather than a service account with no
# access to the bucket (the trap #888's harness documented).
for _k in ("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT",
           "GOOGLE_SERVICE_ACCOUNT_PATH", "GOOGLE_SERVICE_ACCOUNT_KEY"):
    os.environ.pop(_k, None)

for p in (SERVER_BIN, WEB_DIST, Path(DRIVER)):
    if not p.exists():
        log("FATAL missing:", p); sys.exit(2)

node = shutil.which("node")
node_path = _ensure_playwright(log=log)
browser = _system_browser_path()
if browser is None:
    log("FATAL no system chrome"); sys.exit(2)


def run_arm(arm: str) -> dict:
    arm_out = OUT / arm
    arm_out.mkdir(parents=True, exist_ok=True)
    if arm == "isolated":
        os.environ["LUCIDA_COI"] = "1"
    else:
        os.environ.pop("LUCIDA_COI", None)

    res = {"arm": arm, "ok": False, "fixture": FIXTURE}
    with ServerProcess(out_dir=arm_out, binary=SERVER_BIN, web_dist=WEB_DIST,
                       health_timeout_s=180.0, log=log) as server:
        handle = server.start()
        base_url = handle.base_url
        log(arm, "server up:", base_url)
        t0 = time.time()
        ws = create_workspace_and_open(
            base_url=base_url, workspace_name=f"tr-{arm}", fixture=FIXTURE,
            config_path=arm_out / "client-config.json",
            open_timeout=1800.0, subprocess_timeout=1860.0, log=log,
        )
        res["dataset_open_wall_s"] = round(time.time() - t0, 2)
        viewer_url = f"{base_url}/w/{ws.workspace_id}?viewer_profile=default"
        res.update(workspace_id=ws.workspace_id, dataset_id=ws.dataset_id, viewer_url=viewer_url)
        log(arm, "dataset opened:", ws.dataset_id)

        req = {
            "url": viewer_url, "executable_path": browser, "out_dir": str(arm_out),
            "width": 1600, "height": 1000, "device_scale_factor": 2, "arm": arm,
            "ready_wait_ms": int(os.environ.get("TR_READY_WAIT_MS", "600000")),
            "settle_ms": int(os.environ.get("TR_SETTLE_MS", "15000")),
            "pan_ms": 6000,
        }
        env = dict(os.environ)
        existing = env.get("NODE_PATH")
        env["NODE_PATH"] = f"{node_path}{os.pathsep}{existing}" if existing else str(node_path)
        env.setdefault("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
        log(arm, "driving Chrome at DPR2 ...")
        completed = run_group([node, DRIVER, json.dumps(req)], cwd=str(arm_out), env=env,
                              capture_output=True, text=True, timeout=2400.0)
        driver_out = None
        for line in (completed.stdout or "").splitlines():
            line = line.strip()
            if line.startswith("{"):
                try: driver_out = json.loads(line)
                except Exception: pass
        if driver_out is None:
            log(arm, "driver produced no JSON; stderr tail:")
            log("\n".join((completed.stderr or "").splitlines()[-25:]))
        else:
            res["ok"] = bool(driver_out.get("ok"))
            res["driver"] = driver_out
    return res


results = {}
for arm in ARMS:
    results[arm] = run_arm(arm)
    log(arm, "->", "OK" if results[arm]["ok"] else "FAILED")

(OUT / "run-result.json").write_text(json.dumps(results, indent=2, default=str))
print(json.dumps({a: {"ok": r["ok"], "reason": (r.get("driver") or {}).get("reason")} for a, r in results.items()}))
