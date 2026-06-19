"""Resolve (or build) the SPA bundle the server serves for the web surface.

The web surface needs the server to actually serve lucida's single-page app so a
real browser can render the viewer. The server reads ``LUCIDA_WEB_DIST`` and
serves the bundle there (ADR-0020); if it is unset/empty it serves only a
placeholder landing page with no viewer canvas — useless for a screenshot. So
``drive --surface web`` must point the server at a real ``dist/`` *before* boot.

This module owns only that one decision — *which* directory to serve — kept
separate from :mod:`tryout.server` (which owns the process) and the web surface
(which owns the screenshots) so each stays single-purpose:

  * **Fast path (the loop the spec calls out):** if ``LUCIDA_TRYOUT_WEB_DIST``
    points at a directory containing ``index.html``, reuse it verbatim. This is
    the agent/test loop — no build, just serve the prebuilt bundle.
  * **Build path:** otherwise build it from *this working tree* so the bundle
    reflects the checkout, exactly as :mod:`tryout.server` builds the server from
    source: ``wasm-pack build lucida-core --target web --out-dir pkg`` then
    ``pnpm install`` + ``pnpm run build`` in ``lucida-web/``, and serve the
    produced ``lucida-web/dist``.

Either way the returned path is absolute (the server resolves a relative
``LUCIDA_WEB_DIST`` against its own cwd — our throwaway temp dir — which would
not contain the bundle), and is validated to contain ``index.html`` so a boot
against a half-built bundle fails clearly here rather than as a blank screenshot
later.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .errors import TryoutError
from .server import repo_root


# Generous ceilings for the (rare) build path. wasm-pack compiles lucida-core to
# wasm; pnpm bundles the SPA. Both are slow from cold, so these are backstops
# that still guarantee the build can never hang the run.
DEFAULT_WASM_BUILD_TIMEOUT_S = 1800.0
DEFAULT_PNPM_INSTALL_TIMEOUT_S = 900.0
DEFAULT_PNPM_BUILD_TIMEOUT_S = 900.0


@dataclass(frozen=True)
class WebDist:
    """A resolved SPA bundle, with how we got it (for the report)."""

    path: Path           # absolute dir containing index.html (the LUCIDA_WEB_DIST value)
    source: str          # "env" (reused) or "build" (built from the working tree)
    built: bool          # True iff we ran the wasm-pack + pnpm build


def _has_index(directory: Path) -> bool:
    return (directory / "index.html").is_file()


def resolve_web_dist(*, log=print) -> WebDist:
    """Return an absolute SPA-bundle dir for the server to serve.

    Reuses ``LUCIDA_TRYOUT_WEB_DIST`` when it holds an ``index.html`` (fast
    path); otherwise builds the bundle from the working tree. Raises
    :class:`TryoutError` (stage ``config`` / ``build``) on any failure so the web
    surface records a clean ``ran=False`` rather than booting against a missing
    or half-built bundle.
    """
    pointed = os.environ.get("LUCIDA_TRYOUT_WEB_DIST")
    if pointed and pointed.strip():
        candidate = Path(pointed).expanduser()
        if not candidate.exists():
            raise TryoutError(
                "config",
                f"LUCIDA_TRYOUT_WEB_DIST points at a non-existent path: {candidate}",
            )
        if not candidate.is_dir():
            raise TryoutError(
                "config",
                f"LUCIDA_TRYOUT_WEB_DIST is not a directory: {candidate}",
            )
        if not _has_index(candidate):
            raise TryoutError(
                "config",
                f"LUCIDA_TRYOUT_WEB_DIST has no index.html: {candidate} "
                "(point it at a built lucida-web/dist, or unset it to build)",
            )
        absolute = candidate.resolve()
        log(f"[tryout] web: reusing prebuilt SPA bundle {absolute} (LUCIDA_TRYOUT_WEB_DIST)")
        return WebDist(path=absolute, source="env", built=False)

    return _build_web_dist(log=log)


def _build_web_dist(*, log=print) -> WebDist:
    """Build the SPA bundle from the working tree and return its absolute dist dir.

    Mirrors how :mod:`tryout.server` builds the server: tools must be on PATH or
    the caller should set ``LUCIDA_TRYOUT_WEB_DIST`` to a prebuilt bundle.
    """
    root = repo_root()
    core_dir = root / "lucida-core"
    web_dir = root / "lucida-web"
    if not core_dir.is_dir():
        raise TryoutError("build", f"lucida-core not found under {root}; cannot build the SPA")
    if not web_dir.is_dir():
        raise TryoutError("build", f"lucida-web not found under {root}; cannot build the SPA")

    wasm_pack = shutil.which("wasm-pack")
    pnpm = shutil.which("pnpm")
    missing = [
        name
        for name, found in (("wasm-pack", wasm_pack), ("pnpm", pnpm))
        if found is None
    ]
    if missing:
        raise TryoutError(
            "build",
            f"{', '.join(missing)} not found on PATH; install the web toolchain or "
            "set LUCIDA_TRYOUT_WEB_DIST to a prebuilt lucida-web/dist",
        )

    log("[tryout] web: building SPA bundle from the working tree (wasm-pack + pnpm) ...")
    started = time.monotonic()

    _run_build_step(
        [wasm_pack, "build", "--target", "web", "--out-dir", "pkg"],
        cwd=core_dir,
        timeout_s=DEFAULT_WASM_BUILD_TIMEOUT_S,
        what="wasm-pack build (lucida-core)",
        log=log,
    )
    _run_build_step(
        [pnpm, "install", "--frozen-lockfile"],
        cwd=web_dir,
        timeout_s=DEFAULT_PNPM_INSTALL_TIMEOUT_S,
        what="pnpm install (lucida-web)",
        # Fall back to a non-frozen install if there is no/locked lockfile match.
        fallback_argv=[pnpm, "install"],
        log=log,
    )
    _run_build_step(
        [pnpm, "run", "build"],
        cwd=web_dir,
        timeout_s=DEFAULT_PNPM_BUILD_TIMEOUT_S,
        what="pnpm run build (lucida-web)",
        log=log,
    )

    dist = (web_dir / "dist").resolve()
    if not _has_index(dist):
        raise TryoutError(
            "build",
            f"SPA build reported success but {dist}/index.html is missing",
        )
    log(f"[tryout] web: SPA built in {time.monotonic() - started:.1f}s -> {dist}")
    return WebDist(path=dist, source="build", built=True)


def _run_build_step(
    argv: list[str],
    *,
    cwd: Path,
    timeout_s: float,
    what: str,
    log,
    fallback_argv: list[str] | None = None,
) -> None:
    """Run one build step, raising a clear ``build`` TryoutError on failure."""
    try:
        result = subprocess.run(
            argv,
            cwd=str(cwd),
            timeout=timeout_s,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except subprocess.TimeoutExpired as error:
        raise TryoutError("build", f"{what} timed out after {timeout_s:g}s") from error
    if result.returncode != 0:
        if fallback_argv is not None:
            log(f"[tryout] web: {what} failed; retrying with {' '.join(fallback_argv)}")
            _run_build_step(
                fallback_argv, cwd=cwd, timeout_s=timeout_s, what=what, log=log
            )
            return
        tail = "\n".join((result.stdout or "").splitlines()[-40:])
        raise TryoutError(
            "build",
            f"{what} failed (exit {result.returncode})",
            detail={"output_tail": tail},
        )
