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

  * **Browser matrix (required by default).** Drive the real SPA via Playwright
    (provisioned through ``npm`` into a harness-owned cache and pointed at the
    same system Chrome the CLI uses — no browser download) at both DPR1 and DPR2.
    Each arm waits for the same ``window.__lucidaCaptureReady`` signal, forces a
    resize and requires the presented-frame counter to advance, captures the
    full page and canvas separately, pixel-checks the canvas, and exercises the
    retained responsive, accessibility, overlay, keyboard, and idle contracts.
    The DPR2 arm additionally runs the bounded mutating async/fault-recovery and
    first-run tours; DPR1 records explicit validated skip receipts for those
    stateful tours. Playwright/browser failures remain structured artifacts, but
    fail the web surface unless the caller explicitly disables the matrix.

Design choices, matching the CLI/Python surfaces:

  * **Captured, not fatal.** Each CLI capture's argv + outcome + log path is
    recorded; a non-zero exit is *data*. The surface reports ``ran=False`` only if
    it could not be exercised at all (CLI binary missing / SPA bundle missing).
    ``ok`` requires the nonblank floor plus both browser-matrix arms.
  * **Hermetic + reaped.** Every browser the harness launches has a hard
    subprocess timeout and is reaped on every path (the CLI reaps its own Chrome;
    the Playwright driver closes its browser in a ``finally`` and the subprocess
    timeout is the backstop) so no orphan browser survives a run.
  * **Verifiable offline.** The PNGs + the recorded ``viewer_url`` + the result
    let a human confirm lucida displayed the dataset without re-running.
"""

from __future__ import annotations

import json
import math
import os
import runpy
import shutil
import subprocess
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from ..browser_launch import headless_webgpu_browser_args
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
# Hard ceiling for each Playwright matrix subprocess (provision + launch +
# navigate + render-wait + capture). Generous; the backstop against an orphan.
DEFAULT_SPA_TIMEOUT_S = 240.0
# How long the Playwright driver waits for window.__lucidaCaptureReady, in ms.
DEFAULT_SPA_RENDER_WAIT_MS = 150_000
# Default full-page viewport for each matrix arm.
DEFAULT_VIEWPORT_W = 1400
DEFAULT_VIEWPORT_H = 900
# Must match lucida-web/package.json. The repo install is the normal/CI path;
# this exact fallback keeps an ad-hoc tryout from silently testing with a newer
# browser driver than the lockfile and delivery validator approve.
PLAYWRIGHT_VERSION = "1.61.0"
# The browser contract runs axe in the page itself. Keep this exact fallback in
# lockstep with lucida-web/package.json for reproducible ad-hoc and CI runs.
AXE_CORE_VERSION = "4.12.1"


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
class RealSpaArmResult:
    """One isolated production-SPA render arm at an explicit browser DPR."""

    device_scale_factor: int
    captured: bool
    rendered: bool
    frame_advanced: bool
    reason: str
    spa_png: str | None = None
    spa_png_nonblank: bool | None = None
    canvas_png: str | None = None
    canvas_png_nonblank: bool | None = None
    canvas_content: dict[str, Any] | None = None
    console_log: str | None = None
    console_messages: int | None = None
    diagnostic: str | None = None
    render: dict[str, Any] | None = None
    browser_contract: dict[str, Any] | None = None
    gpu_failures: list[str] = field(default_factory=list)
    contract_failures: list[str] = field(default_factory=list)
    log: str | None = None
    # Internal normalized pixel sample used for the cross-DPR equivalence gate.
    # Kept out of the JSON artifact; the compact metric receipt is emitted on
    # RealSpaResult.dpr_matrix instead of thousands of sample triples.
    canvas_css_sample: dict[str, Any] | None = field(default=None, repr=False)

    @property
    def ok(self) -> bool:
        return (
            self.captured
            and self.rendered
            and self.frame_advanced
            and self.canvas_png_nonblank is True
            and not self.gpu_failures
            and not self.contract_failures
        )

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "device_scale_factor": self.device_scale_factor,
            "captured": self.captured,
            "rendered": self.rendered,
            "frame_advanced": self.frame_advanced,
            "ok": self.ok,
            "reason": self.reason,
            "gpu_failures": list(self.gpu_failures),
            "contract_failures": list(self.contract_failures),
        }
        for key in (
            "spa_png",
            "spa_png_nonblank",
            "canvas_png",
            "canvas_png_nonblank",
            "canvas_content",
            "console_log",
            "console_messages",
            "diagnostic",
            "render",
            "browser_contract",
            "log",
        ):
            value = getattr(self, key)
            if value is not None:
                record[key] = value
        return record


@dataclass(frozen=True)
class RealContentExpectation:
    """Optional fixture-specific assertions layered on the generic pixel gate."""

    require_non_u16: bool = False
    min_channel_count: int = 1
    expected_channel: int | None = None
    expected_contrast: tuple[float, float] | None = None
    require_collection_1x12: bool = False


@dataclass
class RealSpaResult:
    """The required DPR1+DPR2 real-SPA render matrix.

    The legacy top-level artifact fields mirror the stricter DPR2 arm so old
    reports still show one representative capture while new consumers inspect
    ``arms`` and ``ok``.
    """

    captured: bool
    reason: str
    ok: bool = False
    arms: list[RealSpaArmResult] = field(default_factory=list)
    spa_png: str | None = None
    spa_png_nonblank: bool | None = None
    console_log: str | None = None
    url: str | None = None
    console_messages: int | None = None
    render: dict[str, Any] | None = None
    dpr_matrix: dict[str, Any] | None = None
    log: str | None = None

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "captured": self.captured,
            "ok": self.ok,
            "reason": self.reason,
            "required_device_scale_factors": [1, 2],
            "arms": [arm.to_dict() for arm in self.arms],
        }
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
        if self.dpr_matrix is not None:
            record["dpr_matrix"] = self.dpr_matrix
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
        # Surface the representative DPR2 artifacts at the top level too
        # spa_png/console_log keys), so a reader doesn't have to dig.
        if self.real_spa is not None and self.real_spa.spa_png is not None:
            record["spa_png"] = self.real_spa.spa_png
        if self.real_spa is not None and self.real_spa.console_log is not None:
            record["console_log"] = self.real_spa.console_log
        if self.error is not None:
            record["error"] = self.error
        return record


# --------------------------------------------------------------------------- #
# Non-blank PNG check (shared by floor + browser matrix).
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


def canvas_png_content_receipt(path: Path) -> dict[str, Any]:
    """Prove that a canvas PNG contains interior rendered signal, not chrome.

    A rounded black canvas has multiple whole-image colors because its corners
    expose page background and antialiasing. Sampling only the interior and
    requiring luminance spread plus color entropy makes that false positive
    fail while retaining a compact, inspectable receipt.
    """

    receipt: dict[str, Any] = {
        "passed": False,
        "sample_scope": "interior-80-percent",
        "path": str(path),
    }
    if not png_is_nonblank(path):
        receipt["reason"] = "PNG failed the baseline decode/nonblank gate"
        return receipt
    decoder = _assert_png_nonblank_script()
    if decoder is None:
        receipt["reason"] = "pixel decoder unavailable"
        return receipt
    try:
        namespace = runpy.run_path(str(decoder))
        data = path.read_bytes()
        width, height, _depth, color_type, compressed, palette = namespace["parse_png"](data)
        rows = namespace["reconstruct_scanlines"](width, height, color_type, compressed)
        color_at = namespace["color_at"]
        margin_x = width // 10 if width >= 20 else 0
        margin_y = height // 10 if height >= 20 else 0
        left, right = margin_x, width - margin_x
        top, bottom = margin_y, height - margin_y
        step_x = max(1, (right - left) // 192)
        step_y = max(1, (bottom - top) // 192)
        color_bins: Counter[tuple[int, int, int]] = Counter()
        luminance_bins: Counter[int] = Counter()
        luminances: list[float] = []
        for y in range(top, bottom, step_y):
            row = rows[y]
            for x in range(left, right, step_x):
                red, green, blue, alpha = color_at(row, x, color_type, palette)
                if alpha < 128:
                    continue
                alpha_fraction = alpha / 255.0
                red = round(red * alpha_fraction)
                green = round(green * alpha_fraction)
                blue = round(blue * alpha_fraction)
                luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
                luminances.append(luminance)
                color_bins[(red // 16, green // 16, blue // 16)] += 1
                luminance_bins[int(luminance // 8)] += 1

        sampled = len(luminances)
        if sampled == 0:
            receipt["reason"] = "interior contained no opaque pixels"
            return receipt

        def entropy(counter: Counter[Any]) -> float:
            return -sum(
                (count / sampled) * math.log2(count / sampled)
                for count in counter.values()
                if count > 0
            )

        dominant_fraction = max(color_bins.values(), default=sampled) / sampled
        luminance_min = min(luminances)
        luminance_max = max(luminances)
        color_entropy = entropy(color_bins)
        luminance_entropy = entropy(luminance_bins)
        receipt.update({
            "width": width,
            "height": height,
            "sampled_opaque_pixels": sampled,
            "distinct_color_bins": len(color_bins),
            "distinct_luminance_bins": len(luminance_bins),
            "luminance_min": round(luminance_min, 4),
            "luminance_max": round(luminance_max, 4),
            "luminance_range": round(luminance_max - luminance_min, 4),
            "color_entropy_bits": round(color_entropy, 6),
            "luminance_entropy_bits": round(luminance_entropy, 6),
            "dominant_color_fraction": round(dominant_fraction, 6),
            "non_background_fraction": round(1.0 - dominant_fraction, 6),
        })
        passed = (
            sampled >= 64
            and len(color_bins) >= 3
            and luminance_max >= 12
            and luminance_max - luminance_min >= 8
            and color_entropy >= 0.1
            and luminance_entropy >= 0.05
            and 1.0 - dominant_fraction >= 0.002
        )
        receipt["passed"] = passed
        receipt["reason"] = (
            "interior rendered-content evidence passed"
            if passed
            else "interior lacked meaningful luminance/entropy/non-background signal"
        )
        return receipt
    except Exception as error:  # noqa: BLE001 - any decoder failure is fail-closed evidence
        receipt["reason"] = f"interior pixel analysis failed: {error}"
        return receipt


_CSS_EQUIVALENCE_GRID = (96, 64)


def _canvas_css_sample(path: Path) -> dict[str, Any] | None:
    """Sample one isolated canvas on a fixed normalized CSS-space grid.

    Element screenshots are emitted at browser backing resolution (DPR2 is
    twice as wide/high as DPR1). Sampling by normalized coordinates removes
    that resolution difference while a 4x4 sub-grid average makes the evidence
    tolerant of ordinary raster/antialiasing changes.
    """

    decoder = _assert_png_nonblank_script()
    if decoder is None or not path.is_file():
        return None
    try:
        namespace = runpy.run_path(str(decoder))
        width, height, _depth, color_type, compressed, palette = namespace["parse_png"](
            path.read_bytes()
        )
        rows = namespace["reconstruct_scanlines"](width, height, color_type, compressed)
        color_at = namespace["color_at"]
        grid_w, grid_h = _CSS_EQUIVALENCE_GRID
        pixels: list[tuple[float, float, float]] = []
        # Four sub-samples per axis avoid making the result depend on one source
        # texel while bounding this proof to ~100k color reads even for 4K DPR2.
        offsets = (0.125, 0.375, 0.625, 0.875)
        for gy in range(grid_h):
            for gx in range(grid_w):
                red_sum = green_sum = blue_sum = 0.0
                count = 0
                for oy in offsets:
                    y = min(height - 1, int(((gy + oy) / grid_h) * height))
                    row = rows[y]
                    for ox in offsets:
                        x = min(width - 1, int(((gx + ox) / grid_w) * width))
                        red, green, blue, alpha = color_at(row, x, color_type, palette)
                        alpha_fraction = alpha / 255.0
                        red_sum += red * alpha_fraction
                        green_sum += green * alpha_fraction
                        blue_sum += blue * alpha_fraction
                        count += 1
                pixels.append((red_sum / count, green_sum / count, blue_sum / count))
        return {
            "grid_width": grid_w,
            "grid_height": grid_h,
            "source_width": width,
            "source_height": height,
            "pixels": pixels,
        }
    except Exception:  # noqa: BLE001 - malformed evidence fails closed upstream
        return None


def _dilate_mask(mask: list[bool], width: int, height: int) -> list[bool]:
    out = [False] * len(mask)
    for index, present in enumerate(mask):
        if not present:
            continue
        y, x = divmod(index, width)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    out[ny * width + nx] = True
    return out


def _canvas_css_equivalence_from_samples(
    first: dict[str, Any] | None,
    second: dict[str, Any] | None,
) -> dict[str, Any]:
    """Compare two normalized isolated-canvas samples in CSS space."""

    base: dict[str, Any] = {
        "passed": False,
        "method": "normalized-96x64-rgb-grid-with-1-cell-signal-tolerance",
        "max_mean_absolute_rgb_error": 0.12,
        "min_luminance_correlation": 0.70,
        "min_bidirectional_signal_overlap": 0.55,
    }
    if not isinstance(first, dict) or not isinstance(second, dict):
        return {**base, "reason": "normalized isolated-canvas samples were unavailable"}
    width = first.get("grid_width")
    height = first.get("grid_height")
    if width != second.get("grid_width") or height != second.get("grid_height"):
        return {**base, "reason": "normalized canvas grids differed"}
    left = first.get("pixels")
    right = second.get("pixels")
    if not isinstance(width, int) or not isinstance(height, int) \
            or not isinstance(left, list) or not isinstance(right, list) \
            or len(left) != width * height or len(right) != len(left):
        return {**base, "reason": "normalized canvas samples were malformed"}

    left_lum = [0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] for p in left]
    right_lum = [0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] for p in right]
    mean_abs = sum(
        abs(a[channel] - b[channel])
        for a, b in zip(left, right, strict=True)
        for channel in range(3)
    ) / (len(left) * 3 * 255.0)

    left_mean = sum(left_lum) / len(left_lum)
    right_mean = sum(right_lum) / len(right_lum)
    covariance = sum(
        (a - left_mean) * (b - right_mean)
        for a, b in zip(left_lum, right_lum, strict=True)
    )
    left_var = sum((value - left_mean) ** 2 for value in left_lum)
    right_var = sum((value - right_mean) ** 2 for value in right_lum)
    correlation = covariance / math.sqrt(left_var * right_var) \
        if left_var > 0 and right_var > 0 else 0.0

    signal_threshold = max(8.0, 0.08 * max(max(left_lum), max(right_lum)))
    left_mask = [value >= signal_threshold for value in left_lum]
    right_mask = [value >= signal_threshold for value in right_lum]
    left_dilated = _dilate_mask(left_mask, width, height)
    right_dilated = _dilate_mask(right_mask, width, height)
    left_count = sum(left_mask)
    right_count = sum(right_mask)
    left_covered = sum(a and b for a, b in zip(left_mask, right_dilated, strict=True))
    right_covered = sum(a and b for a, b in zip(right_mask, left_dilated, strict=True))
    overlap = min(
        left_covered / left_count if left_count else 0.0,
        right_covered / right_count if right_count else 0.0,
    )
    passed = mean_abs <= 0.12 and correlation >= 0.70 and overlap >= 0.55
    return {
        **base,
        "passed": passed,
        "reason": (
            "isolated canvases were equivalent in normalized CSS space"
            if passed
            else "isolated canvases diverged in normalized CSS space"
        ),
        "grid": [width, height],
        "dpr1_source_pixels": [first.get("source_width"), first.get("source_height")],
        "dpr2_source_pixels": [second.get("source_width"), second.get("source_height")],
        "mean_absolute_rgb_error": round(mean_abs, 6),
        "luminance_correlation": round(correlation, 6),
        "bidirectional_signal_overlap": round(overlap, 6),
        "signal_threshold": round(signal_threshold, 4),
        "dpr1_signal_bins": left_count,
        "dpr2_signal_bins": right_count,
    }


def canvas_css_equivalence_receipt(first_path: Path, second_path: Path) -> dict[str, Any]:
    """Public synthetic/live proof that DPR1 and DPR2 canvases depict one view."""

    return _canvas_css_equivalence_from_samples(
        _canvas_css_sample(first_path),
        _canvas_css_sample(second_path),
    )


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
    real_content_expectation: RealContentExpectation = RealContentExpectation(),
    first_run_dataset_path: str | None = None,
    require_first_run: bool = False,
    log=print,
) -> WebSurfaceResult:
    """Capture the viewer floor and the required DPR1/2 real-SPA matrix.

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

    # --- required real-browser matrix ----------------------------------------
    if attempt_real_spa:
        # Drive the same workspace URL the floor captured (with the viewer
        # profile), so both matrix arms show the same view the floor verified.
        spa_url = viewer_url or _fallback_workspace_url(base_url, workspace_id)
        result.real_spa = capture_real_spa(
            url=spa_url,
            web_out=web_out,
            expectation=real_content_expectation,
            first_run_dataset_path=first_run_dataset_path,
            require_first_run=require_first_run,
            log=log,
        )
        result.ok = floor_ok and result.real_spa.ok
    else:
        result.real_spa = RealSpaResult(
            captured=False,
            reason="disabled by caller",
            ok=False,
        )

    return result


def _is_required(capture: WebCaptureResult, captures: list[WebCaptureResult]) -> bool:
    # viewer is the only required capture; mirror the plan without re-threading it.
    return capture.name == "viewer"


def _fallback_workspace_url(base_url: str, workspace_id: str) -> str:
    """The SPA workspace URL the server serves: ``{base_url}/w/{id}``.

    Mirrors the CLI's ``workspace_web_url``; used only if the CLI didn't report a
    URL (e.g. it failed before printing JSON) so the browser matrix can still try.
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
# Browser matrix: drive the real SPA in isolated real-browser DPR arms.
# --------------------------------------------------------------------------- #

# The Node driver. It is resilient by construction: every failure prints one JSON
# object to stdout and exits, so the Python side always gets a structured reason.
# It reuses the product's own readiness contract (window.__lucidaCaptureReady)
# so spa.png is captured only once the viewer has actually rendered the dataset.
_SPA_DRIVER = r'''
'use strict';
const fs = require('fs');
const crypto = require('crypto');

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

let axeSource = null;
try {
  axeSource = require('axe-core').source;
} catch (error) {
  out({ captured: false, reason: 'axe_core_not_resolvable: ' + String(error).split('\n')[0] });
  process.exit(0);
}

const req = JSON.parse(process.argv[2]);
const url = req.url;
const spaPng = req.spa_png;
const canvasPng = req.canvas_png;
const firstRunPng = req.first_run_png;
const focusFailurePng = req.focus_failure_png;
const consoleLog = req.console_log;
const exe = req.executable_path || undefined;
const width = req.width || 1400;
const height = req.height || 900;
const deviceScaleFactor = req.device_scale_factor;
const renderWaitMs = req.render_wait_ms || 150000;
const firstRunDatasetPath = req.first_run_dataset_path || null;
const firstRunRequiredChannels = Number(req.first_run_required_channels || 1);
const requireCollection1x12 = Boolean(req.require_collection_1x12);

// The product's render-readiness probe (kept in lockstep with the CLI's
// LUCIDA_CAPTURE_READY_PROBE): a sized canvas whose __lucidaCaptureReady reports
// ready with frames drawn and a dataset loaded.
function readyProbe() {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { ready: false, reason: 'missing_canvas', frame_count: 0, dataset_count: 0, canvas_width: 0, canvas_height: 0 };
  const canvasRect = canvas.getBoundingClientRect();
  const clientWidth = Number(canvas.clientWidth || canvasRect.width || 0);
  const clientHeight = Number(canvas.clientHeight || canvasRect.height || 0);
  const backingWidth = Number(canvas.width || 0);
  const backingHeight = Number(canvas.height || 0);
  const cw = backingWidth || Math.floor(clientWidth);
  const ch = backingHeight || Math.floor(clientHeight);
  if (!cw || !ch) return { ready: false, reason: 'zero_size_canvas', frame_count: 0, dataset_count: 0, canvas_width: cw || 0, canvas_height: ch || 0 };
  const s = window.__lucidaCaptureReady;
  if (!s) return { ready: false, reason: 'missing_lucida_capture_ready', frame_count: 0, dataset_count: 0, canvas_width: cw, canvas_height: ch };
  const fc = Number(s.frameCount || 0);
  const dc = Number(s.datasetCount || 0);
  const ready = Boolean(s.ready) && fc > 0 && dc > 0;
  return {
    ready,
    reason: ready ? 'rendered' : String(s.reason || 'not_ready'),
    frame_count: fc,
    dataset_count: dc,
    canvas_width: cw,
    canvas_height: ch,
    canvas_backing_width: backingWidth,
    canvas_backing_height: backingHeight,
    canvas_client_width: clientWidth,
    canvas_client_height: clientHeight,
    canvas_css_width: Number(canvasRect.width || 0),
    canvas_css_height: Number(canvasRect.height || 0),
    backing_to_client_x: clientWidth > 0 ? backingWidth / clientWidth : null,
    backing_to_client_y: clientHeight > 0 ? backingHeight / clientHeight : null,
    device_pixel_ratio: Number(window.devicePixelRatio || 0),
    datasets: Array.isArray(s.datasets) ? s.datasets : [],
    view: s.view || null,
    camera: s.camera || null,
  };
}

async function installBrowserProbes(page) {
  await page.evaluate(() => {
    function rectRecord(element) {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    }
    function intersects(left, right) {
      return Boolean(left && right)
        && left.left < right.right && left.right > right.left
        && left.top < right.bottom && left.bottom > right.top;
    }
    function intersection(left, right) {
      if (!intersects(left, right)) return null;
      const result = {
        left: Math.max(left.left, right.left),
        top: Math.max(left.top, right.top),
        right: Math.min(left.right, right.right),
        bottom: Math.min(left.bottom, right.bottom),
      };
      result.x = result.left;
      result.y = result.top;
      result.width = result.right - result.left;
      result.height = result.bottom - result.top;
      return result.width > 0 && result.height > 0 ? result : null;
    }
    function elementIsEffectivelyVisible(element) {
      if (!element || !element.isConnected) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hidden || current.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || style.visibility === 'hidden'
            || style.visibility === 'collapse' || style.contentVisibility === 'hidden'
            || Number.parseFloat(style.opacity || '1') === 0) return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function visibleClip(element) {
      const visual = window.visualViewport;
      const left = Number(visual && visual.offsetLeft || 0);
      const top = Number(visual && visual.offsetTop || 0);
      let clip = {
        left,
        top,
        right: left + Number(visual && visual.width || innerWidth),
        bottom: top + Number(visual && visual.height || innerHeight),
      };
      for (let ancestor = element && element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const bounds = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          clip.left = Math.max(clip.left, bounds.left);
          clip.right = Math.min(clip.right, bounds.right);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          clip.top = Math.max(clip.top, bounds.top);
          clip.bottom = Math.min(clip.bottom, bounds.bottom);
        }
      }
      clip.x = clip.left;
      clip.y = clip.top;
      clip.width = Math.max(0, clip.right - clip.left);
      clip.height = Math.max(0, clip.bottom - clip.top);
      return clip;
    }
    function effectiveVisibleRect(element) {
      if (!elementIsEffectivelyVisible(element)) return null;
      return intersection(rectRecord(element), visibleClip(element));
    }
    function hitRecord(element) {
      if (!element) return { found: false, hit: false, rect: null };
      const rect = rectRecord(element);
      const visibleRect = effectiveVisibleRect(element);
      if (!visibleRect) {
        return { found: true, hit: false, in_viewport: false, rect, visible_rect: null };
      }
      const top = document.elementFromPoint(
        visibleRect.left + visibleRect.width / 2,
        visibleRect.top + visibleRect.height / 2,
      );
      return {
        found: true,
        hit: top === element || element.contains(top),
        in_viewport: Boolean(rect)
          && rect.left >= visibleClip(element).left && rect.top >= visibleClip(element).top
          && rect.right <= visibleClip(element).right && rect.bottom <= visibleClip(element).bottom,
        rect,
        visible_rect: visibleRect,
      };
    }
    window.__lucidaTryoutRectRecord = rectRecord;
    window.__lucidaTryoutElementIsEffectivelyVisible = elementIsEffectivelyVisible;
    window.__lucidaTryoutVisibleClip = visibleClip;
    window.__lucidaTryoutEffectiveVisibleRect = effectiveVisibleRect;
    window.__lucidaTryoutLayoutProbe = (label) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = (name) => buttons.find((candidate) => candidate.textContent.trim() === name) || null;
      const canvas = document.querySelector('canvas[aria-label$="viewer"]') || document.querySelector('canvas');
      const canvasRect = rectRecord(canvas);
      const alert = document.querySelector('[role="alert"]');
      const chrome = document.querySelector('.workspace-chrome');
      const finitePositiveCanvas = Boolean(canvasRect)
        && [canvasRect.x, canvasRect.y, canvasRect.width, canvasRect.height].every(Number.isFinite)
        && canvasRect.width > 0 && canvasRect.height > 0;
      return {
        label,
        viewport: [window.innerWidth, window.innerHeight],
        document_width: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        body_width: [document.body.scrollWidth, document.body.clientWidth],
        horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
          || document.body.scrollWidth > document.body.clientWidth + 1,
        canvas: canvasRect,
        finite_positive_canvas: finitePositiveCanvas,
        primary_hits: {
          workspaces: hitRecord(button('Workspaces')),
          share: hitRecord(button('Share Workspace')),
          layers: hitRecord(button('Layers')),
        },
        alert: alert ? {
          rect: rectRecord(alert),
          immediately_after_chrome: alert.previousElementSibling === chrome,
          has_retry: Array.from(alert.querySelectorAll('button')).some((candidate) => /retry/i.test(candidate.textContent)),
          has_dismiss: Array.from(alert.querySelectorAll('button')).some((candidate) => /dismiss/i.test(candidate.textContent)),
        } : null,
      };
    };
  });
}

async function waitForLayoutSettlement(page, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stableSamples = 0;
  let samples = 0;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => {
      const selectors = [
        '[data-testid="mentions-of-me-badge"]',
        '[data-testid="mentions-of-me-panel"]',
        '[data-testid="explore-panel"]',
        '[data-testid="collection-selector"]',
        '.minimap-panel',
        '.thread-popover',
      ];
      return selectors.map((selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        const visible = elements.find((element) =>
          window.__lucidaTryoutElementIsEffectivelyVisible(element));
        const rect = visible ? window.__lucidaTryoutRectRecord(visible) : null;
        return [selector, rect && [rect.left, rect.top, rect.width, rect.height]];
      });
    });
    samples += 1;
    const key = JSON.stringify(snapshot);
    if (key === previous) stableSamples += 1;
    else stableSamples = 0;
    if (stableSamples >= 2) return { settled: true, samples, snapshot };
    previous = key;
    await page.waitForTimeout(50);
  }
  return { settled: false, samples, snapshot: previous };
}

async function prepareViewportTrigger(page, locator, label) {
  const count = await locator.count();
  if (count !== 1) {
    return { label, found: false, count, in_viewport: false, hit_testable: false, rect: null };
  }
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return inspectViewportTrigger(page, locator, label);
}

async function inspectViewportTrigger(page, locator, label) {
  const count = await locator.count();
  if (count !== 1) {
    return { label, found: false, count, in_viewport: false, hit_testable: false, rect: null };
  }
  return locator.evaluate((element, triggerLabel) => {
    const rect = window.__lucidaTryoutRectRecord(element);
    const visibleRect = window.__lucidaTryoutEffectiveVisibleRect(element);
    const hit = visibleRect ? document.elementFromPoint(
      visibleRect.left + visibleRect.width / 2,
      visibleRect.top + visibleRect.height / 2,
    ) : null;
    return {
      label: triggerLabel,
      found: true,
      count: 1,
      in_viewport: Boolean(rect && visibleRect)
        && Math.abs(rect.width - visibleRect.width) < 0.5
        && Math.abs(rect.height - visibleRect.height) < 0.5,
      hit_testable: Boolean(hit && (hit === element || element.contains(hit))),
      rect,
      visible_rect: visibleRect,
    };
  }, label);
}

async function exerciseIdleContract(page) {
  await ensureViewMode(page, '2d');
  await waitForReady(page, -1, 30000);
  // The overlay tour intentionally leaves Explore open. Its thumbnail UI is a
  // different workload from the renderer-idle contract (and may contain
  // transient placeholders), so close every optional surface and record that
  // clean boundary instead of measuring whatever state an earlier tour left.
  for (const name of ['Explore', 'Saved Views']) {
    const toggle = page.getByRole('button', { name, exact: true });
    if (await toggle.count() === 1 && await toggle.getAttribute('aria-pressed') === 'true') {
      await toggle.click();
    }
  }
  const mentionsToggle = page.locator('[data-testid="mentions-of-me-badge"]');
  if (await mentionsToggle.count() === 1
    && await mentionsToggle.getAttribute('aria-expanded') === 'true') {
    await mentionsToggle.click();
  }
  const closeThread = page.getByRole('button', { name: 'Close thread' });
  while (await closeThread.count() > 0) await closeThread.first().click();
  await resetWorkspaceScroll(page);
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-floating-surface], .thread-popover, .explore-panel').length === 0
  ), undefined, { timeout: 10000 });
  const quiescencePreconditions = await page.evaluate(() => ({
    floating_surface_count: document.querySelectorAll('[data-floating-surface]').length,
    thread_count: document.querySelectorAll('.thread-popover').length,
    explore_panel_count: document.querySelectorAll('.explore-panel').length,
    pending_thumbnail_count: document.querySelectorAll('.explore-thumb-pending').length,
    dialog_count: document.querySelectorAll('[role="dialog"]').length,
  }));
  const settled = await waitForRuntimeSettled(page);
  if (!settled) return { contract_version: null, settled_before: false };
  const performanceSession = await page.context().newCDPSession(page);
  await performanceSession.send('Performance.enable');
  const metric = (metrics, name) => {
    const entry = metrics && metrics.metrics.find((candidate) => candidate.name === name);
    return entry ? Number(entry.value) : null;
  };
  const median = (values) => {
    const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (finite.length === 0) return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
  };
  const capture = () => page.evaluate(() => ({
    raf: { ...window.__lucidaTryoutRafTelemetry, pending: window.__lucidaTryoutRafPending.size },
    intervals: {
      requested: window.__lucidaTryoutIntervalTelemetry.requested,
      fired: window.__lucidaTryoutIntervalTelemetry.fired,
      cleared: window.__lucidaTryoutIntervalTelemetry.cleared,
      callback_duration_ms: window.__lucidaTryoutIntervalTelemetry.callback_duration_ms,
      active: window.__lucidaTryoutIntervalTelemetry.active.size,
    },
    frame_count: Number(window.__lucidaCaptureReady && window.__lucidaCaptureReady.frameCount || 0),
    runtime: window.__lucidaRenderContract.getSnapshot(),
  }));
  const samples = [];
  const sampleDurationMs = 1000;
  const cpuTaskBudgetMs = 25;
  for (let index = 0; index < 3; index++) {
    const performanceBefore = await performanceSession.send('Performance.getMetrics');
    const before = await capture();
    await page.waitForTimeout(sampleDurationMs);
    const after = await capture();
    const performanceAfter = await performanceSession.send('Performance.getMetrics');
    const beforeTaskDuration = metric(performanceBefore, 'TaskDuration');
    const afterTaskDuration = metric(performanceAfter, 'TaskDuration');
    const beforeScriptDuration = metric(performanceBefore, 'ScriptDuration');
    const afterScriptDuration = metric(performanceAfter, 'ScriptDuration');
    const sample = {
      index,
      duration_ms: sampleDurationMs,
      cpu_task_duration_delta_ms: beforeTaskDuration === null || afterTaskDuration === null
        ? null : (afterTaskDuration - beforeTaskDuration) * 1000,
      cpu_script_duration_delta_ms: beforeScriptDuration === null || afterScriptDuration === null
        ? null : (afterScriptDuration - beforeScriptDuration) * 1000,
      requested_delta: after.raf.requested - before.raf.requested,
      fired_delta: after.raf.fired - before.raf.fired,
      interval_fired_delta: after.intervals.fired - before.intervals.fired,
      interval_callback_duration_delta_ms:
        after.intervals.callback_duration_ms - before.intervals.callback_duration_ms,
      active_intervals_after: after.intervals.active,
      frame_delta: after.frame_count - before.frame_count,
      pending_after: after.raf.pending,
      posted_delta: after.runtime.client.frames.posted - before.runtime.client.frames.posted,
      presented_delta: after.runtime.client.frames.presented - before.runtime.client.frames.presented,
      worker_message_delta: after.runtime.client.worker.messages - before.runtime.client.worker.messages,
      runtime_pending_after: after.runtime.client.frames.pending,
      loop_pending_after: after.runtime.loop.animationFramePending,
      loop_dirty_after: after.runtime.loop.interactiveDirty || after.runtime.loop.residencyDirty,
      long_task_observer_supported: before.runtime.mainThread.longTaskObserverSupported
        && after.runtime.mainThread.longTaskObserverSupported,
      long_task_count_delta: after.runtime.mainThread.longTaskCount
        - before.runtime.mainThread.longTaskCount,
      long_task_duration_delta_ms: after.runtime.mainThread.longTaskDurationMs
        - before.runtime.mainThread.longTaskDurationMs,
      before: before.runtime,
      after: after.runtime,
    };
    sample.product_activity_zero = sample.frame_delta === 0
      && sample.posted_delta === 0 && sample.presented_delta === 0
      && sample.worker_message_delta === 0 && sample.runtime_pending_after === 0
      && !sample.loop_pending_after && !sample.loop_dirty_after;
    sample.strict_zero_activity = sample.product_activity_zero
      && sample.requested_delta === 0 && sample.fired_delta === 0
      && sample.interval_fired_delta === 0 && sample.active_intervals_after === 0
      && sample.pending_after === 0 && sample.long_task_observer_supported
      && sample.long_task_count_delta === 0 && sample.long_task_duration_delta_ms === 0;
    // CDP task metrics include coarse browser noise outside product-owned
    // render telemetry. Accept their median/two-of-three result, but never use
    // that tolerance to mask a non-zero RAF/render/worker/long-task window.
    sample.quiet_window_passed = Number.isFinite(sample.cpu_task_duration_delta_ms)
      && sample.cpu_task_duration_delta_ms <= cpuTaskBudgetMs
      && Number.isFinite(sample.cpu_script_duration_delta_ms)
      && sample.cpu_script_duration_delta_ms <= cpuTaskBudgetMs;
    samples.push(sample);
  }
  const before = samples[0];
  const after = samples[samples.length - 1];
  const resizer = page.getByRole('separator', { name: 'Resize viewer' });
  await resizer.focus();
  await resizer.press('ArrowLeft');
  await page.waitForFunction(({ posted, presented }) => {
    const contract = window.__lucidaRenderContract;
    if (!contract || contract.version !== 1) return false;
    const snapshot = contract.getSnapshot();
    return snapshot.client.frames.posted > posted
      && snapshot.client.frames.presented > presented
      && snapshot.client.frames.pending === 0;
  }, {
    posted: after.after.client.frames.posted,
    presented: after.after.client.frames.presented,
  }, { timeout: 30000 });
  const resumed = await waitForRuntimeSettled(page);
  await performanceSession.detach();
  return {
    contract_version: before.before.version,
    quiescence_preconditions: quiescencePreconditions,
    settled_before: before.before.client.frames.pending === 0
      && !before.before.loop.animationFramePending
      && !before.before.loop.interactiveDirty
      && !before.before.loop.residencyDirty,
    sample_count: samples.length,
    required_passing_sample_count: 2,
    passing_sample_count: samples.filter((sample) => sample.quiet_window_passed).length,
    samples,
    duration_ms: sampleDurationMs * samples.length,
    sample_duration_ms: sampleDurationMs,
    cpu_task_budget_ms: cpuTaskBudgetMs,
    cpu_task_duration_delta_ms: median(samples.map((sample) => sample.cpu_task_duration_delta_ms)),
    cpu_script_duration_delta_ms: median(samples.map((sample) => sample.cpu_script_duration_delta_ms)),
    requested_delta: samples.reduce((sum, sample) => sum + sample.requested_delta, 0),
    fired_delta: samples.reduce((sum, sample) => sum + sample.fired_delta, 0),
    interval_fired_delta: samples.reduce((sum, sample) => sum + sample.interval_fired_delta, 0),
    interval_callback_duration_delta_ms: samples.reduce(
      (sum, sample) => sum + sample.interval_callback_duration_delta_ms,
      0,
    ),
    active_intervals_after: Math.max(...samples.map((sample) => sample.active_intervals_after)),
    frame_delta: samples.reduce((sum, sample) => sum + sample.frame_delta, 0),
    pending_after: Math.max(...samples.map((sample) => sample.pending_after)),
    posted_delta: samples.reduce((sum, sample) => sum + sample.posted_delta, 0),
    presented_delta: samples.reduce((sum, sample) => sum + sample.presented_delta, 0),
    worker_message_delta: samples.reduce((sum, sample) => sum + sample.worker_message_delta, 0),
    runtime_pending_after: Math.max(...samples.map((sample) => sample.runtime_pending_after)),
    loop_pending_after: samples.some((sample) => sample.loop_pending_after),
    loop_dirty_after: samples.some((sample) => sample.loop_dirty_after),
    product_activity_zero: samples.every((sample) => sample.product_activity_zero),
    strict_zero_activity: samples.every((sample) => sample.strict_zero_activity),
    long_task_observer_supported: samples.every((sample) => sample.long_task_observer_supported),
    long_task_count_delta: samples.reduce((sum, sample) => sum + sample.long_task_count_delta, 0),
    long_task_duration_delta_ms: samples.reduce(
      (sum, sample) => sum + sample.long_task_duration_delta_ms,
      0,
    ),
    interaction: {
      kind: 'keyboard-resize-viewer',
      settled_after: Boolean(resumed),
      posted_advanced: Boolean(resumed
        && resumed.client.frames.posted > after.after.client.frames.posted),
      presented_advanced: Boolean(resumed
        && resumed.client.frames.presented > after.after.client.frames.presented),
      worker_messages_advanced: Boolean(resumed
        && resumed.client.worker.messages > after.after.client.worker.messages),
      pending_after: resumed && resumed.client.frames.pending,
    },
    before: before.before,
    after: after.after,
    resumed,
  };
}

function idleFailures(contract) {
  const failures = [];
  const preconditions = contract && contract.quiescence_preconditions;
  if (!preconditions || preconditions.floating_surface_count !== 0
    || preconditions.thread_count !== 0 || preconditions.explore_panel_count !== 0
    || preconditions.pending_thumbnail_count !== 0 || preconditions.dialog_count !== 0) {
    failures.push('renderer idle probe inherited active UI work from an earlier tour');
  }
  if (contract.contract_version !== 1) failures.push('renderer runtime contract version 1 was unavailable');
  if (!contract.settled_before) failures.push('viewer did not settle before the idle budget');
  if (!Array.isArray(contract.samples) || contract.samples.length !== 3
    || contract.sample_count !== 3 || contract.required_passing_sample_count !== 2
    || contract.passing_sample_count < contract.required_passing_sample_count) {
    failures.push('idle browser trace did not pass two of three quiet windows');
  }
  if (contract.requested_delta !== 0 || contract.fired_delta !== 0) {
    failures.push('idle browser trace retained a requestAnimationFrame loop');
  }
  if (contract.interval_fired_delta !== 0 || contract.active_intervals_after !== 0) {
    failures.push('idle browser trace retained a recurring interval');
  }
  if (contract.frame_delta !== 0) failures.push('idle renderer kept presenting frames');
  if (contract.pending_after !== 0) failures.push('idle browser retained a RAF callback');
  if (!Number.isFinite(contract.cpu_task_duration_delta_ms)
    || contract.cpu_task_duration_delta_ms > contract.cpu_task_budget_ms
    || !Number.isFinite(contract.cpu_script_duration_delta_ms)
    || contract.cpu_script_duration_delta_ms > contract.cpu_task_budget_ms) {
    failures.push('idle main-thread task duration exceeded its CPU budget');
  }
  if (contract.posted_delta !== 0 || contract.presented_delta !== 0
    || contract.worker_message_delta !== 0 || contract.frame_delta !== 0
    || contract.product_activity_zero !== true
    || !Array.isArray(contract.samples)
    || contract.samples.some((sample) => sample.product_activity_zero !== true)) {
    failures.push('settled viewer posted, presented, or received worker messages while idle');
  }
  if (contract.strict_zero_activity !== true || !Array.isArray(contract.samples)
    || contract.samples.some((sample) => sample.strict_zero_activity !== true)) {
    failures.push('idle activity was non-zero in at least one quiet window');
  }
  if (contract.runtime_pending_after !== 0 || contract.loop_pending_after || contract.loop_dirty_after) {
    failures.push('renderer retained pending work after the idle budget');
  }
  if (!contract.long_task_observer_supported || contract.long_task_count_delta !== 0
    || contract.long_task_duration_delta_ms !== 0) {
    failures.push('idle main thread exceeded the zero-long-task budget');
  }
  if (!contract.interaction || !contract.interaction.settled_after
    || !contract.interaction.posted_advanced
    || !contract.interaction.presented_advanced
    || !contract.interaction.worker_messages_advanced
    || contract.interaction.pending_after !== 0) {
    failures.push('real keyboard interaction did not resume and settle a presented frame');
  }
  return failures;
}

async function captureLayoutProbe(page, label) {
  await resetWorkspaceScroll(page);
  await waitForLayoutSettlement(page);
  const targets = {
    workspaces: page.getByRole('button', { name: 'Workspaces', exact: true }),
    share: page.getByRole('button', { name: 'Share Workspace', exact: true }),
    layers: page.getByRole('button', { name: 'Layers', exact: true }),
    dataset_url: page.getByLabel('Dataset URL or path'),
    open: page.getByRole('button', { name: 'Open', exact: true }),
    browse: page.getByRole('button', { name: 'Browse files', exact: true }),
    explore: page.getByRole('button', { name: 'Explore', exact: true }),
    mentions: page.locator('[data-testid="mentions-of-me-badge"]'),
  };
  const reachableControls = {};
  for (const [name, locator] of Object.entries(targets)) {
    const receipt = await prepareViewportTrigger(page, locator, label + ': ' + name);
    reachableControls[name] = {
      found: receipt.found,
      reachable: receipt.in_viewport && receipt.hit_testable,
      rect: receipt.rect,
      visible_rect: receipt.visible_rect || null,
    };
  }
  await resetWorkspaceScroll(page);
  const layoutSettlement = await waitForLayoutSettlement(page);
  const probe = await page.evaluate(
    (probeLabel) => window.__lucidaTryoutLayoutProbe(probeLabel),
    label,
  );
  probe.reachable_controls = reachableControls;
  probe.layout_settlement = layoutSettlement;
  return probe;
}

function layoutFailures(probe) {
  const failures = [];
  if (!probe.layout_settlement || !probe.layout_settlement.settled) {
    failures.push(probe.label + ': layout did not settle before geometry capture');
  }
  if (probe.horizontal_overflow) failures.push(probe.label + ': horizontal document overflow');
  if (!probe.finite_positive_canvas) failures.push(probe.label + ': canvas was not finite and positive');
  const requiredControls = probe.label.startsWith('mobile')
    ? ['workspaces', 'share', 'layers', 'dataset_url', 'open', 'browse', 'explore', 'mentions']
    : ['workspaces', 'share', 'dataset_url', 'open', 'browse', 'explore', 'mentions'];
  for (const name of requiredControls) {
    const hit = (probe.reachable_controls || {})[name];
    if (!hit || !hit.found) {
      failures.push(probe.label + ': primary control ' + name + ' was not reachable');
    } else if (!hit.reachable) {
      failures.push(probe.label + ': primary control ' + name + ' was occluded');
    }
    if (probe.label.startsWith('mobile') && ['workspaces', 'share', 'layers'].includes(name)
      && hit && hit.rect
      && (hit.rect.width < 44 || hit.rect.height < 44)) {
      failures.push(probe.label + ': primary control ' + name + ' was smaller than 44x44');
    }
  }
  return failures;
}

async function captureDashboardLayout(page, label) {
  const dashboardActions = page.locator('.workspace-dashboard-actions');
  const targets = {
    create_input: page.getByLabel('New workspace from dataset URL or path'),
    create_from_url: page.getByRole('button', { name: 'Create from URL', exact: true }),
    browse: page.getByRole('button', { name: 'Browse files…', exact: true }),
    search: page.getByLabel('Search workspaces'),
    new_workspace: dashboardActions.getByRole('button', {
      name: /^(New Workspace|Creating\.\.\.)$/,
    }),
  };
  const controls = {};
  for (const [name, locator] of Object.entries(targets)) {
    const receipt = await prepareViewportTrigger(page, locator, label + ': ' + name);
    controls[name] = {
      found: receipt.found,
      reachable: receipt.in_viewport && receipt.hit_testable,
      rect: receipt.rect,
      visible_rect: receipt.visible_rect || null,
    };
  }
  await resetWorkspaceScroll(page);
  const layoutSettlement = await waitForLayoutSettlement(page);
  return page.evaluate(({ probeLabel, controlRecords }) => ({
    label: probeLabel,
    viewport: [innerWidth, innerHeight],
    document_width: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      || document.body.scrollWidth > document.body.clientWidth + 1,
    controls: controlRecords,
    layout_settlement: null,
  }), { probeLabel: label, controlRecords: controls }).then((probe) => ({
    ...probe,
    layout_settlement: layoutSettlement,
  }));
}

function dashboardLayoutFailures(probe) {
  const failures = [];
  if (!probe.layout_settlement || !probe.layout_settlement.settled) {
    failures.push(probe.label + ': dashboard layout did not settle before geometry capture');
  }
  if (probe.horizontal_overflow) failures.push(probe.label + ': dashboard horizontal overflow');
  for (const [name, control] of Object.entries(probe.controls || {})) {
    if (!control.found || !control.reachable) {
      failures.push(probe.label + ': dashboard control ' + name + ' was not vertically reachable');
    }
  }
  return failures;
}

async function exerciseDashboardContract(context, sourcePage) {
  const dashboard = await context.newPage();
  try {
    const origin = new URL(sourcePage.url()).origin;
    await dashboard.goto(origin + '/', { waitUntil: 'load', timeout: renderWaitMs });
    await installBrowserProbes(dashboard);
    await dashboard.getByRole('heading', { name: 'Workspaces' }).waitFor({ state: 'visible', timeout: 15000 });
    await dashboard.setViewportSize({ width: 1280, height: 720 });
    const desktop = await captureDashboardLayout(dashboard, 'dashboard-desktop-1280x720');
    const desktopAxe = await runAxe(dashboard, 'dashboard-desktop-1280x720');
    await dashboard.setViewportSize({ width: 390, height: 844 });
    const mobile = await captureDashboardLayout(dashboard, 'dashboard-mobile-390x844');
    const mobileAxe = await runAxe(dashboard, 'dashboard-mobile-390x844');
    const failures = [
      ...dashboardLayoutFailures(desktop),
      ...dashboardLayoutFailures(mobile),
      ...axeFailures(desktopAxe),
      ...axeFailures(mobileAxe),
    ];
    return { ok: failures.length === 0, layouts: [desktop, mobile], axe: [desktopAxe, mobileAxe], failures };
  } finally {
    await dashboard.close();
  }
}

async function waitForReady(page, minimumFrame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let probe = null;
  while (Date.now() < deadline) {
    probe = await page.evaluate(readyProbe);
    if (probe && probe.ready && Number(probe.frame_count || 0) > minimumFrame) return probe;
    await page.waitForTimeout(100);
  }
  return probe;
}

async function viewportPresentationSnapshot(page) {
  const [ready, runtime, layout] = await Promise.all([
    page.evaluate(readyProbe),
    renderRuntimeSnapshot(page),
    page.evaluate(() => {
      const canvas = Array.from(document.querySelectorAll('canvas'))
        .find((element) => element.getClientRects().length > 0) || null;
      const rect = canvas && canvas.getBoundingClientRect();
      return {
        viewport: [window.innerWidth, window.innerHeight],
        canvas: canvas && rect ? {
          css: [rect.width, rect.height],
          backing: [canvas.width, canvas.height],
        } : null,
      };
    }),
  ]);
  return { ready, runtime, ...layout };
}

function viewportPresentationAdvanced(before, after, expectedViewport) {
  const beforeClient = before && before.runtime && before.runtime.client;
  const afterClient = after && after.runtime && after.runtime.client;
  return Boolean(beforeClient && afterClient
    && after && after.ready && after.ready.ready
    && Array.isArray(after.viewport)
    && after.viewport[0] === expectedViewport[0]
    && after.viewport[1] === expectedViewport[1]
    && Number(after.ready.frame_count || 0) > Number(before.ready.frame_count || 0)
    && afterClient.surface.forwarded > beforeClient.surface.forwarded
    && afterClient.frames.posted > beforeClient.frames.posted
    && afterClient.frames.presented > beforeClient.frames.presented);
}

async function waitForViewportPresentation(page, before, expectedViewport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await viewportPresentationSnapshot(page);
  while (Date.now() < deadline) {
    if (viewportPresentationAdvanced(before, snapshot, expectedViewport)) {
      return { passed: true, snapshot };
    }
    await page.waitForTimeout(100);
    snapshot = await viewportPresentationSnapshot(page);
  }
  return { passed: false, snapshot };
}

async function exerciseInitialViewportPresentation(page, width, height, timeoutMs) {
  const baseline = await viewportPresentationSnapshot(page);
  const originalViewport = Array.isArray(baseline.viewport)
    ? baseline.viewport
    : [width, height];
  const originalWidth = originalViewport[0];
  const mutationDelta = Math.min(160, Math.max(64, Math.floor(originalWidth * 0.1)));
  const narrowerWidth = Math.max(320, originalWidth - mutationDelta);
  const mutatedViewport = [
    narrowerWidth === originalWidth ? originalWidth + mutationDelta : narrowerWidth,
    originalViewport[1],
  ];
  await page.setViewportSize({ width: mutatedViewport[0], height: mutatedViewport[1] });
  const mutated = await waitForViewportPresentation(
    page,
    baseline,
    mutatedViewport,
    timeoutMs,
  );
  await page.setViewportSize({ width: originalViewport[0], height: originalViewport[1] });
  if (!mutated.passed) {
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return {
      passed: false,
      failed_stage: 'mutated-presentation',
      baseline,
      mutated: mutated.snapshot,
      restored: await viewportPresentationSnapshot(page),
    };
  }
  const restored = await waitForViewportPresentation(
    page,
    mutated.snapshot,
    originalViewport,
    timeoutMs,
  );
  return {
    passed: restored.passed,
    failed_stage: restored.passed ? null : 'restored-presentation',
    baseline,
    mutated: mutated.snapshot,
    restored: restored.snapshot,
  };
}

async function waitForRenderedChannel(page, minimumFrame, expectedChannel, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let probe = null;
  while (Date.now() < deadline) {
    probe = await page.evaluate(readyProbe);
    const view = probe && probe.view;
    const firstLayer = view && Array.isArray(view.layers) ? view.layers[0] : null;
    if (probe && probe.ready
        && Number(probe.frame_count || 0) > minimumFrame
        && Number(view && view.c) === expectedChannel
        && Number(firstLayer && firstLayer.channel) === expectedChannel) {
      return { ...probe, expected_channel_matched: true };
    }
    await page.waitForTimeout(100);
  }
  return probe ? { ...probe, expected_channel_matched: false } : null;
}

function primaryViewerCanvas(page) {
  const labelled = page.locator('canvas[aria-label$="viewer"]:visible').first();
  return labelled;
}

/**
 * Capture the primary viewer canvas without composited DOM siblings.
 *
 * Playwright's element screenshot is a clipped page screenshot, not a raw
 * canvas readback: absolutely-positioned annotation, minimap, or collection
 * DOM painted above the canvas is otherwise included. Keep the exact canvas
 * and its ancestor chain visible (so layout/WebGPU presentation is untouched),
 * but hide every other branch for the capture frame. Ancestor decoration and
 * pseudo-elements are neutralized as well, leaving only the canvas pixels.
 */
async function capturePrimaryCanvas(page, options = {}) {
  let canvas = primaryViewerCanvas(page);
  if (await canvas.count() === 0) canvas = page.locator('canvas:visible').first();
  if (await canvas.count() === 0) return null;
  const token = crypto.randomBytes(12).toString('hex');
  await canvas.evaluate((element, captureToken) => {
    const pathAttribute = 'data-lucida-canvas-proof-path';
    for (let current = element; current instanceof Element; current = current.parentElement) {
      current.setAttribute(pathAttribute, captureToken);
    }
    document.documentElement.setAttribute('data-lucida-canvas-proof-root', captureToken);
    const style = document.createElement('style');
    style.setAttribute('data-lucida-canvas-proof-style', captureToken);
    style.textContent = `
      html[data-lucida-canvas-proof-root="${captureToken}"] body * {
        visibility: hidden !important;
      }
      html[data-lucida-canvas-proof-root="${captureToken}"] body
        [data-lucida-canvas-proof-path="${captureToken}"] {
        visibility: visible !important;
      }
      html[data-lucida-canvas-proof-root="${captureToken}"] body
        [data-lucida-canvas-proof-path="${captureToken}"]:not(canvas) {
        background: transparent !important;
        border-color: transparent !important;
        box-shadow: none !important;
        outline-color: transparent !important;
      }
      html[data-lucida-canvas-proof-root="${captureToken}"] body *::before,
      html[data-lucida-canvas-proof-root="${captureToken}"] body *::after {
        visibility: hidden !important;
        opacity: 0 !important;
      }
    `;
    document.head.append(style);
  }, token);
  try {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    return await canvas.screenshot(options);
  } finally {
    await page.evaluate((captureToken) => {
      for (const element of document.querySelectorAll('[data-lucida-canvas-proof-path]')) {
        if (element.getAttribute('data-lucida-canvas-proof-path') === captureToken) {
          element.removeAttribute('data-lucida-canvas-proof-path');
        }
      }
      for (const style of document.querySelectorAll('[data-lucida-canvas-proof-style]')) {
        if (style.getAttribute('data-lucida-canvas-proof-style') === captureToken) style.remove();
      }
      if (document.documentElement.getAttribute('data-lucida-canvas-proof-root') === captureToken) {
        document.documentElement.removeAttribute('data-lucida-canvas-proof-root');
      }
    }, token).catch(() => {});
  }
}

async function renderedCanvasDigest(page) {
  const pixels = await capturePrimaryCanvas(page);
  if (!pixels) return null;
  return crypto.createHash('sha256').update(pixels).digest('hex');
}

async function exerciseCanvasIsolationContract(context) {
  const probe = await context.newPage();
  try {
    await probe.setViewportSize({ width: 480, height: 360 });
    await probe.setContent(`
      <main style="position:relative;width:320px;height:240px;background:#f4f4f4">
        <canvas aria-label="2D slice viewer" width="320" height="240"
          style="display:block;width:320px;height:240px;background:black"></canvas>
        <div data-probe-overlay="collection" data-testid="collection-selector"
          style="position:absolute;left:12px;right:12px;bottom:12px;height:46px;
                 background:linear-gradient(90deg,#ff006e,#ffbe0b,#3a86ff)"></div>
        <div data-probe-overlay="minimap" class="minimap-panel"
          style="position:absolute;right:14px;top:14px;width:92px;height:92px;
                 background:repeating-linear-gradient(45deg,#00f5d4 0 8px,#9b5de5 8px 16px)"></div>
      </main>
    `);
    const canvas = primaryViewerCanvas(probe);
    await canvas.evaluate((element) => {
      const context2d = element.getContext('2d');
      context2d.fillStyle = '#000000';
      context2d.fillRect(0, 0, element.width, element.height);
    });
    const contaminated = await canvas.screenshot();
    const isolated = await capturePrimaryCanvas(probe);
    await probe.locator('[data-probe-overlay]').evaluateAll((elements) => {
      for (const element of elements) element.style.visibility = 'hidden';
    });
    await probe.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const expectedBlack = await canvas.screenshot();
    const digest = (pixels) => crypto.createHash('sha256').update(pixels).digest('hex');
    const contaminatedDigest = digest(contaminated);
    const isolatedDigest = digest(isolated);
    const expectedBlackDigest = digest(expectedBlack);
    return {
      executed: true,
      contaminated_differs_from_black: contaminatedDigest !== expectedBlackDigest,
      isolated_matches_black: isolatedDigest === expectedBlackDigest,
      contaminated_digest: contaminatedDigest,
      isolated_digest: isolatedDigest,
      expected_black_digest: expectedBlackDigest,
    };
  } finally {
    await probe.close();
  }
}

function canvasIsolationFailures(contract) {
  const failures = [];
  if (!contract || !contract.executed) failures.push('canvas-only capture probe did not execute');
  if (!contract || !contract.contaminated_differs_from_black) {
    failures.push('canvas-only capture probe did not create a DOM-contaminated control image');
  }
  if (!contract || !contract.isolated_matches_black) {
    failures.push('canvas-only capture included collection/minimap DOM pixels');
  }
  return failures;
}

async function renderRuntimeSnapshot(page) {
  return page.evaluate(() => {
    const contract = window.__lucidaRenderContract;
    if (!contract || contract.version !== 1 || typeof contract.getSnapshot !== 'function') return null;
    const snapshot = contract.getSnapshot();
    return snapshot && snapshot.version === 1 ? snapshot : null;
  });
}

async function waitForRuntimeSettled(page, timeoutMs = 15000, quietMs = 350) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  let previous = null;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await renderRuntimeSnapshot(page);
    const settled = Boolean(latest)
      && latest.client.frames.pending === 0
      && !latest.loop.animationFramePending
      && !latest.loop.interactiveDirty
      && !latest.loop.residencyDirty;
    const key = latest ? [
      latest.client.frames.posted,
      latest.client.frames.presented,
      latest.client.frames.pending,
      latest.client.worker.messages,
    ].join(':') : null;
    if (settled && key === previous) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= quietMs) return latest;
    } else {
      stableSince = 0;
    }
    previous = key;
    await page.waitForTimeout(50);
  }
  return null;
}

async function waitForSurfaceRecovery(page, baseline, timeoutMs = 30000) {
  // Recovery and quiescence are distinct guarantees. Requiring the presented
  // frame and `pending === 0` in the same browser poll can miss a valid recovery
  // when the renderer immediately schedules follow-up residency work. This
  // helper proves only the recovery boundary; callers whose contract requires
  // quiescence must separately use the quiet-window settlement helper.
  try {
    await page.waitForFunction(({ expectedMode, forwarded, posted, presented }) => {
      const contract = window.__lucidaRenderContract;
      if (!contract || contract.version !== 1) return false;
      const snapshot = contract.getSnapshot();
      const counters = snapshot.client.surface.byMode[expectedMode];
      const accepted = snapshot.client.surface.lastForwarded;
      return snapshot.mode === expectedMode
        && counters.forwarded > forwarded
        && accepted && accepted.mode === expectedMode
        && accepted.width > 0 && accepted.height > 0 && !accepted.rejection
        && snapshot.client.frames.posted > posted
        && snapshot.client.frames.presented > presented;
    }, baseline, { timeout: timeoutMs });
  } catch (error) {
    const snapshot = await renderRuntimeSnapshot(page);
    const counters = snapshot && snapshot.client.surface.byMode[baseline.expectedMode];
    throw new Error(baseline.expectedMode + ' surface recovery timed out: ' + JSON.stringify({
      baseline,
      observed_mode: snapshot && snapshot.mode,
      observed_surface: counters,
      observed_last_forwarded: snapshot && snapshot.client.surface.lastForwarded,
      observed_frames: snapshot && snapshot.client.frames,
      cause: String(error && error.message ? error.message : error).split('\n')[0],
    }));
  }
  return renderRuntimeSnapshot(page);
}

async function waitForFinalCanvasSettlement(
  page,
  timeoutMs = 30000,
  minObservationMs = 5000,
  requiredQuietMs = 3000,
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const observations = [];
  let sampleCount = 0;
  let stableSamples = 0;
  let previousKey = null;
  let lastChangeAt = startedAt;
  let finalDigest = null;
  let finalFrameCount = 0;
  let finalRuntimeKey = null;

  while (Date.now() < deadline) {
    const runtime = await renderRuntimeSnapshot(page);
    const probe = await page.evaluate(readyProbe);
    const runtimeSettled = Boolean(runtime)
      && runtime.client.frames.pending === 0
      && !runtime.loop.animationFramePending
      && !runtime.loop.interactiveDirty
      && !runtime.loop.residencyDirty;
    const runtimeKey = runtime ? [
      runtime.client.frames.posted,
      runtime.client.frames.presented,
      runtime.client.frames.pending,
      runtime.client.worker.messages,
    ].join(':') : null;
    let digest = null;
    let captureError = null;
    if (runtimeSettled && probe && probe.ready) {
      try {
        const pixels = await capturePrimaryCanvas(page);
        digest = crypto.createHash('sha256').update(pixels).digest('hex');
      } catch (error) {
        captureError = String(error);
      }
    }

    sampleCount += 1;
    const key = digest && runtimeKey ? runtimeKey + ':' + digest : null;
    if (key && key === previousKey) {
      stableSamples += 1;
    } else {
      stableSamples = key ? 1 : 0;
      lastChangeAt = Date.now();
    }
    previousKey = key;
    if (digest) finalDigest = digest;
    if (probe && Number.isFinite(Number(probe.frame_count))) {
      finalFrameCount = Number(probe.frame_count);
    }
    if (runtimeKey) finalRuntimeKey = runtimeKey;

    const observedMs = Date.now() - startedAt;
    const quietMs = key ? Date.now() - lastChangeAt : 0;
    observations.push({
      at_ms: observedMs,
      ready: Boolean(probe && probe.ready),
      runtime_settled: runtimeSettled,
      runtime_key: runtimeKey,
      digest,
      frame_count: probe ? Number(probe.frame_count || 0) : 0,
      capture_error: captureError,
    });
    if (observations.length > 20) observations.shift();

    if (
      observedMs >= minObservationMs
      && quietMs >= requiredQuietMs
      && stableSamples >= 4
    ) {
      return {
        executed: true,
        passed: true,
        reason: 'canvas and renderer remained stable after final viewport restoration',
        samples: sampleCount,
        stable_samples: stableSamples,
        observed_ms: observedMs,
        quiet_ms: quietMs,
        min_observation_ms: minObservationMs,
        required_quiet_ms: requiredQuietMs,
        final_digest: finalDigest,
        final_frame_count: finalFrameCount,
        final_runtime_key: finalRuntimeKey,
        observations,
      };
    }
    await page.waitForTimeout(500);
  }

  return {
    executed: true,
    passed: false,
    reason: 'canvas or renderer did not remain stable before the settlement timeout',
    samples: sampleCount,
    stable_samples: stableSamples,
    observed_ms: Date.now() - startedAt,
    quiet_ms: previousKey ? Date.now() - lastChangeAt : 0,
    min_observation_ms: minObservationMs,
    required_quiet_ms: requiredQuietMs,
    final_digest: finalDigest,
    final_frame_count: finalFrameCount,
    final_runtime_key: finalRuntimeKey,
    observations,
  };
}

async function initialZeroSizeRecovery(context, sourcePage, target) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.id = 'lucida-tryout-initial-zero-size';
    style.textContent = '.viewer-stage { display: none !important; width: 0 !important; height: 0 !important; min-width: 0 !important; min-height: 0 !important; }';
    const install = () => {
      if (document.documentElement && !style.isConnected) document.documentElement.appendChild(style);
    };
    const observer = new MutationObserver(install);
    observer.observe(document, { childList: true, subtree: true });
    install();
    window.__lucidaTryoutReleaseInitialZero = () => {
      observer.disconnect();
      style.remove();
    };
  });
  try {
    await page.goto(sourcePage.url(), { waitUntil: 'load', timeout: renderWaitMs });
    await installBrowserProbes(page);
    const toggle = page.getByRole('button', { name: /Switch view mode to/ });
    await toggle.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => {
      const contract = window.__lucidaRenderContract;
      if (!contract || contract.version !== 1) return false;
      const snapshot = contract.getSnapshot();
      return snapshot.version === 1 && snapshot.client.surface.byMode.slice.suppressed > 0;
    }, undefined, { timeout: 30000 });
    if (target === '3d') {
      const current = ((await toggle.textContent()) || '').trim();
      if (current !== 'View: 3D') await toggle.click();
      await page.waitForFunction(() => {
        const contract = window.__lucidaRenderContract;
        if (!contract || contract.version !== 1) return false;
        const snapshot = contract.getSnapshot();
        return snapshot.mode === 'volume'
          && snapshot.client.surface.byMode.volume.suppressed > 0;
      }, undefined, { timeout: 30000 });
    }
    const mode = target === '3d' ? 'volume' : 'slice';
    const initial = await renderRuntimeSnapshot(page);
    const modeBefore = initial && initial.client.surface.byMode[mode];
    const suppressed = initial && initial.client.surface.lastSuppressed;
    await page.evaluate(() => {
      window.__lucidaTryoutReleaseInitialZero && window.__lucidaTryoutReleaseInitialZero();
      window.dispatchEvent(new Event('resize'));
    });
    const restored = await waitForSurfaceRecovery(page, {
      expectedMode: mode,
      forwarded: Number(modeBefore && modeBefore.forwarded || 0),
      posted: Number(initial && initial.client.frames.posted || 0),
      presented: Number(initial && initial.client.frames.presented || 0),
    });
    const canvasLabel = target === '3d' ? '3D volume viewer' : '2D slice viewer';
    const rect = await page.locator('canvas[aria-label="' + canvasLabel + '"]').evaluate(
      (element) => window.__lucidaTryoutRectRecord(element),
    );
    const forwarded = restored && restored.client.surface.lastForwarded;
    return {
      mode: target,
      contract_version: initial && initial.version,
      initial_suppressed: Boolean(modeBefore && modeBefore.suppressed > 0)
        && Boolean(suppressed && suppressed.mode === mode
          && suppressed.rejection === 'non-positive'
          && (suppressed.width <= 0 || suppressed.height <= 0)),
      initial_invalid_not_forwarded: Boolean(modeBefore && modeBefore.forwarded === 0),
      initial: initial,
      restored_finite_positive: Boolean(rect)
        && [rect.width, rect.height].every(Number.isFinite)
        && rect.width > 0 && rect.height > 0,
      restored_forwarded_positive: Boolean(forwarded && forwarded.mode === mode
        && forwarded.width > 0 && forwarded.height > 0 && !forwarded.rejection),
      frame_advanced: Boolean(restored && initial
        && restored.client.frames.posted > initial.client.frames.posted
        && restored.client.frames.presented > initial.client.frames.presented),
      restored,
      rect,
    };
  } finally {
    await page.close();
  }
}

function initialZeroSizeFailures(contract) {
  const failures = [];
  if (contract.contract_version !== 1) failures.push(contract.mode + ': renderer contract version 1 was unavailable');
  if (!contract.initial_suppressed) failures.push(contract.mode + ': fresh 0x0 mount lacked a non-positive suppression receipt');
  if (!contract.initial_invalid_not_forwarded) failures.push(contract.mode + ': fresh invalid surface reached the worker boundary');
  if (!contract.restored_finite_positive || !contract.restored_forwarded_positive) {
    failures.push(contract.mode + ': fresh 0x0 mount did not restore a positive forwarded surface');
  }
  if (!contract.frame_advanced) failures.push(contract.mode + ': fresh 0x0 restore did not post and present a frame');
  return failures;
}

async function ensureViewMode(page, target) {
  const wanted = target === '3d' ? '3D' : '2D';
  const toggle = page.getByRole('button', { name: /Switch view mode to/ });
  const current = ((await toggle.textContent()) || '').trim();
  if (current !== 'View: ' + wanted) await toggle.click();
  await page.locator('canvas[aria-label="' + wanted + (target === '3d' ? ' volume' : ' slice') + ' viewer"]').waitFor({ state: 'visible', timeout: 30000 });
  return waitForReady(page, -1, 30000);
}

async function zeroSizeRecovery(page, target) {
  const label = target === '3d' ? '3D volume viewer' : '2D slice viewer';
  const mode = target === '3d' ? 'volume' : 'slice';
  await ensureViewMode(page, target);
  const initial = await waitForRuntimeSettled(page);
  if (!initial) return { mode: target, contract_version: null, settled_before: false };
  const initialMode = initial.client.surface.byMode[mode];
  const savedStyle = await page.evaluate((canvasLabel) => {
    const canvas = document.querySelector('canvas[aria-label="' + canvasLabel + '"]');
    const wrapper = canvas && canvas.parentElement;
    if (!wrapper) return null;
    const oldStyle = wrapper.getAttribute('style');
    wrapper.style.display = 'none';
    wrapper.style.width = '0px';
    wrapper.style.height = '0px';
    window.dispatchEvent(new Event('resize'));
    return oldStyle;
  }, label);
  await page.waitForFunction(({ expectedMode, suppressed, forwarded }) => {
    const contract = window.__lucidaRenderContract;
    if (!contract || contract.version !== 1) return false;
    const snapshot = contract.getSnapshot();
    const counters = snapshot.client.surface.byMode[expectedMode];
    const rejected = snapshot.client.surface.lastSuppressed;
    return snapshot.mode === expectedMode
      && counters.suppressed > suppressed
      && counters.forwarded === forwarded
      && rejected && rejected.mode === expectedMode
      && rejected.rejection === 'non-positive'
      && (rejected.width <= 0 || rejected.height <= 0);
  }, {
    expectedMode: mode,
    suppressed: initialMode.suppressed,
    forwarded: initialMode.forwarded,
  }, { timeout: 30000 });
  const collapsedRuntime = await renderRuntimeSnapshot(page);
  const collapsed = await page.evaluate((canvasLabel) => {
    const canvas = document.querySelector('canvas[aria-label="' + canvasLabel + '"]');
    return window.__lucidaTryoutRectRecord(canvas);
  }, label);
  await page.evaluate(({ canvasLabel, oldStyle }) => {
    const canvas = document.querySelector('canvas[aria-label="' + canvasLabel + '"]');
    const wrapper = canvas && canvas.parentElement;
    if (!wrapper) return;
    if (oldStyle === null) wrapper.removeAttribute('style');
    else wrapper.setAttribute('style', oldStyle);
    window.dispatchEvent(new Event('resize'));
  }, { canvasLabel: label, oldStyle: savedStyle });
  const collapsedMode = collapsedRuntime.client.surface.byMode[mode];
  await waitForSurfaceRecovery(page, {
    expectedMode: mode,
    forwarded: collapsedMode.forwarded,
    posted: collapsedRuntime.client.frames.posted,
    presented: collapsedRuntime.client.frames.presented,
  });
  const restoredRuntime = await waitForRuntimeSettled(page, 30000);
  if (!restoredRuntime) {
    throw new Error(mode + ' surface recovered but renderer did not settle');
  }
  const restored = await page.evaluate((canvasLabel) => {
    const canvas = document.querySelector('canvas[aria-label="' + canvasLabel + '"]');
    return window.__lucidaTryoutRectRecord(canvas);
  }, label);
  const collapsedCounters = collapsedRuntime.client.surface.byMode[mode];
  const collapsedSuppressed = collapsedRuntime.client.surface.lastSuppressed;
  const restoredForwarded = restoredRuntime && restoredRuntime.client.surface.lastForwarded;
  return {
    mode: target,
    contract_version: initial.version,
    settled_before: true,
    collapsed_to_zero: Boolean(collapsed) && (collapsed.width === 0 || collapsed.height === 0),
    collapsed_suppressed: collapsedCounters.suppressed > initialMode.suppressed
      && collapsedSuppressed && collapsedSuppressed.mode === mode
      && collapsedSuppressed.rejection === 'non-positive'
      && (collapsedSuppressed.width <= 0 || collapsedSuppressed.height <= 0),
    collapsed_invalid_not_forwarded: collapsedCounters.forwarded === initialMode.forwarded,
    restored_finite_positive: Boolean(restored)
      && [restored.width, restored.height].every(Number.isFinite)
      && restored.width > 0 && restored.height > 0,
    restored_forwarded_positive: Boolean(restoredForwarded
      && restoredForwarded.mode === mode
      && restoredForwarded.width > 0 && restoredForwarded.height > 0
      && !restoredForwarded.rejection),
    frame_advanced: Boolean(restoredRuntime
      && restoredRuntime.client.frames.posted > collapsedRuntime.client.frames.posted
      && restoredRuntime.client.frames.presented > collapsedRuntime.client.frames.presented),
    initial,
    collapsed_runtime: collapsedRuntime,
    restored_runtime: restoredRuntime,
    collapsed,
    restored,
  };
}

async function runAxe(page, label) {
  if (!await page.evaluate(() => Boolean(window.axe))) {
    await page.addScriptTag({ content: axeSource });
  }
  const result = await page.evaluate(async () => {
    const report = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return report.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    }));
  });
  return { label, violations: result };
}

function axeFailures(audit) {
  return audit.violations.length
    ? [audit.label + ': axe violations ' + audit.violations.map((item) => item.id).join(', ')]
    : [];
}

async function focusAppearance(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(style.outlineWidth || '0');
    const outlineOffset = Number.parseFloat(style.outlineOffset || '0');
    const focused = document.activeElement === element;
    const focusVisible = element.matches(':focus-visible');
    const ringVisible = focusVisible
      && style.outlineStyle !== 'none'
      && Number.isFinite(outlineWidth)
      && outlineWidth >= 2;
    return {
      // A missing focus ring is meaningful only when this exact target owns
      // focus. Focus placement has its own receipt and failure diagnostic.
      visible: focused ? ringVisible : null,
      focused,
      focus_visible_match: focusVisible,
      outline_style: style.outlineStyle,
      outline_width: style.outlineWidth,
      outline_color: style.outlineColor,
      outline_offset: style.outlineOffset,
      box_shadow: style.boxShadow,
    };
  });
}

async function waitForFocusInside(
  page,
  state,
  selector,
  expectedFocusSelector = null,
  timeoutMs = 2000,
) {
  let waitPassed = false;
  let waitError = null;
  try {
    await page.waitForFunction(({ targetSelector, focusSelector }) => {
      const element = document.querySelector(targetSelector);
      const expected = focusSelector ? document.querySelector(focusSelector) : null;
      return Boolean(element && element.contains(document.activeElement)
        && (!focusSelector || document.activeElement === expected));
    }, { targetSelector: selector, focusSelector: expectedFocusSelector }, { timeout: timeoutMs });
    waitPassed = true;
  } catch (error) {
    waitError = String(error && error.message ? error.message : error).split('\n')[0];
  }
  const observation = await page.evaluate(({ targetSelector, focusSelector }) => {
    const element = document.querySelector(targetSelector);
    const expected = focusSelector ? document.querySelector(focusSelector) : null;
    const active = document.activeElement;
    return {
      target_found: Boolean(element),
      focus_inside: Boolean(element && active && element.contains(active)),
      expected_focus_found: focusSelector ? Boolean(expected) : null,
      expected_focus_matched: focusSelector ? active === expected : null,
      active_element: active ? {
        tag: active.tagName.toLowerCase(),
        id: active.id || null,
        role: active.getAttribute('role'),
        aria_label: active.getAttribute('aria-label'),
        aria_labelledby: active.getAttribute('aria-labelledby'),
        text: (active.textContent || '').trim().slice(0, 120),
      } : null,
    };
  }, { targetSelector: selector, focusSelector: expectedFocusSelector });
  return {
    state,
    selector,
    expected_focus_selector: expectedFocusSelector,
    timeout_ms: timeoutMs,
    wait_passed: waitPassed,
    wait_error: waitError,
    ...observation,
  };
}

async function waitForLocatorFocus(page, locator, state, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let focused = false;
  let waitError = null;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      focused = await locator.evaluate(
        (element) => document.activeElement === element,
        undefined,
        { timeout: Math.min(100, remaining) },
      );
      if (focused) break;
    } catch (error) {
      waitError = String(error && error.message ? error.message : error).split('\n')[0];
    }
    await page.waitForTimeout(25);
  }
  const activeElement = await page.evaluate(() => {
    const active = document.activeElement;
    return active ? {
      tag: active.tagName.toLowerCase(),
      id: active.id || null,
      role: active.getAttribute('role'),
      aria_label: active.getAttribute('aria-label'),
      aria_labelledby: active.getAttribute('aria-labelledby'),
      text: (active.textContent || '').trim().slice(0, 120),
    } : null;
  });
  return {
    state,
    timeout_ms: timeoutMs,
    wait_passed: focused,
    wait_error: focused ? null : waitError,
    active_element: activeElement,
  };
}

async function exerciseDialogFocusCycle(page, dialog) {
  const focusState = () => dialog.evaluate((element) => {
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(element.querySelectorAll(selector)).filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const active = document.activeElement;
    return {
      count: focusable.length,
      inside: Boolean(active && element.contains(active)),
      index: focusable.indexOf(active),
      identity: active ? [
        active.tagName.toLowerCase(),
        active.id || '',
        active.getAttribute('aria-label') || '',
        (active.textContent || '').trim().slice(0, 80),
      ].join('|') : null,
    };
  });
  const initial = await focusState();
  const focusableCount = initial.count;
  await dialog.evaluate((element) => {
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const first = Array.from(element.querySelectorAll(selector)).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (first) first.focus();
  });
  const cycleStart = await focusState();
  const forward = [];
  const backward = [];
  for (let index = 0; index < focusableCount; index++) {
    await page.keyboard.press('Tab');
    forward.push(await focusState());
  }
  for (let index = 0; index < focusableCount; index++) {
    await page.keyboard.press('Shift+Tab');
    backward.push(await focusState());
  }
  const visitedEveryFocusable = (states) => new Set(
    states.filter((state) => state.index >= 0).map((state) => state.index),
  ).size === focusableCount;
  return {
    focusable_count: focusableCount,
    initial_inside: initial.inside,
    initial_index: initial.index,
    initial_identity: initial.identity,
    initial_state: initial,
    cycle_start_inside: cycleStart.inside,
    cycle_start_index: cycleStart.index,
    cycle_start_identity: cycleStart.identity,
    cycle_start_state: cycleStart,
    forward_sequence: forward.map((state) => state.identity),
    backward_sequence: backward.map((state) => state.identity),
    forward_states: forward,
    backward_states: backward,
    forward_unique_count: new Set(forward.map((state) => state.identity)).size,
    backward_unique_count: new Set(backward.map((state) => state.identity)).size,
    forward_wrapped_to_start: focusableCount > 0 && cycleStart.index >= 0
      && forward[forward.length - 1].index === cycleStart.index,
    backward_wrapped_to_start: focusableCount > 0 && cycleStart.index >= 0
      && backward[backward.length - 1].index === cycleStart.index,
    forward_full_cycle_inside: focusableCount > 0 && cycleStart.index >= 0
      && forward.every((state) => state.inside)
      && visitedEveryFocusable(forward),
    backward_full_cycle_inside: focusableCount > 0 && cycleStart.index >= 0
      && backward.every((state) => state.inside)
      && visitedEveryFocusable(backward),
  };
}

async function traceLogicalFocus(page, trigger, panel, maxSteps = 64) {
  await trigger.focus();
  const sequence = [];
  let reachedPanel = false;
  let panelFocusVisible = false;
  for (let index = 0; index < maxSteps; index++) {
    await page.keyboard.press('Tab');
    const state = await panel.evaluate((element) => {
      const active = document.activeElement;
      if (!active) return { in_panel: false, label: 'none', focus_visible: false };
      const style = getComputedStyle(active);
      const width = Number.parseFloat(style.outlineWidth || '0');
      return {
        in_panel: element.contains(active),
        label: active.getAttribute('aria-label') || active.textContent.trim().slice(0, 80) || active.tagName,
        focus_visible: active.matches(':focus-visible')
          && style.outlineStyle !== 'none'
          && Number.isFinite(width) && width >= 2,
      };
    });
    sequence.push(state.label);
    if (state.in_panel) {
      reachedPanel = true;
      panelFocusVisible = Boolean(state.focus_visible);
      break;
    }
  }
  await trigger.focus();
  return {
    max_steps: maxSteps,
    steps: sequence.length,
    reached_panel: reachedPanel,
    panel_focus_visible: panelFocusVisible,
    sequence,
  };
}

async function annotationPinIsHitTestable(pin) {
  return await pin.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const viewport = window.visualViewport;
    const left = viewport ? viewport.offsetLeft : 0;
    const top = viewport ? viewport.offsetTop : 0;
    const right = left + (viewport ? viewport.width : window.innerWidth);
    const bottom = top + (viewport ? viewport.height : window.innerHeight);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < left || x > right || y < top || y > bottom) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === element || element.contains(hit)));
  }).catch(() => false);
}

async function firstActionableAnnotationPin(page) {
  const pins = page.locator('button[data-testid^="annot-pin-"]');
  const count = await pins.count();
  for (let index = 0; index < count; index++) {
    const candidate = pins.nth(index);
    if (await annotationPinIsHitTestable(candidate)) return candidate;
  }
  return null;
}

async function createActionableAnnotationPin(page) {
  const pins = page.locator('button[data-testid^="annot-pin-"]');
  const previousTestIds = new Set(await pins.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-testid')).filter(Boolean)));
  const canvas = page.locator('canvas[aria-label="2D slice viewer"]').first();
  const position = await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const candidates = [
      [0.5, 0.5], [0.35, 0.5], [0.65, 0.5],
      [0.5, 0.35], [0.5, 0.65], [0.35, 0.35], [0.65, 0.65],
    ];
    for (const [xFraction, yFraction] of candidates) {
      const x = rect.left + rect.width * xFraction;
      const y = rect.top + rect.height * yFraction;
      if (document.elementFromPoint(x, y) === element) {
        return { x: x - rect.left, y: y - rect.top };
      }
    }
    return null;
  });
  if (!position) {
    throw new Error('thread-popover fixture found no unobstructed point on the 2D canvas');
  }
  await canvas.click({ position, modifiers: ['Shift'] });
  const newTestIdHandle = await page.waitForFunction((knownTestIds) => {
    const buttons = document.querySelectorAll('button[data-testid^="annot-pin-"]');
    for (const button of buttons) {
      const testId = button.getAttribute('data-testid');
      if (testId && !knownTestIds.includes(testId)) return testId;
    }
    return null;
  }, Array.from(previousTestIds), { timeout: 10000 });
  const newTestId = await newTestIdHandle.jsonValue();
  if (typeof newTestId !== 'string') {
    throw new Error('thread-popover fixture did not expose the newly created pin');
  }
  const pin = page.getByTestId(newTestId);
  await pin.click({ trial: true, timeout: 10000 });
  if (!await annotationPinIsHitTestable(pin)) {
    throw new Error('thread-popover fixture created a pin that was not hit-testable');
  }
  return pin;
}

async function exerciseThreadPopover(page) {
  let pin = await firstActionableAnnotationPin(page);
  const created = pin === null;
  if (pin === null) pin = await createActionableAnnotationPin(page);
  const triggerHitTestableBeforeClick = await annotationPinIsHitTestable(pin);
  if (!triggerHitTestableBeforeClick) {
    throw new Error('thread-popover trigger was not hit-testable before click');
  }
  if (await pin.getAttribute('aria-expanded') !== 'true') await pin.click();
  const thread = page.locator('.thread-popover').first();
  await thread.waitFor({ state: 'visible', timeout: 10000 });
  const triggerKeptFocus = await pin.evaluate((element) => document.activeElement === element);
  const linked = await pin.evaluate((element) => {
    const target = element.getAttribute('aria-controls');
    const panel = target ? document.getElementById(target) : null;
    return Boolean(panel)
      && element.getAttribute('aria-expanded') === 'true'
      && panel.getAttribute('role') === 'dialog'
      && panel.getAttribute('aria-label') === 'Annotation discussion';
  });
  const logicalFocus = await traceLogicalFocus(page, pin, thread, 16);
  const close = thread.getByRole('button', { name: 'Close thread' });
  await close.focus();
  await page.keyboard.press('Escape');
  await thread.waitFor({ state: 'detached', timeout: 10000 });
  const escapeRestoredTrigger = await pin.evaluate((element) => (
    document.activeElement === element && element.getAttribute('aria-expanded') === 'false'
  ));

  await pin.click();
  await thread.waitFor({ state: 'visible', timeout: 10000 });
  await close.focus();
  await close.click();
  await thread.waitFor({ state: 'detached', timeout: 10000 });
  const closeRestoredTrigger = await pin.evaluate((element) => (
    document.activeElement === element && element.getAttribute('aria-expanded') === 'false'
  ));

  // Leave the thread open for the simultaneous-overlay geometry proof that
  // follows this interaction receipt.
  await pin.click();
  await thread.waitFor({ state: 'visible', timeout: 10000 });
  return {
    created,
    trigger_hit_testable_before_click: triggerHitTestableBeforeClick,
    trigger_panel_linked: linked,
    trigger_kept_focus: triggerKeptFocus,
    logical_focus: logicalFocus,
    escape_restored_trigger: escapeRestoredTrigger,
    close_restored_trigger: closeRestoredTrigger,
  };
}

async function exerciseSavedViewActionsMenu(page) {
  const toggle = page.getByRole('button', { name: 'Saved Views', exact: true });
  const toggleReceipt = await prepareViewportTrigger(page, toggle, 'saved views: toggle');
  if (!toggleReceipt.hit_testable) {
    throw new Error('saved-view sidebar toggle was not hit-testable');
  }
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  const sidebar = page.locator('.saved-view-sidebar');
  await sidebar.waitFor({ state: 'visible', timeout: 10000 });

  let createdSavedView = false;
  let rows = sidebar.locator('[data-testid="saved-view-row"]');
  if (await rows.count() === 0) {
    await sidebar.getByRole('button', { name: 'Save view', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save current view' });
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    const name = dialog.getByTestId('saved-view-name-input');
    await name.fill('Tryout actions menu');
    await dialog.getByTestId('saved-view-save-confirm').click();
    await page.waitForFunction(() => (
      document.querySelectorAll('.saved-view-sidebar [data-testid="saved-view-row"]').length > 0
    ), undefined, { timeout: 10000 });
    createdSavedView = true;
    rows = sidebar.locator('[data-testid="saved-view-row"]');
  }

  const row = rows.first();
  const trigger = row.getByRole('button', { name: 'Saved view actions', exact: true });
  const triggerReceipt = await prepareViewportTrigger(page, trigger, 'saved views: actions');
  if (!triggerReceipt.hit_testable) {
    throw new Error('saved-view actions trigger was not hit-testable');
  }
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Saved view actions' });
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return Boolean(active && active.getAttribute('role') === 'menuitem'
      && active.closest('[role="menu"][aria-label="Saved view actions"]'));
  }, undefined, { timeout: 10000 });
  const geometry = await menu.evaluate((element) => {
    const rect = window.__lucidaTryoutRectRecord(element);
    const visual = window.visualViewport;
    const viewport = {
      left: Number(visual && visual.offsetLeft || 0),
      top: Number(visual && visual.offsetTop || 0),
      right: Number(visual && visual.offsetLeft || 0)
        + Number(visual && visual.width || innerWidth),
      bottom: Number(visual && visual.offsetTop || 0)
        + Number(visual && visual.height || innerHeight),
    };
    const intersects = (left, right) => Boolean(left && right)
      && left.left < right.right && left.right > right.left
      && left.top < right.bottom && left.bottom > right.top;
    const anchorId = element.id.replace('saved-view-actions-', '');
    const anchor = document.querySelector(
      '[aria-controls="saved-view-actions-' + CSS.escape(anchorId) + '"]',
    );
    const focusable = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const controls = new Set();
    for (const region of document.querySelectorAll('[data-floating-safe-region]')) {
      if (!window.__lucidaTryoutElementIsEffectivelyVisible(region)) continue;
      if (region.contains(anchor)) {
        if (region.matches(focusable) && region !== anchor) controls.add(region);
        for (const control of region.querySelectorAll(focusable)) {
          if (control !== anchor && !control.contains(anchor)) controls.add(control);
        }
      } else {
        // Non-owning safe regions (for example the minimap) are obstacles as a
        // whole, matching the product placement algorithm rather than checking
        // only whatever controls happen to live inside them.
        controls.add(region);
      }
    }
    const collisions = [];
    for (const control of controls) {
      if (control === anchor || element.contains(control) || control.contains(element)) continue;
      const visible = window.__lucidaTryoutEffectiveVisibleRect(control);
      if (intersects(rect, visible)) {
        collisions.push(
          control.getAttribute('aria-label')
            || (control.textContent || '').trim().slice(0, 80)
            || control.tagName,
        );
      }
    }
    return {
      rect,
      within_viewport: Boolean(rect)
        && rect.left >= viewport.left && rect.top >= viewport.top
        && rect.right <= viewport.right && rect.bottom <= viewport.bottom,
      safe_control_collisions: collisions,
      registered_surface: element.hasAttribute('data-floating-surface'),
    };
  });

  const items = menu.getByRole('menuitem');
  const itemCount = await items.count();
  const initialFocus = await menu.evaluate((element) => (
    Boolean(document.activeElement && element.firstElementChild === document.activeElement)
  ));
  const firstIdentity = await items.first().textContent();
  await page.keyboard.press('ArrowDown');
  const secondIdentity = await menu.evaluate((element) => (
    element.contains(document.activeElement)
      ? (document.activeElement.textContent || '').trim()
      : null
  ));
  const arrowNavigationPassed = itemCount >= 2
    && Boolean(firstIdentity && secondIdentity && firstIdentity.trim() !== secondIdentity);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 10000 });
  const escapeRestored = await trigger.evaluate((element) => (
    document.activeElement === element
      && element.getAttribute('aria-expanded') === 'false'
      && !element.hasAttribute('aria-controls')
  ));

  // Reopen, then perform a real overflow-scroll transition that leaves the row
  // mounted but wholly outside its list's painted clip. A spacer guarantees the
  // single-row fixture can scroll far enough to exercise the same lifecycle as
  // a long production list.
  await trigger.click();
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  await trigger.evaluate((element) => {
    const list = element.closest('.saved-view-list');
    if (!list) throw new Error('saved-view trigger has no scrolling list');
    const spacer = document.createElement('div');
    spacer.dataset.tryoutSavedViewSpacer = 'true';
    spacer.style.height = '1000px';
    spacer.setAttribute('aria-hidden', 'true');
    list.append(spacer);
    list.style.height = '48px';
    list.style.maxHeight = '48px';
    list.style.flex = 'none';
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await menu.waitFor({ state: 'detached', timeout: 10000 });
  const clippedAnchor = await trigger.evaluate((trigger) => {
    const search = document.querySelector('input[aria-label="Search saved views"]');
    const list = trigger.closest('.saved-view-list');
    const triggerRect = window.__lucidaTryoutEffectiveVisibleRect(trigger);
    const receipt = {
      trigger_connected: trigger.isConnected,
      trigger_fully_clipped: triggerRect === null,
      aria_expanded_cleared: trigger.getAttribute('aria-expanded') === 'false'
        && !trigger.hasAttribute('aria-controls'),
      fallback_focused: Boolean(search && document.activeElement === search),
      fallback_label: search && search.getAttribute('aria-label'),
    };
    if (list) {
      list.scrollTop = 0;
      list.style.removeProperty('height');
      list.style.removeProperty('max-height');
      list.style.removeProperty('flex');
      list.querySelector('[data-tryout-saved-view-spacer="true"]')?.remove();
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    return receipt;
  });
  const rowCount = await rows.count();
  if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
  return {
    applicable: true,
    created_saved_view: createdSavedView,
    row_count: rowCount,
    toggle_trigger: toggleReceipt,
    menu_trigger: triggerReceipt,
    item_count: itemCount,
    initial_focus_first_item: initialFocus,
    arrow_navigation_passed: arrowNavigationPassed,
    escape_restored_trigger: escapeRestored,
    geometry,
    clipped_anchor: clippedAnchor,
  };
}

async function exerciseCollectionSelector(page, label) {
  const selector = page.locator('[data-testid="collection-selector"]');
  if (await selector.count() !== 1 || !await selector.isVisible()) {
    return {
      label,
      applicable: false,
      present: false,
      populated_cell_count: 0,
      required_cell_count: 12,
      skip_reason: 'fixture does not expose a visible collection selector',
    };
  }
  const cells = selector.locator('button[data-testid^="collection-cell-"]:not([disabled])');
  const count = await cells.count();
  const expectedLabels = Array.from({ length: 12 }, (_, index) => 'Go to A' + (index + 1));
  const labels = await cells.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label')));
  const supportsWideFixture = count === 12
    && expectedLabels.every((expected) => labels.includes(expected));
  if (!supportsWideFixture) {
    return {
      label,
      applicable: false,
      present: true,
      populated_cell_count: count,
      required_cell_count: 12,
      observed_cell_labels: labels,
      skip_reason: 'fixture is not the deterministic 1x12 collection profile',
    };
  }
  const edgeCell = selector.getByRole('button', { name: 'Go to A12', exact: true });
  await edgeCell.scrollIntoViewIfNeeded();
  await edgeCell.focus();
  // Enter keyboard modality and prove the edge control remains in the logical
  // tab sequence. Returning with Shift+Tab also makes :focus-visible a real
  // keyboard result rather than a programmatic-focus artifact.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const beforeClick = await edgeCell.evaluate((element) => {
    const selectorElement = element.closest('[data-testid="collection-selector"]');
    const minimap = Array.from(document.querySelectorAll('.minimap-panel')).find((candidate) =>
      window.__lucidaTryoutElementIsEffectivelyVisible(candidate)) || null;
    const owner = element.closest('[data-testid="persistent-viewer-overlays"]');
    const cellRect = window.__lucidaTryoutRectRecord(element);
    const selectorRect = window.__lucidaTryoutRectRecord(selectorElement);
    const minimapRect = window.__lucidaTryoutRectRecord(minimap);
    const selectorVisibleRect = window.__lucidaTryoutEffectiveVisibleRect(selectorElement);
    const minimapVisibleRect = window.__lucidaTryoutEffectiveVisibleRect(minimap);
    const cellVisibleRect = window.__lucidaTryoutEffectiveVisibleRect(element);
    const intersects = (left, right) => Boolean(left && right)
      && left.left < right.right && left.right > right.left
      && left.top < right.bottom && left.bottom > right.top;
    const centerX = cellVisibleRect ? cellVisibleRect.left + cellVisibleRect.width / 2 : -1;
    const centerY = cellVisibleRect ? cellVisibleRect.top + cellVisibleRect.height / 2 : -1;
    const hit = cellVisibleRect ? document.elementFromPoint(centerX, centerY) : null;
    const style = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(style.outlineWidth || '0');
    const outlineOffset = Number.parseFloat(style.outlineOffset || '0');
    window.__lucidaTryoutCollectionEdgeClick = false;
    element.addEventListener('click', () => {
      window.__lucidaTryoutCollectionEdgeClick = true;
    }, { once: true });
    return {
      applicable: true,
      present: true,
      populated_cell_count: element.parentElement
        ? selectorElement.querySelectorAll('button[data-testid^="collection-cell-"]:not([disabled])').length
        : 0,
      required_cell_count: 12,
      edge_cell_label: element.getAttribute('aria-label'),
      edge_cell_rect: cellRect,
      selector_rect: selectorRect,
      minimap_rect: minimapRect,
      selector_visible_rect: selectorVisibleRect,
      minimap_visible_rect: minimapVisibleRect,
      selector_minimap_overlap: intersects(selectorVisibleRect, minimapVisibleRect),
      edge_cell_inside_selector: Boolean(cellRect && selectorRect)
        && cellRect.left >= selectorRect.left && cellRect.top >= selectorRect.top
        && cellRect.right <= selectorRect.right && cellRect.bottom <= selectorRect.bottom,
      edge_cell_hit_testable: hit === element || element.contains(hit),
      edge_cell_focused: document.activeElement === element,
      edge_cell_focus_visible: document.activeElement === element
        ? element.matches(':focus-visible')
        && style.outlineStyle !== 'none'
        && Number.isFinite(outlineWidth) && outlineWidth >= 2
        : null,
      edge_cell_focus_ring_inset: document.activeElement === element
        ? Number.isFinite(outlineOffset) && outlineOffset <= 0
        : null,
      owner_present: Boolean(owner),
      owner_layout: owner && owner.getAttribute('data-overlay-layout'),
      edge_cell_keyboard_returned: document.activeElement === element,
    };
  });
  let clickCompleted = false;
  try {
    await edgeCell.click({ timeout: 10000 });
    clickCompleted = true;
  } catch (_) {}
  const clickReceived = await page.evaluate(() => Boolean(window.__lucidaTryoutCollectionEdgeClick));
  return {
    label,
    ...beforeClick,
    edge_cell_click_completed: clickCompleted,
    edge_cell_click_received: clickReceived,
  };
}

async function persistentOverlayProfile(page, label) {
  // The edge-cell interaction scrolls the wide selector into its usable mobile
  // arrangement. Measure the persistent overlays after that state transition;
  // combining pre-interaction geometry with a post-interaction receipt makes a
  // single profile describe two mutually inconsistent layouts.
  const collectionInteraction = await exerciseCollectionSelector(page, label);
  const layoutSettlement = await waitForLayoutSettlement(page);
  const geometry = await page.evaluate((profileLabel) => {
    const visual = window.visualViewport;
    const viewport = {
      left: Number(visual && visual.offsetLeft || 0),
      top: Number(visual && visual.offsetTop || 0),
      right: Number(visual && visual.offsetLeft || 0)
        + Number(visual && visual.width || innerWidth),
      bottom: Number(visual && visual.offsetTop || 0)
        + Number(visual && visual.height || innerHeight),
    };
    const record = (selector) => {
      const element = document.querySelector(selector);
      const rect = window.__lucidaTryoutRectRecord(element);
      const visibleRect = window.__lucidaTryoutEffectiveVisibleRect(element);
      return {
        selector,
        present: Boolean(element && visibleRect),
        rect,
        visible_rect: visibleRect,
        within_viewport: Boolean(rect)
          && rect.left >= viewport.left && rect.top >= viewport.top
          && rect.right <= viewport.right && rect.bottom <= viewport.bottom,
        registered_safe_region: Boolean(
          element && element.hasAttribute('data-floating-safe-region'),
        ),
        accessible_name: element
          && (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby')),
      };
    };
    const collection = record('[data-testid="collection-selector"]');
    const minimap = record('.minimap-panel');
    const overlaps = Boolean(collection.visible_rect && minimap.visible_rect)
      && collection.visible_rect.left < minimap.visible_rect.right
      && collection.visible_rect.right > minimap.visible_rect.left
      && collection.visible_rect.top < minimap.visible_rect.bottom
      && collection.visible_rect.bottom > minimap.visible_rect.top;
    const owner = document.querySelector('[data-testid="persistent-viewer-overlays"]');
    return {
      label: profileLabel,
      viewport: [innerWidth, innerHeight],
      owner_present: Boolean(owner),
      owner_layout: owner && owner.getAttribute('data-overlay-layout'),
      collection,
      minimap,
      overlap: overlaps,
    };
  }, label);
  return {
    ...geometry,
    layout_settlement: layoutSettlement,
    collection_interaction: collectionInteraction,
  };
}

async function floatingSurfaceProbe(page, label, exercisePersistentInteraction = true) {
  // Geometry is a read-only snapshot of the simultaneous surfaces. The
  // collection edge click deliberately changes the selected member (and can
  // therefore move/close an annotation thread), so it must run only after this
  // snapshot rather than invalidating the state the snapshot claims to prove.
  const mentionsTrigger = page.locator('[data-testid="mentions-of-me-badge"]');
  const exploreTrigger = page.getByRole('button', { name: 'Explore', exact: true });
  const viewportTriggers = {
    explore: await inspectViewportTrigger(page, exploreTrigger, label + ': Explore'),
    mentions: await inspectViewportTrigger(page, mentionsTrigger, label + ': Mentions'),
  };
  const layoutSettlement = await waitForLayoutSettlement(page);
  const probe = await page.evaluate((probeLabel) => {
    const visibleElement = (selector) => Array.from(document.querySelectorAll(selector))
      .find((element) => window.__lucidaTryoutElementIsEffectivelyVisible(element)) || null;
    const panel = visibleElement('[data-testid="mentions-of-me-panel"]');
    const mentionsRect = window.__lucidaTryoutRectRecord(panel);
    const mentionsVisibleRect = window.__lucidaTryoutEffectiveVisibleRect(panel);
    const explore = visibleElement('[data-testid="explore-panel"]');
    const exploreRect = window.__lucidaTryoutRectRecord(explore);
    const exploreVisibleRect = window.__lucidaTryoutEffectiveVisibleRect(explore);
    const mentions = visibleElement('[data-testid="mentions-of-me-badge"]');
    const anchorRect = window.__lucidaTryoutRectRecord(mentions);
    const namedSurfaceSpecs = [
      ['thread_popover', '.thread-popover', 'requires an annotation in the deterministic fixture'],
      ['minimap', '.minimap-panel', 'renderer-ready fixture'],
      ['collection_selector', '[data-testid="collection-selector"]', 'fixture has no collection-navigation capability'],
      [
        'notice',
        '.viewer-error, [data-testid="viewport-loading-indicator"], [data-testid="loading-view-banner"], [data-testid="import-warning-banner"], [data-testid="annotation-restore-notice"], [data-testid="annotation-deeplink-notfound"]',
        'transient notice is exercised by its owning recovery contract',
      ],
    ];
    const visual = window.visualViewport;
    const viewportBounds = {
      left: Number(visual && visual.offsetLeft || 0),
      top: Number(visual && visual.offsetTop || 0),
      right: Number(visual && visual.offsetLeft || 0) + Number(visual && visual.width || innerWidth),
      bottom: Number(visual && visual.offsetTop || 0) + Number(visual && visual.height || innerHeight),
    };
    const intersects = (left, right) => Boolean(left && right)
      && left.left < right.right && left.right > right.left
      && left.top < right.bottom && left.bottom > right.top;
    const intersection = (left, right) => {
      if (!intersects(left, right)) return null;
      const result = {
        left: Math.max(left.left, right.left),
        top: Math.max(left.top, right.top),
        right: Math.min(left.right, right.right),
        bottom: Math.min(left.bottom, right.bottom),
      };
      result.width = result.right - result.left;
      result.height = result.bottom - result.top;
      return result.width > 0 && result.height > 0 ? result : null;
    };
    const surfaceWithinViewport = (rect) => Boolean(rect)
      && rect.left >= viewportBounds.left && rect.top >= viewportBounds.top
      && rect.right <= viewportBounds.right && rect.bottom <= viewportBounds.bottom;
    const namedSurfaceEntries = namedSurfaceSpecs.map(([name, selector, absentReason]) => {
      const element = visibleElement(selector);
      const mountedElement = element || document.querySelector(selector);
      const owningSlot = mountedElement && mountedElement.closest('[data-overlay-usable]');
      const rect = window.__lucidaTryoutRectRecord(element);
      const visibleRect = window.__lucidaTryoutEffectiveVisibleRect(element);
      return {
        name,
        element,
        receipt: {
        selector,
        mounted: Boolean(mountedElement),
        present: Boolean(element),
        exercised: Boolean(element),
        absent_reason: element ? null : absentReason,
        rect,
        visible_rect: visibleRect,
        within_viewport: element ? surfaceWithinViewport(rect) : null,
        registered_safe_region: Boolean(element && element.hasAttribute('data-floating-safe-region')),
        role: element && element.getAttribute('role'),
        accessible_name: element && (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby')),
        suppression_reason: owningSlot && owningSlot.getAttribute('data-overlay-suppression'),
        },
      };
    });
    const namedSurfaces = Object.fromEntries(
      namedSurfaceEntries.map((entry) => [entry.name, entry.receipt]),
    );
    const threadElement = namedSurfaceEntries.find((entry) => entry.name === 'thread_popover')
      ?.element || null;
    const threadAnchor = threadElement && threadElement.id
      ? document.querySelector('[aria-controls="' + CSS.escape(threadElement.id) + '"]')
      : null;
    const threadPlacementObstacles = Array.from(
      document.querySelectorAll('[data-floating-safe-region]'),
    ).filter((element) => threadElement
      && element !== threadElement
      && element !== threadAnchor
      && !element.contains(threadElement)
      && !element.contains(threadAnchor))
      .map((element) => ({
        selector_hint: element.className || element.getAttribute('data-testid') || element.tagName,
        rect: window.__lucidaTryoutEffectiveVisibleRect(element),
      }))
      .filter((entry) => entry.rect);
    const simultaneousSurfaces = [
      { name: 'mentions', element: panel, rect: mentionsVisibleRect },
      { name: 'explore', element: explore, rect: exploreVisibleRect },
      ...namedSurfaceEntries
        .filter((entry) => entry.receipt.present)
        .map((entry) => ({
          name: entry.name,
          element: entry.element,
          rect: entry.receipt.visible_rect,
        })),
    ].filter((surface) => Boolean(surface.element && surface.rect));
    const namedSurfaceCollisions = [];
    for (let leftIndex = 0; leftIndex < simultaneousSurfaces.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < simultaneousSurfaces.length; rightIndex++) {
        const left = simultaneousSurfaces[leftIndex];
        const right = simultaneousSurfaces[rightIndex];
        if (intersects(left.rect, right.rect)) {
          namedSurfaceCollisions.push([left.name, right.name]);
        }
      }
    }
    const hit = (element, visibleRect) => {
      if (!element || !visibleRect) return false;
      const top = document.elementFromPoint(
        visibleRect.left + visibleRect.width / 2,
        visibleRect.top + visibleRect.height / 2,
      );
      return top === element || element.contains(top) || Boolean(top && top.contains(element));
    };
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const safeControlElements = new Set();
    for (const region of document.querySelectorAll('[data-floating-safe-region]')) {
      if (!window.__lucidaTryoutElementIsEffectivelyVisible(region)) continue;
      if (region.matches(focusableSelector)) safeControlElements.add(region);
      for (const control of region.querySelectorAll(focusableSelector)) {
        if (window.__lucidaTryoutElementIsEffectivelyVisible(control)) {
          safeControlElements.add(control);
        }
      }
    }
    const safeRegionRecords = Array.from(safeControlElements).map((element, index) => {
      const rect = window.__lucidaTryoutRectRecord(element);
      const clip = window.__lucidaTryoutVisibleClip(element);
      const visibleRect = window.__lucidaTryoutEffectiveVisibleRect(element);
      return {
        element,
        label: element.getAttribute('aria-label') || element.textContent.trim()
          || element.getAttribute('data-testid') || `safe-control-${index}`,
        rect,
        visible_clip: clip,
        visible_rect: visibleRect,
        intersects_visible_clip: Boolean(visibleRect),
        in_viewport: Boolean(rect)
          && rect.left >= viewportBounds.left && rect.top >= viewportBounds.top
          && rect.right <= viewportBounds.right && rect.bottom <= viewportBounds.bottom,
        hit: hit(element, visibleRect),
      };
    });
    const surfaceSafeRegionCollisions = [];
    let surfaceSafeRegionPairsChecked = 0;
    for (const surface of simultaneousSurfaces) {
      for (const safe of safeRegionRecords) {
        if (surface.element === safe.element
          || surface.element.contains(safe.element)
          || safe.element.contains(surface.element)) continue;
        surfaceSafeRegionPairsChecked += 1;
        if (safe.intersects_visible_clip && intersects(surface.rect, safe.visible_rect)) {
          surfaceSafeRegionCollisions.push([surface.name, safe.label]);
        }
      }
    }
    const safeRegions = safeRegionRecords.map(({ element: _element, ...receipt }) => receipt);
    const occludedSafeRegions = Array.from(new Set(
      surfaceSafeRegionCollisions.map(([, label]) => label),
    ));
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    return {
      label: probeLabel,
      page_scale: Number(window.visualViewport && window.visualViewport.scale || 1),
      device_pixel_ratio: Number(window.devicePixelRatio || 0),
      layout_viewport: [innerWidth, innerHeight],
      zoom_profile: probeLabel === 'zoom-125-page-scale'
        ? 'browser-page-scale-1.25'
        : null,
      visual_viewport: viewportBounds,
      rect: mentionsRect,
      anchor_rect: anchorRect,
      surfaces: {
        mentions: {
          rect: mentionsRect,
          visible_rect: mentionsVisibleRect,
          within_viewport: Boolean(mentionsRect)
            && mentionsRect.left >= viewportBounds.left && mentionsRect.top >= viewportBounds.top
            && mentionsRect.right <= viewportBounds.right && mentionsRect.bottom <= viewportBounds.bottom,
        },
        explore: {
          rect: exploreRect,
          visible_rect: exploreVisibleRect,
          horizontally_bounded: Boolean(exploreRect)
            && exploreRect.left >= 0 && exploreRect.right <= innerWidth,
          intersects_visual_viewport: Boolean(exploreRect)
            && intersects(exploreRect, viewportBounds),
          vertically_reachable: Boolean(exploreRect)
            && exploreRect.height > 0
            && exploreRect.top + scrollY >= 0
            && exploreRect.bottom + scrollY <= documentHeight + 1,
        },
      },
      named_surfaces: namedSurfaces,
      thread_placement: {
        anchor_rect: window.__lucidaTryoutRectRecord(threadAnchor),
        anchor_visible_rect: window.__lucidaTryoutEffectiveVisibleRect(threadAnchor),
        inline_left: threadElement && threadElement.style.left,
        inline_top: threadElement && threadElement.style.top,
        candidate_obstacles: threadPlacementObstacles,
      },
      simultaneous_surface_names: simultaneousSurfaces.map((surface) => surface.name),
      named_surface_collisions: namedSurfaceCollisions,
      surface_safe_region_pairs_checked: surfaceSafeRegionPairsChecked,
      surface_safe_region_collisions: surfaceSafeRegionCollisions,
      pairwise_overlap: intersects(mentionsVisibleRect, exploreVisibleRect),
      safe_regions: safeRegions,
      occluded_safe_regions: occludedSafeRegions,
      horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      primary_controls_unoccluded: safeRegions.every((safe) =>
        !safe.intersects_visible_clip || safe.hit)
        && surfaceSafeRegionCollisions.length === 0,
      trigger_panel_linked: Boolean(mentions && panel)
        && mentions.getAttribute('aria-controls') === panel.id
        && mentions.getAttribute('aria-expanded') === 'true'
        && panel.getAttribute('role') === 'dialog',
      trigger_kept_focus: document.activeElement === mentions,
      flipped_from_bottom_right: probeLabel !== 'edge-bottom-right'
        || Boolean(mentionsRect && anchorRect && mentionsRect.bottom <= anchorRect.top + 1),
    };
  }, label);
  const collectionInteraction = exercisePersistentInteraction
    ? await exerciseCollectionSelector(page, label)
    : {
        label,
        applicable: false,
        present: false,
        populated_cell_count: 0,
        required_cell_count: 12,
        skip_reason: 'interaction is exercised in the isolated persistent-overlay profile',
      };
  return {
    ...probe,
    collection_interaction: collectionInteraction,
    viewport_triggers: viewportTriggers,
    layout_settlement: layoutSettlement,
  };
}

function attachAcceptanceDiagnostics(page, diagnostics) {
  page.on('console', (message) => {
    try {
      diagnostics.messages.push('[' + message.type() + '] ' + message.text());
    } catch (_) {}
  });
  page.on('pageerror', (error) => {
    const text = String(error && error.message ? error.message : error);
    diagnostics.pageErrors.push(text);
    diagnostics.messages.push('[pageerror] ' + text);
  });
  page.on('requestfailed', (request) => {
    try {
      const failure = {
        url: request.url(),
        error: request.failure() && request.failure().errorText,
      };
      diagnostics.requestFailures.push(failure);
      diagnostics.messages.push('[requestfailed] ' + failure.url + ' ' + failure.error);
    } catch (_) {}
  });
  page.on('websocket', (socket) => {
    socket.on('framereceived', (event) => {
      try {
        const text = typeof event.payload === 'string'
          ? event.payload
          : event.payload.toString('utf8');
        if (/"type"\s*:\s*"open_dataset_failed"/.test(text)) {
          diagnostics.datasetTerminals.push(text.slice(0, 2000));
        }
      } catch (_) {}
    });
  });
}

async function pageZoomOverlayProbe(
  browser,
  sourcePage,
  sourceDeviceScaleFactor,
  diagnostics,
) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 576 },
    deviceScaleFactor: sourceDeviceScaleFactor,
  });
  const page = await context.newPage();
  attachAcceptanceDiagnostics(page, diagnostics);
  try {
    await page.goto(sourcePage.url(), { waitUntil: 'load', timeout: renderWaitMs });
    await installBrowserProbes(page);
    await waitForReady(page, -1, 30000);
    await resetWorkspaceScroll(page);
    const explore = page.getByRole('button', { name: 'Explore', exact: true });
    const exploreTrigger = await prepareViewportTrigger(page, explore, 'zoom-125: Explore');
    if (!exploreTrigger.hit_testable) throw new Error('zoom-125 Explore trigger was not hit-testable');
    if (await explore.getAttribute('aria-pressed') !== 'true') await explore.click();
    const mentions = page.locator('[data-testid="mentions-of-me-badge"]');
    const mentionsTrigger = await prepareViewportTrigger(page, mentions, 'zoom-125: Mentions');
    if (!mentionsTrigger.hit_testable) throw new Error('zoom-125 Mentions trigger was not hit-testable');
    await mentions.click();
    await page.locator('[data-testid="mentions-of-me-panel"]').waitFor({
      state: 'visible',
      timeout: 10000,
    });
    // This is real page/pinch zoom at the browser's visual-viewport boundary.
    // `deviceScaleFactor` remains the matrix arm's DPR, so changing it cannot
    // accidentally masquerade as page zoom again.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 });
    await page.waitForFunction(() => (
      Math.abs(Number(window.visualViewport && window.visualViewport.scale || 1) - 1.25) < 0.01
    ), undefined, { timeout: 10000 });
    // Page zoom changes the visual viewport after the opening click. Bring the
    // actual anchor back inside that new painted boundary before evaluating the
    // still-open panel; otherwise the probe compares pre-zoom scroll state with
    // post-zoom geometry.
    const postZoomMentionsTrigger = await prepareViewportTrigger(
      page,
      mentions,
      'zoom-125 post-scale: Mentions',
    );
    if (!postZoomMentionsTrigger.hit_testable) {
      throw new Error('zoom-125 Mentions trigger was not hit-testable after page scale');
    }
    await page.waitForTimeout(150);
    return {
      ...await floatingSurfaceProbe(page, 'zoom-125-page-scale', false),
      opening_trigger_receipts: {
        explore: exploreTrigger,
        mentions: mentionsTrigger,
        post_zoom_mentions: postZoomMentionsTrigger,
      },
    };
  } finally {
    await context.close();
  }
}

async function exerciseOverlayContract(
  sourcePage,
  browser,
  sourceDeviceScaleFactor,
  diagnostics,
) {
  // Overlay geometry and error-state assertions must not inherit renderer or
  // alert state from the zero-size recovery exercises that precede them on the
  // matrix arm's main page. A dedicated context gives this capability profile
  // its own controller, transport, error precedence, viewport, and lifecycle.
  // Suspend the matrix arm's source page while the isolated profile runs. If
  // both clients stayed connected, the peer banner would add flow content and
  // this would silently become a different geometry profile from the original
  // single-client acceptance scenario.
  const sourceUrl = sourcePage.url();
  await sourcePage.goto('about:blank', { waitUntil: 'load', timeout: renderWaitMs });
  let context = null;
  let result = null;
  let failure = null;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: sourceDeviceScaleFactor,
    });
    const page = await context.newPage();
    attachAcceptanceDiagnostics(page, diagnostics);
    await page.goto(sourceUrl, { waitUntil: 'load', timeout: renderWaitMs });
    await installBrowserProbes(page);
    const ready = await waitForReady(page, -1, 30000);
    if (!ready || !ready.ready) {
      throw new Error('overlay profile viewer did not become ready in its isolated context');
    }
    await ensureViewMode(page, '2d');
    await page.locator('.peer-list').waitFor({ state: 'detached', timeout: 10000 });
    result = await exerciseOverlayContractInPage(
      page,
      browser,
      sourceDeviceScaleFactor,
      diagnostics,
    );
  } catch (error) {
    failure = error;
  } finally {
    if (context) await context.close();
  }
  try {
    await sourcePage.goto(sourceUrl, { waitUntil: 'load', timeout: renderWaitMs });
    await installBrowserProbes(sourcePage);
    const restored = await ensureViewMode(sourcePage, '2d');
    if (!restored || !restored.ready) {
      throw new Error('matrix source page did not recover after isolated overlay profile');
    }
    await sourcePage.locator('.peer-list').waitFor({ state: 'detached', timeout: 10000 });
  } catch (restoreError) {
    failure = failure
      ? new Error(String(failure) + '; source page restore failed: ' + String(restoreError))
      : restoreError;
  }
  if (failure) throw failure;
  return result;
}

async function exerciseOverlayContractInPage(
  page,
  browser,
  sourceDeviceScaleFactor,
  diagnostics,
) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await resetWorkspaceScroll(page);
  const savedViewActions = await exerciseSavedViewActionsMenu(page);
  // Opening/closing the docked sidebar legitimately scrolls its toolbar
  // trigger into view. Start the independent simultaneous-surface scenario
  // from a declared scroll position instead of inheriting that exercise.
  await resetWorkspaceScroll(page);
  const explore = page.getByRole('button', { name: 'Explore', exact: true });
  const desktopExploreTrigger = await prepareViewportTrigger(page, explore, 'desktop: Explore');
  if (!desktopExploreTrigger.hit_testable) throw new Error('desktop Explore trigger was not hit-testable');
  if (await explore.getAttribute('aria-pressed') !== 'true') await explore.click();
  const thread = await exerciseThreadPopover(page);
  const mentions = page.locator('[data-testid="mentions-of-me-badge"]');
  const desktopMentionsTrigger = await prepareViewportTrigger(page, mentions, 'desktop: Mentions');
  if (!desktopMentionsTrigger.hit_testable) throw new Error('desktop Mentions trigger was not hit-testable');
  await mentions.click();
  // Capture the click's focus result before waiters, geometry probes, or the
  // logical-focus trace are allowed to move focus and mask a regression.
  const mentionsFocusAfterClick = await mentions.evaluate((element) => ({
    captured_before_focus_mutation: true,
    trigger_focused: document.activeElement === element,
    active_element: document.activeElement && {
      tag: document.activeElement.tagName,
      role: document.activeElement.getAttribute('role'),
      testid: document.activeElement.getAttribute('data-testid'),
      aria_label: document.activeElement.getAttribute('aria-label'),
    },
  }));
  await page.locator('[data-testid="mentions-of-me-panel"]').waitFor({ state: 'visible', timeout: 10000 });
  const desktop = await floatingSurfaceProbe(page, 'desktop');
  const logicalFocus = await traceLogicalFocus(
    page,
    mentions,
    page.locator('[data-testid="mentions-of-me-panel"]'),
  );
  await resetWorkspaceScroll(page);
  const overlayAxeDesktop = await runAxe(page, 'overlays-open-desktop');
  const noticeInput = page.getByLabel('Dataset URL or path');
  const noticeInputTrigger = await prepareViewportTrigger(page, noticeInput, 'notice: dataset input');
  if (!noticeInputTrigger.hit_testable) throw new Error('notice dataset input was not hit-testable');
  await noticeInput.fill(
    'file:///__lucida_tryout_overlay_notice_missing_dpr'
      + sourceDeviceScaleFactor + '.ome.zarr',
  );
  const noticeOpen = page.getByRole('button', { name: 'Open', exact: true });
  const noticeOpenTrigger = await prepareViewportTrigger(page, noticeOpen, 'notice: Open');
  if (!noticeOpenTrigger.hit_testable) throw new Error('notice Open trigger was not hit-testable');
  const terminalStart = diagnostics.datasetTerminals.length;
  await noticeOpen.click();
  const noticeAlert = page.getByRole('alert').filter({
    has: page.getByRole('button', { name: 'Retry dataset' }),
  }).last();
  try {
    await noticeAlert.waitFor({ state: 'visible', timeout: 15000 });
  } catch (error) {
    const visibleAlerts = await page.getByRole('alert').evaluateAll((elements) =>
      elements.map((element) => ({
        text: (element.textContent || '').trim(),
        buttons: Array.from(element.querySelectorAll('button'))
          .map((button) => (button.textContent || '').trim()),
      })),
    );
    throw new Error(
      'overlay dataset error did not surface Retry dataset; visible alerts='
        + JSON.stringify(visibleAlerts) + '; received dataset terminals='
        + JSON.stringify(diagnostics.datasetTerminals.slice(terminalStart))
        + '; cause=' + String(error),
    );
  }
  await page.waitForTimeout(150);
  // The error banner and toolbar are both ordinary document content. A taller
  // desktop viewport makes their simultaneous state physically representable,
  // instead of manufacturing a collision result from an inherited bottom
  // scroll position that clips the newly inserted banner.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await resetWorkspaceScroll(page);
  const noticeMentionsTrigger = await prepareViewportTrigger(
    page,
    mentions,
    'notice-active: Mentions',
  );
  if (!noticeMentionsTrigger.hit_testable) {
    throw new Error('notice-active Mentions trigger was not hit-testable');
  }
  await mentions.evaluate((element) => element.focus({ preventScroll: true }));
  const notice = await floatingSurfaceProbe(page, 'notice-active');
  const overlayAxeNotice = await runAxe(page, 'overlays-open-with-notice');
  await noticeAlert.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await resetWorkspaceScroll(page);
  await mentions.evaluate((element) => element.focus({ preventScroll: true }));
  const zoomed = await pageZoomOverlayProbe(
    browser,
    page,
    sourceDeviceScaleFactor,
    diagnostics,
  );
  await resetWorkspaceScroll(page);
  const originalEdgeStyles = await page.evaluate(() => {
    const anchor = document.querySelector('[data-testid="mentions-of-me-badge"]');
    const explore = Array.from(document.querySelectorAll('button'))
      .find((element) => element.textContent.trim() === 'Explore');
    return {
      anchor: anchor && anchor.getAttribute('style'),
      explore: explore && explore.getAttribute('style'),
    };
  });
  await page.evaluate(() => {
    const anchor = document.querySelector('[data-testid="mentions-of-me-badge"]');
    const owner = anchor && anchor.closest('.main-content');
    const explore = Array.from(document.querySelectorAll('button'))
      .find((element) => element.textContent.trim() === 'Explore');
    if (!anchor || !owner) throw new Error('edge probe could not resolve the trigger scroll clip');
    const ownerRect = owner.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    // Exercise the bottom/end edge of the trigger's *real painted clip*. A
    // viewport-fixed point outside `.main-content` would be correctly clipped
    // by production visibility logic and is not a valid placement precondition.
    anchor.style.position = 'fixed';
    anchor.style.left = Math.max(ownerRect.left, ownerRect.right - anchorRect.width - 1) + 'px';
    anchor.style.top = Math.max(ownerRect.top, ownerRect.bottom - anchorRect.height - 1) + 'px';
    anchor.style.right = 'auto';
    anchor.style.bottom = 'auto';
    anchor.style.zIndex = '100';
    // The synthetic end-edge position occupies the Explore trigger's real
    // toolbar cell. Its open dock was proven from a real click already; hide
    // that one trigger during this isolated anchor-edge geometry probe instead
    // of declaring an intentionally covered sibling a product occlusion.
    if (explore) {
      explore.style.visibility = 'hidden';
      explore.style.pointerEvents = 'none';
    }
    window.dispatchEvent(new Event('resize'));
  });
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const edgeMentionsTrigger = await inspectViewportTrigger(
    page,
    mentions,
    'edge-bottom-right: Mentions',
  );
  if (!edgeMentionsTrigger.in_viewport || !edgeMentionsTrigger.hit_testable) {
    throw new Error('edge-bottom-right Mentions trigger was not hit-testable inside its real clip');
  }
  const edge = await floatingSurfaceProbe(page, 'edge-bottom-right');
  await page.evaluate((savedStyles) => {
    const anchor = document.querySelector('[data-testid="mentions-of-me-badge"]');
    const explore = Array.from(document.querySelectorAll('button'))
      .find((element) => element.textContent.trim() === 'Explore');
    if (savedStyles.anchor === null) anchor.removeAttribute('style');
    else anchor.setAttribute('style', savedStyles.anchor);
    if (explore) {
      if (savedStyles.explore === null) explore.removeAttribute('style');
      else explore.setAttribute('style', savedStyles.explore);
    }
    window.dispatchEvent(new Event('resize'));
  }, originalEdgeStyles);
  await page.setViewportSize({ width: 390, height: 844 });
  await resetWorkspaceScroll(page);
  await page.waitForTimeout(150);
  // Persistent canvas controls and toolbar-anchored panels have different
  // narrow-screen scroll states. Prove the stacked minimap + wide selector
  // while the canvas is visible, before scrolling the Mentions anchor into
  // view for the independent floating-surface proof.
  const mobilePersistent = await persistentOverlayProfile(page, 'mobile-persistent');
  const mobileMentionsTrigger = await prepareViewportTrigger(page, mentions, 'mobile: Mentions');
  if (!mobileMentionsTrigger.hit_testable) throw new Error('mobile Mentions trigger was not hit-testable');
  await mentions.evaluate((element) => element.focus({ preventScroll: true }));
  const narrow = await floatingSurfaceProbe(page, 'mobile', false);
  const overlayAxeMobile = await runAxe(page, 'overlays-open-mobile');
  await mentions.click();
  const closeThread = page.getByRole('button', { name: 'Close thread' });
  if (await closeThread.count() > 0) await closeThread.first().click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await resetWorkspaceScroll(page);
  return {
    source_device_pixel_ratio: sourceDeviceScaleFactor,
    require_collection_1x12: requireCollection1x12,
    probes: { desktop, notice, zoomed, edge, narrow },
    persistent_profiles: { mobile: mobilePersistent },
    thread,
    logical_focus: logicalFocus,
    mentions_focus_after_click: mentionsFocusAfterClick,
    saved_view_actions: savedViewActions,
    trigger_receipts: {
      desktop_explore: desktopExploreTrigger,
      desktop_mentions: desktopMentionsTrigger,
      notice_input: noticeInputTrigger,
      notice_open: noticeOpenTrigger,
      notice_mentions: noticeMentionsTrigger,
      edge_mentions: edgeMentionsTrigger,
      mobile_mentions: mobileMentionsTrigger,
    },
    axe: [overlayAxeDesktop, overlayAxeNotice, overlayAxeMobile],
  };
}

function overlayFailures(contract, requireCollectionProfile) {
  const failures = [];
  const sameRect = (left, right, tolerance = 2) => Boolean(left && right)
    && ['left', 'top', 'right', 'bottom', 'width', 'height'].every((key) =>
      Number.isFinite(left[key]) && Number.isFinite(right[key])
        && Math.abs(left[key] - right[key]) <= tolerance);
  if (!contract || !contract.thread
    || contract.thread.trigger_hit_testable_before_click !== true) {
    failures.push('annotation thread trigger was not hit-testable before click');
  }
  if (!contract || !contract.mentions_focus_after_click
    || contract.mentions_focus_after_click.captured_before_focus_mutation !== true
    || contract.mentions_focus_after_click.trigger_focused !== true) {
    failures.push('Mentions trigger did not retain focus immediately after click');
  }
  const savedViewActions = contract && contract.saved_view_actions;
  const savedViewGeometry = savedViewActions && savedViewActions.geometry;
  const clippedSavedViewAnchor = savedViewActions && savedViewActions.clipped_anchor;
  if (!savedViewActions || savedViewActions.applicable !== true
    || savedViewActions.row_count < 1 || savedViewActions.item_count < 2
    || savedViewActions.initial_focus_first_item !== true
    || savedViewActions.arrow_navigation_passed !== true
    || savedViewActions.escape_restored_trigger !== true
    || !savedViewGeometry || savedViewGeometry.within_viewport !== true
    || savedViewGeometry.registered_surface !== true
    || !Array.isArray(savedViewGeometry.safe_control_collisions)
    || savedViewGeometry.safe_control_collisions.length > 0
    || !clippedSavedViewAnchor || clippedSavedViewAnchor.trigger_connected !== true
    || clippedSavedViewAnchor.trigger_fully_clipped !== true
    || clippedSavedViewAnchor.aria_expanded_cleared !== true
    || clippedSavedViewAnchor.fallback_focused !== true
    || clippedSavedViewAnchor.fallback_label !== 'Search saved views') {
    failures.push('overlay: saved-view actions menu lifecycle did not pass');
  }
  const edgeTrigger = contract && contract.trigger_receipts
    && contract.trigger_receipts.edge_mentions;
  if (!edgeTrigger || edgeTrigger.in_viewport !== true
    || edgeTrigger.hit_testable !== true) {
    failures.push('overlay edge-bottom-right: trigger precondition did not pass inside its real clip');
  }
  const triggerReceipts = contract && contract.trigger_receipts || {};
  for (const [name, receipt] of Object.entries({
    desktop_explore: triggerReceipts.desktop_explore,
    desktop_mentions: triggerReceipts.desktop_mentions,
    notice_mentions: triggerReceipts.notice_mentions,
    mobile_mentions: triggerReceipts.mobile_mentions,
  })) {
    if (!receipt || receipt.in_viewport !== true || receipt.hit_testable !== true) {
      failures.push('overlay opening trigger ' + name + ' was not hit-testable');
    }
  }
  const zoomTrigger = contract && contract.probes && contract.probes.zoomed
    && contract.probes.zoomed.opening_trigger_receipts
    && contract.probes.zoomed.opening_trigger_receipts.post_zoom_mentions;
  if (!zoomTrigger || zoomTrigger.in_viewport !== true || zoomTrigger.hit_testable !== true) {
    failures.push('overlay zoom-125: post-scale Mentions trigger was not hit-testable');
  }
  const mobilePersistent = contract && contract.persistent_profiles
    && contract.persistent_profiles.mobile;
  const mobilePersistentInteraction = mobilePersistent && mobilePersistent.collection_interaction;
  const mobilePersistentCollection = mobilePersistent && mobilePersistent.collection;
  const mobilePersistentMinimap = mobilePersistent && mobilePersistent.minimap;
  if (!mobilePersistent
    || !mobilePersistent.layout_settlement || mobilePersistent.layout_settlement.settled !== true
    || mobilePersistent.owner_present !== true
    || !mobilePersistentInteraction
    || typeof mobilePersistentInteraction.applicable !== 'boolean'
    || (mobilePersistentInteraction.applicable === false
      && (typeof mobilePersistentInteraction.skip_reason !== 'string'
        || mobilePersistentInteraction.skip_reason.trim().length === 0))
    || !mobilePersistentMinimap || mobilePersistentMinimap.present !== true
    || mobilePersistentMinimap.within_viewport !== true
    || mobilePersistentMinimap.registered_safe_region !== true) {
    failures.push('overlay mobile: isolated persistent-overlay capability receipt did not pass');
  } else if ((requireCollectionProfile
    || mobilePersistentInteraction && mobilePersistentInteraction.applicable === true)
    && (mobilePersistent.owner_layout !== 'stacked'
    || mobilePersistent.overlap !== false
    || !mobilePersistentCollection || mobilePersistentCollection.present !== true
    || mobilePersistentCollection.within_viewport !== true
    || mobilePersistentCollection.registered_safe_region !== true
    || !mobilePersistentCollection.accessible_name
    || !mobilePersistentInteraction || mobilePersistentInteraction.applicable !== true
    || mobilePersistentInteraction.owner_layout !== mobilePersistent.owner_layout
    || !sameRect(mobilePersistentCollection.rect, mobilePersistentInteraction.selector_rect)
    || !sameRect(mobilePersistentMinimap.rect, mobilePersistentInteraction.minimap_rect)
    || mobilePersistentInteraction.populated_cell_count < mobilePersistentInteraction.required_cell_count
    || mobilePersistentInteraction.edge_cell_label !== 'Go to A12'
    || mobilePersistentInteraction.selector_minimap_overlap !== false
    || !mobilePersistentInteraction.edge_cell_inside_selector
    || !mobilePersistentInteraction.edge_cell_hit_testable
    || !mobilePersistentInteraction.edge_cell_focused
    || !mobilePersistentInteraction.edge_cell_focus_visible
    || !mobilePersistentInteraction.edge_cell_focus_ring_inset
    || !mobilePersistentInteraction.edge_cell_keyboard_returned
    || !mobilePersistentInteraction.edge_cell_click_completed
    || !mobilePersistentInteraction.edge_cell_click_received)) {
    failures.push('overlay mobile: isolated stacked persistent-overlay profile did not pass');
  }
  for (const probe of Object.values(contract && contract.probes || {})) {
    const mobileFloatingProfile = probe.label === 'mobile';
    const zoomFloatingProfile = probe.label === 'zoom-125-page-scale';
    const isolatedFloatingProfile = mobileFloatingProfile || zoomFloatingProfile;
    if (!probe.layout_settlement || probe.layout_settlement.settled !== true) {
      failures.push('overlay ' + probe.label + ': layout did not settle before geometry capture');
    }
    const viewportTriggers = probe.viewport_triggers || {};
    // Explore can live on the next wrapped toolbar row while its dock remains
    // legitimately open. The panel-owning Mentions anchor, however, must match
    // the exact geometry state being evaluated.
    if (!viewportTriggers.mentions || !viewportTriggers.mentions.hit_testable) {
      failures.push('overlay ' + probe.label + ': Mentions anchor was not hit-testable');
    }
    if (!probe.surfaces || !probe.surfaces.mentions.within_viewport) failures.push('overlay ' + probe.label + ': Mentions escaped viewport bounds');
    if (!probe.surfaces || !probe.surfaces.explore.horizontally_bounded
      || !probe.surfaces.explore.intersects_visual_viewport
      || !probe.surfaces.explore.vertically_reachable) {
      failures.push('overlay ' + probe.label + ': Explore was not reachable inside the document');
    }
    if (probe.pairwise_overlap) failures.push('overlay ' + probe.label + ': Explore and Mentions collided');
    const minimapReceipt = probe.named_surfaces && probe.named_surfaces.minimap;
    const zoomMinimapYielded = zoomFloatingProfile && minimapReceipt
      && minimapReceipt.mounted === true
      && ['boundary-too-small', 'transient-collision'].includes(minimapReceipt.suppression_reason);
    if (!mobileFloatingProfile && (!minimapReceipt
      || (!zoomMinimapYielded && (!minimapReceipt.present
        || !minimapReceipt.within_viewport
        || !minimapReceipt.registered_safe_region)))) {
      failures.push('overlay ' + probe.label + ': renderer minimap was not a bounded shared safe region');
    }
    if (!probe.named_surfaces || !probe.named_surfaces.thread_popover
      || !probe.named_surfaces.collection_selector || !probe.named_surfaces.notice) {
      failures.push('overlay ' + probe.label + ': named overlay applicability receipts were incomplete');
    }
    const collection = probe.named_surfaces && probe.named_surfaces.collection_selector;
    const threadReceipt = probe.named_surfaces && probe.named_surfaces.thread_popover;
    if (probe.label === 'desktop' && (!threadReceipt || !threadReceipt.present
      || !threadReceipt.within_viewport || !threadReceipt.registered_safe_region)) {
      failures.push('overlay desktop: annotation thread was not a bounded shared safe region');
    }
    const interaction = probe.collection_interaction;
    if (!interaction || typeof interaction.applicable !== 'boolean'
      || (interaction.applicable === false && !interaction.skip_reason)) {
      failures.push('overlay ' + probe.label + ': collection capability receipt was incomplete');
    } else if (!isolatedFloatingProfile && requireCollectionProfile && interaction.applicable !== true) {
      failures.push('overlay ' + probe.label + ': required 1x12 collection capability was absent');
    } else if (!isolatedFloatingProfile && interaction.applicable && (!collection || !collection.present
      || !collection.within_viewport || !collection.registered_safe_region
      || !collection.accessible_name
      || interaction.populated_cell_count < interaction.required_cell_count
      || interaction.edge_cell_label !== 'Go to A12'
      || interaction.selector_minimap_overlap !== false
      || !interaction.edge_cell_inside_selector || !interaction.edge_cell_hit_testable
      || !interaction.edge_cell_focused || !interaction.edge_cell_focus_visible
      || !interaction.edge_cell_focus_ring_inset
      || !interaction.edge_cell_keyboard_returned
      || !interaction.edge_cell_click_completed || !interaction.edge_cell_click_received
      || !interaction.owner_present
      || (probe.label === 'mobile' && interaction.owner_layout !== 'stacked'))) {
      failures.push('overlay ' + probe.label + ': wide collection edge-cell interaction did not pass');
    }
    if (!Array.isArray(probe.named_surface_collisions)
      || probe.named_surface_collisions.length > 0) {
      failures.push('overlay ' + probe.label + ': simultaneous named surfaces collided');
    }
    if (!Array.isArray(probe.surface_safe_region_collisions)
      || probe.surface_safe_region_collisions.length > 0
      || !Number.isFinite(probe.surface_safe_region_pairs_checked)
      || probe.surface_safe_region_pairs_checked < 1) {
      failures.push('overlay ' + probe.label + ': floating surfaces collided with safe-region controls');
    }
    if (probe.horizontal_overflow) failures.push('overlay ' + probe.label + ': horizontal overflow');
    if (!probe.primary_controls_unoccluded) failures.push('overlay ' + probe.label + ': primary controls were occluded');
    if (!probe.trigger_panel_linked) failures.push('overlay ' + probe.label + ': trigger and dialog reading order were not linked');
    if (!probe.trigger_kept_focus) failures.push('overlay ' + probe.label + ': opening the non-modal dialog lost trigger focus');
    if (!probe.flipped_from_bottom_right) failures.push('overlay edge-bottom-right: panel did not flip above its anchor');
  }
  const zoomed = contract && contract.probes && contract.probes.zoomed;
  if (!zoomed || zoomed.zoom_profile !== 'browser-page-scale-1.25'
    || Math.abs(Number(zoomed.page_scale || 0) - 1.25) >= 0.01
    || zoomed.device_pixel_ratio !== contract.source_device_pixel_ratio
    || !Array.isArray(zoomed.layout_viewport)
    || zoomed.layout_viewport[0] !== 1024 || zoomed.layout_viewport[1] !== 576) {
    failures.push('overlay zoom-125: browser page scale was not applied independently of DPR');
  }
  if (!contract || !contract.logical_focus || !contract.logical_focus.reached_panel
    || !contract.logical_focus.panel_focus_visible) {
    failures.push('overlay: bounded logical focus sequence did not reach visible focus inside Mentions');
  }
  if (!contract || !contract.thread || !contract.thread.trigger_panel_linked
    || !contract.thread.trigger_kept_focus || !contract.thread.logical_focus
    || !contract.thread.logical_focus.reached_panel
    || !contract.thread.logical_focus.panel_focus_visible
    || !contract.thread.escape_restored_trigger
    || !contract.thread.close_restored_trigger) {
    failures.push('overlay: annotation thread trigger/focus/reading-order contract did not pass');
  }
  for (const audit of contract && contract.axe || []) failures.push(...axeFailures(audit));
  return failures;
}

async function resetWorkspaceScroll(page) {
  return page.evaluate(() => {
    window.scrollTo(0, 0);
    const main = document.querySelector('.main-content');
    if (main) {
      main.scrollLeft = 0;
      main.scrollTop = 0;
    }
    return {
      window_x: window.scrollX,
      window_y: window.scrollY,
      main_content_found: Boolean(main),
      main_content_left: main ? main.scrollLeft : null,
      main_content_top: main ? main.scrollTop : null,
    };
  });
}

async function exerciseErrorPlacement(page, dpr) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await resetWorkspaceScroll(page);
  const input = page.getByLabel('Dataset URL or path');
  await input.fill('file:///__lucida_tryout_missing_dpr' + dpr + '.ome.zarr');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const alert = page.getByRole('alert').last();
  await alert.waitFor({ state: 'visible', timeout: 15000 });
  const desktopScrollReset = await resetWorkspaceScroll(page);
  const desktop = await captureLayoutProbe(page, 'desktop-error');
  const desktopAxe = await runAxe(page, 'dataset-error-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const mobileScrollReset = await resetWorkspaceScroll(page);
  const mobile = await captureLayoutProbe(page, 'mobile-error');
  const mobileAxe = await runAxe(page, 'dataset-error-mobile');
  const result = {
    desktop: desktop.alert,
    mobile: mobile.alert,
    scroll_resets: { desktop: desktopScrollReset, mobile: mobileScrollReset },
    axe: [desktopAxe, mobileAxe],
    retry_action: { clicked: false, failure_reappeared: false, dismiss_cleared: false },
  };
  const initialAlertElement = await alert.elementHandle();
  await alert.getByRole('button', { name: 'Retry dataset', exact: true }).click();
  result.retry_action.clicked = true;
  if (initialAlertElement) {
    await page.waitForFunction((element) => !element.isConnected, initialAlertElement, {
      timeout: 10000,
    });
  }
  const retryAlert = page.getByRole('alert').filter({
    has: page.getByRole('button', { name: 'Retry dataset', exact: true }),
  }).last();
  await retryAlert.waitFor({ state: 'visible', timeout: 15000 });
  result.retry_action.failure_reappeared = true;
  await retryAlert.getByRole('button', { name: 'Dismiss', exact: true }).click();
  result.retry_action.dismiss_cleared = await page.getByRole('alert').count() === 0;
  await page.setViewportSize({ width: 1280, height: 720 });
  return result;
}

async function exerciseKeyboardContract(page, focusFailureScreenshotPath) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await resetWorkspaceScroll(page);
  const canvas = page.locator('canvas[aria-label$="viewer"]').first();
  const canvasName = await canvas.getAttribute('aria-label');
  const describedBy = await canvas.getAttribute('aria-describedby');
  const instructions = describedBy
    ? ((await page.locator('#' + describedBy).textContent()) || '').trim()
    : '';

  const sidebar = page.getByRole('separator', { name: 'Resize layers panel' });
  await sidebar.focus();
  const sidebarBefore = await sidebar.getAttribute('aria-valuenow');
  await sidebar.press('ArrowRight');
  await page.waitForTimeout(50);
  const sidebarAfter = await sidebar.getAttribute('aria-valuenow');
  const sidebarFocus = await focusAppearance(sidebar);

  const viewer = page.getByRole('separator', { name: 'Resize viewer' });
  await viewer.focus();
  const viewerBefore = await viewer.getAttribute('aria-valuetext');
  await viewer.press('ArrowRight');
  await page.waitForTimeout(50);
  const viewerAfter = await viewer.getAttribute('aria-valuetext');
  const viewerFocus = await focusAppearance(viewer);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  const drawerTrigger = page.getByRole('button', { name: 'Layers', exact: true });
  const drawerTriggerViewport = await prepareViewportTrigger(
    page,
    drawerTrigger,
    'keyboard: Layers',
  );
  await drawerTrigger.focus();
  await drawerTrigger.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Layers' });
  await drawer.waitFor({ state: 'visible', timeout: 10000 });
  const close = drawer.getByRole('button', { name: 'Close layers panel' });
  const drawerFocusWait = await waitForFocusInside(
    page,
    'keyboard.layers-dialog-initial-focus',
    '#layers-panel[role="dialog"]',
    '#layers-panel button[aria-label="Close layers panel"]',
  );
  if (!drawerFocusWait.wait_passed && focusFailureScreenshotPath) {
    await page.screenshot({ path: focusFailureScreenshotPath, fullPage: true });
  }
  const initialFocusInside = await drawer.evaluate((element) => element.contains(document.activeElement));
  const closeFocus = await focusAppearance(close);
  const focusCycle = await exerciseDialogFocusCycle(page, drawer);
  const reducedMotion = await drawer.evaluate((element) => {
    const values = getComputedStyle(element).transitionDuration.split(',').map((value) => {
      const trimmed = value.trim();
      return trimmed.endsWith('ms') ? Number.parseFloat(trimmed) : Number.parseFloat(trimmed) * 1000;
    });
    return {
      transition_duration_ms: values,
      respected: values.every((value) => Number.isFinite(value) && value <= 0.011),
    };
  });
  await page.keyboard.press('Escape');
  const focusRestored = await drawerTrigger.evaluate((element) => document.activeElement === element);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 720 });

  return {
    canvas_name: canvasName,
    canvas_instructions: instructions,
    sidebar_resizer_changed: sidebarBefore !== sidebarAfter,
    viewer_resizer_changed: viewerBefore !== viewerAfter,
    sidebar_focus_visible: sidebarFocus.visible,
    viewer_focus_visible: viewerFocus.visible,
    sidebar_focus: sidebarFocus,
    viewer_focus: viewerFocus,
    drawer_focus_wait: drawerFocusWait,
    drawer_trigger_viewport: drawerTriggerViewport,
    drawer_focus_failure_screenshot: !drawerFocusWait.wait_passed
      ? focusFailureScreenshotPath
      : null,
    drawer_initial_focus_inside: initialFocusInside,
    drawer_close_focus_visible: closeFocus.visible,
    drawer_close_focus: closeFocus,
    drawer_focus_cycle: focusCycle,
    drawer_escape_restored_focus: focusRestored,
    reduced_motion: reducedMotion,
  };
}

function keyboardFailures(contract) {
  const failures = [];
  if (!contract.canvas_name || !/viewer/i.test(contract.canvas_name)) failures.push('canvas lacked a meaningful accessible name');
  if (!contract.canvas_instructions) failures.push('canvas lacked accessible keyboard instructions');
  if (!contract.sidebar_resizer_changed) failures.push('layers resizer did not respond to keyboard input');
  if (!contract.viewer_resizer_changed) failures.push('viewer resizer did not respond to keyboard input');
  const focusReceipts = [contract.sidebar_focus, contract.viewer_focus, contract.drawer_close_focus];
  if (focusReceipts.some((receipt) => receipt && receipt.focused && receipt.visible !== true)) {
    failures.push('keyboard focus was not visibly indicated');
  }
  if (focusReceipts.some((receipt) => !receipt || receipt.focused !== true)) {
    failures.push('keyboard focus target did not retain focus');
  }
  if (!contract.drawer_focus_wait || !contract.drawer_focus_wait.wait_passed) {
    const active = contract.drawer_focus_wait && contract.drawer_focus_wait.active_element;
    failures.push('keyboard.layers-dialog-initial-focus did not settle (active='
      + JSON.stringify(active || null) + ')');
  }
  if (!contract.drawer_focus_wait || !contract.drawer_focus_wait.expected_focus_matched) {
    failures.push('keyboard.layers-dialog-initial-focus did not reach the Close layers panel button');
  }
  if (!contract.drawer_trigger_viewport || !contract.drawer_trigger_viewport.hit_testable) {
    failures.push('mobile Layers dialog trigger was not hit-testable');
  }
  if (!contract.drawer_focus_cycle
    || contract.drawer_focus_cycle.cycle_start_inside !== true
    || contract.drawer_focus_cycle.cycle_start_index < 0
    || !contract.drawer_focus_cycle.forward_full_cycle_inside
    || !contract.drawer_focus_cycle.backward_full_cycle_inside) {
    failures.push('mobile Layers dialog did not trap a complete forward/backward focus cycle');
  }
  if (!contract.drawer_escape_restored_focus) failures.push('mobile Layers dialog did not restore focus after Escape');
  if (!contract.reduced_motion || !contract.reduced_motion.respected) failures.push('reduced-motion did not suppress the Layers transition');
  return failures;
}

function errorPlacementFailures(contract) {
  const failures = [];
  for (const [label, alert] of Object.entries({
    desktop: contract && contract.desktop,
    mobile: contract && contract.mobile,
  })) {
    const reset = contract && contract.scroll_resets && contract.scroll_resets[label];
    if (!reset || !reset.main_content_found || reset.window_x !== 0 || reset.window_y !== 0
      || reset.main_content_left !== 0 || reset.main_content_top !== 0) {
      failures.push(label + ': workspace scroll container was not reset before the alert probe');
    }
    if (!alert) {
      failures.push(label + ': dataset failure alert did not render');
      continue;
    }
    if (!alert.immediately_after_chrome) failures.push(label + ': alert was not immediately after workspace chrome');
    if (!alert.has_retry || !alert.has_dismiss) failures.push(label + ': alert lacked retry/dismiss actions');
    if (!alert.rect || alert.rect.top < 0 || alert.rect.bottom > (label === 'mobile' ? 844 : 720)) {
      failures.push(label + ': alert was outside the supported viewport');
    }
  }
  for (const audit of contract && contract.axe || []) failures.push(...axeFailures(audit));
  if (!contract || !contract.retry_action || !contract.retry_action.clicked
    || !contract.retry_action.failure_reappeared || !contract.retry_action.dismiss_cleared) {
    failures.push('dataset failure Retry/Dismiss recovery action did not pass');
  }
  return failures;
}

async function installTerminalFaultHarness(page) {
  await page.addInitScript(() => {
    // Keep the decode terminal probe bounded and identical on every runner.
    // This changes only the harness page's advertised core count; production
    // code still constructs and owns the real workers and recovery policy.
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      configurable: true,
      get: () => 4,
    });
    const NativeWorker = window.Worker;
    const records = [];
    const constructionFailures = { gpu: 0, decode: 0 };
    class HarnessObservedWorker extends NativeWorker {
      constructor(workerUrl, options) {
        const url = String(workerUrl);
        const kind = /decode\.worker/i.test(url)
          ? 'decode'
          : (/gpu\.worker/i.test(url) ? 'gpu' : 'other');
        if ((kind === 'gpu' || kind === 'decode') && constructionFailures[kind] > 0) {
          constructionFailures[kind] -= 1;
          throw new Error('tryout injected ' + kind + ' worker construction failure');
        }
        super(workerUrl, options);
        this.__lucidaTryoutKind = kind;
        this.__lucidaTryoutTerminated = false;
        records.push(this);
      }
      terminate() {
        this.__lucidaTryoutTerminated = true;
        return super.terminate();
      }
    }
    window.Worker = HarnessObservedWorker;
    window.__lucidaTryoutWorkerFaults = {
      snapshot() {
        return {
          gpu_created: records.filter((worker) => worker.__lucidaTryoutKind === 'gpu').length,
          decode_created: records.filter((worker) => worker.__lucidaTryoutKind === 'decode').length,
          gpu_active: records.filter((worker) => worker.__lucidaTryoutKind === 'gpu' && !worker.__lucidaTryoutTerminated).length,
          decode_active: records.filter((worker) => worker.__lucidaTryoutKind === 'decode' && !worker.__lucidaTryoutTerminated).length,
          construction_failures_remaining: { ...constructionFailures },
        };
      },
      failNextConstruction(kind, count = 1) {
        if (kind !== 'gpu' && kind !== 'decode') return false;
        constructionFailures[kind] += Math.max(0, Math.floor(Number(count) || 0));
        return true;
      },
      crashGpu() {
        const worker = [...records].reverse().find((item) =>
          item.__lucidaTryoutKind === 'gpu' && !item.__lucidaTryoutTerminated);
        if (!worker) return false;
        worker.dispatchEvent(new ErrorEvent('error', { message: 'tryout injected GPU worker crash' }));
        return true;
      },
      loseGpuDevice() {
        const worker = [...records].reverse().find((item) =>
          item.__lucidaTryoutKind === 'gpu' && !item.__lucidaTryoutTerminated);
        if (!worker) return false;
        worker.dispatchEvent(new MessageEvent('message', {
          data: {
            type: 'error',
            code: 'gpu-device-lost',
            message: 'tryout injected GPU device loss',
          },
        }));
        return true;
      },
      crashDecodeRound() {
        const workers = records.filter((item) =>
          item.__lucidaTryoutKind === 'decode' && !item.__lucidaTryoutTerminated);
        for (const worker of workers) {
          worker.dispatchEvent(new ErrorEvent('error', { message: 'tryout injected decode worker crash' }));
        }
        return workers.length;
      },
    };
  });
}

async function exerciseTerminalPath(browser, sourcePage, sourceDeviceScaleFactor, mode) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: sourceDeviceScaleFactor,
  });
  const page = await context.newPage();
  try {
    await installTerminalFaultHarness(page);
    await page.goto(sourcePage.url(), { waitUntil: 'load', timeout: renderWaitMs });
    await installBrowserProbes(page);
    const beforeReady = await waitForReady(page, -1, 30000);
    const before = await page.evaluate(() => window.__lucidaTryoutWorkerFaults.snapshot());
    let injected = false;
    let injectedWorkerCount = 0;
    let constructionFailuresInjected = 0;
    if (mode === 'gpu-worker-crash') {
      injected = await page.evaluate(() => window.__lucidaTryoutWorkerFaults.crashGpu());
    } else if (mode === 'gpu-device-loss') {
      injected = await page.evaluate(() => window.__lucidaTryoutWorkerFaults.loseGpuDevice());
    } else if (mode === 'decode-terminal') {
      constructionFailuresInjected = before.decode_active;
      const constructionArmed = await page.evaluate((count) => (
        window.__lucidaTryoutWorkerFaults.failNextConstruction('decode', count)
      ), constructionFailuresInjected);
      injectedWorkerCount += await page.evaluate(() => window.__lucidaTryoutWorkerFaults.crashDecodeRound());
      injected = constructionArmed && injectedWorkerCount >= 2;
    } else {
      throw new Error('unknown terminal fault mode: ' + mode);
    }

    const alert = page.getByRole('alert').filter({
      has: page.getByRole('button', { name: mode === 'decode-terminal' ? 'Reload viewer' : 'Restart renderer' }),
    }).first();
    await alert.waitFor({ state: 'visible', timeout: 10000 });
    const surfaced = await alert.evaluate((element) => ({
      text: element.textContent || '',
      render_error_code: element.getAttribute('data-render-error-code'),
      dataset_error_kind: element.getAttribute('data-dataset-error-kind'),
    }));
    const recoveryButton = alert.getByRole('button', {
      name: mode === 'decode-terminal' ? 'Reload viewer' : 'Restart renderer',
    });
    let constructionFailureSurfaced = null;
    const canvasBeforeRecovery = mode === 'decode-terminal'
      ? null
      : await page.locator('canvas[aria-label$="viewer"]').first().elementHandle();
    if (mode === 'decode-terminal') {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
        recoveryButton.click(),
      ]);
      await installBrowserProbes(page);
    } else {
      if (mode === 'gpu-worker-crash') {
        constructionFailuresInjected = 1;
        await page.evaluate(() => (
          window.__lucidaTryoutWorkerFaults.failNextConstruction('gpu', 1)
        ));
      }
      // The product's capture global intentionally survives a stopped loop.
      // Clear it and retain the old pull-contract identity so only a newly
      // installed loop with a newly presented frame can satisfy recovery.
      await page.evaluate(() => {
        window.__lucidaCaptureReady = undefined;
        window.__lucidaTryoutRuntimeBeforeRecovery = window.__lucidaRenderContract || null;
      });
      await recoveryButton.click();
      if (canvasBeforeRecovery) {
        await page.waitForFunction((element) => !element.isConnected, canvasBeforeRecovery, {
          timeout: 10000,
        });
      }
      if (mode === 'gpu-worker-crash') {
        const constructionAlert = page.getByRole('alert').filter({
          hasText: 'gpu worker construction failure',
        }).first();
        await constructionAlert.waitFor({ state: 'visible', timeout: 10000 });
        constructionFailureSurfaced = {
          text: (await constructionAlert.textContent()) || '',
          recovery_action_visible: await constructionAlert.getByRole('button', {
            name: 'Restart renderer',
          }).isVisible(),
        };
        const failedCanvas = await page.locator('canvas[aria-label$="viewer"]').first().elementHandle();
        await page.evaluate(() => {
          window.__lucidaCaptureReady = undefined;
          window.__lucidaTryoutRuntimeBeforeRecovery = window.__lucidaRenderContract || null;
        });
        await constructionAlert.getByRole('button', { name: 'Restart renderer' }).click();
        if (failedCanvas) {
          await page.waitForFunction((element) => !element.isConnected, failedCanvas, {
            timeout: 10000,
          });
        }
      }
      await page.waitForFunction((createdBefore) => {
        const state = window.__lucidaTryoutWorkerFaults.snapshot();
        return state.gpu_created > createdBefore && state.gpu_active > 0;
      }, before.gpu_created, { timeout: 10000 });
      await page.waitForFunction(() => {
        const capture = window.__lucidaCaptureReady;
        const contract = window.__lucidaRenderContract;
        if (!capture || !capture.ready || Number(capture.frameCount || 0) < 1
          || !contract || contract === window.__lucidaTryoutRuntimeBeforeRecovery) return false;
        const runtime = contract.getSnapshot();
        return runtime.client.frames.presented > 0
          && runtime.client.frames.pending === 0;
      }, undefined, { timeout: 30000 });
    }
    const recovered = await waitForReady(page, -1, 30000);
    // Capture readiness can become true while the freshly installed renderer
    // still has one already-posted frame in flight. Wait for that replacement
    // runtime to drain before recording the terminal-recovery proof; otherwise
    // a healthy reload nondeterministically reports pending=1 on faster arms.
    await page.waitForFunction(() => {
      const contract = window.__lucidaRenderContract;
      const runtime = contract && contract.getSnapshot();
      return Boolean(runtime)
        && Number(runtime.client.frames.presented || 0) > 0
        && Number(runtime.client.frames.pending || 0) === 0;
    }, undefined, { timeout: 30000 });
    const after = await page.evaluate(() => window.__lucidaTryoutWorkerFaults.snapshot());
    const recoveryProof = await page.evaluate((reloaded) => {
      const contract = window.__lucidaRenderContract;
      const runtime = contract ? contract.getSnapshot() : null;
      return {
        runtime_replaced: reloaded
          ? true
          : Boolean(contract && contract !== window.__lucidaTryoutRuntimeBeforeRecovery),
        capture_frame_count: Number(window.__lucidaCaptureReady && window.__lucidaCaptureReady.frameCount || 0),
        presented_frame_count: Number(runtime && runtime.client.frames.presented || 0),
        pending_frame_count: Number(runtime && runtime.client.frames.pending || 0),
      };
    }, mode === 'decode-terminal');
    const workerRecreated = mode === 'decode-terminal'
      ? after.decode_active > 0
      : after.gpu_created > before.gpu_created && after.gpu_active > 0;
    return {
      mode,
      injected,
      injected_worker_count: injectedWorkerCount,
      construction_failures_injected: constructionFailuresInjected,
      construction_failure_surfaced: constructionFailureSurfaced,
      ready_before: Boolean(beforeReady && beforeReady.ready),
      surfaced,
      recovery_action: mode === 'decode-terminal' ? 'Reload viewer' : 'Restart renderer',
      recovered: Boolean(recovered && recovered.ready),
      worker_recreated: workerRecreated,
      alert_cleared: await page.getByRole('alert').count() === 0,
      workers_before: before,
      workers_after: after,
      recovery_proof: recoveryProof,
    };
  } finally {
    await context.close();
  }
}

function terminalPathFailures(receipts) {
  const failures = [];
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const byMode = Object.fromEntries((receipts || []).map((receipt) => [receipt.mode, receipt]));
  for (const mode of ['gpu-worker-crash', 'gpu-device-loss', 'decode-terminal']) {
    const receipt = byMode[mode];
    if (!receipt || !receipt.injected || !receipt.ready_before || !receipt.recovered
      || !receipt.worker_recreated
      || !receipt.alert_cleared || !receipt.surfaced) {
      failures.push(mode + ': terminal failure/recovery receipt did not pass');
      continue;
    }
    const expectedAction = mode === 'decode-terminal' ? 'Reload viewer' : 'Restart renderer';
    if (receipt.recovery_action !== expectedAction) {
      failures.push(mode + ': truthful recovery action was not recorded');
    }
    const recoveryProof = receipt.recovery_proof;
    if (!recoveryProof || !recoveryProof.runtime_replaced
      || !finite(recoveryProof.capture_frame_count) || recoveryProof.capture_frame_count < 1
      || !finite(recoveryProof.presented_frame_count) || recoveryProof.presented_frame_count < 1
      || !finite(recoveryProof.pending_frame_count) || recoveryProof.pending_frame_count !== 0) {
      failures.push(mode + ': replacement did not prove a newly presented frame');
    }
    const before = receipt.workers_before;
    const after = receipt.workers_after;
    if (!before || !after) {
      failures.push(mode + ': raw worker counters were missing');
    } else if (mode === 'decode-terminal') {
      if (!finite(before.decode_active) || before.decode_active < 2
        || !finite(after.decode_active) || after.decode_active < 1) {
        failures.push(mode + ': raw decoder counters contradict recovery');
      }
    } else if (!finite(before.gpu_created) || !finite(after.gpu_created)
      || after.gpu_created <= before.gpu_created
      || !finite(after.gpu_active) || after.gpu_active < 1) {
      failures.push(mode + ': raw GPU worker counters contradict recovery');
    }
    if (mode === 'gpu-worker-crash'
      && (receipt.surfaced.render_error_code !== null
        || !/worker crash/i.test(receipt.surfaced.text))) {
      failures.push(mode + ': worker crash was not independently identified');
    }
    if (mode === 'gpu-worker-crash'
      && (!finite(receipt.construction_failures_injected)
        || receipt.construction_failures_injected !== 1
        || !receipt.construction_failure_surfaced
        || !receipt.construction_failure_surfaced.recovery_action_visible
        || !/construction failure/i.test(receipt.construction_failure_surfaced.text))) {
      failures.push(mode + ': synchronous construction failure was not visibly retryable');
    }
    if (mode === 'gpu-device-loss'
      && (receipt.surfaced.render_error_code !== 'gpu-device-lost'
        || !/device loss/i.test(receipt.surfaced.text))) {
      failures.push(mode + ': device loss was not independently identified');
    }
    if (mode === 'decode-terminal'
      && (receipt.surfaced.dataset_error_kind !== 'data'
        || !/decoding stopped/i.test(receipt.surfaced.text)
        || !/replacement could not start/i.test(receipt.surfaced.text)
        || !finite(receipt.injected_worker_count) || receipt.injected_worker_count < 2
        || !finite(receipt.construction_failures_injected)
        || receipt.construction_failures_injected < 2)) {
      failures.push(mode + ': decode exhaustion was not independently identified');
    }
  }
  return failures;
}

function tryoutWorkspaceRecord(id, name) {
  const now = '2026-07-16T00:00:00Z';
  return {
    id,
    name,
    role: 'owner',
    created_by: 'tryout@example.invalid',
    created_at: now,
    updated_at: now,
    archived_at: null,
    seq: 1,
    default_saved_view_id: null,
    last_opened_at: null,
    pinned_at: null,
  };
}

async function fulfillTryoutFailure(route, detail) {
  await route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail }),
  });
}

async function waitForHeldRoute(page, getRoute, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const route = getRoute();
    if (route) return route;
    await page.waitForTimeout(20);
  }
  throw new Error(label + ' did not reach the harness route');
}

async function exerciseDashboardFailures(browser, sourcePage, sourceDeviceScaleFactor) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: sourceDeviceScaleFactor,
  });
  const page = await context.newPage();
  let listRequests = 0;
  let listMode = 'pass';
  let createRequests = 0;
  let heldCreate = null;
  const syntheticId = 'tryout-recovered-' + sourceDeviceScaleFactor;
  try {
    await page.route('**/api/workspaces**', async (route) => {
      const request = route.request();
      const parsed = new URL(request.url());
      if (parsed.pathname === '/api/workspaces/archived' && request.method() === 'GET'
        && listMode !== 'pass') {
        listRequests += 1;
        if (listMode === 'fail') {
          listMode = 'recover';
          await fulfillTryoutFailure(route, 'tryout injected dashboard load failure');
        } else {
          listMode = 'pass';
          await route.continue();
        }
        return;
      }
      if (parsed.pathname === '/api/workspaces' && request.method() === 'POST') {
        createRequests += 1;
        if (createRequests === 1) {
          await fulfillTryoutFailure(route, 'tryout injected workspace create failure');
        } else {
          heldCreate = route;
        }
        return;
      }
      if (parsed.pathname === '/api/workspaces/' + syntheticId && request.method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(tryoutWorkspaceRecord(syntheticId, 'Recovered workspace')),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(new URL('/', sourcePage.url()).href, {
      waitUntil: 'load',
      timeout: renderWaitMs,
    });
    await page.getByRole('heading', { name: 'Workspaces' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('status').filter({ hasText: 'Active workspaces loaded.' }).waitFor({
      state: 'visible',
      timeout: 10000,
    });
    listMode = 'fail';
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    const loadAlert = page.getByRole('alert').filter({ hasText: 'Could not load archived workspaces.' });
    await loadAlert.waitFor({ state: 'visible', timeout: 10000 });
    const loadRetryVisible = await loadAlert.getByRole('button', { name: 'Retry' }).isVisible();
    await loadAlert.getByRole('button', { name: 'Retry' }).click();
    await page.getByRole('status').filter({ hasText: 'Archived workspaces loaded.' }).waitFor({
      state: 'visible',
      timeout: 10000,
    });
    await page.getByRole('button', { name: 'Active', exact: true }).click();
    const createButton = page.locator('.workspace-dashboard-actions').getByRole('button', {
      name: /^(New Workspace|Creating\.\.\.)$/,
    });
    await createButton.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    await createButton.click();
    const createAlert = page.getByRole('alert').filter({ hasText: 'Could not create the workspace.' });
    await createAlert.waitFor({ state: 'visible', timeout: 10000 });
    const createRetryVisible = await createAlert.getByRole('button', { name: 'Retry' }).isVisible();
    await createAlert.getByRole('button', { name: 'Retry' }).click();
    const pendingRoute = await waitForHeldRoute(page, () => heldCreate, 'dashboard create retry');
    const disabledWhilePending = await createButton.isDisabled();
    await createButton.evaluate((element) => element.click());
    await page.waitForTimeout(50);
    const duplicateBlocked = createRequests === 2;
    await pendingRoute.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(tryoutWorkspaceRecord(syntheticId, 'Recovered workspace')),
    });
    await page.waitForURL('**/w/' + syntheticId, { timeout: 10000 });
    return {
      dashboard_load: {
        failure_visible: true,
        retry_visible: loadRetryVisible,
        request_count: listRequests,
        recovered: true,
      },
      dashboard_create: {
        failure_visible: true,
        retry_visible: createRetryVisible,
        request_count: createRequests,
        disabled_while_pending: disabledWhilePending,
        duplicate_submit_blocked: duplicateBlocked,
        recovered_navigation: page.url().endsWith('/w/' + syntheticId),
      },
    };
  } finally {
    await context.close();
  }
}

async function exerciseWorkspaceOpenFailure(browser, sourcePage, sourceDeviceScaleFactor) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: sourceDeviceScaleFactor,
  });
  const page = await context.newPage();
  const targetWorkspaceId = decodeURIComponent(
    new URL(sourcePage.url()).pathname.replace(/^\/w\//, '').replace(/\/$/, ''),
  );
  const targetApiPath = '/api/workspaces/' + encodeURIComponent(targetWorkspaceId);
  let requests = 0;
  let failOpen = true;
  try {
    await page.route('**/api/workspaces/**', async (route) => {
      const request = route.request();
      if (new URL(request.url()).pathname === targetApiPath
        && request.method() === 'POST') {
        requests += 1;
        if (failOpen) {
          await fulfillTryoutFailure(route, 'tryout injected workspace open failure');
        } else {
          await route.continue();
        }
        return;
      }
      await route.continue();
    });
    await page.goto(sourcePage.url(), { waitUntil: 'load', timeout: renderWaitMs });
    await page.getByTestId('workspace-access-message').waitFor({ state: 'visible', timeout: 10000 });
    const failureRequestCount = requests;
    failOpen = false;
    const retry = page.getByRole('button', { name: 'Retry workspace' });
    const retryVisible = await retry.isVisible();
    await retry.click();
    await page.getByRole('button', { name: 'Workspaces', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    return {
      failure_visible: true,
      retry_visible: retryVisible,
      request_count: requests,
      failure_request_count: failureRequestCount,
      retry_request_delta: requests - failureRequestCount,
      recovered: requests === failureRequestCount + 1,
      stale_failure_cleared: await page.getByTestId('workspace-access-message').count() === 0,
    };
  } finally {
    await context.close();
  }
}

async function exerciseViewerApiFailures(browser, sourcePage, sourceDeviceScaleFactor) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: sourceDeviceScaleFactor,
  });
  const page = await context.newPage();
  const workspaceId = decodeURIComponent(
    new URL(sourcePage.url()).pathname.replace(/^\/w\//, '').replace(/\/$/, ''),
  );
  const workspacePath = '/api/workspaces/' + encodeURIComponent(workspaceId);
  const sharingPath = workspacePath + '/sharing';
  let sharingGetMode = 'pass';
  let sharingLoadRequests = 0;
  let sharingCancelRequests = 0;
  let heldSharingLoads = [];
  let sharingPatchMode = 'pass';
  let sharingMutationRequests = 0;
  let heldSharingMutation = null;
  let renameMode = 'pass';
  let renameRequests = 0;
  let heldRename = null;
  try {
    await page.route('**/api/workspaces/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === sharingPath && request.method() === 'GET') {
        if (sharingGetMode === 'fail') {
          sharingLoadRequests += 1;
          await fulfillTryoutFailure(route, 'tryout injected sharing load failure');
        } else if (sharingGetMode === 'recover') {
          sharingLoadRequests += 1;
          await route.continue();
        } else if (sharingGetMode === 'hold-cancel') {
          sharingCancelRequests += 1;
          heldSharingLoads.push(route);
        } else {
          await route.continue();
        }
        return;
      }
      if (path === sharingPath && request.method() === 'PATCH') {
        sharingMutationRequests += 1;
        if (sharingPatchMode === 'fail') {
          sharingPatchMode = 'hold';
          await fulfillTryoutFailure(route, 'tryout injected sharing mutation failure');
        } else if (sharingPatchMode === 'hold') {
          heldSharingMutation = route;
        } else {
          await route.continue();
        }
        return;
      }
      if (path === workspacePath && request.method() === 'PATCH') {
        renameRequests += 1;
        if (renameMode === 'fail') {
          renameMode = 'hold';
          await fulfillTryoutFailure(route, 'tryout injected rename failure');
        } else if (renameMode === 'hold') {
          heldRename = route;
        } else {
          await route.continue();
        }
        return;
      }
      await route.continue();
    });

    await page.goto(sourcePage.url(), { waitUntil: 'load', timeout: renderWaitMs });
    await waitForReady(page, -1, 30000);
    const shareTrigger = page.getByRole('button', { name: 'Share Workspace' });

    // Sharing load: failure and Retry are distinct from mutation recovery.
    sharingGetMode = 'fail';
    await shareTrigger.click();
    let dialog = page.getByRole('dialog', { name: 'Share Workspace' });
    const loadAlert = dialog.getByRole('alert').filter({ hasText: 'Could not load sharing settings.' });
    await loadAlert.waitFor({ state: 'visible', timeout: 10000 });
    const loadFailureRequestCount = sharingLoadRequests;
    const loadRetryVisible = await loadAlert.getByRole('button', { name: 'Retry' }).isVisible();
    sharingGetMode = 'recover';
    await loadAlert.getByRole('button', { name: 'Retry' }).click();
    await dialog.getByLabel('Link access').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(50);
    sharingGetMode = 'pass';
    const sharingLoad = {
      failure_visible: true,
      retry_visible: loadRetryVisible,
      request_count: sharingLoadRequests,
      failure_request_count: loadFailureRequestCount,
      retry_request_count: sharingLoadRequests - loadFailureRequestCount,
      recovered: sharingLoadRequests > loadFailureRequestCount,
    };
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // Cancel a held load, then release its late response. The closed dialog
    // must stay closed and publish neither stale success nor stale failure.
    sharingGetMode = 'hold-cancel';
    heldSharingLoads = [];
    await shareTrigger.click();
    dialog = page.getByRole('dialog', { name: 'Share Workspace' });
    await waitForHeldRoute(page, () => heldSharingLoads[0] ?? null, 'sharing cancel load');
    await page.waitForTimeout(100);
    const cancelRoutes = [...heldSharingLoads];
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await Promise.all(cancelRoutes.map((route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ link_access: 'restricted', link_role: 'viewer', members: [] }),
      })));
    await page.waitForTimeout(100);
    const sharingCancel = {
      request_count: sharingCancelRequests,
      dialog_closed: await page.getByRole('dialog', { name: 'Share Workspace' }).count() === 0,
      stale_status_suppressed: await page.locator('.workspace-share-operation').count() === 0,
    };

    // Sharing mutation: fail, retry into a held request, prove controls are
    // disabled and a synthetic duplicate event cannot create a third request.
    sharingGetMode = 'pass';
    await shareTrigger.click();
    dialog = page.getByRole('dialog', { name: 'Share Workspace' });
    const linkAccess = dialog.getByLabel('Link access');
    await linkAccess.waitFor({ state: 'visible', timeout: 10000 });
    const originalAccess = await linkAccess.inputValue();
    const nextAccess = originalAccess === 'restricted' ? 'anyone_with_link' : 'restricted';
    sharingPatchMode = 'fail';
    await linkAccess.selectOption(nextAccess);
    const mutationAlert = dialog.getByRole('alert').filter({ hasText: 'Could not update link access.' });
    await mutationAlert.waitFor({ state: 'visible', timeout: 10000 });
    const mutationRetryVisible = await mutationAlert.getByRole('button', { name: 'Retry' }).isVisible();
    await mutationAlert.getByRole('button', { name: 'Retry' }).click();
    const mutationRoute = await waitForHeldRoute(page, () => heldSharingMutation, 'sharing mutation retry');
    const mutationDisabled = await linkAccess.isDisabled();
    await linkAccess.evaluate((element) => element.dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(50);
    const mutationDuplicateBlocked = sharingMutationRequests === 2;
    await mutationRoute.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ link_access: nextAccess, link_role: 'viewer', members: [] }),
    });
    await dialog.getByRole('status').filter({ hasText: 'Link access updated.' }).waitFor({
      state: 'visible',
      timeout: 10000,
    });
    const sharingMutation = {
      failure_visible: true,
      retry_visible: mutationRetryVisible,
      request_count: sharingMutationRequests,
      disabled_while_pending: mutationDisabled,
      duplicate_submit_blocked: mutationDuplicateBlocked,
      recovered: await linkAccess.inputValue() === nextAccess,
    };
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // Rename uses the same latest-operation primitive but a distinct action
    // key. Verify its success announcement and no-double-submit boundary live.
    const nameInput = page.getByRole('textbox', { name: 'Workspace name' });
    const nextName = 'Tryout recovered DPR' + sourceDeviceScaleFactor;
    renameMode = 'fail';
    await nameInput.fill(nextName);
    await nameInput.blur();
    const renameAlert = page.getByRole('alert').filter({ hasText: 'Workspace name was not saved.' });
    await renameAlert.waitFor({ state: 'visible', timeout: 10000 });
    const renameRetryVisible = await renameAlert.getByRole('button', { name: 'Retry' }).isVisible();
    await renameAlert.getByRole('button', { name: 'Retry' }).click();
    const renameRoute = await waitForHeldRoute(page, () => heldRename, 'workspace rename retry');
    const renameDisabled = await nameInput.isDisabled();
    await nameInput.evaluate((element) => element.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await page.waitForTimeout(50);
    const renameDuplicateBlocked = renameRequests === 2;
    await renameRoute.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tryoutWorkspaceRecord(workspaceId, nextName)),
    });
    const renameSuccess = page.getByRole('status').filter({ hasText: 'Workspace renamed to ' + nextName + '.' });
    await renameSuccess.waitFor({ state: 'visible', timeout: 10000 });
    const rename = {
      failure_visible: true,
      retry_visible: renameRetryVisible,
      request_count: renameRequests,
      disabled_while_pending: renameDisabled,
      duplicate_submit_blocked: renameDuplicateBlocked,
      success_announced: true,
      recovered: await nameInput.inputValue() === nextName,
    };

    return { sharing_load: sharingLoad, sharing_cancel: sharingCancel, sharing_mutation: sharingMutation, rename };
  } finally {
    await context.close();
  }
}

async function exerciseTransportFailure(browser, sourcePage, sourceDeviceScaleFactor) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: sourceDeviceScaleFactor,
  });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const sockets = [];
      let datasetOpenFrames = 0;
      let closeEvents = 0;
      let snapshotFrames = 0;
      class HarnessObservedWebSocket extends NativeWebSocket {
        constructor(socketUrl, protocols) {
          if (protocols === undefined) super(socketUrl);
          else super(socketUrl, protocols);
          sockets.push(this);
          this.addEventListener('close', () => { closeEvents += 1; });
          this.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            try {
              if (JSON.parse(event.data).type === 'snapshot') snapshotFrames += 1;
            } catch (_) {}
          });
        }
        send(data) {
          if (typeof data === 'string') {
            try {
              if (JSON.parse(data).type === 'open_remote_dataset') datasetOpenFrames += 1;
            } catch (_) {}
          }
          return super.send(data);
        }
      }
      window.WebSocket = HarnessObservedWebSocket;
      window.__lucidaTryoutTransportFaults = {
        closeLatest() {
          const socket = [...sockets].reverse().find((item) => item.readyState === NativeWebSocket.OPEN);
          if (!socket) return false;
          // Browser clients may send only 1000 or application codes 3000-4999.
          // 4012 preserves the injected-reconnect identity without Chromium's
          // InvalidAccessError aborting the acceptance path.
          socket.close(4012, 'tryout injected reconnect');
          return true;
        },
        snapshot() {
          return {
            sockets_created: sockets.length,
            open_sockets: sockets.filter((item) => item.readyState === NativeWebSocket.OPEN).length,
            dataset_open_frames: datasetOpenFrames,
            close_events: closeEvents,
            snapshot_frames: snapshotFrames,
          };
        },
      };
    });
    await page.goto(sourcePage.url(), { waitUntil: 'load', timeout: renderWaitMs });
    await waitForReady(page, -1, 30000);
    const before = await page.evaluate(() => window.__lucidaTryoutTransportFaults.snapshot());
    const injected = await page.evaluate(() => window.__lucidaTryoutTransportFaults.closeLatest());
    await page.waitForFunction((closedBefore) => (
      window.__lucidaTryoutTransportFaults.snapshot().close_events > closedBefore
    ), before.close_events, { timeout: 10000 });
    const input = page.getByLabel('Dataset URL or path');
    const missing = 'file:///__lucida_tryout_transport_recovery_dpr'
      + sourceDeviceScaleFactor + '.ome.zarr';
    await input.fill(missing);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const transportAlert = page.getByRole('alert').filter({ hasText: 'workspace connection is not ready' });
    await transportAlert.waitFor({ state: 'visible', timeout: 10000 });
    const afterRejectedSend = await page.evaluate(() => window.__lucidaTryoutTransportFaults.snapshot());
    await page.waitForFunction((snapshotsBefore) => {
      const state = window.__lucidaTryoutTransportFaults.snapshot();
      return state.open_sockets > 0 && state.snapshot_frames > snapshotsBefore;
    }, before.snapshot_frames, { timeout: 15000 });
    const retry = transportAlert.getByRole('button', { name: 'Retry dataset' });
    const retryVisible = await retry.isVisible();
    await retry.click();
    await page.waitForFunction(() => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
      return alerts.some((element) => /Retry dataset/.test(element.textContent || '')
        && !/workspace connection is not ready/.test(element.textContent || ''));
    }, undefined, { timeout: 15000 });
    const recoveredAttemptAlert = page.getByRole('alert').filter({
      has: page.getByRole('button', { name: 'Retry dataset' }),
    }).last();
    const recoveredAttemptText = (await recoveredAttemptAlert.textContent()) || '';
    const afterRetry = await page.evaluate(() => window.__lucidaTryoutTransportFaults.snapshot());
    await recoveredAttemptAlert.getByRole('button', { name: 'Dismiss' }).click();
    return {
      injected,
      failure_visible: true,
      retry_visible: retryVisible,
      rejected_send_frame_delta: afterRejectedSend.dataset_open_frames - before.dataset_open_frames,
      retry_send_frame_delta: afterRetry.dataset_open_frames - afterRejectedSend.dataset_open_frames,
      reconnect_created_socket: afterRetry.sockets_created > before.sockets_created,
      recovery_attempt_reached_server: !recoveredAttemptText.includes('connection is not ready'),
      dismissed: await page.getByRole('alert').count() === 0,
    };
  } finally {
    await context.close();
  }
}

function asyncFailureContractFailures(contract) {
  const failures = [];
  for (const name of ['dashboard_load']) {
    const receipt = contract && contract[name];
    if (!receipt || !receipt.failure_visible || !receipt.retry_visible
      || receipt.request_count !== 2 || !receipt.recovered) {
      failures.push(name + ': failure/retry receipt did not pass');
    }
  }
  const workspaceOpen = contract && contract.workspace_open;
  if (!workspaceOpen || !workspaceOpen.failure_visible || !workspaceOpen.retry_visible
    || ![1, 2].includes(workspaceOpen.failure_request_count)
    || workspaceOpen.retry_request_delta !== 1
    || workspaceOpen.request_count !== workspaceOpen.failure_request_count + 1
    || !workspaceOpen.recovered || !workspaceOpen.stale_failure_cleared) {
    failures.push('workspace_open: failure/retry/stale receipt did not pass');
  }
  const sharingLoad = contract && contract.sharing_load;
  if (!sharingLoad || !sharingLoad.failure_visible || !sharingLoad.retry_visible
    || ![1, 2].includes(sharingLoad.failure_request_count)
    || ![1, 2].includes(sharingLoad.retry_request_count)
    || sharingLoad.request_count !== sharingLoad.failure_request_count + sharingLoad.retry_request_count
    || !sharingLoad.recovered) {
    failures.push('sharing_load: failure/retry receipt did not pass');
  }
  for (const name of ['dashboard_create', 'sharing_mutation', 'rename']) {
    const receipt = contract && contract[name];
    const recovered = name === 'dashboard_create'
      ? receipt && receipt.recovered_navigation
      : receipt && receipt.recovered;
    if (!receipt || !receipt.failure_visible || !receipt.retry_visible
      || receipt.request_count !== 2 || !receipt.disabled_while_pending
      || !receipt.duplicate_submit_blocked || !recovered) {
      failures.push(name + ': mutation/no-double-submit receipt did not pass');
    }
  }
  if (!contract || !contract.rename || !contract.rename.success_announced) {
    failures.push('rename: accessible success announcement was missing');
  }
  if (!contract || !contract.sharing_cancel
    || ![1, 2].includes(contract.sharing_cancel.request_count)
    || !contract.sharing_cancel.dialog_closed
    || !contract.sharing_cancel.stale_status_suppressed) {
    failures.push('sharing_cancel: late completion was not suppressed after cancel');
  }
  const transport = contract && contract.transport;
  if (!transport || !transport.injected || !transport.failure_visible || !transport.retry_visible
    || transport.rejected_send_frame_delta !== 0 || transport.retry_send_frame_delta !== 1
    || !transport.reconnect_created_socket || !transport.recovery_attempt_reached_server
    || !transport.dismissed) {
    failures.push('transport: disconnect/reconnect recovery receipt did not pass');
  }
  return failures;
}

async function exerciseFirstRun(context, sourcePage, datasetPath, screenshotPath, requiredChannelCount) {
  if (!datasetPath) return { requested: false, ok: true, reason: 'dataset path not supplied' };
  const firstRun = await context.newPage();
  const browserEvents = [];
  const recordEvent = (kind, detail = {}) => {
    if (browserEvents.length >= 500) return;
    browserEvents.push({ event_index: browserEvents.length, at_ms: Date.now(), kind, ...detail });
  };
  const frameSummary = (event) => {
    const payload = event && event.payload;
    const byteLength = typeof payload === 'string'
      ? payload.length
      : Number(payload && payload.length || 0);
    if (typeof payload !== 'string') return { byte_length: byteLength, message_type: 'binary' };
    try {
      const message = JSON.parse(payload);
      return {
        byte_length: byteLength,
        message_type: message && message.type || 'json',
        request_id: typeof (message && message.request_id) === 'string'
          ? message.request_id : null,
        source_url: typeof (message && message.url) === 'string' ? message.url : null,
        sequence: typeof (message && message.seq) === 'number'
          && Number.isFinite(message.seq) ? message.seq : null,
        opened_dataset_id: message && message.opened && message.opened.manifest
          && typeof message.opened.manifest.dataset_id === 'string'
          ? message.opened.manifest.dataset_id : null,
        summary_dataset_id: message && message.summary
          && typeof message.summary.workspace_dataset_id === 'string'
          ? message.summary.workspace_dataset_id : null,
      };
    } catch (_) {
      return { byte_length: byteLength, message_type: 'text' };
    }
  };
  firstRun.on('console', (message) => {
    recordEvent('console', {
      level: message.type(),
      text: message.text().slice(0, 1000),
    });
  });
  firstRun.on('pageerror', (error) => {
    recordEvent('pageerror', { text: String(error && error.message || error).slice(0, 1000) });
  });
  firstRun.on('requestfailed', (request) => {
    recordEvent('requestfailed', {
      url: request.url(),
      error: request.failure() && request.failure().errorText,
    });
  });
  let nextSocketId = 1;
  firstRun.on('websocket', (socket) => {
    const socketId = nextSocketId++;
    recordEvent('websocket-open', { socket_id: socketId, url: socket.url() });
    socket.on('framesent', (event) => recordEvent(
      'websocket-frame-sent',
      { socket_id: socketId, ...frameSummary(event) },
    ));
    socket.on('framereceived', (event) => recordEvent(
      'websocket-frame-received',
      { socket_id: socketId, ...frameSummary(event) },
    ));
    socket.on('socketerror', (error) => recordEvent('websocket-error', {
      socket_id: socketId,
      text: String(error).slice(0, 1000),
    }));
    socket.on('close', () => recordEvent('websocket-close', {
      socket_id: socketId,
      url: socket.url(),
    }));
  });
  let stage = 'dashboard-load';
  let dashboardResponsive = false;
  let opened = null;
  const failureReceipt = async (reason) => {
    const readiness = await firstRun.evaluate(readyProbe).catch(() => null);
    const uiState = await firstRun.evaluate(() => ({
      url: location.href,
      title: document.title,
      alerts: Array.from(document.querySelectorAll('[role="alert"]'))
        .map((element) => element.textContent.trim()).filter(Boolean),
      statuses: Array.from(document.querySelectorAll('[role="status"]'))
        .map((element) => element.textContent.trim()).filter(Boolean),
      buttons: Array.from(document.querySelectorAll('button'))
        .map((element) => ({
          name: element.getAttribute('aria-label') || element.textContent.trim(),
          disabled: element.disabled,
        })),
      dimension_controls: Array.from(document.querySelectorAll('.dimension-controls input'))
        .map((element) => ({ label: element.getAttribute('aria-label'), value: element.value })),
      main_content: (() => {
        const element = document.querySelector('.main-content');
        return element ? {
          scroll_top: element.scrollTop,
          client_height: element.clientHeight,
          scroll_height: element.scrollHeight,
        } : null;
      })(),
    })).catch(() => null);
    await firstRun.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    return {
      requested: true,
      ok: false,
      stage,
      reason,
      required_channel_count: requiredChannelCount,
      channel_navigation_required: requiredChannelCount > 1,
      fixture_channel_count: 0,
      dashboard_responsive: dashboardResponsive,
      workspace_created: /\/w\//.test(firstRun.url()),
      dataset_opened: false,
      next_channel_enabled: false,
      navigation_changed_channel_exactly: false,
      navigation_baseline_frame: null,
      rendered_frame_after: null,
      rendered_channel_wait_matched: false,
      canvas_digest_before: null,
      canvas_digest_after: null,
      canvas_pixels_changed: false,
      sharing_dialog_opened: false,
      sharing_focus_wait: null,
      sharing_initial_focus_on_close: false,
      sharing_initial_focus_visible: false,
      sharing_focus_appearance: null,
      sharing_focus_restore_wait: null,
      sharing_focus_restored: false,
      sharing_focus_contract: false,
      sharing_link_action: { updated: false },
      seed_open_transport: { matched: false },
      axe: [],
      readiness: readiness || opened,
      ui_state: uiState,
      browser_events: browserEvents,
      screenshot: screenshotPath,
    };
  };
  try {
    const origin = new URL(sourcePage.url()).origin;
    await firstRun.setViewportSize({ width: 390, height: 844 });
    await firstRun.goto(origin + '/', { waitUntil: 'load', timeout: renderWaitMs });
    await firstRun.getByRole('heading', { name: 'Workspaces' }).waitFor({ state: 'visible', timeout: 15000 });
    const createInput = firstRun.getByLabel('New workspace from dataset URL or path');
    const createButton = firstRun.getByRole('button', { name: 'Create from URL' });
    dashboardResponsive = await firstRun.evaluate(() => {
      const input = document.querySelector('[aria-label="New workspace from dataset URL or path"]');
      const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent.trim() === 'Create from URL');
      const reachable = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth
          && rect.top >= 0 && rect.bottom <= innerHeight
          && (top === element || element.contains(top));
      };
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        && reachable(input) && reachable(button);
    });
    stage = 'workspace-navigation';
    await createInput.fill(datasetPath);
    await createButton.click();
    await firstRun.waitForURL(/\/w\//, { timeout: 30000 });
    stage = 'dataset-readiness';
    opened = await waitForReady(firstRun, -1, Math.min(renderWaitMs, 30000));
    if (!opened || !opened.ready || Number(opened.dataset_count || 0) <= 0) {
      return await failureReceipt('fresh workspace did not render its seeded dataset within 30 seconds');
    }
    stage = 'channel-controls';
    const nextChannel = firstRun.getByRole('button', { name: 'Next C' });
    const channelSlider = firstRun.locator('input[type="range"][aria-label="C index"]');
    if (await nextChannel.count() !== 1 || await channelSlider.count() !== 1) {
      return await failureReceipt('seeded dataset rendered without exactly one semantic C navigator');
    }
    const readChannel = () => channelSlider.evaluate((element) => Number(element.value));
    const beforeChannel = await readChannel();
    const channelCounts = (opened && Array.isArray(opened.datasets) ? opened.datasets : [])
      .flatMap((dataset) => Array.isArray(dataset.channelCounts) ? dataset.channelCounts : [])
      .filter((count) => Number.isFinite(Number(count)))
      .map(Number);
    const fixtureChannelCount = Math.max(0, ...channelCounts);
    const nextChannelEnabled = await nextChannel.isEnabled();
    const expectedChannel = beforeChannel + 1;
    const navigationBaseline = await firstRun.evaluate(readyProbe);
    const navigationBaselineFrame = Number(navigationBaseline && navigationBaseline.frame_count || 0);
    const canvasDigestBefore = await renderedCanvasDigest(firstRun);
    stage = 'channel-navigation';
    if (nextChannelEnabled) await nextChannel.click();
    const navigationDeadline = Date.now() + 10000;
    let afterChannel = await readChannel();
    while (nextChannelEnabled && afterChannel !== expectedChannel && Date.now() < navigationDeadline) {
      await firstRun.waitForTimeout(50);
      afterChannel = await readChannel();
    }
    const navigated = nextChannelEnabled
      ? await waitForRenderedChannel(firstRun, navigationBaselineFrame, expectedChannel, 30000)
      : null;
    const renderedChannel = navigated && navigated.view ? Number(navigated.view.c) : null;
    const renderedLayerChannel = navigated && navigated.view && Array.isArray(navigated.view.layers)
      && navigated.view.layers[0] ? Number(navigated.view.layers[0].channel) : null;
    const canvasDigestAfter = await renderedCanvasDigest(firstRun);
    stage = 'sharing-dialog';
    const share = firstRun.getByRole('button', { name: 'Share Workspace' });
    await share.focus();
    await share.press('Enter');
    const dialog = firstRun.getByRole('dialog', { name: 'Share Workspace' });
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await dialog.getByText('Link access', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const close = dialog.getByRole('button', { name: 'Close' });
    stage = 'sharing-focus';
    const sharingFocusWait = await waitForFocusInside(
      firstRun,
      'first-run.sharing-dialog-initial-focus',
      '[role="dialog"][aria-labelledby="workspace-share-title"]',
      '.workspace-share-header button',
    );
    const focusedClose = await close.evaluate((element) => document.activeElement === element);
    const sharingFocusVisible = await focusAppearance(close);
    const linkAccess = dialog.getByLabel('Link access');
    const linkAccessBefore = await linkAccess.inputValue();
    await linkAccess.selectOption('anyone_with_link');
    await dialog.getByRole('status').filter({ hasText: 'Link access updated.' }).waitFor({
      state: 'visible',
      timeout: 10000,
    });
    const linkAccessAfter = await linkAccess.inputValue();
    const sharingFocusCycle = await exerciseDialogFocusCycle(firstRun, dialog);
    const sharingAxe = await runAxe(firstRun, 'sharing-dialog-open');
    await firstRun.screenshot({ path: screenshotPath, fullPage: true });
    await firstRun.keyboard.press('Escape');
    const sharingFocusRestoreWait = await waitForLocatorFocus(
      firstRun,
      share,
      'first-run.sharing-dialog-focus-restored',
    );
    const focusRestored = sharingFocusRestoreWait.wait_passed;
    const sentSeedOpen = browserEvents.find((event) =>
      event.kind === 'websocket-frame-sent'
      && event.message_type === 'open_remote_dataset'
      && typeof event.request_id === 'string'
      && event.request_id.length > 0
    ) || null;
    const receivedSeedOpen = sentSeedOpen ? browserEvents.find((event) =>
      event.kind === 'websocket-frame-received'
      && event.message_type === 'open_dataset_succeeded'
      && event.socket_id === sentSeedOpen.socket_id
      && event.request_id === sentSeedOpen.request_id
      && event.event_index > sentSeedOpen.event_index
      && Number.isFinite(event.sequence)
      && event.sequence >= 1
      && typeof event.opened_dataset_id === 'string'
      && event.opened_dataset_id.length > 0
      && event.opened_dataset_id === event.summary_dataset_id
    ) || null : null;
    const seedOpenTransport = {
      matched: Boolean(sentSeedOpen && receivedSeedOpen),
      socket_id: sentSeedOpen && sentSeedOpen.socket_id,
      request_id: sentSeedOpen && sentSeedOpen.request_id,
      source_url: sentSeedOpen && sentSeedOpen.source_url,
      sent_event_index: sentSeedOpen && sentSeedOpen.event_index,
      success_event_index: receivedSeedOpen && receivedSeedOpen.event_index,
      success_sequence: receivedSeedOpen && receivedSeedOpen.sequence,
      opened_dataset_id: receivedSeedOpen && receivedSeedOpen.opened_dataset_id,
    };
    const result = {
      requested: true,
      stage: 'complete',
      required_channel_count: requiredChannelCount,
      channel_navigation_required: requiredChannelCount > 1,
      fixture_channel_count: fixtureChannelCount,
      dashboard_responsive: dashboardResponsive,
      workspace_created: /\/w\//.test(firstRun.url()),
      dataset_opened: Boolean(opened && opened.ready && Number(opened.dataset_count || 0) > 0),
      next_channel_enabled: nextChannelEnabled,
      channel_before: beforeChannel,
      expected_channel_after: expectedChannel,
      channel_after: afterChannel,
      navigation_baseline_frame: navigationBaselineFrame,
      rendered_frame_after: navigated ? Number(navigated.frame_count || 0) : null,
      rendered_channel_wait_matched: Boolean(navigated && navigated.expected_channel_matched),
      canvas_digest_before: canvasDigestBefore,
      canvas_digest_after: canvasDigestAfter,
      canvas_pixels_changed: Boolean(canvasDigestBefore && canvasDigestAfter
        && canvasDigestBefore !== canvasDigestAfter),
      rendered_channel_after: renderedChannel,
      rendered_layer_channel_after: renderedLayerChannel,
      navigation_changed_channel_exactly: nextChannelEnabled
        && afterChannel === expectedChannel
        && Boolean(navigated && navigated.expected_channel_matched)
        && renderedChannel === expectedChannel
        && renderedLayerChannel === expectedChannel,
      sharing_dialog_opened: true,
      sharing_focus_wait: sharingFocusWait,
      sharing_initial_focus_on_close: focusedClose,
      sharing_initial_focus_visible: sharingFocusVisible.visible,
      sharing_focus_appearance: sharingFocusVisible,
      sharing_focus_restore_wait: sharingFocusRestoreWait,
      sharing_focus_restored: focusRestored,
      sharing_focus_contract: sharingFocusWait.wait_passed
        && focusedClose && sharingFocusVisible.visible && focusRestored
        && sharingFocusCycle.initial_inside && sharingFocusCycle.initial_index >= 0
        && sharingFocusCycle.cycle_start_inside && sharingFocusCycle.cycle_start_index >= 0
        && sharingFocusCycle.forward_full_cycle_inside
        && sharingFocusCycle.backward_full_cycle_inside,
      sharing_focus_cycle: sharingFocusCycle,
      sharing_link_action: {
        before: linkAccessBefore,
        after: linkAccessAfter,
        updated: linkAccessBefore === 'restricted' && linkAccessAfter === 'anyone_with_link',
        status: 'Link access updated.',
      },
      seed_open_transport: seedOpenTransport,
      browser_events: browserEvents,
      axe: [sharingAxe],
      screenshot: screenshotPath,
    };
    result.ok = result.dashboard_responsive && result.workspace_created && result.dataset_opened
      && result.fixture_channel_count >= result.required_channel_count
      && result.seed_open_transport.matched
      && (!result.channel_navigation_required
        || (result.next_channel_enabled && result.navigation_changed_channel_exactly))
      && (!result.channel_navigation_required || result.canvas_pixels_changed)
      && result.sharing_dialog_opened && result.sharing_focus_contract
      && result.sharing_link_action.updated
      && result.axe.every((audit) => audit.violations.length === 0);
    return result;
  } catch (error) {
    return await failureReceipt(
      String(error && error.message ? error.message : error).split('\n')[0],
    );
  } finally {
    await firstRun.close();
  }
}

(async () => {
  const messages = [];
  const pageErrors = [];
  const requestFailures = [];
  const datasetTerminals = [];
  let browser = null;
  const browserArgs = req.browser_args;
  if (!Array.isArray(browserArgs) || browserArgs.length === 0) {
    out({ captured: false, reason: 'browser_launch_args_missing' });
    process.exit(0);
  }
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: exe,
      args: browserArgs,
    });
  } catch (e) {
    out({ captured: false, reason: 'browser_launch_failed: ' + String(e).split('\n')[0] });
    process.exit(0);
  }

  try {
    if (deviceScaleFactor !== 1 && deviceScaleFactor !== 2) {
      throw new Error('device_scale_factor must be exactly 1 or 2');
    }
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const nativeRequest = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      const pending = new Set();
      const activeIntervals = new Set();
      window.__lucidaTryoutRafPending = pending;
      window.__lucidaTryoutRafTelemetry = { requested: 0, fired: 0, cancelled: 0 };
      window.__lucidaTryoutIntervalTelemetry = {
        requested: 0,
        fired: 0,
        cleared: 0,
        callback_duration_ms: 0,
        active: activeIntervals,
      };
      window.requestAnimationFrame = (callback) => {
        window.__lucidaTryoutRafTelemetry.requested += 1;
        let id = 0;
        id = nativeRequest((timestamp) => {
          pending.delete(id);
          window.__lucidaTryoutRafTelemetry.fired += 1;
          callback(timestamp);
        });
        pending.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        if (pending.delete(id)) window.__lucidaTryoutRafTelemetry.cancelled += 1;
        nativeCancel(id);
      };
      window.setInterval = (callback, delay, ...args) => {
        window.__lucidaTryoutIntervalTelemetry.requested += 1;
        let id = 0;
        const measured = typeof callback === 'function'
          ? (...callbackArgs) => {
            window.__lucidaTryoutIntervalTelemetry.fired += 1;
            const started = performance.now();
            try {
              return callback(...callbackArgs);
            } finally {
              window.__lucidaTryoutIntervalTelemetry.callback_duration_ms
                += performance.now() - started;
            }
          }
          : callback;
        id = nativeSetInterval(measured, delay, ...args);
        activeIntervals.add(id);
        return id;
      };
      window.clearInterval = (id) => {
        if (activeIntervals.delete(id)) window.__lucidaTryoutIntervalTelemetry.cleared += 1;
        nativeClearInterval(id);
      };
    });
    // Capture fatal diagnostics from the main page and every isolated
    // acceptance profile into one arm-level result and console artifact.
    const diagnostics = { messages, pageErrors, requestFailures, datasetTerminals };
    attachAcceptanceDiagnostics(page, diagnostics);

    await page.goto(url, { waitUntil: 'load', timeout: renderWaitMs });
    await installBrowserProbes(page);

    // Poll the product readiness probe until the viewer has rendered the dataset.
    let probe = null;
    const deadline = Date.now() + renderWaitMs;
    while (Date.now() < deadline) {
      probe = await page.evaluate(readyProbe);
      if (probe && probe.ready) break;
      await page.waitForTimeout(250);
    }

    const rendered = Boolean(probe && probe.ready);
    let frameAdvanced = false;
    let initialViewportPresentation = null;
    if (rendered) {
      // Prove a durable intermediate viewport and its GPU presentation before
      // restoring. Back-to-back CDP metric updates can be coalesced to the
      // original size and falsely look like an unresponsive renderer.
      initialViewportPresentation = await exerciseInitialViewportPresentation(
        page,
        width,
        height,
        Math.min(renderWaitMs, 30000),
      );
      frameAdvanced = initialViewportPresentation.passed;
      probe = initialViewportPresentation.restored.ready;
    }

    const contractFailures = [];
    const browserContract = {
      runtime: null,
      initial_viewport_presentation: initialViewportPresentation,
      fixture_capabilities: {
        collection_1x12_required: requireCollection1x12,
      },
      dashboard: null,
      layouts: [],
      initial_zero_size_recovery: [],
      zero_size_recovery: [],
      overlays: null,
      error_placement: null,
      async_failures: { executed: false, reason: 'DPR2-only acceptance', receipts: {} },
      terminal_paths: { executed: false, reason: 'DPR2-only acceptance', receipts: [] },
      keyboard: null,
      idle: null,
      canvas_isolation: null,
      final_canvas_settlement: null,
      axe: [],
      first_run: { requested: false, ok: true, reason: 'DPR2-only acceptance' },
    };
    if (rendered && frameAdvanced) {
      browserContract.runtime = await renderRuntimeSnapshot(page);
      if (!browserContract.runtime || browserContract.runtime.version !== 1) {
        contractFailures.push('renderer runtime contract version 1 was unavailable');
      }
      browserContract.canvas_isolation = await exerciseCanvasIsolationContract(context);
      contractFailures.push(...canvasIsolationFailures(browserContract.canvas_isolation));
      browserContract.dashboard = await exerciseDashboardContract(context, page);
      contractFailures.push(...browserContract.dashboard.failures);
      await ensureViewMode(page, '2d');
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      browserContract.layouts.push(await captureLayoutProbe(page, 'desktop-1280x720'));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      browserContract.layouts.push(await captureLayoutProbe(page, 'mobile-390x844'));
      for (const layout of browserContract.layouts) contractFailures.push(...layoutFailures(layout));

      await page.setViewportSize({ width: 1280, height: 720 });
      browserContract.initial_zero_size_recovery.push(
        await initialZeroSizeRecovery(context, page, '2d'),
      );
      browserContract.initial_zero_size_recovery.push(
        await initialZeroSizeRecovery(context, page, '3d'),
      );
      for (const recovery of browserContract.initial_zero_size_recovery) {
        contractFailures.push(...initialZeroSizeFailures(recovery));
      }
      browserContract.zero_size_recovery.push(await zeroSizeRecovery(page, '2d'));
      browserContract.zero_size_recovery.push(await zeroSizeRecovery(page, '3d'));
      for (const recovery of browserContract.zero_size_recovery) {
        if (recovery.contract_version !== 1 || !recovery.settled_before) {
          contractFailures.push(recovery.mode + ': renderer did not settle before 0x0 collapse');
        }
        if (!recovery.collapsed_to_zero) contractFailures.push(recovery.mode + ': canvas did not reach a 0x0 collapsed state');
        if (!recovery.collapsed_suppressed || !recovery.collapsed_invalid_not_forwarded) {
          contractFailures.push(recovery.mode + ': collapsed invalid surface reached the worker boundary');
        }
        if (!recovery.restored_finite_positive || !recovery.restored_forwarded_positive) {
          contractFailures.push(recovery.mode + ': canvas did not restore finite positive forwarded geometry');
        }
        if (!recovery.frame_advanced) contractFailures.push(recovery.mode + ': renderer did not present after 0x0 restoration');
      }
      await ensureViewMode(page, '2d');

      browserContract.overlays = await exerciseOverlayContract(
        page,
        browser,
        deviceScaleFactor,
        diagnostics,
      );
      contractFailures.push(...overlayFailures(
        browserContract.overlays,
        requireCollection1x12,
      ));
      browserContract.error_placement = await exerciseErrorPlacement(page, deviceScaleFactor);
      contractFailures.push(...errorPlacementFailures(browserContract.error_placement));
      if (deviceScaleFactor === 2) {
        const dashboardFailures = await exerciseDashboardFailures(
          browser,
          page,
          deviceScaleFactor,
        );
        const workspaceOpen = await exerciseWorkspaceOpenFailure(
          browser,
          page,
          deviceScaleFactor,
        );
        const viewerApiFailures = await exerciseViewerApiFailures(
          browser,
          page,
          deviceScaleFactor,
        );
        const transport = await exerciseTransportFailure(
          browser,
          page,
          deviceScaleFactor,
        );
        const asyncReceipts = {
          ...dashboardFailures,
          workspace_open: workspaceOpen,
          ...viewerApiFailures,
          transport,
        };
        browserContract.async_failures = {
          executed: true,
          reason: null,
          receipts: asyncReceipts,
        };
        contractFailures.push(...asyncFailureContractFailures(asyncReceipts));

        const terminalReceipts = [];
        for (const mode of ['gpu-worker-crash', 'gpu-device-loss', 'decode-terminal']) {
          terminalReceipts.push(
            await exerciseTerminalPath(browser, page, deviceScaleFactor, mode),
          );
        }
        browserContract.terminal_paths = {
          executed: true,
          reason: null,
          receipts: terminalReceipts,
        };
        contractFailures.push(...terminalPathFailures(terminalReceipts));
      }
      browserContract.keyboard = await exerciseKeyboardContract(page, focusFailurePng);
      contractFailures.push(...keyboardFailures(browserContract.keyboard));
      browserContract.idle = await exerciseIdleContract(page);
      contractFailures.push(...idleFailures(browserContract.idle));

      await page.setViewportSize({ width: 1280, height: 720 });
      browserContract.axe.push(await runAxe(page, 'desktop-1280x720'));
      await page.setViewportSize({ width: 390, height: 844 });
      browserContract.axe.push(await runAxe(page, 'mobile-390x844'));
      for (const audit of browserContract.axe) {
        contractFailures.push(...axeFailures(audit));
      }

      if (deviceScaleFactor === 2) {
        browserContract.first_run = await exerciseFirstRun(
          context,
          page,
          firstRunDatasetPath,
          firstRunPng,
          firstRunRequiredChannels,
        );
        if (browserContract.first_run.requested && !browserContract.first_run.ok) {
          contractFailures.push('first-run workspace/dataset/navigation/sharing flow failed');
        }
      }
      await page.setViewportSize({ width, height });
      await ensureViewMode(page, '2d');
      probe = await waitForReady(page, -1, 30000);
      browserContract.final_canvas_settlement = await waitForFinalCanvasSettlement(page);
      if (!browserContract.final_canvas_settlement.passed) {
        contractFailures.push(
          'final isolated canvas did not settle after viewport and mode restoration',
        );
      }
      probe = await waitForReady(page, -1, 30000);
    }

    // Capture both the full page (human diagnosis) and the canvas element
    // (content gate). A colorful application shell cannot hide a black viewer.
    await page.screenshot({ path: spaPng, fullPage: true });
    await capturePrimaryCanvas(page, { path: canvasPng });

    try { fs.writeFileSync(consoleLog, messages.join('\n') + '\n'); } catch (_) {}

    const gpuFailures = messages.filter((message) =>
      /device\s*(was\s*)?lost|gpu[^\n]*(out of memory|validation\s*error)|gpuvalidationerror|uncaptured\s*(webgpu\s*)?error|uncapturederror|webgpu[^\n]*fatal/i.test(message)
    );
    const runtimeFailures = pageErrors.map((message) => 'page error: ' + message);
    const allContractFailures = [...contractFailures, ...runtimeFailures];
    out({
      captured: true,
      rendered,
      frame_advanced: frameAdvanced,
      reason: !rendered
        ? ('captured_not_ready: ' + (probe ? probe.reason : 'unknown'))
        : (!frameAdvanced
          ? ('initial_viewport_presentation_failed:'
            + (initialViewportPresentation && initialViewportPresentation.failed_stage || 'unknown'))
          : (gpuFailures.length ? 'gpu_failure' : (runtimeFailures.length ? 'page_error' : 'rendered'))),
      console_messages: messages.length,
      gpu_failures: gpuFailures,
      runtime_failures: runtimeFailures,
      request_failures: requestFailures,
      contract_failures: allContractFailures,
      browser_contract: browserContract,
      render: probe || null,
      url,
      device_scale_factor: deviceScaleFactor,
    });
  } catch (e) {
    // Still try to flush the console log we gathered before failing.
    try { fs.writeFileSync(consoleLog, messages.join('\n') + '\n'); } catch (_) {}
    const diagnostic = String(e && e.stack ? e.stack : e);
    out({
      captured: false,
      reason: 'spa_capture_failed: ' + String(e).split('\n')[0],
      diagnostic,
      console_messages: messages.length,
    });
  } finally {
    try { await browser.close(); } catch (_) {}
  }
  process.exit(0);
})();
'''


def _capture_real_spa_arm(
    *,
    url: str,
    web_out: Path,
    device_scale_factor: int,
    spa_timeout_s: float = DEFAULT_SPA_TIMEOUT_S,
    render_wait_ms: int = DEFAULT_SPA_RENDER_WAIT_MS,
    viewport: tuple[int, int] = (DEFAULT_VIEWPORT_W, DEFAULT_VIEWPORT_H),
    first_run_dataset_path: str | None = None,
    first_run_required_channels: int = 1,
    require_collection_1x12: bool = False,
    log=print,
) -> RealSpaArmResult:
    """Drive one isolated real-SPA arm at exactly DPR1 or DPR2.

    Never raises: every failure to provision Node/Playwright/a browser, or any
    runtime error, becomes a structured failed arm. The
    subprocess has a hard timeout so a stuck browser can't hang the run, and the
    driver always closes its browser, so no orphan survives.
    """
    if device_scale_factor not in (1, 2):
        raise ValueError("device_scale_factor must be exactly 1 or 2")
    suffix = f"dpr{device_scale_factor}"
    spa_png = web_out / f"spa-{suffix}.png"
    canvas_png = web_out / f"canvas-{suffix}.png"
    first_run_png = web_out / f"first-run-{suffix}.png"
    focus_failure_png = web_out / f"focus-failure-{suffix}.png"
    console_log = web_out / f"console-{suffix}.log"
    driver_log = web_out / f"spa-driver-{suffix}.log"

    node = shutil.which("node")
    if node is None:
        return _spa_arm_skipped(
            "node not found on PATH (the real-SPA matrix needs Node + Playwright)",
            device_scale_factor=device_scale_factor,
            console_log=console_log,
        )

    try:
        node_path = _ensure_playwright(log=log)
    except TryoutError as error:
        return _spa_arm_skipped(
            error.message,
            device_scale_factor=device_scale_factor,
            console_log=console_log,
        )

    browser_path = _system_browser_path()
    if browser_path is None:
        return _spa_arm_skipped(
            "no Chrome/Chromium found (set LUCIDA_BROWSER) for the real-SPA matrix",
            device_scale_factor=device_scale_factor,
            console_log=console_log,
        )

    request = json.dumps(
        {
            "url": url,
            "spa_png": str(spa_png),
            "canvas_png": str(canvas_png),
            "first_run_png": str(first_run_png),
            "focus_failure_png": str(focus_failure_png),
            "console_log": str(console_log),
            "executable_path": browser_path,
            "browser_args": headless_webgpu_browser_args(),
            "width": viewport[0],
            "height": viewport[1],
            "device_scale_factor": device_scale_factor,
            "render_wait_ms": render_wait_ms,
            "first_run_dataset_path": first_run_dataset_path,
            "first_run_required_channels": first_run_required_channels,
            "require_collection_1x12": require_collection_1x12,
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
        f"[tryout] web matrix: driving the real SPA via Playwright "
        f"(system Chrome, DPR{device_scale_factor}) at {url}"
    )
    # Write the driver to a real .cjs file (rather than `node -e`): a file script
    # puts the request at argv[2] deterministically, resolves `require` naturally,
    # and leaves the exact driver on disk for the human verifier to inspect.
    driver_path = web_out / f"spa-driver-{suffix}.cjs"
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
        return RealSpaArmResult(
            device_scale_factor=device_scale_factor,
            captured=False,
            rendered=False,
            frame_advanced=False,
            reason=f"real-SPA capture timed out after {spa_timeout_s:g}s",
            spa_png=str(spa_png) if spa_png.is_file() else None,
            canvas_png=str(canvas_png) if canvas_png.is_file() else None,
            console_log=str(console_log) if console_log.is_file() else None,
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
        return RealSpaArmResult(
            device_scale_factor=device_scale_factor,
            captured=False,
            rendered=False,
            frame_advanced=False,
            reason=reason,
            spa_png=str(spa_png) if spa_png.is_file() else None,
            canvas_png=str(canvas_png) if canvas_png.is_file() else None,
            console_log=str(console_log) if console_log.is_file() else None,
            log=str(driver_log),
        )

    captured = bool(payload.get("captured"))
    spa_exists = spa_png.is_file()
    spa_nonblank = png_is_nonblank(spa_png) if spa_exists else False
    canvas_exists = canvas_png.is_file()
    canvas_content = (
        canvas_png_content_receipt(canvas_png)
        if canvas_exists
        else {"passed": False, "reason": "canvas PNG was not created"}
    )
    canvas_nonblank = canvas_content.get("passed") is True
    console_exists = console_log.is_file()
    rendered = bool(payload.get("rendered"))
    frame_advanced = bool(payload.get("frame_advanced"))
    gpu_failures = [str(value) for value in (payload.get("gpu_failures") or [])]
    contract_failures = [str(value) for value in (payload.get("contract_failures") or [])]
    log(
        f"[tryout]   web DPR{device_scale_factor}: {'captured' if captured else 'failed'} "
        f"({payload.get('reason')}) in {duration:g}s"
        + (
            f" -> canvas-{suffix}.png ({'non-blank' if canvas_nonblank else 'blank'})"
            if canvas_exists
            else ""
        )
    )
    return RealSpaArmResult(
        device_scale_factor=device_scale_factor,
        captured=captured,
        rendered=rendered,
        frame_advanced=frame_advanced,
        reason=str(payload.get("reason") or ("captured" if captured else "not captured")),
        spa_png=str(spa_png) if spa_exists else None,
        spa_png_nonblank=spa_nonblank if spa_exists else None,
        canvas_png=str(canvas_png) if canvas_exists else None,
        canvas_png_nonblank=canvas_nonblank if canvas_exists else None,
        canvas_content=canvas_content,
        console_log=str(console_log) if console_exists else None,
        console_messages=payload.get("console_messages"),
        diagnostic=(str(payload["diagnostic"]) if payload.get("diagnostic") is not None else None),
        render=payload.get("render"),
        browser_contract=payload.get("browser_contract"),
        gpu_failures=gpu_failures,
        contract_failures=contract_failures,
        log=str(driver_log),
        canvas_css_sample=_canvas_css_sample(canvas_png) if canvas_exists else None,
    )


def _spa_arm_skipped(
    reason: str,
    *,
    device_scale_factor: int,
    console_log: Path,
) -> RealSpaArmResult:
    # Leave a breadcrumb so the artifact dir explains the failure with no PNG.
    _write_text(console_log, f"# real-SPA DPR{device_scale_factor} failed: {reason}\n")
    return RealSpaArmResult(
        device_scale_factor=device_scale_factor,
        captured=False,
        rendered=False,
        frame_advanced=False,
        reason=reason,
        console_log=str(console_log),
    )


def _dpr_matrix_receipt(
    arms: list[RealSpaArmResult],
) -> tuple[dict[str, Any], list[str]]:
    """Record and validate the backing-store relationship across DPR arms."""

    by_dpr = {arm.device_scale_factor: arm for arm in arms}
    failures: list[str] = []
    arm_receipts: dict[str, Any] = {}
    for dpr in (1, 2):
        render = by_dpr.get(dpr).render if dpr in by_dpr else None
        backing_width = render.get("canvas_backing_width") if isinstance(render, dict) else None
        backing_height = render.get("canvas_backing_height") if isinstance(render, dict) else None
        client_width = render.get("canvas_client_width") if isinstance(render, dict) else None
        client_height = render.get("canvas_client_height") if isinstance(render, dict) else None
        camera = render.get("camera") if isinstance(render, dict) else None
        numeric = (backing_width, backing_height, client_width, client_height)
        valid = all(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and float(value) > 0
            for value in numeric
        )
        arm_receipts[f"dpr{dpr}"] = {
            "backing_width": backing_width,
            "backing_height": backing_height,
            "client_width": client_width,
            "client_height": client_height,
            "backing_area": (
                float(backing_width) * float(backing_height) if valid else None
            ),
            "client_area": float(client_width) * float(client_height) if valid else None,
            "logical_camera": camera,
        }
        if not valid:
            failures.append(f"DPR{dpr} canvas backing/client dimensions were missing")
        camera_valid = (
            isinstance(camera, dict)
            and camera.get("mode") == "slice"
            and camera.get("viewportUnits") == "css-pixels"
            and isinstance(camera.get("center"), list)
            and len(camera["center"]) == 2
            and isinstance(camera.get("viewport"), list)
            and len(camera["viewport"]) == 2
            and isinstance(camera.get("zoom"), (int, float))
            and not isinstance(camera.get("zoom"), bool)
            and math.isfinite(float(camera["zoom"]))
            and float(camera["zoom"]) > 0
        )
        if camera_valid:
            camera_valid = all(
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
                for value in [*camera["center"], *camera["viewport"]]
            )
        arm_receipts[f"dpr{dpr}"]["logical_camera_valid"] = camera_valid
        if not camera_valid:
            failures.append(f"DPR{dpr} did not expose a valid CSS-logical slice camera")
            continue
        if valid:
            for axis, client in enumerate((client_width, client_height)):
                if not math.isclose(
                    float(camera["viewport"][axis]), float(client), rel_tol=0.01, abs_tol=1.0
                ):
                    failures.append(
                        f"DPR{dpr} logical camera viewport axis {axis} did not match canvas CSS size"
                    )
        probe = camera.get("projectionProbe")
        probe_valid = (
            isinstance(probe, dict)
            and isinstance(probe.get("world"), list)
            and len(probe["world"]) == 2
            and isinstance(probe.get("screen"), list)
            and len(probe["screen"]) == 2
            and all(
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
                for value in [*probe["world"], *probe["screen"]]
            )
        )
        if not probe_valid:
            failures.append(f"DPR{dpr} logical camera projection probe was missing")
        else:
            expected = [
                (float(probe["world"][axis]) - float(camera["center"][axis]))
                * float(camera["zoom"])
                + float(camera["viewport"][axis]) / 2
                for axis in (0, 1)
            ]
            if any(
                not math.isclose(float(probe["screen"][axis]), expected[axis], abs_tol=1e-6)
                for axis in (0, 1)
            ):
                failures.append(f"DPR{dpr} projection probe did not obey CSS-logical camera math")

    dpr1 = arm_receipts["dpr1"]
    dpr2 = arm_receipts["dpr2"]
    ratio = None
    if dpr1["backing_area"] and dpr2["backing_area"]:
        ratio = dpr2["backing_area"] / dpr1["backing_area"]
        if not math.isclose(ratio, 4.0, rel_tol=0.05, abs_tol=0.05):
            failures.append(
                f"DPR2/DPR1 canvas backing-area ratio was {ratio:.4g}, expected approximately 4"
            )
        for axis in ("width", "height"):
            if not math.isclose(
                float(dpr1[f"client_{axis}"]),
                float(dpr2[f"client_{axis}"]),
                rel_tol=0.01,
                abs_tol=1.0,
            ):
                failures.append(
                    f"DPR1/DPR2 canvas client {axis} differed across otherwise identical arms"
                )
    camera1 = dpr1.get("logical_camera")
    camera2 = dpr2.get("logical_camera")
    if dpr1.get("logical_camera_valid") and dpr2.get("logical_camera_valid") \
            and isinstance(camera1, dict) and isinstance(camera2, dict):
        for key in ("center", "viewport"):
            left = camera1.get(key)
            right = camera2.get(key)
            if isinstance(left, list) and isinstance(right, list) and len(left) == len(right):
                if any(
                    not math.isclose(float(a), float(b), rel_tol=1e-8, abs_tol=1e-6)
                    for a, b in zip(left, right, strict=True)
                ):
                    failures.append(f"DPR1/DPR2 logical camera {key} differed")
        if isinstance(camera1.get("zoom"), (int, float)) \
                and isinstance(camera2.get("zoom"), (int, float)) \
                and not math.isclose(
                    float(camera1["zoom"]), float(camera2["zoom"]),
                    rel_tol=1e-8, abs_tol=1e-8,
                ):
            failures.append("DPR1/DPR2 logical camera zoom differed")

    equivalence = _canvas_css_equivalence_from_samples(
        by_dpr.get(1).canvas_css_sample if by_dpr.get(1) else None,
        by_dpr.get(2).canvas_css_sample if by_dpr.get(2) else None,
    )
    if equivalence.get("passed") is not True:
        failures.append(
            "DPR1/DPR2 isolated canvases were not equivalent in normalized CSS space: "
            + str(equivalence.get("reason") or "unknown")
        )
    receipt = {
        "expected_backing_area_ratio": 4.0,
        "backing_area_ratio": ratio,
        "arms": arm_receipts,
        "css_canvas_equivalence": equivalence,
        "passed": not failures,
    }
    return receipt, failures


def _fixture_has_known_collection_1x12_profile(dataset_path: str | None) -> bool:
    """Recognize the repository's generated wide-collection browser fixture."""

    if not dataset_path:
        return False
    metadata_path = Path(dataset_path) / "zarr.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return False

    def mappings(value: Any):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from mappings(child)
        elif isinstance(value, list):
            for child in value:
                yield from mappings(child)

    for candidate in mappings(metadata):
        if candidate.get("name") != "lucida-browser-smoke-wide-collection":
            continue
        rows = candidate.get("rows")
        columns = candidate.get("columns")
        return rows == [{"name": "A"}] and columns == [
            {"name": str(index)} for index in range(1, 13)
        ]
    return False


def capture_real_spa(
    *,
    url: str,
    web_out: Path,
    spa_timeout_s: float = DEFAULT_SPA_TIMEOUT_S,
    render_wait_ms: int = DEFAULT_SPA_RENDER_WAIT_MS,
    viewport: tuple[int, int] = (DEFAULT_VIEWPORT_W, DEFAULT_VIEWPORT_H),
    expectation: RealContentExpectation = RealContentExpectation(),
    first_run_dataset_path: str | None = None,
    require_first_run: bool = False,
    log=print,
) -> RealSpaResult:
    """Run the invariant production-render matrix at DPR1 and DPR2.

    Arms are isolated browser contexts and DPR2 is the representative legacy
    artifact. The matrix succeeds only when both canvas captures contain real
    pixels, a forced resize produces a later GPU-complete frame, and neither arm
    reports a device-loss/GPU-fatal diagnostic.
    """
    require_collection_1x12 = (
        expectation.require_collection_1x12
        or _fixture_has_known_collection_1x12_profile(first_run_dataset_path)
    )
    arms = [
        _capture_real_spa_arm(
            url=url,
            web_out=web_out,
            device_scale_factor=device_scale_factor,
            spa_timeout_s=spa_timeout_s,
            render_wait_ms=render_wait_ms,
            viewport=viewport,
            first_run_dataset_path=first_run_dataset_path,
            first_run_required_channels=expectation.min_channel_count,
            require_collection_1x12=require_collection_1x12,
            log=log,
        )
        for device_scale_factor in (1, 2)
    ]
    for arm in arms:
        arm.contract_failures.extend(
            _content_contract_failures(arm.render, expectation, arm.device_scale_factor)
        )
        arm.contract_failures.extend(
            _browser_acceptance_contract_failures(
                arm.browser_contract,
                device_scale_factor=arm.device_scale_factor,
                require_first_run=require_first_run,
                required_channel_count=expectation.min_channel_count,
                require_collection_1x12=require_collection_1x12,
            )
        )
    dpr_matrix, matrix_failures = _dpr_matrix_receipt(arms)
    if matrix_failures:
        # The ratio is a property of both arms. Attach it to the representative
        # DPR2 arm so the ordinary matrix reason remains concise and specific.
        arms[-1].contract_failures.extend(matrix_failures)
    primary = arms[-1]
    ok = all(arm.ok for arm in arms)
    failed = [
        f"DPR{arm.device_scale_factor}: {_arm_failure_reason(arm)}"
        for arm in arms
        if not arm.ok
    ]
    return RealSpaResult(
        captured=all(arm.captured for arm in arms),
        ok=ok,
        reason="rendered at DPR1 and DPR2" if ok else "; ".join(failed),
        arms=arms,
        spa_png=primary.spa_png,
        spa_png_nonblank=primary.spa_png_nonblank,
        console_log=primary.console_log,
        url=url,
        console_messages=sum(arm.console_messages or 0 for arm in arms),
        render=primary.render,
        dpr_matrix=dpr_matrix,
        log=primary.log,
    )


def _arm_failure_reason(arm: RealSpaArmResult) -> str:
    """Combine the browser outcome with every gate that rejected the arm."""

    details = [arm.reason]
    details.extend(arm.contract_failures)
    details.extend(arm.gpu_failures)
    if arm.canvas_png_nonblank is False:
        details.append("canvas screenshot lacked rendered interior content")
        if isinstance(arm.canvas_content, dict):
            reason = arm.canvas_content.get("reason")
            if isinstance(reason, str) and reason:
                details.append(reason)
    if not arm.frame_advanced:
        details.append("presented frame did not advance")
    # Preserve order while avoiding repeated lower-level diagnostics.
    return "; ".join(dict.fromkeys(detail for detail in details if detail))


def _browser_acceptance_contract_failures(
    contract: dict[str, Any] | None,
    *,
    device_scale_factor: int,
    require_first_run: bool,
    required_channel_count: int,
    require_collection_1x12: bool = False,
) -> list[str]:
    """Independently validate the structured browser acceptance receipt.

    The embedded driver owns interaction execution, while this parser owns the
    success semantics. Keeping both sides strict prevents a deleted/dead driver
    call or a partially-populated result from passing merely because the source
    still contains a marker string.
    """

    if not isinstance(contract, dict):
        return ["browser acceptance receipt was missing"]
    failures: list[str] = []

    def numeric_at_least(value: Any, minimum: float) -> bool:
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and float(value) >= minimum
        )

    def numeric_equal(value: Any, expected: float) -> bool:
        return numeric_at_least(value, -math.inf) and float(value) == expected

    def nested(value: Any, *keys: str) -> Any:
        current = value
        for key in keys:
            if not isinstance(current, dict):
                return None
            current = current.get(key)
        return current

    def rects_match(left: Any, right: Any, tolerance: float = 2.0) -> bool:
        keys = ("left", "top", "right", "bottom", "width", "height")
        return isinstance(left, dict) and isinstance(right, dict) and all(
            numeric_at_least(left.get(key), -math.inf)
            and numeric_at_least(right.get(key), -math.inf)
            and abs(float(left[key]) - float(right[key])) <= tolerance
            for key in keys
        )

    def audits_ok(value: Any, required_labels: set[str], scope: str) -> None:
        audits = value if isinstance(value, list) else []
        by_label = {
            audit.get("label"): audit
            for audit in audits
            if isinstance(audit, dict) and isinstance(audit.get("label"), str)
        }
        missing = sorted(required_labels - set(by_label))
        if missing:
            failures.append(f"{scope} axe receipts were missing: {', '.join(missing)}")
        for label in required_labels & set(by_label):
            violations = by_label[label].get("violations")
            if not isinstance(violations, list):
                failures.append(f"{label} axe receipt was malformed")
            elif violations:
                failures.append(f"{label} axe receipt contained violations")

    runtime = contract.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("version") != 1:
        failures.append("renderer runtime contract version 1 was unavailable")

    viewport_presentation = contract.get("initial_viewport_presentation")
    baseline_viewport = nested(viewport_presentation, "baseline", "viewport")
    mutated_viewport = nested(viewport_presentation, "mutated", "viewport")
    restored_viewport = nested(viewport_presentation, "restored", "viewport")

    def viewport_snapshot_valid(snapshot: Any) -> bool:
        viewport = nested(snapshot, "viewport")
        canvas_css = nested(snapshot, "canvas", "css")
        canvas_backing = nested(snapshot, "canvas", "backing")
        return (
            isinstance(snapshot, dict)
            and isinstance(viewport, list)
            and len(viewport) == 2
            and all(numeric_at_least(value, 1) for value in viewport)
            and isinstance(canvas_css, list)
            and len(canvas_css) == 2
            and all(numeric_at_least(value, 1) for value in canvas_css)
            and isinstance(canvas_backing, list)
            and len(canvas_backing) == 2
            and all(numeric_at_least(value, 1) for value in canvas_backing)
            and nested(snapshot, "ready", "ready") is True
            and nested(snapshot, "runtime", "version") == 1
        )

    def viewport_stage_advanced(before: Any, after: Any) -> bool:
        return all(
            numeric_at_least(after_value, 0)
            and numeric_at_least(before_value, 0)
            and float(after_value) > float(before_value)
            for before_value, after_value in (
                (nested(before, "ready", "frame_count"),
                 nested(after, "ready", "frame_count")),
                (nested(before, "runtime", "client", "surface", "forwarded"),
                 nested(after, "runtime", "client", "surface", "forwarded")),
                (nested(before, "runtime", "client", "frames", "posted"),
                 nested(after, "runtime", "client", "frames", "posted")),
                (nested(before, "runtime", "client", "frames", "presented"),
                 nested(after, "runtime", "client", "frames", "presented")),
            )
        )

    viewport_snapshots = [
        nested(viewport_presentation, "baseline"),
        nested(viewport_presentation, "mutated"),
        nested(viewport_presentation, "restored"),
    ]
    if not isinstance(viewport_presentation, dict) \
            or viewport_presentation.get("passed") is not True \
            or viewport_presentation.get("failed_stage") is not None \
            or not all(viewport_snapshot_valid(value) for value in viewport_snapshots) \
            or baseline_viewport == mutated_viewport \
            or restored_viewport != baseline_viewport \
            or not viewport_stage_advanced(viewport_snapshots[0], viewport_snapshots[1]) \
            or not viewport_stage_advanced(viewport_snapshots[1], viewport_snapshots[2]):
        failures.append("initial viewport mutation/restoration presentation receipt did not pass")

    canvas_isolation = contract.get("canvas_isolation")
    if not isinstance(canvas_isolation, dict) \
            or canvas_isolation.get("executed") is not True \
            or canvas_isolation.get("contaminated_differs_from_black") is not True \
            or canvas_isolation.get("isolated_matches_black") is not True:
        failures.append("canvas-only capture isolation receipt did not pass")

    final_settlement = contract.get("final_canvas_settlement")
    if not isinstance(final_settlement, dict) \
            or final_settlement.get("executed") is not True \
            or final_settlement.get("passed") is not True \
            or not numeric_at_least(final_settlement.get("samples"), 4) \
            or not numeric_at_least(final_settlement.get("stable_samples"), 4) \
            or not numeric_at_least(final_settlement.get("observed_ms"), 5000) \
            or not numeric_at_least(final_settlement.get("quiet_ms"), 3000) \
            or not isinstance(final_settlement.get("final_digest"), str) \
            or len(final_settlement.get("final_digest", "")) != 64:
        failures.append("final isolated canvas settlement receipt did not pass")

    fixture_capabilities = contract.get("fixture_capabilities")
    if not isinstance(fixture_capabilities, dict) \
            or fixture_capabilities.get("collection_1x12_required") \
            is not require_collection_1x12:
        failures.append("fixture collection capability expectation receipt was missing")

    initial_recoveries = contract.get("initial_zero_size_recovery")
    recoveries_by_mode = {
        recovery.get("mode"): recovery
        for recovery in initial_recoveries
        if isinstance(recovery, dict) and recovery.get("mode") in {"2d", "3d"}
    } if isinstance(initial_recoveries, list) else {}
    missing_recoveries = sorted({"2d", "3d"} - set(recoveries_by_mode))
    if missing_recoveries:
        failures.append(
            "fresh 0x0 recovery receipts were missing: "
            + ", ".join(missing_recoveries)
        )
    for target, render_mode in (("2d", "slice"), ("3d", "volume")):
        recovery = recoveries_by_mode.get(target)
        if not isinstance(recovery, dict):
            continue
        initial = recovery.get("initial")
        restored = recovery.get("restored")
        counters = nested(initial, "client", "surface", "byMode", render_mode)
        suppressed = nested(initial, "client", "surface", "lastSuppressed")
        forwarded = nested(restored, "client", "surface", "lastForwarded")
        initial_posted = nested(initial, "client", "frames", "posted")
        initial_presented = nested(initial, "client", "frames", "presented")
        restored_posted = nested(restored, "client", "frames", "posted")
        restored_presented = nested(restored, "client", "frames", "presented")
        suppressed_dimension = (
            isinstance(suppressed, dict)
            and (
                numeric_at_least(suppressed.get("width"), 0)
                and numeric_equal(suppressed.get("width"), 0)
                or numeric_at_least(suppressed.get("height"), 0)
                and numeric_equal(suppressed.get("height"), 0)
            )
        )
        raw_initial_ok = (
            isinstance(initial, dict)
            and initial.get("version") == 1
            and isinstance(counters, dict)
            and numeric_at_least(counters.get("suppressed"), 1)
            and numeric_equal(counters.get("forwarded"), 0)
            and isinstance(suppressed, dict)
            and suppressed.get("mode") == render_mode
            and suppressed.get("rejection") == "non-positive"
            and suppressed_dimension
        )
        raw_restored_ok = (
            isinstance(restored, dict)
            and restored.get("version") == 1
            and isinstance(forwarded, dict)
            and forwarded.get("mode") == render_mode
            and numeric_at_least(forwarded.get("width"), 1)
            and numeric_at_least(forwarded.get("height"), 1)
            and numeric_at_least(initial_posted, 0)
            and numeric_at_least(initial_presented, 0)
            and numeric_at_least(restored_posted, 1)
            and numeric_at_least(restored_presented, 1)
            and float(restored_posted) > float(initial_posted)
            and float(restored_presented) > float(initial_presented)
        )
        if recovery.get("contract_version") != 1 or not raw_initial_ok:
            failures.append(
                f"{target}: fresh 0x0 mount did not prove suppression before the worker boundary"
            )
        if recovery.get("initial_suppressed") is not True \
                or recovery.get("initial_invalid_not_forwarded") is not True:
            failures.append(
                f"{target}: fresh invalid surface was not rejected before forwarding"
            )
        if recovery.get("restored_finite_positive") is not True \
                or recovery.get("restored_forwarded_positive") is not True \
                or recovery.get("frame_advanced") is not True \
                or not raw_restored_ok:
            failures.append(
                f"{target}: fresh 0x0 recovery did not forward positive geometry and present"
            )

    later_recoveries = contract.get("zero_size_recovery")
    later_by_mode = {
        recovery.get("mode"): recovery
        for recovery in later_recoveries
        if isinstance(recovery, dict) and recovery.get("mode") in {"2d", "3d"}
    } if isinstance(later_recoveries, list) else {}
    missing_later = sorted({"2d", "3d"} - set(later_by_mode))
    if missing_later:
        failures.append(
            "later 0x0 recovery receipts were missing: " + ", ".join(missing_later)
        )
    for target, render_mode in (("2d", "slice"), ("3d", "volume")):
        recovery = later_by_mode.get(target)
        if not isinstance(recovery, dict):
            continue
        initial = recovery.get("initial")
        collapsed = recovery.get("collapsed_runtime")
        restored = recovery.get("restored_runtime")
        initial_counters = nested(initial, "client", "surface", "byMode", render_mode)
        collapsed_counters = nested(collapsed, "client", "surface", "byMode", render_mode)
        rejected = nested(collapsed, "client", "surface", "lastSuppressed")
        accepted = nested(restored, "client", "surface", "lastForwarded")
        collapsed_posted = nested(collapsed, "client", "frames", "posted")
        collapsed_presented = nested(collapsed, "client", "frames", "presented")
        restored_posted = nested(restored, "client", "frames", "posted")
        restored_presented = nested(restored, "client", "frames", "presented")
        raw_collapse_ok = (
            isinstance(initial, dict)
            and initial.get("version") == 1
            and isinstance(collapsed, dict)
            and collapsed.get("version") == 1
            and isinstance(initial_counters, dict)
            and isinstance(collapsed_counters, dict)
            and numeric_at_least(initial_counters.get("suppressed"), 0)
            and numeric_at_least(initial_counters.get("forwarded"), 0)
            and numeric_at_least(collapsed_counters.get("suppressed"), 1)
            and float(collapsed_counters["suppressed"])
            > float(initial_counters["suppressed"])
            and float(collapsed_counters.get("forwarded", math.inf))
            == float(initial_counters["forwarded"])
            and isinstance(rejected, dict)
            and rejected.get("mode") == render_mode
            and rejected.get("rejection") == "non-positive"
            and (
                numeric_equal(rejected.get("width"), 0)
                or numeric_equal(rejected.get("height"), 0)
            )
        )
        raw_restore_ok = (
            isinstance(restored, dict)
            and restored.get("version") == 1
            and isinstance(accepted, dict)
            and accepted.get("mode") == render_mode
            and numeric_at_least(accepted.get("width"), 1)
            and numeric_at_least(accepted.get("height"), 1)
            and numeric_at_least(collapsed_posted, 0)
            and numeric_at_least(collapsed_presented, 0)
            and numeric_at_least(restored_posted, 1)
            and numeric_at_least(restored_presented, 1)
            and float(restored_posted) > float(collapsed_posted)
            and float(restored_presented) > float(collapsed_presented)
            and numeric_equal(nested(restored, "client", "frames", "pending"), 0)
            and nested(restored, "loop", "animationFramePending") is False
            and nested(restored, "loop", "interactiveDirty") is False
            and nested(restored, "loop", "residencyDirty") is False
        )
        if recovery.get("contract_version") != 1 \
                or recovery.get("settled_before") is not True \
                or recovery.get("collapsed_to_zero") is not True \
                or recovery.get("collapsed_suppressed") is not True \
                or recovery.get("collapsed_invalid_not_forwarded") is not True \
                or not raw_collapse_ok:
            failures.append(
                f"{target}: later 0x0 collapse did not prove suppression before forwarding"
            )
        if recovery.get("restored_finite_positive") is not True \
                or recovery.get("restored_forwarded_positive") is not True \
                or recovery.get("frame_advanced") is not True \
                or not raw_restore_ok:
            failures.append(
                f"{target}: later 0x0 recovery did not forward positive geometry and settle"
            )

    dashboard = contract.get("dashboard")
    if not isinstance(dashboard, dict) or dashboard.get("ok") is not True:
        failures.append("dashboard responsive acceptance did not pass")
    else:
        dashboard_layouts = {
            layout.get("label"): layout
            for layout in dashboard.get("layouts", [])
            if isinstance(layout, dict)
        }
        expected = {"dashboard-desktop-1280x720", "dashboard-mobile-390x844"}
        if not expected.issubset(dashboard_layouts):
            failures.append("dashboard DPR arm omitted a responsive baseline")
        for label, viewport in (
            ("dashboard-desktop-1280x720", [1280, 720]),
            ("dashboard-mobile-390x844", [390, 844]),
        ):
            layout = dashboard_layouts.get(label)
            controls = layout.get("controls") if isinstance(layout, dict) else None
            settlement = layout.get("layout_settlement") \
                if isinstance(layout, dict) else None
            required_controls = {
                "create_input", "create_from_url", "browse", "new_workspace", "search",
            }
            raw_ok = (
                isinstance(layout, dict)
                and layout.get("viewport") == viewport
                and layout.get("horizontal_overflow") is False
                and isinstance(settlement, dict)
                and settlement.get("settled") is True
                and isinstance(controls, dict)
                and required_controls.issubset(controls)
                and all(
                    isinstance(controls[name], dict)
                    and controls[name].get("found") is True
                    and controls[name].get("reachable") is True
                    for name in required_controls
                )
            )
            if not raw_ok:
                failures.append(f"{label} dashboard layout receipt did not pass")
        audits_ok(dashboard.get("axe"), expected, "dashboard")

    viewer_layouts = {
        layout.get("label"): layout
        for layout in contract.get("layouts", [])
        if isinstance(layout, dict)
    }
    if not {"desktop-1280x720", "mobile-390x844"}.issubset(viewer_layouts):
        failures.append("viewer DPR arm omitted a responsive baseline")
    for label, viewport, required_controls in (
        (
            "desktop-1280x720",
            [1280, 720],
            {"workspaces", "share", "dataset_url", "open", "browse", "explore", "mentions"},
        ),
        (
            "mobile-390x844",
            [390, 844],
            {"workspaces", "share", "layers", "dataset_url", "open", "browse", "explore", "mentions"},
        ),
    ):
        layout = viewer_layouts.get(label)
        controls = layout.get("reachable_controls") if isinstance(layout, dict) else None
        settlement = layout.get("layout_settlement") if isinstance(layout, dict) else None
        raw_ok = (
            isinstance(layout, dict)
            and layout.get("viewport") == viewport
            and layout.get("horizontal_overflow") is False
            and layout.get("finite_positive_canvas") is True
            and isinstance(settlement, dict)
            and settlement.get("settled") is True
            and isinstance(controls, dict)
            and required_controls.issubset(controls)
            and all(
                isinstance(controls[name], dict)
                and controls[name].get("found") is True
                and controls[name].get("reachable") is True
                for name in required_controls
            )
        )
        if raw_ok and label.startswith("mobile"):
            for name in {"workspaces", "share", "layers"}:
                rect = controls[name].get("rect")
                if not isinstance(rect, dict) \
                        or not numeric_at_least(rect.get("width"), 44) \
                        or not numeric_at_least(rect.get("height"), 44):
                    raw_ok = False
        if not raw_ok:
            failures.append(f"{label} viewer layout receipt did not pass")

    overlays = contract.get("overlays")
    if not isinstance(overlays, dict):
        failures.append("overlay acceptance receipt was missing")
    else:
        focus = overlays.get("logical_focus")
        if not isinstance(focus, dict) or focus.get("reached_panel") is not True \
                or focus.get("panel_focus_visible") is not True:
            failures.append("overlay logical focus sequence did not pass")
        thread = overlays.get("thread")
        thread_focus = thread.get("logical_focus") if isinstance(thread, dict) else None
        if not isinstance(thread, dict) \
                or thread.get("trigger_panel_linked") is not True \
                or thread.get("trigger_kept_focus") is not True \
                or thread.get("escape_restored_trigger") is not True \
                or thread.get("close_restored_trigger") is not True \
                or not isinstance(thread_focus, dict) \
                or thread_focus.get("reached_panel") is not True \
                or thread_focus.get("panel_focus_visible") is not True:
            failures.append("overlay annotation-thread focus and reading-order receipt did not pass")
        click_focus = overlays.get("mentions_focus_after_click")
        if not isinstance(click_focus, dict) \
                or click_focus.get("captured_before_focus_mutation") is not True \
                or click_focus.get("trigger_focused") is not True:
            failures.append("Mentions trigger did not retain focus immediately after click")
        saved_view_actions = overlays.get("saved_view_actions")
        saved_view_geometry = saved_view_actions.get("geometry") \
            if isinstance(saved_view_actions, dict) else None
        clipped_saved_view_anchor = saved_view_actions.get("clipped_anchor") \
            if isinstance(saved_view_actions, dict) else None
        if not isinstance(saved_view_actions, dict) \
                or saved_view_actions.get("applicable") is not True \
                or not numeric_at_least(saved_view_actions.get("row_count"), 1) \
                or not numeric_at_least(saved_view_actions.get("item_count"), 2) \
                or saved_view_actions.get("initial_focus_first_item") is not True \
                or saved_view_actions.get("arrow_navigation_passed") is not True \
                or saved_view_actions.get("escape_restored_trigger") is not True \
                or not isinstance(saved_view_geometry, dict) \
                or saved_view_geometry.get("within_viewport") is not True \
                or saved_view_geometry.get("registered_surface") is not True \
                or saved_view_geometry.get("safe_control_collisions") != [] \
                or not isinstance(clipped_saved_view_anchor, dict) \
                or clipped_saved_view_anchor.get("trigger_connected") is not True \
                or clipped_saved_view_anchor.get("trigger_fully_clipped") is not True \
                or clipped_saved_view_anchor.get("aria_expanded_cleared") is not True \
                or clipped_saved_view_anchor.get("fallback_focused") is not True \
                or clipped_saved_view_anchor.get("fallback_label") != "Search saved views":
            failures.append("overlay saved-view actions menu lifecycle did not pass")
        trigger_receipts = overlays.get("trigger_receipts")
        for trigger_name in (
            "desktop_explore",
            "desktop_mentions",
            "notice_mentions",
            "edge_mentions",
            "mobile_mentions",
        ):
            trigger = trigger_receipts.get(trigger_name) \
                if isinstance(trigger_receipts, dict) else None
            if not isinstance(trigger, dict) \
                    or trigger.get("in_viewport") is not True \
                    or trigger.get("hit_testable") is not True:
                failures.append(
                    f"overlay opening trigger {trigger_name} was not hit-testable"
                )
        probes = overlays.get("probes")
        zoomed = probes.get("zoomed") if isinstance(probes, dict) else None
        zoomed_opening = zoomed.get("opening_trigger_receipts") \
            if isinstance(zoomed, dict) else None
        zoomed_mentions_trigger = zoomed_opening.get("post_zoom_mentions") \
            if isinstance(zoomed_opening, dict) else None
        if not isinstance(zoomed, dict) \
                or zoomed.get("zoom_profile") != "browser-page-scale-1.25" \
                or not numeric_equal(zoomed.get("page_scale"), 1.25) \
                or not numeric_equal(
                    zoomed.get("device_pixel_ratio"), device_scale_factor
                ) \
                or zoomed.get("layout_viewport") != [1024, 576] \
                or not isinstance(zoomed_mentions_trigger, dict) \
                or zoomed_mentions_trigger.get("in_viewport") is not True \
                or zoomed_mentions_trigger.get("hit_testable") is not True:
            failures.append("overlay browser-page-scale 125% zoom receipt did not pass")
        required_probes = {"desktop", "notice", "zoomed", "edge", "narrow"}
        persistent_profiles = overlays.get("persistent_profiles")
        mobile_persistent = persistent_profiles.get("mobile") \
            if isinstance(persistent_profiles, dict) else None
        mobile_persistent_collection = mobile_persistent.get("collection") \
            if isinstance(mobile_persistent, dict) else None
        mobile_persistent_minimap = mobile_persistent.get("minimap") \
            if isinstance(mobile_persistent, dict) else None
        mobile_persistent_interaction = mobile_persistent.get("collection_interaction") \
            if isinstance(mobile_persistent, dict) else None
        mobile_persistent_settlement = mobile_persistent.get("layout_settlement") \
            if isinstance(mobile_persistent, dict) else None
        mobile_persistent_ok = (
            isinstance(mobile_persistent, dict)
            and isinstance(mobile_persistent_settlement, dict)
            and mobile_persistent_settlement.get("settled") is True
            and mobile_persistent.get("owner_present") is True
            and isinstance(mobile_persistent_interaction, dict)
            and isinstance(mobile_persistent_interaction.get("applicable"), bool)
            and (
                mobile_persistent_interaction.get("applicable") is True
                or (
                    isinstance(mobile_persistent_interaction.get("skip_reason"), str)
                    and bool(mobile_persistent_interaction["skip_reason"].strip())
                )
            )
            and isinstance(mobile_persistent_minimap, dict)
            and mobile_persistent_minimap.get("present") is True
            and mobile_persistent_minimap.get("within_viewport") is True
            and mobile_persistent_minimap.get("registered_safe_region") is True
        )
        if require_collection_1x12 or (
            isinstance(mobile_persistent_interaction, dict)
            and mobile_persistent_interaction.get("applicable") is True
        ):
            mobile_persistent_ok = mobile_persistent_ok and (
                mobile_persistent.get("owner_layout") == "stacked"
                and mobile_persistent.get("overlap") is False
                and isinstance(mobile_persistent_collection, dict)
                and mobile_persistent_collection.get("present") is True
                and mobile_persistent_collection.get("within_viewport") is True
                and mobile_persistent_collection.get("registered_safe_region") is True
                and bool(mobile_persistent_collection.get("accessible_name"))
                and isinstance(mobile_persistent_interaction, dict)
                and mobile_persistent_interaction.get("applicable") is True
                and mobile_persistent_interaction.get("owner_layout")
                == mobile_persistent.get("owner_layout")
                and rects_match(
                    mobile_persistent_collection.get("rect"),
                    mobile_persistent_interaction.get("selector_rect"),
                )
                and rects_match(
                    mobile_persistent_minimap.get("rect"),
                    mobile_persistent_interaction.get("minimap_rect"),
                )
                and numeric_at_least(
                    mobile_persistent_interaction.get("populated_cell_count"), 12,
                )
                and numeric_equal(
                    mobile_persistent_interaction.get("required_cell_count"), 12,
                )
                and mobile_persistent_interaction.get("edge_cell_label") == "Go to A12"
                and mobile_persistent_interaction.get("selector_minimap_overlap") is False
                and mobile_persistent_interaction.get("edge_cell_inside_selector") is True
                and mobile_persistent_interaction.get("edge_cell_hit_testable") is True
                and mobile_persistent_interaction.get("edge_cell_focused") is True
                and mobile_persistent_interaction.get("edge_cell_focus_visible") is True
                and mobile_persistent_interaction.get("edge_cell_focus_ring_inset") is True
                and mobile_persistent_interaction.get("edge_cell_keyboard_returned") is True
                and mobile_persistent_interaction.get("edge_cell_click_completed") is True
                and mobile_persistent_interaction.get("edge_cell_click_received") is True
            )
        if not mobile_persistent_ok:
            failures.append("overlay mobile persistent-overlay profile did not pass")
        if not isinstance(probes, dict) or not required_probes.issubset(probes):
            failures.append("overlay acceptance omitted a required geometry profile")
        else:
            for label in required_probes:
                probe = probes[label]
                mobile_floating_profile = label == "narrow"
                zoom_floating_profile = label == "zoomed"
                isolated_floating_profile = (
                    mobile_floating_profile or zoom_floating_profile
                )
                surfaces = probe.get("surfaces") if isinstance(probe, dict) else None
                mentions = surfaces.get("mentions") if isinstance(surfaces, dict) else None
                explore = surfaces.get("explore") if isinstance(surfaces, dict) else None
                named = probe.get("named_surfaces") if isinstance(probe, dict) else None
                minimap = named.get("minimap") if isinstance(named, dict) else None
                annotation_thread = named.get("thread_popover") if isinstance(named, dict) else None
                collection = named.get("collection_selector") if isinstance(named, dict) else None
                collection_interaction = (
                    probe.get("collection_interaction") if isinstance(probe, dict) else None
                )
                settlement = probe.get("layout_settlement") \
                    if isinstance(probe, dict) else None
                viewport_triggers = probe.get("viewport_triggers") \
                    if isinstance(probe, dict) else None
                mentions_trigger = viewport_triggers.get("mentions") \
                    if isinstance(viewport_triggers, dict) else None
                zoom_minimap_yielded = (
                    zoom_floating_profile
                    and isinstance(minimap, dict)
                    and minimap.get("mounted") is True
                    and minimap.get("suppression_reason") in {
                        "boundary-too-small", "transient-collision",
                    }
                )
                collection_receipt_ok = (
                    isinstance(collection_interaction, dict)
                    and isinstance(collection_interaction.get("applicable"), bool)
                    and (
                        not require_collection_1x12
                        or collection_interaction.get("applicable") is True
                    )
                    and (
                        isinstance(collection_interaction.get("skip_reason"), str)
                        and bool(collection_interaction.get("skip_reason", "").strip())
                        if collection_interaction.get("applicable") is False
                        else (
                            isinstance(collection, dict)
                            and collection.get("present") is True
                            and collection.get("within_viewport") is True
                            and collection.get("registered_safe_region") is True
                            and bool(collection.get("accessible_name"))
                            and numeric_at_least(
                                collection_interaction.get("populated_cell_count"), 12,
                            )
                            and numeric_equal(
                                collection_interaction.get("required_cell_count"), 12,
                            )
                            and collection_interaction.get("edge_cell_label") == "Go to A12"
                            and collection_interaction.get("selector_minimap_overlap") is False
                            and collection_interaction.get("edge_cell_inside_selector") is True
                            and collection_interaction.get("edge_cell_hit_testable") is True
                            and collection_interaction.get("edge_cell_focused") is True
                            and collection_interaction.get("edge_cell_focus_visible") is True
                            and collection_interaction.get("edge_cell_focus_ring_inset") is True
                            and collection_interaction.get("edge_cell_keyboard_returned") is True
                            and collection_interaction.get("edge_cell_click_completed") is True
                            and collection_interaction.get("edge_cell_click_received") is True
                            and collection_interaction.get("owner_present") is True
                            and (
                                label != "narrow"
                                or collection_interaction.get("owner_layout") == "stacked"
                            )
                        )
                    )
                )
                if not isinstance(probe, dict) \
                        or not isinstance(settlement, dict) \
                        or settlement.get("settled") is not True \
                        or not isinstance(mentions_trigger, dict) \
                        or mentions_trigger.get("in_viewport") is not True \
                        or mentions_trigger.get("hit_testable") is not True \
                        or probe.get("pairwise_overlap") is not False \
                        or probe.get("horizontal_overflow") is not False \
                        or probe.get("primary_controls_unoccluded") is not True \
                        or probe.get("occluded_safe_regions") != [] \
                        or probe.get("trigger_panel_linked") is not True \
                        or probe.get("trigger_kept_focus") is not True \
                        or not isinstance(mentions, dict) \
                        or mentions.get("within_viewport") is not True \
                        or not isinstance(explore, dict) \
                        or explore.get("horizontally_bounded") is not True \
                        or explore.get("intersects_visual_viewport") is not True \
                        or explore.get("vertically_reachable") is not True \
                        or not isinstance(named, dict) \
                        or not {"thread_popover", "minimap", "collection_selector", "notice"}.issubset(named) \
                        or (not mobile_floating_profile and not zoom_minimap_yielded and (
                            not isinstance(minimap, dict)
                            or minimap.get("present") is not True
                            or minimap.get("within_viewport") is not True
                            or minimap.get("registered_safe_region") is not True
                        )) \
                        or (label == "desktop" and (
                            not isinstance(annotation_thread, dict)
                            or annotation_thread.get("present") is not True
                            or annotation_thread.get("within_viewport") is not True
                            or annotation_thread.get("registered_safe_region") is not True
                        )) \
                        or (not isolated_floating_profile and not collection_receipt_ok) \
                        or probe.get("named_surface_collisions") != [] \
                        or probe.get("surface_safe_region_collisions") != [] \
                        or not numeric_at_least(
                            probe.get("surface_safe_region_pairs_checked"), 1,
                        ):
                    failures.append(f"overlay {label} geometry receipt did not pass")
            edge = probes["edge"]
            if not isinstance(edge, dict) or edge.get("flipped_from_bottom_right") is not True:
                failures.append("overlay edge geometry did not flip above its anchor")
            notice_probe = probes["notice"]
            notice_named = (
                notice_probe.get("named_surfaces")
                if isinstance(notice_probe, dict)
                else None
            )
            notice = notice_named.get("notice") if isinstance(notice_named, dict) else None
            if not isinstance(notice, dict) \
                    or notice.get("present") is not True \
                    or notice.get("within_viewport") is not True \
                    or notice.get("registered_safe_region") is not True \
                    or notice.get("role") not in {"alert", "status"}:
                failures.append("overlay active-notice safe-region receipt did not pass")
        audits_ok(
            overlays.get("axe"),
            {
                "overlays-open-desktop",
                "overlays-open-with-notice",
                "overlays-open-mobile",
            },
            "overlay",
        )

    error = contract.get("error_placement")
    if not isinstance(error, dict) or not isinstance(error.get("desktop"), dict) \
            or not isinstance(error.get("mobile"), dict):
        failures.append("dataset-error placement receipt was incomplete")
    elif isinstance(error, dict):
        scroll_resets = error.get("scroll_resets")
        for label, viewport_height in (("desktop", 720), ("mobile", 844)):
            alert = error.get(label)
            reset = scroll_resets.get(label) if isinstance(scroll_resets, dict) else None
            rect = alert.get("rect") if isinstance(alert, dict) else None
            if not isinstance(reset, dict) \
                    or reset.get("main_content_found") is not True \
                    or not numeric_equal(reset.get("window_x"), 0) \
                    or not numeric_equal(reset.get("window_y"), 0) \
                    or not numeric_equal(reset.get("main_content_left"), 0) \
                    or not numeric_equal(reset.get("main_content_top"), 0):
                failures.append(
                    f"{label} dataset-error probe did not reset the workspace scroll container"
                )
            if not isinstance(alert, dict) \
                    or alert.get("immediately_after_chrome") is not True \
                    or alert.get("has_retry") is not True \
                    or alert.get("has_dismiss") is not True \
                    or not isinstance(rect, dict) \
                    or not numeric_at_least(rect.get("top"), 0) \
                    or not numeric_at_least(rect.get("bottom"), 0) \
                    or float(rect.get("bottom", math.inf)) > viewport_height:
                failures.append(f"{label} dataset-error alert placement did not pass")
        audits_ok(
            error.get("axe"),
            {"dataset-error-desktop", "dataset-error-mobile"},
            "dataset-error",
        )
        retry_action = error.get("retry_action")
        if not isinstance(retry_action, dict) \
                or retry_action.get("clicked") is not True \
                or retry_action.get("failure_reappeared") is not True \
                or retry_action.get("dismiss_cleared") is not True:
            failures.append("dataset-error Retry/Dismiss action receipt did not pass")

    async_section = contract.get("async_failures")
    terminal_section = contract.get("terminal_paths")
    if device_scale_factor == 1:
        for section, label in (
            (async_section, "async failure"),
            (terminal_section, "terminal path"),
        ):
            if not isinstance(section, dict) \
                    or section.get("executed") is not False \
                    or section.get("reason") != "DPR2-only acceptance" \
                    or section.get("receipts") not in ({}, []):
                failures.append(f"DPR1 {label} skip receipt was missing or malformed")
    else:
        async_receipts = (
            async_section.get("receipts") if isinstance(async_section, dict) else None
        )
        if not isinstance(async_section, dict) \
                or async_section.get("executed") is not True \
                or async_section.get("reason") is not None \
                or not isinstance(async_receipts, dict):
            failures.append("DPR2 async failure receipt was missing")
        else:
            for name in ("dashboard_load",):
                receipt = async_receipts.get(name)
                if not isinstance(receipt, dict) \
                        or receipt.get("failure_visible") is not True \
                        or receipt.get("retry_visible") is not True \
                        or receipt.get("request_count") != 2 \
                        or receipt.get("recovered") is not True:
                    failures.append(f"{name} failure/retry receipt did not pass")
            workspace_open = async_receipts.get("workspace_open")
            if not isinstance(workspace_open, dict) \
                    or workspace_open.get("failure_visible") is not True \
                    or workspace_open.get("retry_visible") is not True \
                    or workspace_open.get("failure_request_count") not in {1, 2} \
                    or workspace_open.get("retry_request_delta") != 1 \
                    or workspace_open.get("request_count") \
                    != workspace_open.get("failure_request_count", 0) + 1 \
                    or workspace_open.get("recovered") is not True \
                    or workspace_open.get("stale_failure_cleared") is not True:
                failures.append("workspace_open failure/retry/stale receipt did not pass")
            sharing_load = async_receipts.get("sharing_load")
            if not isinstance(sharing_load, dict) \
                    or sharing_load.get("failure_visible") is not True \
                    or sharing_load.get("retry_visible") is not True \
                    or sharing_load.get("failure_request_count") not in {1, 2} \
                    or sharing_load.get("retry_request_count") not in {1, 2} \
                    or sharing_load.get("request_count") \
                    != sharing_load.get("failure_request_count", 0) \
                    + sharing_load.get("retry_request_count", 0) \
                    or sharing_load.get("recovered") is not True:
                failures.append("sharing_load failure/retry receipt did not pass")
            for name in ("dashboard_create", "sharing_mutation", "rename"):
                receipt = async_receipts.get(name)
                recovered_key = (
                    "recovered_navigation" if name == "dashboard_create" else "recovered"
                )
                if not isinstance(receipt, dict) \
                        or receipt.get("failure_visible") is not True \
                        or receipt.get("retry_visible") is not True \
                        or receipt.get("request_count") != 2 \
                        or receipt.get("disabled_while_pending") is not True \
                        or receipt.get("duplicate_submit_blocked") is not True \
                        or receipt.get(recovered_key) is not True:
                    failures.append(f"{name} mutation/no-double-submit receipt did not pass")
            rename = async_receipts.get("rename")
            if not isinstance(rename, dict) or rename.get("success_announced") is not True:
                failures.append("rename success announcement receipt did not pass")
            sharing_cancel = async_receipts.get("sharing_cancel")
            if not isinstance(sharing_cancel, dict) \
                    or sharing_cancel.get("request_count") not in {1, 2} \
                    or sharing_cancel.get("dialog_closed") is not True \
                    or sharing_cancel.get("stale_status_suppressed") is not True:
                failures.append("sharing cancel/stale-ordering receipt did not pass")
            transport = async_receipts.get("transport")
            if not isinstance(transport, dict) \
                    or transport.get("injected") is not True \
                    or transport.get("failure_visible") is not True \
                    or transport.get("retry_visible") is not True \
                    or transport.get("rejected_send_frame_delta") != 0 \
                    or transport.get("retry_send_frame_delta") != 1 \
                    or transport.get("reconnect_created_socket") is not True \
                    or transport.get("recovery_attempt_reached_server") is not True \
                    or transport.get("dismissed") is not True:
                failures.append("transport disconnect/reconnect receipt did not pass")

        terminal_receipts = (
            terminal_section.get("receipts")
            if isinstance(terminal_section, dict)
            else None
        )
        if not isinstance(terminal_section, dict) \
                or terminal_section.get("executed") is not True \
                or terminal_section.get("reason") is not None \
                or not isinstance(terminal_receipts, list):
            failures.append("DPR2 terminal path receipt was missing")
        else:
            terminal_by_mode = {
                receipt.get("mode"): receipt
                for receipt in terminal_receipts
                if isinstance(receipt, dict)
            }
            for mode in ("gpu-worker-crash", "gpu-device-loss", "decode-terminal"):
                receipt = terminal_by_mode.get(mode)
                if not isinstance(receipt, dict) \
                        or receipt.get("injected") is not True \
                        or receipt.get("ready_before") is not True \
                        or receipt.get("recovered") is not True \
                        or receipt.get("worker_recreated") is not True \
                        or receipt.get("alert_cleared") is not True \
                        or not isinstance(receipt.get("surfaced"), dict):
                    failures.append(f"{mode} terminal recovery receipt did not pass")
                    continue
                surfaced = receipt["surfaced"]
                expected_action = (
                    "Reload viewer" if mode == "decode-terminal" else "Restart renderer"
                )
                if receipt.get("recovery_action") != expected_action:
                    failures.append(f"{mode} truthful recovery action was missing")
                recovery_proof = receipt.get("recovery_proof")
                if not isinstance(recovery_proof, dict) \
                        or recovery_proof.get("runtime_replaced") is not True \
                        or not numeric_at_least(
                            recovery_proof.get("capture_frame_count"), 1,
                        ) \
                        or not numeric_at_least(
                            recovery_proof.get("presented_frame_count"), 1,
                        ) \
                        or not numeric_equal(
                            recovery_proof.get("pending_frame_count"), 0,
                        ):
                    failures.append(
                        f"{mode} replacement did not prove a newly presented frame"
                    )
                workers_before = receipt.get("workers_before")
                workers_after = receipt.get("workers_after")
                if not isinstance(workers_before, dict) \
                        or not isinstance(workers_after, dict):
                    failures.append(f"{mode} raw worker counters were missing")
                elif mode == "decode-terminal":
                    if not numeric_at_least(workers_before.get("decode_active"), 2) \
                            or not numeric_at_least(
                                workers_after.get("decode_active"), 1,
                            ):
                        failures.append(
                            "decode-terminal raw decoder counters contradict recovery"
                        )
                else:
                    before_created = workers_before.get("gpu_created")
                    after_created = workers_after.get("gpu_created")
                    if not numeric_at_least(before_created, 0) \
                            or not numeric_at_least(after_created, 1) \
                            or float(after_created) <= float(before_created) \
                            or not numeric_at_least(
                                workers_after.get("gpu_active"), 1,
                            ):
                        failures.append(
                            f"{mode} raw GPU worker counters contradict recovery"
                        )
                if mode == "gpu-worker-crash" and (
                    surfaced.get("render_error_code") is not None
                    or "worker crash" not in str(surfaced.get("text", "")).lower()
                ):
                    failures.append("GPU worker crash was not independently identified")
                if mode == "gpu-worker-crash":
                    construction_surface = receipt.get("construction_failure_surfaced")
                    if not numeric_equal(
                        receipt.get("construction_failures_injected"), 1,
                    ) or not isinstance(construction_surface, dict) \
                            or construction_surface.get(
                                "recovery_action_visible"
                            ) is not True \
                            or "construction failure" not in str(
                                construction_surface.get("text", ""),
                            ).lower():
                        failures.append(
                            "GPU synchronous construction failure was not visibly retryable"
                        )
                if mode == "gpu-device-loss" and (
                    surfaced.get("render_error_code") != "gpu-device-lost"
                    or "device loss" not in str(surfaced.get("text", "")).lower()
                ):
                    failures.append("GPU device loss was not independently identified")
                if mode == "decode-terminal" and (
                    surfaced.get("dataset_error_kind") != "data"
                    or "decoding stopped" not in str(surfaced.get("text", "")).lower()
                    or "replacement could not start"
                    not in str(surfaced.get("text", "")).lower()
                    or not numeric_at_least(receipt.get("injected_worker_count"), 2)
                    or not numeric_at_least(
                        receipt.get("construction_failures_injected"), 2,
                    )
                ):
                    failures.append("decode terminal exhaustion was not independently identified")

    keyboard = contract.get("keyboard")
    focus_cycle = keyboard.get("drawer_focus_cycle") if isinstance(keyboard, dict) else None
    drawer_focus_wait = keyboard.get("drawer_focus_wait") if isinstance(keyboard, dict) else None
    sidebar_focus = keyboard.get("sidebar_focus") if isinstance(keyboard, dict) else None
    viewer_focus = keyboard.get("viewer_focus") if isinstance(keyboard, dict) else None
    drawer_close_focus = keyboard.get("drawer_close_focus") \
        if isinstance(keyboard, dict) else None
    drawer_trigger_viewport = keyboard.get("drawer_trigger_viewport") \
        if isinstance(keyboard, dict) else None
    if not isinstance(keyboard, dict) \
            or not isinstance(keyboard.get("canvas_name"), str) \
            or "viewer" not in keyboard.get("canvas_name", "").lower() \
            or not isinstance(keyboard.get("canvas_instructions"), str) \
            or not keyboard.get("canvas_instructions", "").strip() \
            or keyboard.get("sidebar_resizer_changed") is not True \
            or keyboard.get("viewer_resizer_changed") is not True \
            or not isinstance(sidebar_focus, dict) \
            or sidebar_focus.get("focused") is not True \
            or not isinstance(viewer_focus, dict) \
            or viewer_focus.get("focused") is not True \
            or not isinstance(drawer_close_focus, dict) \
            or drawer_close_focus.get("focused") is not True \
            or not isinstance(drawer_trigger_viewport, dict) \
            or drawer_trigger_viewport.get("in_viewport") is not True \
            or drawer_trigger_viewport.get("hit_testable") is not True \
            or keyboard.get("drawer_initial_focus_inside") is not True \
            or keyboard.get("drawer_escape_restored_focus") is not True \
            or not isinstance(focus_cycle, dict) \
            or not numeric_at_least(focus_cycle.get("focusable_count"), 2) \
            or focus_cycle.get("initial_inside") is not True \
            or not numeric_at_least(focus_cycle.get("initial_index"), 0) \
            or focus_cycle.get("cycle_start_inside") is not True \
            or not numeric_at_least(focus_cycle.get("cycle_start_index"), 0) \
            or not isinstance(focus_cycle.get("initial_state"), dict) \
            or not isinstance(focus_cycle.get("cycle_start_state"), dict) \
            or not isinstance(focus_cycle.get("forward_states"), list) \
            or not isinstance(focus_cycle.get("backward_states"), list) \
            or not numeric_equal(
                focus_cycle.get("forward_unique_count"),
                focus_cycle.get("focusable_count", math.inf),
            ) \
            or not numeric_equal(
                focus_cycle.get("backward_unique_count"),
                focus_cycle.get("focusable_count", math.inf),
            ) \
            or focus_cycle.get("forward_wrapped_to_start") is not True \
            or focus_cycle.get("backward_wrapped_to_start") is not True \
            or focus_cycle.get("forward_full_cycle_inside") is not True \
            or focus_cycle.get("backward_full_cycle_inside") is not True \
            or not isinstance(keyboard.get("reduced_motion"), dict) \
            or keyboard["reduced_motion"].get("respected") is not True:
        failures.append("keyboard/focus/reduced-motion receipt was incomplete")
    for name, appearance in (
        ("layers resizer", sidebar_focus),
        ("viewer resizer", viewer_focus),
        ("Layers close", drawer_close_focus),
    ):
        if isinstance(appearance, dict) and appearance.get("focused") is True \
                and appearance.get("visible") is not True:
            failures.append(f"{name} focus ring was not visibly indicated")
    if not isinstance(drawer_focus_wait, dict) \
            or drawer_focus_wait.get("state") != "keyboard.layers-dialog-initial-focus" \
            or drawer_focus_wait.get("wait_passed") is not True \
            or drawer_focus_wait.get("target_found") is not True \
            or drawer_focus_wait.get("focus_inside") is not True \
            or drawer_focus_wait.get("expected_focus_found") is not True \
            or drawer_focus_wait.get("expected_focus_matched") is not True:
        active = drawer_focus_wait.get("active_element") \
            if isinstance(drawer_focus_wait, dict) else None
        failures.append(
            "keyboard.layers-dialog-initial-focus did not settle "
            f"(active={active!r})"
        )

    idle = contract.get("idle")
    if not isinstance(idle, dict):
        failures.append("renderer idle/resume acceptance receipt was missing")
    else:
        before = idle.get("before")
        after = idle.get("after")
        resumed = idle.get("resumed")
        before_posted = nested(before, "client", "frames", "posted")
        before_presented = nested(before, "client", "frames", "presented")
        before_worker = nested(before, "client", "worker", "messages")
        before_long_count = nested(before, "mainThread", "longTaskCount")
        before_long_duration = nested(before, "mainThread", "longTaskDurationMs")
        after_posted = nested(after, "client", "frames", "posted")
        after_presented = nested(after, "client", "frames", "presented")
        after_worker = nested(after, "client", "worker", "messages")
        after_long_count = nested(after, "mainThread", "longTaskCount")
        after_long_duration = nested(after, "mainThread", "longTaskDurationMs")
        resumed_posted = nested(resumed, "client", "frames", "posted")
        resumed_presented = nested(resumed, "client", "frames", "presented")
        resumed_worker = nested(resumed, "client", "worker", "messages")

        idle_runtime_stable = (
            isinstance(before, dict)
            and before.get("version") == 1
            and isinstance(after, dict)
            and after.get("version") == 1
            and all(numeric_at_least(value, 0) for value in (
                before_posted,
                before_presented,
                before_worker,
                before_long_count,
                before_long_duration,
                after_posted,
                after_presented,
                after_worker,
                after_long_count,
                after_long_duration,
            ))
            and float(after_posted) == float(before_posted)
            and float(after_presented) == float(before_presented)
            and float(after_worker) == float(before_worker)
            and float(after_long_count) == float(before_long_count)
            and float(after_long_duration) == float(before_long_duration)
            and numeric_equal(nested(after, "client", "frames", "pending"), 0)
            and nested(after, "loop", "animationFramePending") is False
            and nested(after, "loop", "interactiveDirty") is False
            and nested(after, "loop", "residencyDirty") is False
        )
        if idle.get("contract_version") != 1 or idle.get("settled_before") is not True:
            failures.append("renderer did not expose and settle runtime contract version 1")
        samples = idle.get("samples")
        cpu_budget = idle.get("cpu_task_budget_ms")
        raw_samples_ok = isinstance(samples, list) and len(samples) == 3
        passing_cpu_samples = 0
        task_durations: list[float] = []
        script_durations: list[float] = []
        strict_sample_activity = True
        if raw_samples_ok:
            assert isinstance(samples, list)
            for index, sample in enumerate(samples):
                if not isinstance(sample, dict) or sample.get("index") != index \
                        or not numeric_equal(sample.get("duration_ms"), 1000):
                    raw_samples_ok = False
                    strict_sample_activity = False
                    continue
                task_duration = sample.get("cpu_task_duration_delta_ms")
                script_duration = sample.get("cpu_script_duration_delta_ms")
                cpu_sample_ok = (
                    numeric_at_least(task_duration, 0)
                    and numeric_at_least(script_duration, 0)
                    and numeric_equal(cpu_budget, 25)
                    and float(task_duration) <= float(cpu_budget)
                    and float(script_duration) <= float(cpu_budget)
                )
                if cpu_sample_ok:
                    passing_cpu_samples += 1
                if sample.get("quiet_window_passed") is not cpu_sample_ok:
                    raw_samples_ok = False
                if numeric_at_least(task_duration, 0):
                    task_durations.append(float(task_duration))
                if numeric_at_least(script_duration, 0):
                    script_durations.append(float(script_duration))
                strict_fields = (
                    "requested_delta", "fired_delta", "frame_delta", "pending_after",
                    "posted_delta", "presented_delta", "worker_message_delta",
                    "runtime_pending_after", "long_task_count_delta",
                    "long_task_duration_delta_ms",
                )
                sample_before = sample.get("before")
                sample_after = sample.get("after")
                sample_raw_stable = (
                    isinstance(sample_before, dict)
                    and sample_before.get("version") == 1
                    and isinstance(sample_after, dict)
                    and sample_after.get("version") == 1
                    and numeric_equal(
                        nested(sample_before, "client", "frames", "posted"),
                        nested(sample_after, "client", "frames", "posted"),
                    )
                    and numeric_equal(
                        nested(sample_before, "client", "frames", "presented"),
                        nested(sample_after, "client", "frames", "presented"),
                    )
                    and numeric_equal(
                        nested(sample_before, "client", "worker", "messages"),
                        nested(sample_after, "client", "worker", "messages"),
                    )
                    and numeric_equal(
                        nested(sample_before, "mainThread", "longTaskCount"),
                        nested(sample_after, "mainThread", "longTaskCount"),
                    )
                    and numeric_equal(
                        nested(sample_before, "mainThread", "longTaskDurationMs"),
                        nested(sample_after, "mainThread", "longTaskDurationMs"),
                    )
                )
                sample_strict = (
                    all(numeric_equal(sample.get(field), 0) for field in strict_fields)
                    and sample.get("loop_pending_after") is False
                    and sample.get("loop_dirty_after") is False
                    and sample.get("long_task_observer_supported") is True
                    and sample.get("product_activity_zero") is True
                    and sample.get("strict_zero_activity") is True
                    and sample_raw_stable
                )
                strict_sample_activity = strict_sample_activity and sample_strict
        def sample_median(values: list[float]) -> float | None:
            if len(values) != 3:
                return None
            return sorted(values)[1]

        if not raw_samples_ok \
                or not numeric_equal(idle.get("sample_count"), 3) \
                or not numeric_equal(idle.get("required_passing_sample_count"), 2) \
                or not numeric_equal(idle.get("sample_duration_ms"), 1000) \
                or not numeric_equal(idle.get("duration_ms"), 3000) \
                or not numeric_equal(idle.get("passing_sample_count"), passing_cpu_samples) \
                or passing_cpu_samples < 2:
            failures.append("idle browser trace did not pass two of three quiet windows")
        raf_values = (
            idle.get("requested_delta"),
            idle.get("fired_delta"),
            idle.get("frame_delta"),
            idle.get("pending_after"),
        )
        if not all(numeric_at_least(value, 0) for value in raf_values) \
                or not all(numeric_equal(value, 0) for value in raf_values):
            failures.append("idle browser trace exceeded its requestAnimationFrame budget")
        cpu_duration = idle.get("cpu_task_duration_delta_ms")
        script_duration = idle.get("cpu_script_duration_delta_ms")
        if not numeric_equal(cpu_budget, 25) \
                or not numeric_at_least(cpu_duration, 0) \
                or float(cpu_duration) > float(cpu_budget) \
                or not numeric_at_least(script_duration, 0) \
                or float(script_duration) > float(cpu_budget) \
                or not numeric_equal(cpu_duration, sample_median(task_durations)) \
                or not numeric_equal(script_duration, sample_median(script_durations)):
            failures.append("idle main-thread task duration exceeded its CPU budget")
        if not idle_runtime_stable \
                or not numeric_equal(idle.get("posted_delta"), 0) \
                or not numeric_equal(idle.get("presented_delta"), 0) \
                or not numeric_equal(idle.get("worker_message_delta"), 0) \
                or not numeric_equal(idle.get("runtime_pending_after"), 0) \
                or idle.get("loop_pending_after") is not False \
                or idle.get("loop_dirty_after") is not False:
            failures.append("settled viewer performed renderer or worker work while idle")
        if idle.get("long_task_observer_supported") is not True \
                or not numeric_equal(idle.get("long_task_count_delta"), 0) \
                or not numeric_equal(idle.get("long_task_duration_delta_ms"), 0):
            failures.append("idle main thread exceeded the zero-long-task budget")
        if not strict_sample_activity \
                or idle.get("strict_zero_activity") is not True \
                or idle.get("product_activity_zero") is not True:
            failures.append("idle activity was non-zero in at least one quiet window")

        interaction = idle.get("interaction")
        raw_resumed = (
            isinstance(resumed, dict)
            and resumed.get("version") == 1
            and all(numeric_at_least(value, 0) for value in (
                after_posted,
                after_presented,
                after_worker,
                resumed_posted,
                resumed_presented,
                resumed_worker,
            ))
            and float(resumed_posted) > float(after_posted)
            and float(resumed_presented) > float(after_presented)
            and float(resumed_worker) > float(after_worker)
            and numeric_equal(nested(resumed, "client", "frames", "pending"), 0)
            and nested(resumed, "loop", "animationFramePending") is False
            and nested(resumed, "loop", "interactiveDirty") is False
            and nested(resumed, "loop", "residencyDirty") is False
        )
        if not isinstance(interaction, dict) \
                or interaction.get("settled_after") is not True \
                or interaction.get("posted_advanced") is not True \
                or interaction.get("presented_advanced") is not True \
                or interaction.get("worker_messages_advanced") is not True \
                or not numeric_equal(interaction.get("pending_after"), 0) \
                or not raw_resumed:
            failures.append("real keyboard interaction did not resume and settle a presented frame")

    audits_ok(
        contract.get("axe"),
        {"desktop-1280x720", "mobile-390x844"},
        "settled viewer",
    )

    if device_scale_factor == 2:
        first_run = contract.get("first_run")
        requested = isinstance(first_run, dict) and first_run.get("requested") is True
        if require_first_run and not requested:
            failures.append("required DPR2 first-run acceptance was not requested")
        if requested:
            assert isinstance(first_run, dict)
            browser_events = first_run.get("browser_events")
            events = [
                event for event in browser_events
                if isinstance(event, dict)
            ] if isinstance(browser_events, list) else []
            event_kinds = {event.get("kind") for event in events}
            received_types = {
                event.get("message_type") for event in events
                if event.get("kind") == "websocket-frame-received"
            }
            sent_types = {
                event.get("message_type") for event in events
                if event.get("kind") == "websocket-frame-sent"
            }
            fatal_browser_events = [
                event for event in events
                if event.get("kind") in {"pageerror", "websocket-error"}
                or (
                    event.get("kind") == "console"
                    and any(
                        marker in str(event.get("text", "")).lower()
                        for marker in (
                            "[bridge] bad snapshot",
                            "gpuvalidationerror",
                            "uncaptured webgpu error",
                            "device lost",
                            "device was lost",
                            "webgpu fatal",
                        )
                    )
                )
            ]
            if "websocket-open" not in event_kinds or "snapshot" not in received_types:
                failures.append("first-run browser did not establish and receive a workspace snapshot")
            if "open_remote_dataset" not in sent_types:
                failures.append("first-run browser did not send its seeded dataset open")
            sent_seed = next((
                event for event in events
                if event.get("kind") == "websocket-frame-sent"
                and event.get("message_type") == "open_remote_dataset"
                and isinstance(event.get("socket_id"), int)
                and isinstance(event.get("request_id"), str)
                and bool(event.get("request_id"))
                and isinstance(event.get("event_index"), int)
            ), None)
            received_seed = next((
                event for event in events
                if sent_seed is not None
                and event.get("kind") == "websocket-frame-received"
                and event.get("message_type") == "open_dataset_succeeded"
                and event.get("socket_id") == sent_seed.get("socket_id")
                and event.get("request_id") == sent_seed.get("request_id")
                and isinstance(event.get("event_index"), int)
                and event["event_index"] > sent_seed["event_index"]
                and numeric_at_least(event.get("sequence"), 1)
                and isinstance(event.get("opened_dataset_id"), str)
                and bool(event.get("opened_dataset_id"))
                and event.get("opened_dataset_id") == event.get("summary_dataset_id")
            ), None)
            seed_snapshot = next((
                event for event in events
                if sent_seed is not None
                and event.get("kind") == "websocket-frame-received"
                and event.get("message_type") == "snapshot"
                and event.get("socket_id") == sent_seed.get("socket_id")
                and isinstance(event.get("event_index"), int)
                and event["event_index"] < sent_seed["event_index"]
            ), None)
            seed_transport = first_run.get("seed_open_transport")
            causal_seed_ok = (
                sent_seed is not None
                and received_seed is not None
                and seed_snapshot is not None
                and isinstance(seed_transport, dict)
                and seed_transport.get("matched") is True
                and seed_transport.get("socket_id") == sent_seed.get("socket_id")
                and seed_transport.get("request_id") == sent_seed.get("request_id")
                and seed_transport.get("sent_event_index") == sent_seed.get("event_index")
                and seed_transport.get("success_event_index") == received_seed.get("event_index")
                and seed_transport.get("success_sequence") == received_seed.get("sequence")
                and seed_transport.get("opened_dataset_id")
                == received_seed.get("opened_dataset_id")
            )
            if not causal_seed_ok:
                failures.append("first-run seeded open lacked a correlated authoritative success")
            if fatal_browser_events:
                failures.append("first-run browser recorded a snapshot/transport runtime error")
            if first_run.get("ok") is not True:
                failures.append(
                    "DPR2 first-run acceptance did not pass"
                    f" at {first_run.get('stage', 'unknown')}: "
                    f"{first_run.get('reason', 'no structured reason')}"
                )
            elif first_run.get("stage") != "complete":
                failures.append("DPR2 first-run acceptance omitted its completion stage")
            if first_run.get("required_channel_count") != required_channel_count \
                    or first_run.get("channel_navigation_required") \
                    is not (required_channel_count > 1) \
                    or first_run.get("dashboard_responsive") is not True \
                    or first_run.get("workspace_created") is not True \
                    or first_run.get("dataset_opened") is not True \
                    or first_run.get("sharing_dialog_opened") is not True:
                failures.append("first-run raw workspace/navigation/sharing receipt was incomplete")
            if not numeric_at_least(first_run.get("fixture_channel_count"), required_channel_count):
                failures.append("first-run fixture exposed fewer channels than required")
            if required_channel_count > 1:
                expected = first_run.get("expected_channel_after")
                before_channel = first_run.get("channel_before")
                fixture_channel_count = first_run.get("fixture_channel_count")
                navigation_baseline_frame = first_run.get("navigation_baseline_frame")
                rendered_frame_after = first_run.get("rendered_frame_after")
                if first_run.get("next_channel_enabled") is not True \
                        or first_run.get("navigation_changed_channel_exactly") is not True \
                        or first_run.get("rendered_channel_wait_matched") is not True \
                        or not numeric_at_least(before_channel, 0) \
                        or not numeric_equal(expected, float(before_channel) + 1) \
                        or not numeric_at_least(fixture_channel_count, float(expected) + 1) \
                        or first_run.get("channel_after") != expected \
                        or first_run.get("rendered_channel_after") != expected \
                        or first_run.get("rendered_layer_channel_after") != expected \
                        or not numeric_at_least(navigation_baseline_frame, 0) \
                        or not numeric_at_least(
                            rendered_frame_after,
                            float(navigation_baseline_frame) + 1
                            if numeric_at_least(navigation_baseline_frame, 0)
                            else math.inf,
                        ):
                    failures.append("first-run channel navigation was not an exact enabled transition")
                before_digest = first_run.get("canvas_digest_before")
                after_digest = first_run.get("canvas_digest_after")
                if first_run.get("canvas_pixels_changed") is not True \
                        or not isinstance(before_digest, str) \
                        or not isinstance(after_digest, str) \
                        or len(before_digest) != 64 \
                        or len(after_digest) != 64 \
                        or before_digest == after_digest:
                    failures.append("first-run channel transition did not change rendered canvas pixels")
            sharing_focus_wait = first_run.get("sharing_focus_wait")
            if not isinstance(sharing_focus_wait, dict) \
                    or sharing_focus_wait.get("state") \
                    != "first-run.sharing-dialog-initial-focus" \
                    or sharing_focus_wait.get("wait_passed") is not True \
                    or sharing_focus_wait.get("target_found") is not True \
                    or sharing_focus_wait.get("focus_inside") is not True \
                    or sharing_focus_wait.get("expected_focus_found") is not True \
                    or sharing_focus_wait.get("expected_focus_matched") is not True:
                active = sharing_focus_wait.get("active_element") \
                    if isinstance(sharing_focus_wait, dict) else None
                failures.append(
                    "first-run.sharing-dialog-initial-focus did not settle "
                    f"(active={active!r})"
                )
            sharing_focus_appearance = first_run.get("sharing_focus_appearance")
            if first_run.get("sharing_initial_focus_on_close") is True \
                    and isinstance(sharing_focus_appearance, dict) \
                    and sharing_focus_appearance.get("focused") is True \
                    and (sharing_focus_appearance.get("visible") is not True
                         or first_run.get("sharing_initial_focus_visible") is not True):
                failures.append("first-run sharing dialog initial focus was not visibly indicated")
            sharing_focus_restore_wait = first_run.get("sharing_focus_restore_wait")
            if not isinstance(sharing_focus_restore_wait, dict) \
                    or sharing_focus_restore_wait.get("state") \
                    != "first-run.sharing-dialog-focus-restored" \
                    or sharing_focus_restore_wait.get("wait_passed") is not True \
                    or first_run.get("sharing_focus_restored") is not True:
                active = sharing_focus_restore_wait.get("active_element") \
                    if isinstance(sharing_focus_restore_wait, dict) else None
                failures.append(
                    "first-run sharing dialog did not restore focus after Escape "
                    f"(active={active!r})"
                )
            sharing_focus_cycle = first_run.get("sharing_focus_cycle")
            if not isinstance(sharing_focus_cycle, dict) \
                    or not numeric_at_least(sharing_focus_cycle.get("focusable_count"), 2) \
                    or sharing_focus_cycle.get("initial_inside") is not True \
                    or not numeric_at_least(sharing_focus_cycle.get("initial_index"), 0) \
                    or sharing_focus_cycle.get("cycle_start_inside") is not True \
                    or not numeric_at_least(sharing_focus_cycle.get("cycle_start_index"), 0) \
                    or not isinstance(sharing_focus_cycle.get("initial_state"), dict) \
                    or not isinstance(sharing_focus_cycle.get("cycle_start_state"), dict) \
                    or not isinstance(sharing_focus_cycle.get("forward_states"), list) \
                    or not isinstance(sharing_focus_cycle.get("backward_states"), list) \
                    or not numeric_equal(
                        sharing_focus_cycle.get("forward_unique_count"),
                        sharing_focus_cycle.get("focusable_count", math.inf),
                    ) \
                    or not numeric_equal(
                        sharing_focus_cycle.get("backward_unique_count"),
                        sharing_focus_cycle.get("focusable_count", math.inf),
                    ) \
                    or sharing_focus_cycle.get("forward_wrapped_to_start") is not True \
                    or sharing_focus_cycle.get("backward_wrapped_to_start") is not True \
                    or sharing_focus_cycle.get("forward_full_cycle_inside") is not True \
                    or sharing_focus_cycle.get("backward_full_cycle_inside") is not True:
                failures.append("first-run sharing dialog did not trap a complete focus cycle")
            if first_run.get("sharing_focus_contract") is not True:
                failures.append("first-run sharing dialog focus contract did not pass")
            sharing_action = first_run.get("sharing_link_action")
            if not isinstance(sharing_action, dict) \
                    or sharing_action.get("before") != "restricted" \
                    or sharing_action.get("after") != "anyone_with_link" \
                    or sharing_action.get("updated") is not True \
                    or sharing_action.get("status") != "Link access updated.":
                failures.append("first-run sharing dialog did not persist a usable link action")
            audits_ok(first_run.get("axe"), {"sharing-dialog-open"}, "first-run sharing")

    return list(dict.fromkeys(failures))


def _content_contract_failures(
    render: dict[str, Any] | None,
    expectation: RealContentExpectation,
    device_scale_factor: int,
) -> list[str]:
    failures: list[str] = []
    if not isinstance(render, dict):
        return ["capture readiness did not expose render metadata"]

    reported_dpr = render.get("device_pixel_ratio")
    if reported_dpr != device_scale_factor:
        failures.append(
            f"browser reported devicePixelRatio={reported_dpr!r}, expected {device_scale_factor}"
        )

    for axis in ("x", "y"):
        dimension = "width" if axis == "x" else "height"
        backing = render.get(f"canvas_backing_{dimension}")
        client = render.get(f"canvas_client_{dimension}")
        reported_ratio = render.get(f"backing_to_client_{axis}")
        valid_dimensions = all(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and float(value) > 0
            for value in (backing, client)
        )
        actual_ratio = float(backing) / float(client) if valid_dimensions else None
        tolerance = max(0.05, 1.0 / float(client)) if valid_dimensions else 0.05
        if actual_ratio is None \
                or abs(actual_ratio - device_scale_factor) > tolerance \
                or not isinstance(reported_ratio, (int, float)) \
                or isinstance(reported_ratio, bool) \
                or not math.isfinite(float(reported_ratio)) \
                or abs(float(reported_ratio) - actual_ratio) > 1e-6:
            failures.append(
                f"canvas backing/client {axis}-axis ratio was {reported_ratio!r}, "
                f"expected approximately {device_scale_factor}"
            )
    for key in ("canvas_css_width", "canvas_css_height"):
        value = render.get(key)
        if not isinstance(value, (int, float)) \
                or isinstance(value, bool) \
                or not math.isfinite(float(value)) \
                or float(value) <= 0:
            failures.append(f"capture readiness did not record positive {key}")

    datasets = render.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        failures.append("capture readiness did not expose dataset dtype/channel metadata")
        return failures

    data_types = [
        str(data_type).lower()
        for dataset in datasets
        if isinstance(dataset, dict)
        for data_type in (dataset.get("dataTypes") or [])
    ]
    channel_counts = [
        int(count)
        for dataset in datasets
        if isinstance(dataset, dict)
        for count in (dataset.get("channelCounts") or [])
        if isinstance(count, (int, float)) and not isinstance(count, bool)
    ]
    if expectation.require_non_u16 and not any(
        data_type not in {"u16", "uint16"} for data_type in data_types
    ):
        failures.append(f"fixture did not expose a non-u16 intensity dtype: {data_types!r}")
    if max(channel_counts, default=0) < expectation.min_channel_count:
        failures.append(
            f"fixture max channel count {max(channel_counts, default=0)} is below "
            f"required {expectation.min_channel_count}"
        )

    view = render.get("view")
    rendered_layers = view.get("layers") if isinstance(view, dict) else None
    first_layer = (
        rendered_layers[0]
        if isinstance(rendered_layers, list)
        and rendered_layers
        and isinstance(rendered_layers[0], dict)
        else None
    )
    if expectation.expected_channel is not None:
        actual_channel = view.get("c") if isinstance(view, dict) else None
        if actual_channel != expectation.expected_channel:
            failures.append(
                f"rendered channel {actual_channel!r}, expected {expectation.expected_channel}"
            )
        actual_layer_channel = first_layer.get("channel") if first_layer else None
        if actual_layer_channel != expectation.expected_channel:
            failures.append(
                "capture metadata did not expose the expected rendered layer channel: "
                f"{actual_layer_channel!r} != {expectation.expected_channel}"
            )
    if expectation.expected_contrast is not None:
        actual = (
            (first_layer.get("contrastMin"), first_layer.get("contrastMax"))
            if first_layer is not None
            else (None, None)
        )
        expected = expectation.expected_contrast
        if not all(
            isinstance(value, (int, float))
            and abs(float(value) - wanted) <= max(1e-6, abs(wanted) * 1e-6)
            for value, wanted in zip(actual, expected, strict=True)
        ):
            failures.append(f"rendered contrast {actual!r}, expected {expected!r}")
    return failures


def _system_browser_path() -> str | None:
    """The same browser the product CLI would use, for Playwright's executablePath.

    Honors ``LUCIDA_BROWSER`` first (so the floor and matrix use one browser),
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
    """An existing node_modules with the exact browser-harness packages.

    Checks the harness cache and any ``NODE_PATH`` entries, so a warm machine
    skips the npm install entirely (fast path for the loop).
    """
    candidates: list[Path] = [
        _repo_root_from_here() / "lucida-web" / "node_modules",
        _playwright_cache_dir() / "node_modules",
    ]
    node_path = os.environ.get("NODE_PATH")
    if node_path:
        candidates += [Path(part) for part in node_path.split(os.pathsep) if part]
    for modules in candidates:
        if _has_pinned_browser_harness(modules):
            return modules
    return None


def _has_pinned_playwright(modules: Path) -> bool:
    """Whether ``modules`` contains the exact driver approved by the lockfile."""

    manifest = modules / "playwright" / "package.json"
    try:
        package = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return package.get("version") == PLAYWRIGHT_VERSION


def _has_pinned_axe_core(modules: Path) -> bool:
    """Whether ``modules`` contains the exact accessibility engine we approve."""

    manifest = modules / "axe-core" / "package.json"
    try:
        package = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return package.get("version") == AXE_CORE_VERSION


def _has_pinned_browser_harness(modules: Path) -> bool:
    """Whether both reproducible browser-matrix dependencies are available."""

    return _has_pinned_playwright(modules) and _has_pinned_axe_core(modules)


def _ensure_playwright(*, log=print, install_timeout_s: float = 300.0) -> Path:
    """Return a node_modules dir with the pinned browser harness; install if needed.

    Fast path: reuse an already-resolvable copy (harness cache or NODE_PATH).
    Otherwise install the exact repository Playwright and axe-core versions (no
    browser download — we reuse the system Chrome) into the harness cache.
    Raises :class:`TryoutError` (stage ``config``) if they cannot be provisioned,
    so the caller records a clean skip.
    """
    existing = _resolvable_node_modules()
    if existing is not None:
        log(f"[tryout] web matrix: reusing cached browser harness at {existing}")
        return existing

    npm = shutil.which("npm")
    if npm is None:
        raise TryoutError(
            "config",
            "npm not found on PATH; cannot provision Playwright and axe-core for "
            "the real-SPA matrix (set LUCIDA_TRYOUT_PLAYWRIGHT_DIR to a "
            "node_modules that has both exact pins)",
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

    log(
        f"[tryout] web matrix: provisioning Playwright {PLAYWRIGHT_VERSION} and "
        f"axe-core {AXE_CORE_VERSION} "
        f"into {cache_dir} (npm install) ..."
    )
    env = dict(os.environ)
    # Don't download browser binaries; the matrix reuses the system Chrome.
    env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
    try:
        result = run_group(
            [
                npm,
                "install",
                "--no-audit",
                "--no-fund",
                "--loglevel=error",
                f"playwright@{PLAYWRIGHT_VERSION}",
                f"axe-core@{AXE_CORE_VERSION}",
            ],
            cwd=str(cache_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=install_timeout_s,
        )
    except subprocess.TimeoutExpired as error:
        raise TryoutError(
            "config",
            "npm install for the browser harness timed out after "
            f"{install_timeout_s:g}s",
        ) from error
    if result.returncode != 0:
        tail = "\n".join((result.stderr or result.stdout or "").splitlines()[-8:])
        raise TryoutError(
            "config",
            f"npm install browser harness failed (exit {result.returncode}): {tail}",
        )

    modules = cache_dir / "node_modules"
    if not _has_pinned_browser_harness(modules):
        raise TryoutError(
            "config",
            "npm reported success but the exact pinned Playwright and axe-core "
            f"packages are not both under {modules}",
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
        real_content_expectation=_real_content_expectation_from_env(),
        first_run_dataset_path=str(ctx.fixture_path) if ctx.fixture_path is not None else None,
        require_first_run=os.environ.get("LUCIDA_TRYOUT_REQUIRE_FIRST_RUN") == "1",
        log=ctx.log,
    )


def _real_content_expectation_from_env() -> RealContentExpectation:
    """Read optional fixture-specific browser assertions from the environment."""

    def optional_int(name: str) -> int | None:
        raw = os.environ.get(name)
        if raw in (None, ""):
            return None
        try:
            return int(raw)
        except ValueError as error:
            raise TryoutError("config", f"{name} must be an integer") from error

    contrast_min = os.environ.get("LUCIDA_TRYOUT_EXPECT_CONTRAST_MIN")
    contrast_max = os.environ.get("LUCIDA_TRYOUT_EXPECT_CONTRAST_MAX")
    if (contrast_min is None) != (contrast_max is None):
        raise TryoutError(
            "config",
            "LUCIDA_TRYOUT_EXPECT_CONTRAST_MIN and _MAX must be set together",
        )
    try:
        contrast = (
            (float(contrast_min), float(contrast_max))
            if contrast_min is not None and contrast_max is not None
            else None
        )
        min_channels = int(os.environ.get("LUCIDA_TRYOUT_MIN_CHANNELS", "1"))
    except ValueError as error:
        raise TryoutError(
            "config",
            "browser expectation values must be finite numbers/integers",
        ) from error
    if contrast is not None and not all(math.isfinite(value) for value in contrast):
        raise TryoutError("config", "expected contrast values must be finite")
    if min_channels < 1:
        raise TryoutError("config", "LUCIDA_TRYOUT_MIN_CHANNELS must be at least 1")
    return RealContentExpectation(
        require_non_u16=os.environ.get("LUCIDA_TRYOUT_REQUIRE_NON_U16") == "1",
        min_channel_count=min_channels,
        expected_channel=optional_int("LUCIDA_TRYOUT_EXPECT_CHANNEL"),
        expected_contrast=contrast,
    )


from . import Surface, register  # noqa: E402  (registry is defined in the package init)

register(
    Surface(
        name="web",
        run=_run,
        description="capture the viewer and require GPU-complete DPR1/2 canvas renders",
    )
)
