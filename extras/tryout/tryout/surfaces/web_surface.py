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

  * **Ceiling: the DPR render matrix (gating at retina).** Drive the real SPA
    ourselves in a real browser via Playwright (provisioned through ``npm``/``npx``
    into a harness-owned cache, pointed at the same system Chrome the CLI uses —
    no browser download) at ``deviceScaleFactor`` **2 and 1**, wait for the *same*
    ``window.__lucidaCaptureReady`` signal, then judge each arm on whether a
    content frame actually presented into the main canvas. The retina arm gates:
    if it runs and the canvas is blank, the surface fails. If Playwright or a
    browser can't be provisioned, no arm runs, this is recorded as
    ``{captured: false, reason}`` with an explicitly *unenforced* gate, and the
    floor still stands — a provisioning hiccup is captured, never fatal (unless
    ``LUCIDA_TRYOUT_REQUIRE_DPR2=1``).

Why the retina arm is the one that gates: headless browsers default to
``deviceScaleFactor`` 1, and a class of render defects only appears when the
canvas backing store is 2x its CSS box (4x the pixels to fill). Those defects are
*silent* — no exception, no console error, the frame counter still climbing —
so the check has to be pixels in the canvas, not the absence of an error. See
``wiki/gotchas/retina-dpr2-render-verification.md``.

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
# navigate + render-wait + capture for EVERY arm of the render matrix).
# Generous; the backstop against an orphan.
DEFAULT_SPA_TIMEOUT_S = 360.0
# How long the Playwright driver waits for window.__lucidaCaptureReady, per arm,
# in ms. Two arms share DEFAULT_SPA_TIMEOUT_S, so this is deliberately under half
# of it: a wedged arm cannot eat the other arm's budget.
DEFAULT_SPA_RENDER_WAIT_MS = 120_000
# Default full-page viewport for the ceiling capture.
DEFAULT_VIEWPORT_W = 1400
DEFAULT_VIEWPORT_H = 900

# --- the DPR render matrix ------------------------------------------------- #
# Backing store size is CSS pixels x devicePixelRatio, so a retina context makes
# the GPU fill 4x the pixels per frame. A frame cost that crosses the completion
# budget there fails SILENTLY AND TOTALLY (black canvas, no console error) while
# the same code limps along at DPR 1 — and headless Chromium/Playwright/CI all
# default to deviceScaleFactor 1, i.e. only ever the easy half of the matrix.
# See wiki/gotchas/retina-dpr2-render-verification.md. So the ceiling drives BOTH
# scale factors, gating on the retina one.
DEFAULT_SCALE_FACTORS: tuple[int, ...] = (2, 1)
# The arm whose verdict flips the surface: stricter, and what retina users hit.
GATING_SCALE_FACTOR = 2
# Env overrides: the matrix itself, and whether a *skipped* retina arm (no
# browser/Playwright on this host) is tolerated. Default is tolerant, because a
# missing browser is an environment fact, not a lucida defect — but CI can set
# LUCIDA_TRYOUT_REQUIRE_DPR2=1 to make the gate mandatory.
SCALE_FACTORS_ENV = "LUCIDA_TRYOUT_SCALE_FACTORS"
REQUIRE_DPR2_ENV = "LUCIDA_TRYOUT_REQUIRE_DPR2"

# --- what counts as "a content frame actually presented" ------------------- #
# Judged on the CENTRE of the main canvas, not the page and not the whole canvas
# box. Two reasons, both learned from the defect this gate exists for:
#   * the full page is useless — the SPA chrome (sidebar, toolbar, text) renders
#     fine while the viewer is black, so a full-page shot has thousands of
#     colours and "non-blank" passes on a black viewer;
#   * an element-clipped canvas shot composites any DOM overlaid on the canvas
#     (FPS badge, orientation cube, minimap, annotations), which are corner- and
#     edge-anchored — enough to supply a spurious "second colour".
# The centre of the viewport is where a fit view puts the data, so a flat centre
# means nothing was presented. "Flat" rather than "black" on purpose: it also
# catches a canvas cleared to any solid colour and never drawn into.
CONTENT_CENTRE_INSET = 0.2          # analyse the middle 60% x 60%
CONTENT_MIN_DISTINCT_COLORS = 2
CONTENT_MAX_MODAL_FRACTION = 0.98   # >=2% of centre samples must differ
# Tolerance when checking that the arm really ran at the scale factor we asked
# for (observed devicePixelRatio, and the captured canvas image's scale).
DPR_FIDELITY_TOLERANCE = 0.05


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
class RenderArmResult:
    """One arm of the DPR render matrix: the SPA driven at one scale factor.

    ``ok`` is the judged verdict for this arm and answers the only question that
    matters: *did a content frame actually present at this devicePixelRatio?* It
    is deliberately not "the driver didn't throw" — the defect this exists for
    threw nothing, logged nothing, and reported itself ready.
    """

    device_scale_factor: int
    gating: bool
    ran: bool = False
    ok: bool = False
    reason: str = ""
    ready: bool = False
    render: dict[str, Any] | None = None     # the product's own readiness probe
    metrics: dict[str, Any] | None = None    # observed DPR + canvas geometry
    content: dict[str, Any] | None = None    # canvas pixel statistics
    checks: dict[str, bool] = field(default_factory=dict)
    failures: list[str] = field(default_factory=list)
    spa_png: str | None = None
    spa_png_nonblank: bool | None = None
    canvas_png: str | None = None
    console_log: str | None = None
    console_messages: int | None = None
    duration_s: float | None = None

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "device_scale_factor": self.device_scale_factor,
            "gating": self.gating,
            "ran": self.ran,
            "ok": self.ok,
            "reason": self.reason,
            "ready": self.ready,
            "checks": dict(self.checks),
        }
        if self.failures:
            record["failures"] = list(self.failures)
        for key in ("render", "metrics", "content", "spa_png", "spa_png_nonblank",
                    "canvas_png", "console_log", "console_messages", "duration_s"):
            value = getattr(self, key)
            if value is not None:
                record[key] = value
        return record


@dataclass
class RealSpaResult:
    """The real-SPA ceiling outcome: the whole DPR render matrix.

    ``captured`` still means "we got a browser and drove the SPA" (a host with no
    Chrome/Playwright records ``captured: false`` with a reason and never fails
    the run). What is NEW is ``gate``: once a browser *was* available, the
    deviceScaleFactor-2 arm's verdict is authoritative, because that is the arm a
    retina user actually hits.
    """

    captured: bool
    reason: str
    spa_png: str | None = None
    spa_png_nonblank: bool | None = None
    console_log: str | None = None
    url: str | None = None
    console_messages: int | None = None
    render: dict[str, Any] | None = None
    log: str | None = None
    arms: list[RenderArmResult] = field(default_factory=list)
    gate: dict[str, Any] = field(default_factory=dict)

    @property
    def gating_arm(self) -> RenderArmResult | None:
        return next((arm for arm in self.arms if arm.gating), None)

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
        record["scale_factors"] = [arm.device_scale_factor for arm in self.arms]
        record["arms"] = [arm.to_dict() for arm in self.arms]
        record["gate"] = dict(self.gate)
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
            # The second load-bearing verification fact, next to the floor: did
            # the retina (DPR 2) arm present a real content frame? Hoisted to the
            # top level for the same reason `viewer_png_nonblank` is — a reader
            # must not have to dig for the answer the harness exists to give.
            "render_gate": (self.real_spa.gate if self.real_spa is not None
                            else {"gated": False, "reason": "not attempted"}),
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

    # --- ceiling: the DPR render matrix (DPR 2 gates) ------------------------
    if attempt_real_spa:
        # Drive the same workspace URL the floor captured (with the viewer
        # profile), so the ceiling shows the same view the floor verified.
        spa_url = viewer_url or _fallback_workspace_url(base_url, workspace_id)
        result.real_spa = capture_real_spa(
            url=spa_url,
            web_out=web_out,
            log=log,
        )
        # A browser we COULD drive that did not present a content frame at
        # retina is a lucida defect, so it flips the surface. A browser we could
        # not provision is an environment fact, so it does not (unless the
        # caller demanded the gate via LUCIDA_TRYOUT_REQUIRE_DPR2).
        if not result.real_spa.gate.get("ok", True):
            result.ok = False
    else:
        result.real_spa = RealSpaResult(
            captured=False,
            reason="disabled by caller",
            gate={"ok": True, "gated": False, "reason": "disabled by caller"},
        )

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
# Ceiling: the DPR render matrix — drive the real SPA in a real browser at
# deviceScaleFactor 2 AND 1, and gate on the retina arm presenting content.
#
# This is the durable backstop for the retina blind spot. Three properties make
# it able to catch the defect class that hid for two days (see
# wiki/gotchas/retina-dpr2-render-verification.md):
#
#   1. **Both scale factors, every run.** Not a flag someone remembers to pass:
#      the matrix is the default, DPR 2 first because it gates.
#   2. **The verdict is pixels in the canvas, not "no error".** The defect threw
#      nothing and logged nothing, and the SPA chrome around the viewer rendered
#      perfectly — so a full-page "non-blank" check passes on a black viewer.
#      We clip to the main canvas and judge its CENTRE.
#   3. **The arm proves it really was retina.** The observed devicePixelRatio and
#      the captured image's scale are both checked against what we asked for, so
#      a DPR 2 arm that silently degraded to DPR 1 fails loudly instead of
#      manufacturing confidence about the half of the matrix nobody tests.
# --------------------------------------------------------------------------- #

# The Node driver. It is resilient by construction: every failure prints one JSON
# object to stdout and exits, so the Python side always gets a structured reason.
# It reuses the product's own readiness contract (window.__lucidaCaptureReady) so
# an arm is only "ready" once the viewer says it rendered the dataset — and then
# measures the canvas anyway, because that contract is published from the JS side
# of a WebGPU submit and can report a frame the GPU never presented.
#
# The driver only MEASURES (readiness, geometry, pixel statistics). The pass/fail
# policy lives in Python (:func:`judge_render_arm`) so it is testable without a
# browser and so a threshold change is a one-line diff, not a JS edit.
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
    out({ captured: false, reason: 'playwright_not_resolvable: ' + String(e2).split('\n')[0], arms: [] });
    process.exit(0);
  }
}

const req = JSON.parse(process.argv[2]);
const url = req.url;
const exe = req.executable_path || undefined;
const width = req.width || 1400;
const height = req.height || 900;
const renderWaitMs = req.render_wait_ms || 120000;
const scaleFactors = (req.scale_factors && req.scale_factors.length) ? req.scale_factors : [2, 1];
const shots = req.shots || {};
const centreInset = typeof req.centre_inset === 'number' ? req.centre_inset : 0.2;

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

// Geometry: the observed devicePixelRatio, and the MAIN canvas — the largest by
// CSS area, because the SPA also mounts small minimap / thumbnail canvases and
// `querySelector('canvas')` is only "first in the DOM".
function metricsProbe() {
  const list = Array.from(document.querySelectorAll('canvas'));
  let index = -1;
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const r = list[i].getBoundingClientRect();
    const area = r.width * r.height;
    if (area > best) { best = area; index = i; }
  }
  const el = index >= 0 ? list[index] : null;
  const rect = el ? el.getBoundingClientRect() : null;
  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    device_pixel_ratio: window.devicePixelRatio,
    canvas_count: list.length,
    canvas_index: index,
    css_width: rect ? round2(rect.width) : 0,
    css_height: rect ? round2(rect.height) : 0,
    backing_width: el ? (el.width || 0) : 0,
    backing_height: el ? (el.height || 0) : 0,
    inner_width: window.innerWidth,
    inner_height: window.innerHeight,
  };
}

// Decode a captured PNG and reduce it to pixel statistics. Runs in a SEPARATE
// blank page (never the page under test) so a broken SPA cannot influence — or
// break — the measurement, and so the decode uses the browser's native PNG path
// rather than a slow pure-Python one.
function pixelStats(args) {
  return (async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + args.data;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return { width: w, height: h, full: null, centre: null };
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const round6 = (v) => Math.round(v * 1e6) / 1e6;

    function region(x0, y0, x1, y1) {
      const stepX = Math.max(1, Math.floor((x1 - x0) / 256));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 256));
      const counts = new Map();
      let n = 0, nonblack = 0, sum = 0, max = 0;
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const i = (y * w + x) * 4;
          const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
          const key = ((r * 256 + g) * 256 + b) * 256 + a;
          counts.set(key, (counts.get(key) || 0) + 1);
          // A fully transparent pixel composites to the page behind it; for the
          // purpose of "did the viewer draw anything" it counts as nothing.
          const lum = a === 0 ? 0 : (0.2126 * r + 0.7152 * g + 0.0722 * b);
          sum += lum;
          if (lum > max) max = lum;
          if (lum > 6) nonblack += 1;
          n += 1;
        }
      }
      let modal = 0, modalKey = -1;
      for (const entry of counts) { if (entry[1] > modal) { modal = entry[1]; modalKey = entry[0]; } }
      const colour = modalKey < 0 ? null : [
        (modalKey >>> 24) & 255, (modalKey >>> 16) & 255, (modalKey >>> 8) & 255, modalKey & 255,
      ];
      return {
        samples: n,
        distinct_colors: counts.size,
        modal_fraction: round6(n ? modal / n : 1),
        modal_color: colour,
        nonblack_fraction: round6(n ? nonblack / n : 0),
        mean_luma: round6(n ? sum / n : 0),
        max_luma: round6(max),
      };
    }

    const inset = args.inset;
    const ix0 = Math.floor(w * inset), iy0 = Math.floor(h * inset);
    const ix1 = Math.max(ix0 + 1, Math.ceil(w * (1 - inset)));
    const iy1 = Math.max(iy0 + 1, Math.ceil(h * (1 - inset)));
    return { width: w, height: h, full: region(0, 0, w, h), centre: region(ix0, iy0, ix1, iy1) };
  })();
}

(async () => {
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: exe,
      args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check'],
    });
  } catch (e) {
    out({ captured: false, reason: 'browser_launch_failed: ' + String(e).split('\n')[0], arms: [] });
    process.exit(0);
  }

  // The measurement page: always DPR 1, always about:blank.
  let helper = null;
  try {
    const helperContext = await browser.newContext({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
    helper = await helperContext.newPage();
    await helper.goto('about:blank');
  } catch (e) {
    try { await browser.close(); } catch (_) {}
    out({ captured: false, reason: 'analysis_page_unavailable: ' + String(e).split('\n')[0], arms: [] });
    process.exit(0);
  }

  async function analyse(buffer) {
    if (!buffer) return null;
    return await helper.evaluate(pixelStats, { data: buffer.toString('base64'), inset: centreInset });
  }

  const arms = [];
  for (const dsf of scaleFactors) {
    const started = Date.now();
    const paths = shots[String(dsf)] || {};
    const messages = [];
    const arm = { device_scale_factor: dsf, ran: false, ready: false, reason: '' };
    let context = null;
    try {
      context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf });
      const page = await context.newPage();
      page.on('console', (msg) => { try { messages.push('[' + msg.type() + '] ' + msg.text()); } catch (_) {} });
      page.on('pageerror', (err) => { messages.push('[pageerror] ' + String(err && err.message ? err.message : err)); });
      page.on('requestfailed', (rq) => { try { messages.push('[requestfailed] ' + rq.url() + ' ' + (rq.failure() && rq.failure().errorText)); } catch (_) {} });

      await page.goto(url, { waitUntil: 'load', timeout: renderWaitMs });

      // Poll the product readiness probe until the viewer says it rendered.
      let probe = null;
      const deadline = Date.now() + renderWaitMs;
      while (Date.now() < deadline) {
        probe = await page.evaluate(readyProbe);
        if (probe && probe.ready) break;
        await page.waitForTimeout(250);
      }
      const metrics = await page.evaluate(metricsProbe);

      // Capture regardless of readiness so the human sees whatever rendered.
      let fullBuffer = null;
      try {
        fullBuffer = await page.screenshot({ path: paths.spa_png, fullPage: true });
      } catch (e) {
        arm.full_page_error = String(e && e.message ? e.message : e).split('\n')[0];
      }
      let canvasBuffer = null;
      if (metrics && metrics.canvas_index >= 0) {
        try {
          canvasBuffer = await page.locator('canvas').nth(metrics.canvas_index).screenshot({ path: paths.canvas_png });
        } catch (e) {
          arm.canvas_error = String(e && e.message ? e.message : e).split('\n')[0];
        }
      } else {
        arm.canvas_error = 'no canvas element in the page';
      }

      arm.render = probe;
      arm.metrics = metrics;
      arm.ready = Boolean(probe && probe.ready);
      arm.content = await analyse(canvasBuffer);
      arm.full_page = await analyse(fullBuffer);
      arm.ran = true;
      arm.reason = arm.ready ? 'rendered' : ('not_ready: ' + (probe ? probe.reason : 'unknown'));
    } catch (e) {
      arm.reason = 'arm_failed: ' + String(e && e.message ? e.message : e).split('\n')[0];
    } finally {
      try { if (paths.console_log) fs.writeFileSync(paths.console_log, messages.join('\n') + '\n'); } catch (_) {}
      arm.console_messages = messages.length;
      arm.duration_s = Math.round((Date.now() - started) / 100) / 10;
      try { if (context) await context.close(); } catch (_) {}
    }
    arms.push(arm);
  }

  try { await browser.close(); } catch (_) {}
  const ranAny = arms.some((a) => a.ran);
  out({
    captured: ranAny,
    reason: ranAny ? 'drove the SPA at deviceScaleFactor ' + scaleFactors.join(' and ')
                   : ('no arm ran: ' + (arms.length ? arms[0].reason : 'no scale factors')),
    arms,
    url,
  });
  process.exit(0);
})();
'''


# --------------------------------------------------------------------------- #
# The verdict policy. Pure functions over the driver's measurements, so the rule
# "a content frame actually presented at retina" is unit-testable with no
# browser, and a threshold is a one-line change in one place.
# --------------------------------------------------------------------------- #

def _check_dpr_fidelity(
    metrics: Any, content: Any, device_scale_factor: int
) -> tuple[bool, list[str]]:
    """Did this arm really run at the scale factor it claims?

    Two independent witnesses: what the page observed (``devicePixelRatio``) and
    how big the captured canvas image is relative to its CSS box (Playwright
    scales element screenshots by the context's ``deviceScaleFactor``). If either
    disagrees, the arm is not the retina arm it says it is — and a matrix whose
    strict half quietly collapsed into its lenient half is exactly the false
    confidence this gate exists to prevent.
    """
    failures: list[str] = []
    if not isinstance(metrics, dict):
        return False, ["no page metrics were captured"]

    observed = metrics.get("device_pixel_ratio")
    if not isinstance(observed, (int, float)) or isinstance(observed, bool):
        failures.append(f"page did not report a devicePixelRatio (got {observed!r})")
    elif abs(float(observed) - device_scale_factor) > DPR_FIDELITY_TOLERANCE:
        failures.append(
            f"page ran at devicePixelRatio {float(observed):g}, asked for {device_scale_factor}"
        )

    css_width = _as_float(metrics.get("css_width"))
    shot_width = _as_float((content or {}).get("width") if isinstance(content, dict) else None)
    if css_width <= 0:
        failures.append("the main canvas has zero CSS width (nothing to capture)")
    elif shot_width <= 0:
        failures.append("no canvas image was captured")
    else:
        scale = shot_width / css_width
        if abs(scale - device_scale_factor) > DPR_FIDELITY_TOLERANCE:
            failures.append(
                f"canvas capture is {scale:.3g}x its CSS box, asked for {device_scale_factor}x "
                f"({shot_width:g} device px / {css_width:g} CSS px)"
            )
    return (not failures), failures


def _check_canvas_content(content: Any) -> tuple[bool, list[str]]:
    """Did a content frame actually present into the canvas?

    Flatness of the canvas CENTRE is the test. A permanently black viewer — the
    exact shape of the defect this gate exists for — is one flat colour there,
    while everything around it (SPA chrome, corner overlays, the console, the
    frame counter) looks healthy.
    """
    if not isinstance(content, dict):
        return False, ["no canvas pixels were analysed (canvas missing or not capturable)"]
    centre = content.get("centre")
    if not isinstance(centre, dict) or int(centre.get("samples") or 0) <= 0:
        return False, ["the canvas centre had no sampled pixels"]

    distinct = int(centre.get("distinct_colors") or 0)
    modal = _as_float(centre.get("modal_fraction"), default=1.0)
    colour = centre.get("modal_color")
    if distinct < CONTENT_MIN_DISTINCT_COLORS:
        return False, [
            f"the canvas centre is one flat colour rgba{tuple(colour) if colour else '(?)'} "
            "— no content frame presented"
        ]
    if modal > CONTENT_MAX_MODAL_FRACTION:
        return False, [
            f"the canvas centre is {modal:.2%} a single colour "
            f"rgba{tuple(colour) if colour else '(?)'} "
            f"(limit {CONTENT_MAX_MODAL_FRACTION:.0%}) — no content frame presented"
        ]
    return True, []


def judge_render_arm(
    payload: dict[str, Any],
    *,
    device_scale_factor: int,
    gating: bool,
) -> RenderArmResult:
    """Turn one arm's raw measurements into a verdict.

    Three checks, all of which must hold: the product said it rendered, the arm
    really was this scale factor, and the canvas actually shows something. The
    first alone is what the harness used to rely on — and it is precisely the one
    the defect satisfied, because ``__lucidaCaptureReady`` is published from the
    JS side of a WebGPU submit, before the GPU has presented anything.
    """
    arm = RenderArmResult(device_scale_factor=device_scale_factor, gating=gating)
    arm.ran = bool(payload.get("ran"))
    arm.ready = bool(payload.get("ready"))
    arm.render = payload.get("render")
    arm.metrics = payload.get("metrics")
    arm.content = payload.get("content")
    arm.console_messages = payload.get("console_messages")
    arm.duration_s = payload.get("duration_s")

    full_page = payload.get("full_page")
    if isinstance(full_page, dict) and isinstance(full_page.get("full"), dict):
        # Recorded, never gating: the SPA chrome around a black viewer makes the
        # full page "non-blank" no matter what the viewer did.
        arm.spa_png_nonblank = (
            int(full_page["full"].get("distinct_colors") or 0) >= CONTENT_MIN_DISTINCT_COLORS
        )

    if not arm.ran:
        arm.reason = str(payload.get("reason") or "the arm did not run")
        arm.failures = [arm.reason]
        return arm

    failures: list[str] = []
    if not arm.ready:
        failures.append(
            f"the viewer never reported a rendered frame ({payload.get('reason') or 'not ready'})"
        )
    dpr_ok, dpr_failures = _check_dpr_fidelity(arm.metrics, arm.content, device_scale_factor)
    failures.extend(dpr_failures)
    content_ok, content_failures = _check_canvas_content(arm.content)
    failures.extend(content_failures)

    arm.checks = {
        "ready": arm.ready,
        "device_scale_factor": dpr_ok,
        "content_frame": content_ok,
    }
    arm.ok = arm.ready and dpr_ok and content_ok
    arm.failures = failures
    arm.reason = "a content frame presented" if arm.ok else "; ".join(failures)
    return arm


def build_render_gate(
    arms: Sequence[RenderArmResult],
    *,
    skip_reason: str | None = None,
    require: bool = False,
) -> dict[str, Any]:
    """The one verdict that can flip the web surface: the retina arm's.

    A retina arm that ran and failed is a lucida defect and fails the surface. A
    retina arm that could not run (no Chrome, no Playwright, no node) is an
    environment fact and does not — but it is reported as ``gated: false`` so a
    reader never mistakes a missing gate for a passing one, and
    ``LUCIDA_TRYOUT_REQUIRE_DPR2=1`` turns it into a failure for CI.
    """
    gating = next((arm for arm in arms if arm.gating and arm.ran), None)
    if gating is not None:
        return {
            "ok": gating.ok,
            "gated": True,
            "required": require,
            "device_scale_factor": gating.device_scale_factor,
            "reason": gating.reason,
            "failures": list(gating.failures),
            "checks": dict(gating.checks),
        }
    reason = skip_reason or "the deviceScaleFactor 2 arm did not run"
    return {
        "ok": not require,
        "gated": False,
        "required": require,
        "device_scale_factor": GATING_SCALE_FACTOR,
        "reason": f"retina render gate NOT enforced: {reason}",
    }


def _as_float(value: Any, *, default: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


def scale_factors_from_env(default: Sequence[int] = DEFAULT_SCALE_FACTORS) -> list[int]:
    """The render matrix, honoring ``LUCIDA_TRYOUT_SCALE_FACTORS`` (e.g. ``"2,1"``).

    An unparseable value falls back to the default rather than failing the run —
    but the default already includes 2, so the gate can never be dropped by a
    typo, only by an explicit, valid override.
    """
    raw = os.environ.get(SCALE_FACTORS_ENV)
    if not raw or not raw.strip():
        return list(default)
    parsed: list[int] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            value = int(token)
        except ValueError:
            return list(default)
        if value > 0 and value not in parsed:
            parsed.append(value)
    return parsed or list(default)


def require_dpr2_from_env() -> bool:
    """Whether a skipped retina arm should fail the run (``LUCIDA_TRYOUT_REQUIRE_DPR2``)."""
    raw = (os.environ.get(REQUIRE_DPR2_ENV) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def capture_real_spa(
    *,
    url: str,
    web_out: Path,
    spa_timeout_s: float = DEFAULT_SPA_TIMEOUT_S,
    render_wait_ms: int = DEFAULT_SPA_RENDER_WAIT_MS,
    viewport: tuple[int, int] = (DEFAULT_VIEWPORT_W, DEFAULT_VIEWPORT_H),
    scale_factors: Sequence[int] | None = None,
    require_dpr2: bool | None = None,
    log=print,
) -> RealSpaResult:
    """Drive the real SPA at every scale factor in the matrix and judge each arm.

    Never raises: a failure to provision node/Playwright/a browser, or any runtime
    error, becomes ``RealSpaResult(captured=False, reason=...)`` with an
    unenforced (``gated: false``) gate. The whole matrix runs in ONE node process
    and ONE browser (a context per arm), so the second scale factor costs a page
    load, not another launch + provision. The subprocess has a hard timeout and
    the driver always closes its browser, so no orphan survives.
    """
    factors = list(scale_factors) if scale_factors is not None else scale_factors_from_env()
    require = require_dpr2_from_env() if require_dpr2 is None else require_dpr2
    console_log = web_out / "console.log"
    driver_log = web_out / "spa-driver.log"

    def skipped(reason: str) -> RealSpaResult:
        return _spa_skipped(reason, console_log=console_log, require=require)

    node = shutil.which("node")
    if node is None:
        return skipped("node not found on PATH (the real-SPA ceiling needs Node + Playwright)")

    try:
        node_path = _ensure_playwright(log=log)
    except TryoutError as error:
        return skipped(error.message)

    browser_path = _system_browser_path()
    if browser_path is None:
        return skipped("no Chrome/Chromium found (set LUCIDA_BROWSER) for the real-SPA ceiling")

    shots = {
        str(dsf): {
            "spa_png": str(web_out / f"spa-dpr{dsf}.png"),
            "canvas_png": str(web_out / f"canvas-dpr{dsf}.png"),
            "console_log": str(web_out / f"console-dpr{dsf}.log"),
        }
        for dsf in factors
    }
    request = json.dumps(
        {
            "url": url,
            "executable_path": browser_path,
            "width": viewport[0],
            "height": viewport[1],
            "render_wait_ms": render_wait_ms,
            "scale_factors": factors,
            "shots": shots,
            "centre_inset": CONTENT_CENTRE_INSET,
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
        "[tryout] web ceiling: driving the real SPA via Playwright (system Chrome) at "
        f"{url} — deviceScaleFactor {', '.join(str(f) for f in factors)} "
        f"(DPR {GATING_SCALE_FACTOR} gates)"
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
            + f"\n[tryout] real-SPA render matrix timed out after {spa_timeout_s:g}s"
        )
        returncode = None
        _write_text(driver_log, _spa_driver_log(argv, stdout, stderr, returncode))
        # run_group SIGKILLs the whole process group on timeout, so the node
        # driver and its browser child are reaped together. A timeout is NOT a
        # clean skip: the browser was there and never presented, which is exactly
        # the failure mode this gate is for.
        reason = f"real-SPA render matrix timed out after {spa_timeout_s:g}s"
        return RealSpaResult(
            captured=False,
            reason=reason,
            console_log=str(console_log) if console_log.is_file() else None,
            url=url,
            log=str(driver_log),
            gate={
                "ok": False,
                "gated": True,
                "required": require,
                "device_scale_factor": GATING_SCALE_FACTOR,
                "reason": reason,
                "failures": [reason],
            },
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
            console_log=str(console_log) if console_log.is_file() else None,
            url=url,
            log=str(driver_log),
            gate=build_render_gate([], skip_reason=reason, require=require),
        )

    raw_arms = payload.get("arms") or []
    arms: list[RenderArmResult] = []
    for index, dsf in enumerate(factors):
        raw = raw_arms[index] if index < len(raw_arms) else {}
        if not isinstance(raw, dict):
            raw = {}
        arm = judge_render_arm(
            raw,
            device_scale_factor=int(raw.get("device_scale_factor") or dsf),
            gating=(dsf == GATING_SCALE_FACTOR),
        )
        paths = shots[str(dsf)]
        for attribute, key in (("spa_png", "spa_png"), ("canvas_png", "canvas_png"),
                               ("console_log", "console_log")):
            candidate = Path(paths[key])
            if candidate.is_file():
                setattr(arm, attribute, str(candidate))
        arms.append(arm)

    captured = bool(payload.get("captured"))
    gate = build_render_gate(
        arms,
        skip_reason=str(payload.get("reason") or "no arm ran"),
        require=require,
    )

    for arm in arms:
        verdict = "ok" if arm.ok else ("FAIL" if arm.ran else "did not run")
        log(
            f"[tryout]   web ceiling: deviceScaleFactor {arm.device_scale_factor}"
            f"{' (gates)' if arm.gating else ''}: {verdict} — {arm.reason}"
            + (f" ({arm.duration_s:g}s)" if arm.duration_s is not None else "")
        )
    log(
        f"[tryout]   web ceiling: retina render gate "
        f"{'PASS' if gate.get('ok') else 'FAIL'}"
        f"{'' if gate.get('gated') else ' (not enforced)'} in {duration:g}s"
    )

    gating_arm = next((arm for arm in arms if arm.gating), None)
    primary = gating_arm or (arms[0] if arms else None)
    return RealSpaResult(
        captured=captured,
        reason=str(payload.get("reason") or ("captured" if captured else "not captured")),
        spa_png=(primary.spa_png if primary is not None else None),
        spa_png_nonblank=(primary.spa_png_nonblank if primary is not None else None),
        console_log=(
            primary.console_log if primary is not None and primary.console_log
            else (str(console_log) if console_log.is_file() else None)
        ),
        url=str(payload.get("url") or url),
        console_messages=(primary.console_messages if primary is not None else None),
        render=(primary.render if primary is not None else None),
        log=str(driver_log),
        arms=arms,
        gate=gate,
    )


def _spa_skipped(reason: str, *, console_log: Path, require: bool = False) -> RealSpaResult:
    # Leave a breadcrumb so the artifact dir explains the skip even with no PNG.
    _write_text(console_log, f"# real-SPA render matrix skipped: {reason}\n")
    return RealSpaResult(
        captured=False,
        reason=reason,
        console_log=str(console_log),
        gate=build_render_gate([], skip_reason=reason, require=require),
    )


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
