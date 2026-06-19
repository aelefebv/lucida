"""Web surface: capture what lucida *looks like* — a non-blank viewer render.

This is the "screenshots saved for verification" surface. It is layered, and the
two layers reuse the SAME render-readiness contract the product already defines,
so both images are genuinely content-bearing rather than blank canvases:

  * **Floor (required).** Drive the *actual product CLI* —
    ``lucida … viewer screenshot DIR/web/viewer.png`` (and ``viewer overview``) —
    which launches headless Chrome, navigates the real SPA at the workspace URL,
    waits for ``window.__lucidaCaptureReady`` (a rendered canvas with frames and
    a loaded dataset), and writes a non-blank PNG. We reuse lucida's own renderer
    rather than re-implementing it: the floor is exactly what a maintainer would
    run, and its PNG is the required verification artifact. The captured URL is
    recorded so a human can re-open the same view.

  * **Ceiling (best-effort).** Drive the real SPA ourselves in a real browser via
    Playwright (provisioned through ``npm``/``npx`` into a harness-owned cache,
    pointed at the same system Chrome the CLI uses — no browser download), open
    the workspace URL, wait for the *same* ``window.__lucidaCaptureReady`` signal,
    then capture a full-page ``DIR/web/spa.png`` and the browser ``console.log``.
    If Playwright or a browser can't be provisioned, this is recorded as
    ``{captured: false, reason}`` and the floor still stands — a browser hiccup is
    captured, never fatal.

Design choices, matching the CLI/Python surfaces:

  * **Captured, not fatal.** Each CLI capture's argv + outcome + log path is
    recorded; a non-zero exit is *data*. The surface reports ``ran=False`` only if
    it could not be exercised at all (CLI binary missing / SPA bundle missing).
    ``ok`` requires at least one non-blank floor image.
  * **Hermetic + reaped.** Every browser the harness launches has a hard
    subprocess timeout and is reaped on every path (the CLI reaps its own Chrome;
    the Playwright driver closes its browser in a ``finally`` and the subprocess
    timeout is the backstop) so no orphan browser survives a run.
  * **Verifiable offline.** The PNGs + the recorded ``viewer_url`` + the result
    let a human confirm lucida displayed the dataset without re-running.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from ..errors import TryoutError
from . import SurfaceResult
from ._subproc import run_group, scan_json_line, shquote
from .cli_surface import resolve_cli_invocation


# Per-capture wall-clock ceiling. lucida's screenshot path waits for a rendered
# canvas (page load + WGPU frames + dataset); the CLI's own default is tens of
# seconds, so this is a generous backstop that still guarantees no hang.
DEFAULT_CAPTURE_TIMEOUT_S = 180.0
# Seconds we ask lucida's own renderer to wait for the canvas (passed through to
# `viewer screenshot --timeout-seconds`). Slightly under the subprocess ceiling.
DEFAULT_RENDER_WAIT_S = 150
# Hard ceiling for the Playwright ceiling subprocess (provision + launch +
# navigate + render-wait + capture). Generous; the backstop against an orphan.
DEFAULT_SPA_TIMEOUT_S = 240.0
# How long the Playwright driver waits for window.__lucidaCaptureReady, in ms.
DEFAULT_SPA_RENDER_WAIT_MS = 150_000
# Default full-page viewport for the ceiling capture.
DEFAULT_VIEWPORT_W = 1400
DEFAULT_VIEWPORT_H = 900


@dataclass
class WebCaptureResult:
    """One floor capture via the product CLI (screenshot or overview)."""

    name: str
    argv: list[str]
    exit_code: int | None
    ok: bool                 # CLI exited 0 AND produced a non-blank PNG
    png: str                 # absolute path it was asked to write
    png_exists: bool
    nonblank: bool
    url: str | None          # the workspace URL the CLI captured (from its JSON)
    log: str
    duration_s: float
    timed_out: bool = False
    detail: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "name": self.name,
            "argv": self.argv,
            "exit_code": self.exit_code,
            "ok": self.ok,
            "png": self.png,
            "png_exists": self.png_exists,
            "nonblank": self.nonblank,
            "url": self.url,
            "log": self.log,
            "duration_s": self.duration_s,
        }
        if self.timed_out:
            record["timed_out"] = True
        if self.detail is not None:
            record["detail"] = self.detail
        return record


@dataclass
class RealSpaResult:
    """The best-effort real-SPA ceiling outcome."""

    captured: bool
    reason: str
    spa_png: str | None = None
    spa_png_nonblank: bool | None = None
    console_log: str | None = None
    url: str | None = None
    console_messages: int | None = None
    render: dict[str, Any] | None = None
    log: str | None = None

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {"captured": self.captured, "reason": self.reason}
        if self.spa_png is not None:
            record["spa_png"] = self.spa_png
        if self.spa_png_nonblank is not None:
            record["spa_png_nonblank"] = self.spa_png_nonblank
        if self.console_log is not None:
            record["console_log"] = self.console_log
        if self.url is not None:
            record["url"] = self.url
        if self.console_messages is not None:
            record["console_messages"] = self.console_messages
        if self.render is not None:
            record["render"] = self.render
        if self.log is not None:
            record["log"] = self.log
        return record


@dataclass
class WebSurfaceResult(SurfaceResult):
    """The web surface's result. Subclasses :class:`SurfaceResult` for the uniform
    spine; :meth:`payload` preserves every key this surface has always emitted
    (``ran``, ``ok``, ``out_dir``, ``dataset_id``, ``viewer_png``,
    ``viewer_png_nonblank``, ``viewer_url``, ``captures``, ``real_spa``, plus the
    data-dependent ``web_dist``/``web_dist_source``/``spa_png``/``console_log``/
    ``error``).
    """

    out_dir: str = ""
    web_dist: str | None = None
    web_dist_source: str | None = None
    dataset_id: str | None = None
    viewer_png: str | None = None
    viewer_png_nonblank: bool | None = None
    viewer_url: str | None = None
    captures: list[WebCaptureResult] = field(default_factory=list)
    real_spa: RealSpaResult | None = None

    name: str = "web"

    @property
    def passed(self) -> int:
        # For the registry/report: how many captures produced a non-blank PNG.
        return sum(1 for capture in self.captures if capture.ok)

    @property
    def total(self) -> int:
        return len(self.captures)

    def payload(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "ran": self.ran,
            "ok": self.ok,
            "out_dir": self.out_dir,
            "dataset_id": self.dataset_id,
            "viewer_png": self.viewer_png,
            # The single most important verification fact: is the REQUIRED floor
            # image a real, content-bearing render? Surfaced directly so a reader
            # never has to dig into `captures` to learn the floor held.
            "viewer_png_nonblank": self.viewer_png_nonblank,
            "viewer_url": self.viewer_url,
            "captures": [capture.to_dict() for capture in self.captures],
            "real_spa": (self.real_spa.to_dict() if self.real_spa is not None
                         else {"captured": False, "reason": "not attempted"}),
        }
        if self.web_dist is not None:
            record["web_dist"] = self.web_dist
        if self.web_dist_source is not None:
            record["web_dist_source"] = self.web_dist_source
        # Surface the ceiling artifacts at the top level too (spec's optional
        # spa_png/console_log keys), so a reader doesn't have to dig.
        if self.real_spa is not None and self.real_spa.spa_png is not None:
            record["spa_png"] = self.real_spa.spa_png
        if self.real_spa is not None and self.real_spa.console_log is not None:
            record["console_log"] = self.real_spa.console_log
        if self.error is not None:
            record["error"] = self.error
        return record


# --------------------------------------------------------------------------- #
# Non-blank PNG check (shared by floor + ceiling).
#
# We reuse the repo's own pixel-level checker (scripts/assert_png_nonblank.py)
# when present so "non-blank" means exactly what the repo's verification means;
# otherwise we fall back to a conservative size+signature heuristic. Either way a
# blank/missing image flips the capture to not-ok.
# --------------------------------------------------------------------------- #

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# A genuinely rendered viewer PNG is tens of KB+; a blank/placeholder capture is
# far smaller. Used only by the fallback heuristic.
_MIN_NONBLANK_BYTES = 4096


def _repo_root_from_here() -> Path:
    # extras/tryout/tryout/surfaces/web_surface.py -> repo root is 5 parents up.
    return Path(__file__).resolve().parents[4]


def _assert_png_nonblank_script() -> Path | None:
    script = _repo_root_from_here() / "scripts" / "assert_png_nonblank.py"
    return script if script.is_file() else None


def png_is_nonblank(path: Path) -> bool:
    """True iff ``path`` is a PNG with more than one color (content-bearing).

    Prefers the repo's pixel-decoding checker so the harness's notion of
    "non-blank" matches the project's; falls back to a size + signature check if
    that script is unavailable. Any error is treated as "blank" (fail-safe).
    """
    try:
        if not path.is_file() or path.stat().st_size == 0:
            return False
    except OSError:
        return False

    script = _assert_png_nonblank_script()
    if script is not None:
        try:
            result = subprocess.run(
                ["python3", str(script), str(path)],
                capture_output=True,
                text=True,
                timeout=60.0,
            )
            return result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            # Fall through to the heuristic rather than failing the whole surface.
            pass

    try:
        with path.open("rb") as handle:
            head = handle.read(len(_PNG_SIGNATURE))
        if head != _PNG_SIGNATURE:
            return False
        return path.stat().st_size >= _MIN_NONBLANK_BYTES
    except OSError:
        return False


# --------------------------------------------------------------------------- #
# Floor: drive the product CLI to capture a non-blank viewer render.
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class _CaptureStep:
    name: str           # filesystem-safe slug
    verb: str           # "screenshot" or "overview"
    filename: str       # PNG filename under DIR/web/
    required: bool      # a failure of a required capture flips surface ok=false


def _plan_floor_captures() -> list[_CaptureStep]:
    """The floor tour: the required viewer screenshot, then a fit overview.

    ``viewer.png`` is the contract artifact (the required non-blank floor).
    ``overview.png`` adds a fitted whole-dataset view — extra verifiability, and
    captured-not-fatal so an overview hiccup never sinks the run.
    """
    return [
        _CaptureStep("viewer", "screenshot", "viewer.png", required=True),
        _CaptureStep("overview", "overview", "overview.png", required=False),
    ]


def run_web_surface(
    *,
    base_url: str,
    workspace_id: str,
    dataset_id: str | None,
    out_dir: Path,
    config_path: Path,
    web_dist: Path,
    web_dist_source: str | None = None,
    capture_timeout_s: float = DEFAULT_CAPTURE_TIMEOUT_S,
    render_wait_s: int = DEFAULT_RENDER_WAIT_S,
    attempt_real_spa: bool = True,
    log=print,
) -> WebSurfaceResult:
    """Capture the viewer (floor) and best-effort the real-SPA ceiling.

    The server must already be booted with ``LUCIDA_WEB_DIST`` = ``web_dist`` so
    the SPA is served. Returns a :class:`WebSurfaceResult`; per-capture failures
    are captured. ``ran=False`` only if the CLI could not be invoked at all.

    ``dataset_id`` is recorded as metadata (so the result names which dataset the
    images depict); the capture itself targets the workspace's active view —
    exactly what a maintainer would see opening that workspace URL.
    """
    web_out = out_dir / "web"
    # Start clean so a reused --out can't mix a stale viewer.png from a prior
    # fixture with this run's result (drive.json stays authoritative).
    shutil.rmtree(web_out, ignore_errors=True)
    web_out.mkdir(parents=True, exist_ok=True)

    try:
        prefix, prebuilt = resolve_cli_invocation(log=log)
    except TryoutError as error:
        return WebSurfaceResult(
            ran=False,
            ok=False,
            out_dir=str(web_out),
            web_dist=str(web_dist),
            web_dist_source=web_dist_source,
            error=error.to_error(),
        )

    # Hermetic CLI config (same discipline as the CLI surface): a throwaway file
    # in the out dir, never the user's real ~/.config/lucida.
    env = dict(os.environ)
    env["LUCIDA_CONFIG_PATH"] = str(config_path)
    env["XDG_CONFIG_HOME"] = str(out_dir / "xdg-config")

    log(
        f"[tryout] web surface: capturing the real viewer via the product CLI "
        f"({'prebuilt binary' if prebuilt else 'cargo run'}); serving SPA from {web_dist}"
    )

    captures: list[WebCaptureResult] = []
    for step in _plan_floor_captures():
        capture = _run_capture(
            step=step,
            prefix=prefix,
            base_url=base_url,
            workspace_id=workspace_id,
            web_out=web_out,
            env=env,
            cwd=out_dir,
            capture_timeout_s=capture_timeout_s,
            render_wait_s=render_wait_s,
            log=log,
        )
        captures.append(capture)

    # The contract artifact is viewer.png from the required screenshot capture.
    viewer_capture = next((c for c in captures if c.name == "viewer"), None)
    viewer_png = viewer_capture.png if viewer_capture is not None else None
    viewer_png_nonblank = viewer_capture.nonblank if viewer_capture is not None else None
    # Prefer the URL the CLI actually captured; fall back across captures.
    viewer_url = next(
        (c.url for c in captures if c.url),
        None,
    )

    # Surface ok iff every *required* capture produced a non-blank PNG. A failed
    # overview is captured but never taints ok.
    floor_ok = all(c.ok for c in captures if _is_required(c, captures))

    result = WebSurfaceResult(
        ran=True,
        ok=floor_ok,
        out_dir=str(web_out),
        web_dist=str(web_dist),
        web_dist_source=web_dist_source,
        dataset_id=dataset_id,
        viewer_png=viewer_png,
        viewer_png_nonblank=viewer_png_nonblank,
        viewer_url=viewer_url,
        captures=captures,
    )

    # --- ceiling: best-effort real-SPA capture (never fatal) -----------------
    if attempt_real_spa:
        # Drive the same workspace URL the floor captured (with the viewer
        # profile), so the ceiling shows the same view the floor verified.
        spa_url = viewer_url or _fallback_workspace_url(base_url, workspace_id)
        result.real_spa = capture_real_spa(
            url=spa_url,
            web_out=web_out,
            log=log,
        )
    else:
        result.real_spa = RealSpaResult(captured=False, reason="disabled by caller")

    return result


def _is_required(capture: WebCaptureResult, captures: list[WebCaptureResult]) -> bool:
    # viewer is the only required capture; mirror the plan without re-threading it.
    return capture.name == "viewer"


def _fallback_workspace_url(base_url: str, workspace_id: str) -> str:
    """The SPA workspace URL the server serves: ``{base_url}/w/{id}``.

    Mirrors the CLI's ``workspace_web_url``; used only if the CLI didn't report a
    URL (e.g. it failed before printing JSON) so the ceiling can still try.
    """
    return f"{base_url.rstrip('/')}/w/{workspace_id}?viewer_profile=default"


def _run_capture(
    *,
    step: _CaptureStep,
    prefix: Sequence[str],
    base_url: str,
    workspace_id: str,
    web_out: Path,
    env: dict[str, str],
    cwd: Path,
    capture_timeout_s: float,
    render_wait_s: int,
    log,
) -> WebCaptureResult:
    """Run one ``viewer screenshot|overview`` capture and validate the PNG."""
    png_path = web_out / step.filename
    argv = [
        *prefix,
        "--server",
        base_url,
        "--workspace",
        workspace_id,
        "--json",
        "viewer",
        step.verb,
        str(png_path),
        "--timeout-seconds",
        str(render_wait_s),
    ]
    log_path = web_out / f"{step.name}.log"
    started = time.monotonic()
    timed_out = False
    try:
        completed = run_group(
            argv,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=capture_timeout_s,
        )
        exit_code: int | None = completed.returncode
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
    except subprocess.TimeoutExpired as error:
        timed_out = True
        exit_code = None
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = (
            (error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or ""))
            + f"\n[tryout] capture timed out after {capture_timeout_s:g}s"
        )
    except OSError as error:
        timed_out = False
        exit_code = None
        stdout = ""
        stderr = f"[tryout] failed to execute capture: {error}"

    duration = round(time.monotonic() - started, 3)
    url = _extract_url(stdout)
    png_exists = png_path.is_file()
    nonblank = png_is_nonblank(png_path) if png_exists else False
    ok = exit_code == 0 and png_exists and nonblank

    _write_capture_log(
        log_path,
        argv=argv,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_s=duration,
        timed_out=timed_out,
        png=str(png_path),
        png_exists=png_exists,
        nonblank=nonblank,
        url=url,
    )

    detail: dict[str, Any] | None = None
    if not ok:
        # A precise, machine-readable reason the capture is not ok, so a human or
        # agent sees *why* without opening the log.
        if exit_code not in (0, None):
            reason = f"cli exited {exit_code}"
        elif timed_out:
            reason = "cli timed out"
        elif not png_exists:
            reason = "no PNG written"
        elif not nonblank:
            reason = "PNG is blank"
        else:
            reason = "capture failed"
        detail = {"reason": reason, "stderr_tail": "\n".join(stderr.splitlines()[-12:])}

    status = (
        "ok (non-blank)" if ok
        else (f"exit {exit_code}" if exit_code not in (0, None)
              else ("blank PNG" if png_exists else ("timed out" if timed_out else "no PNG")))
    )
    log(f"[tryout]   web {step.name}: {status} ({duration:g}s) -> {png_path.name}")

    return WebCaptureResult(
        name=step.name,
        argv=argv,
        exit_code=exit_code,
        ok=ok,
        png=str(png_path),
        png_exists=png_exists,
        nonblank=nonblank,
        url=url,
        log=str(log_path),
        duration_s=duration,
        timed_out=timed_out,
        detail=detail,
    )


def _extract_url(stdout: str) -> str | None:
    """Pull the captured workspace ``url`` from the CLI's ``--json`` output.

    ``viewer screenshot --json`` prints one JSON object carrying ``url``. uv/cli
    chatter never lands on stdout under --json, but we use the shared
    :func:`tryout.surfaces.scan_json_line` (whole-line, bottom-up) accepting the
    first object with a string ``url``. A pretty-printed (multi-line) object would
    not match line-by-line, so we keep a single-pass full-stdout parse as a
    fallback.
    """
    obj = scan_json_line(
        stdout, accept=lambda candidate: isinstance(candidate.get("url"), str)
    )
    if obj is not None:
        return obj["url"]
    # Fall back to a single-pass parse of the whole stdout (handles pretty JSON).
    try:
        whole = json.loads(stdout)
        if isinstance(whole, dict) and isinstance(whole.get("url"), str):
            return whole["url"]
    except json.JSONDecodeError:
        pass
    return None


def _write_capture_log(
    path: Path,
    *,
    argv: Sequence[str],
    exit_code: int | None,
    stdout: str,
    stderr: str,
    duration_s: float,
    timed_out: bool,
    png: str,
    png_exists: bool,
    nonblank: bool,
    url: str | None,
) -> None:
    """Write a faithful, greppable capture log (argv + outcome + output)."""
    header = {
        "argv": list(argv),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_s": duration_s,
        "png": png,
        "png_exists": png_exists,
        "nonblank": nonblank,
        "url": url,
    }
    lines = [
        "# lucida web (viewer capture) tryout log",
        "# " + json.dumps(header),
        "$ " + " ".join(shquote(part) for part in argv),
        f"# exit_code: {exit_code}" + ("  (timed out)" if timed_out else ""),
        f"# png: {png} (exists={png_exists}, nonblank={nonblank})",
        f"# url: {url}",
        "",
        "--- stdout ---",
        stdout.rstrip("\n"),
        "",
        "--- stderr ---",
        stderr.rstrip("\n"),
        "",
    ]
    try:
        path.write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Ceiling: drive the real SPA in a real browser via Playwright (best-effort).
# --------------------------------------------------------------------------- #

# The Node driver. It is resilient by construction: every failure prints one JSON
# object to stdout and exits, so the Python side always gets a structured reason.
# It reuses the product's own readiness contract (window.__lucidaCaptureReady)
# so spa.png is captured only once the viewer has actually rendered the dataset.
_SPA_DRIVER = r'''
'use strict';
const fs = require('fs');

function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (e1) {
  try { ({ chromium } = require('@playwright/test')); }
  catch (e2) {
    out({ captured: false, reason: 'playwright_not_resolvable: ' + String(e2).split('\n')[0] });
    process.exit(0);
  }
}

const req = JSON.parse(process.argv[2]);
const url = req.url;
const spaPng = req.spa_png;
const consoleLog = req.console_log;
const exe = req.executable_path || undefined;
const width = req.width || 1400;
const height = req.height || 900;
const renderWaitMs = req.render_wait_ms || 150000;

// The product's render-readiness probe (kept in lockstep with the CLI's
// LUCIDA_CAPTURE_READY_PROBE): a sized canvas whose __lucidaCaptureReady reports
// ready with frames drawn and a dataset loaded.
function readyProbe() {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { ready: false, reason: 'missing_canvas', frame_count: 0, dataset_count: 0, canvas_width: 0, canvas_height: 0 };
  const cw = canvas.width || Math.floor(canvas.clientWidth);
  const ch = canvas.height || Math.floor(canvas.clientHeight);
  if (!cw || !ch) return { ready: false, reason: 'zero_size_canvas', frame_count: 0, dataset_count: 0, canvas_width: cw || 0, canvas_height: ch || 0 };
  const s = window.__lucidaCaptureReady;
  if (!s) return { ready: false, reason: 'missing_lucida_capture_ready', frame_count: 0, dataset_count: 0, canvas_width: cw, canvas_height: ch };
  const fc = Number(s.frameCount || 0);
  const dc = Number(s.datasetCount || 0);
  const ready = Boolean(s.ready) && fc > 0 && dc > 0;
  return { ready, reason: ready ? 'rendered' : String(s.reason || 'not_ready'), frame_count: fc, dataset_count: dc, canvas_width: cw, canvas_height: ch };
}

(async () => {
  const messages = [];
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: exe,
      args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check'],
    });
  } catch (e) {
    out({ captured: false, reason: 'browser_launch_failed: ' + String(e).split('\n')[0] });
    process.exit(0);
  }

  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    // Capture the browser console + page errors -> console.log artifact.
    page.on('console', (msg) => { try { messages.push('[' + msg.type() + '] ' + msg.text()); } catch (_) {} });
    page.on('pageerror', (err) => { messages.push('[pageerror] ' + String(err && err.message ? err.message : err)); });
    page.on('requestfailed', (rq) => { try { messages.push('[requestfailed] ' + rq.url() + ' ' + (rq.failure() && rq.failure().errorText)); } catch (_) {} });

    await page.goto(url, { waitUntil: 'load', timeout: renderWaitMs });

    // Poll the product readiness probe until the viewer has rendered the dataset.
    let probe = null;
    const deadline = Date.now() + renderWaitMs;
    while (Date.now() < deadline) {
      probe = await page.evaluate(readyProbe);
      if (probe && probe.ready) break;
      await page.waitForTimeout(250);
    }

    // Capture full-page no matter what (even if not "ready") so the human sees
    // whatever rendered; nonblank-ness is judged by the Python side.
    await page.screenshot({ path: spaPng, fullPage: true });

    try { fs.writeFileSync(consoleLog, messages.join('\n') + '\n'); } catch (_) {}

    const rendered = Boolean(probe && probe.ready);
    out({
      captured: true,
      rendered,
      reason: rendered ? 'rendered' : ('captured_not_ready: ' + (probe ? probe.reason : 'unknown')),
      console_messages: messages.length,
      render: probe || null,
      url,
    });
  } catch (e) {
    // Still try to flush the console log we gathered before failing.
    try { fs.writeFileSync(consoleLog, messages.join('\n') + '\n'); } catch (_) {}
    out({ captured: false, reason: 'spa_capture_failed: ' + String(e).split('\n')[0], console_messages: messages.length });
  } finally {
    try { await browser.close(); } catch (_) {}
  }
  process.exit(0);
})();
'''


def capture_real_spa(
    *,
    url: str,
    web_out: Path,
    spa_timeout_s: float = DEFAULT_SPA_TIMEOUT_S,
    render_wait_ms: int = DEFAULT_SPA_RENDER_WAIT_MS,
    viewport: tuple[int, int] = (DEFAULT_VIEWPORT_W, DEFAULT_VIEWPORT_H),
    log=print,
) -> RealSpaResult:
    """Best-effort: drive the real SPA in a browser and capture spa.png + console.

    Never raises: every failure to provision Node/Playwright/a browser, or any
    runtime error, becomes ``RealSpaResult(captured=False, reason=...)``. The
    subprocess has a hard timeout so a stuck browser can't hang the run, and the
    driver always closes its browser, so no orphan survives.
    """
    spa_png = web_out / "spa.png"
    console_log = web_out / "console.log"
    driver_log = web_out / "spa-driver.log"

    node = shutil.which("node")
    if node is None:
        return _spa_skipped(
            "node not found on PATH (the real-SPA ceiling needs Node + Playwright)",
            console_log=console_log,
        )

    try:
        node_path = _ensure_playwright(log=log)
    except TryoutError as error:
        return _spa_skipped(error.message, console_log=console_log)

    browser_path = _system_browser_path()
    if browser_path is None:
        return _spa_skipped(
            "no Chrome/Chromium found (set LUCIDA_BROWSER) for the real-SPA ceiling",
            console_log=console_log,
        )

    request = json.dumps(
        {
            "url": url,
            "spa_png": str(spa_png),
            "console_log": str(console_log),
            "executable_path": browser_path,
            "width": viewport[0],
            "height": viewport[1],
            "render_wait_ms": render_wait_ms,
        }
    )
    env = dict(os.environ)
    # Resolve `require('playwright')` from the harness-owned cache regardless of
    # cwd (Node resolves relative to the script path otherwise).
    existing_node_path = env.get("NODE_PATH")
    env["NODE_PATH"] = (
        f"{node_path}{os.pathsep}{existing_node_path}" if existing_node_path else str(node_path)
    )
    # Don't let Playwright try to download a browser at runtime; we bring our own.
    env.setdefault("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")

    log(
        f"[tryout] web ceiling: driving the real SPA via Playwright "
        f"(system Chrome) at {url}"
    )
    # Write the driver to a real .cjs file (rather than `node -e`): a file script
    # puts the request at argv[2] deterministically, resolves `require` naturally,
    # and leaves the exact driver on disk for the human verifier to inspect.
    driver_path = web_out / "spa-driver.cjs"
    _write_text(driver_path, _SPA_DRIVER)
    argv = [node, str(driver_path), request]
    started = time.monotonic()
    try:
        completed = run_group(
            argv,
            cwd=str(web_out),
            env=env,
            capture_output=True,
            text=True,
            timeout=spa_timeout_s,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        returncode: int | None = completed.returncode
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = (
            (error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or ""))
            + f"\n[tryout] real-SPA capture timed out after {spa_timeout_s:g}s"
        )
        returncode = None
        _write_text(driver_log, _spa_driver_log(argv, stdout, stderr, returncode))
        # run_group SIGKILLs the whole process group on timeout, so the node
        # driver and its browser child are reaped together; record a clean skip.
        return RealSpaResult(
            captured=False,
            reason=f"real-SPA capture timed out after {spa_timeout_s:g}s",
            spa_png=str(spa_png) if spa_png.is_file() else None,
            console_log=str(console_log) if console_log.is_file() else None,
            url=url,
            log=str(driver_log),
        )

    duration = round(time.monotonic() - started, 3)
    _write_text(driver_log, _spa_driver_log(argv, stdout, stderr, returncode))

    # The SPA driver prints exactly one result object carrying a ``captured`` key.
    payload = scan_json_line(stdout, accept=lambda candidate: "captured" in candidate)
    if payload is None:
        reason = (
            f"real-SPA driver produced no result (exit {returncode}); "
            + (("stderr: " + "\n".join(stderr.splitlines()[-6:])) if stderr.strip() else "no stderr")
        )
        return RealSpaResult(
            captured=False,
            reason=reason,
            spa_png=str(spa_png) if spa_png.is_file() else None,
            console_log=str(console_log) if console_log.is_file() else None,
            url=url,
            log=str(driver_log),
        )

    captured = bool(payload.get("captured"))
    spa_exists = spa_png.is_file()
    spa_nonblank = png_is_nonblank(spa_png) if spa_exists else False
    console_exists = console_log.is_file()
    log(
        f"[tryout]   web ceiling: {'captured' if captured else 'skipped'} "
        f"({payload.get('reason')}) in {duration:g}s"
        + (f" -> spa.png ({'non-blank' if spa_nonblank else 'blank'})" if spa_exists else "")
    )
    return RealSpaResult(
        captured=captured,
        reason=str(payload.get("reason") or ("captured" if captured else "not captured")),
        spa_png=str(spa_png) if spa_exists else None,
        spa_png_nonblank=spa_nonblank if spa_exists else None,
        console_log=str(console_log) if console_exists else None,
        url=str(payload.get("url") or url),
        console_messages=payload.get("console_messages"),
        render=payload.get("render"),
        log=str(driver_log),
    )


def _spa_skipped(reason: str, *, console_log: Path) -> RealSpaResult:
    # Leave a breadcrumb so the artifact dir explains the skip even with no PNG.
    _write_text(console_log, f"# real-SPA ceiling skipped: {reason}\n")
    return RealSpaResult(captured=False, reason=reason, console_log=str(console_log))


def _system_browser_path() -> str | None:
    """The same browser the product CLI would use, for Playwright's executablePath.

    Honors ``LUCIDA_BROWSER`` first (so the floor and ceiling use one browser),
    then the platform's standard Chrome/Chromium/Edge locations. Matching the
    product CLI, an explicit-but-missing ``LUCIDA_BROWSER`` is respected as
    intent: we return ``None`` (skip with a clear reason) rather than silently
    falling back to a different browser than the user named.
    """
    override = os.environ.get("LUCIDA_BROWSER")
    if override and override.strip():
        return override if Path(override).exists() else None
    absolute_candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    for candidate in absolute_candidates:
        if Path(candidate).exists():
            return candidate
    for name in (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "msedge",
    ):
        found = shutil.which(name)
        if found:
            return found
    return None


def _playwright_cache_dir() -> Path:
    """Harness-owned dir where we provision the Playwright npm package.

    Overridable via ``LUCIDA_TRYOUT_PLAYWRIGHT_DIR`` (e.g. a warm CI cache). The
    default lives under the user cache home so it persists across runs without
    touching the repo.
    """
    override = os.environ.get("LUCIDA_TRYOUT_PLAYWRIGHT_DIR")
    if override and override.strip():
        return Path(override).expanduser()
    base = os.environ.get("XDG_CACHE_HOME")
    root = Path(base).expanduser() if base else (Path.home() / ".cache")
    return root / "lucida-tryout" / "playwright"


def _resolvable_node_modules() -> Path | None:
    """An existing node_modules that already resolves ``playwright``, if any.

    Checks the harness cache and any ``NODE_PATH`` entries, so a warm machine
    skips the npm install entirely (fast path for the loop).
    """
    candidates: list[Path] = [_playwright_cache_dir() / "node_modules"]
    node_path = os.environ.get("NODE_PATH")
    if node_path:
        candidates += [Path(part) for part in node_path.split(os.pathsep) if part]
    for modules in candidates:
        if (modules / "playwright" / "package.json").is_file():
            return modules
    return None


def _ensure_playwright(*, log=print, install_timeout_s: float = 300.0) -> Path:
    """Return a node_modules dir that resolves ``playwright``; install if needed.

    Fast path: reuse an already-resolvable copy (harness cache or NODE_PATH).
    Otherwise ``npm install playwright`` (no browser download — we reuse the
    system Chrome) into the harness cache. Raises :class:`TryoutError` (stage
    ``config``) if it can't be provisioned, so the caller records a clean skip.
    """
    existing = _resolvable_node_modules()
    if existing is not None:
        log(f"[tryout] web ceiling: reusing cached Playwright at {existing}")
        return existing

    npm = shutil.which("npm")
    if npm is None:
        raise TryoutError(
            "config",
            "npm not found on PATH; cannot provision Playwright for the real-SPA "
            "ceiling (set LUCIDA_TRYOUT_PLAYWRIGHT_DIR to a node_modules that has it)",
        )

    cache_dir = _playwright_cache_dir()
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        package_json = cache_dir / "package.json"
        if not package_json.is_file():
            package_json.write_text(
                json.dumps(
                    {"name": "lucida-tryout-playwright", "private": True, "version": "0.0.0"}
                )
                + "\n",
                encoding="utf-8",
            )
    except OSError as error:
        raise TryoutError(
            "config", f"could not prepare Playwright cache dir {cache_dir}: {error}"
        ) from error

    log(f"[tryout] web ceiling: provisioning Playwright into {cache_dir} (npm install) ...")
    env = dict(os.environ)
    # Don't download browser binaries; the ceiling reuses the system Chrome.
    env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
    try:
        result = run_group(
            [npm, "install", "--no-audit", "--no-fund", "--loglevel=error", "playwright"],
            cwd=str(cache_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=install_timeout_s,
        )
    except subprocess.TimeoutExpired as error:
        raise TryoutError(
            "config", f"npm install playwright timed out after {install_timeout_s:g}s"
        ) from error
    if result.returncode != 0:
        tail = "\n".join((result.stderr or result.stdout or "").splitlines()[-8:])
        raise TryoutError(
            "config",
            f"npm install playwright failed (exit {result.returncode}): {tail}",
        )

    modules = cache_dir / "node_modules"
    if not (modules / "playwright" / "package.json").is_file():
        raise TryoutError(
            "config",
            f"npm reported success but Playwright is not under {modules}",
        )
    return modules


def _spa_driver_log(argv: Sequence[str], stdout: str, stderr: str, returncode: int | None) -> str:
    return "\n".join(
        [
            "# lucida web real-SPA (Playwright) driver log",
            f"# exit_code: {returncode}",
            "$ node -e <driver> -- <request>",
            "",
            "--- stdout ---",
            stdout.rstrip("\n"),
            "",
            "--- stderr ---",
            stderr.rstrip("\n"),
            "",
        ]
    )


def _write_text(path: Path, text: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Registry adapter: how `drive` runs this surface generically.
# --------------------------------------------------------------------------- #

def _run(ctx) -> WebSurfaceResult:
    """Run the web surface from a :class:`tryout.drive.SurfaceContext`.

    The SPA bundle is resolved (or built) *before* boot by ``drive`` — the server
    must be booted with ``LUCIDA_WEB_DIST`` pointed at it. If that resolution
    failed, we record a clean ``ran=False`` skip here (the same skip ``drive``
    used to build inline) rather than running against a server with no viewer.
    """
    web_dist = ctx.web_dist
    if web_dist is None:
        error = (
            ctx.web_dist_error.to_error()
            if ctx.web_dist_error is not None
            else {"stage": "config", "message": "SPA bundle unavailable"}
        )
        return WebSurfaceResult(
            ran=False,
            ok=False,
            out_dir=str(ctx.out_dir / "web"),
            error=error,
        )
    return run_web_surface(
        base_url=ctx.base_url,
        workspace_id=ctx.workspace_id,
        dataset_id=ctx.dataset_id,
        out_dir=ctx.out_dir,
        config_path=ctx.cli_config_path,
        web_dist=web_dist.path,
        web_dist_source=web_dist.source,
        log=ctx.log,
    )


from . import Surface, register  # noqa: E402  (registry is defined in the package init)

register(
    Surface(
        name="web",
        run=_run,
        description="capture the rendered viewer (product CLI) + best-effort real-SPA",
    )
)
