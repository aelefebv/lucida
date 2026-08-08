#!/usr/bin/env python3
"""Bring up lucida-server from the research worktree, open a local fixture, and
run the trace-volume driver at DPR2. Adapted from the DPR2 interaction-profiler
recipe (~/scratch/gauntlet-interaction-stutter/harness/run_profile.py)."""
from __future__ import annotations
import json, os, shutil, subprocess, sys
from pathlib import Path

REPO = Path("/Users/austin/code/lucida/.claude/worktrees/agent-ad88b0ed1af13be94")
HARNESS = Path("/tmp/tv")
sys.path.insert(0, str(REPO / "extras" / "tryout"))

from tryout.server import ServerProcess  # noqa: E402
from tryout.surfaces.python_client import create_workspace_and_open  # noqa: E402
from tryout.surfaces.web_surface import _ensure_playwright, _system_browser_path  # noqa: E402
from tryout.surfaces._subproc import run_group  # noqa: E402

OUT = Path(sys.argv[1])
FIXTURE = sys.argv[2]
DRIVER = str(HARNESS / "tv_driver.cjs")
SERVER_BIN = Path(os.environ.get("TV_SERVER_BIN", "/Users/austin/code/lucida/target/release/lucida-server"))
WEB_DIST = Path(os.environ.get("TV_WEB_DIST", str(REPO / "lucida-web" / "dist")))

OUT.mkdir(parents=True, exist_ok=True)
def log(*a): print("[tv]", *a, flush=True)

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

result = {"ok": False, "out_dir": str(OUT), "fixture": FIXTURE}
with ServerProcess(out_dir=OUT, binary=SERVER_BIN, web_dist=WEB_DIST, health_timeout_s=180.0, log=log) as server:
    handle = server.start()
    base_url = handle.base_url
    log("server up:", base_url)
    ws = create_workspace_and_open(
        base_url=base_url, workspace_name="tv", fixture=FIXTURE,
        config_path=OUT / "client-config.json",
        open_timeout=900.0, subprocess_timeout=960.0, log=log,
    )
    viewer_url = f"{base_url}/w/{ws.workspace_id}?viewer_profile=default"
    result.update(workspace_id=ws.workspace_id, dataset_id=ws.dataset_id, viewer_url=viewer_url)
    log("dataset opened:", ws.dataset_id, "->", viewer_url)

    req = {
        "url": viewer_url, "executable_path": browser, "out_dir": str(OUT),
        "width": 1600, "height": 1000, "device_scale_factor": 2,
        "ready_wait_ms": int(os.environ.get("TV_READY_WAIT_MS", "240000")),
        "settle_ms": int(os.environ.get("TV_SETTLE_MS", "8000")),
        "pan_ms": 10000, "zoom_ms": 8000, "idle_ms": 5000,
    }
    env = dict(os.environ)
    existing = env.get("NODE_PATH")
    env["NODE_PATH"] = f"{node_path}{os.pathsep}{existing}" if existing else str(node_path)
    env.setdefault("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
    log("running trace-volume driver at DPR2 ...")
    completed = run_group([node, DRIVER, json.dumps(req)], cwd=str(OUT), env=env,
                          capture_output=True, text=True, timeout=900.0)
    driver_out = None
    for line in (completed.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try: driver_out = json.loads(line)
            except Exception: pass
    if driver_out is None:
        log("driver produced no JSON; stderr tail:")
        log("\n".join((completed.stderr or "").splitlines()[-25:]))
        log("stdout tail:")
        log("\n".join((completed.stdout or "").splitlines()[-15:]))
    else:
        result["ok"] = bool(driver_out.get("ok"))
        result["driver"] = driver_out

(OUT / "run-result.json").write_text(json.dumps(result, indent=2))
print(json.dumps({k: result[k] for k in ("ok", "out_dir", "dataset_id", "viewer_url") if k in result}))
