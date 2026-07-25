"""The ``drive`` orchestration: bring up, exercise surfaces, capture, tear down.

This is slice 2's counterpart to :mod:`tryout.bringup`. Where ``up`` boots and
immediately tears down, ``drive`` keeps the server *alive* across a tour of one
or more surfaces, then reaps it. It reuses slice 1's spine wholesale rather than
re-implementing any lifecycle:

  * :class:`tryout.server.ServerProcess` — the same context-managed boot /
    health-gate / always-reap server (free port, temp DB, ``LUCIDA_AUTH=disabled``).
  * :func:`tryout.surfaces.create_workspace_and_open` — the same client-driven
    bring-up that creates the workspace and opens the fixture read-only.

On top of that it runs the requested surfaces (CLI, Python, web — discovered from
the surface :data:`tryout.surfaces.REGISTRY`, not a hand-maintained ladder)
against the *one* opened workspace + dataset, writes ``DIR/drive.json`` (mirroring
stdout), and returns a uniform record + exit code.

Invariants (mirroring slice 1):
  * The server is reaped on every path — the ``with ServerProcess(...)`` block
    plus a defensive ``stop()`` in ``finally`` guarantee it.
  * ``drive.json`` is written on success *and* failure, so the human verifier
    always has an artifact.
  * A per-command / per-step failure inside a surface is captured, not fatal.
  * Exit is non-zero only if bring-up failed or a *requested* surface could not
    be exercised at all (e.g. CLI binary missing, Python driver unrunnable).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import capture
from .bringup import validate_fixture
from .errors import TryoutError
from .server import ServerProcess
from .surfaces import REGISTRY, SurfaceResult, create_workspace_and_open, registered_names
from .web import WebDist, resolve_web_dist


# The surfaces this command knows how to drive come from the surface REGISTRY, in
# its canonical tour order (the web surface registers last so the CLI/Python tours
# — which can mutate view state — run first and a maintainer's screenshot reflects
# the post-tour state too). Adding a surface is one registration, not an edit here.
def all_surfaces() -> tuple[str, ...]:
    return tuple(registered_names())


@dataclass(frozen=True)
class DriveOutcome:
    record: dict[str, Any]
    drive_json_path: Path | None
    exit_code: int


@dataclass
class SurfaceContext:
    """Everything a registered surface's ``run`` needs from one live drive cycle.

    The drive loop builds this once the server is up and the fixture is open, then
    hands it to each :class:`tryout.surfaces.Surface`'s ``run`` — so the loop never
    branches per surface, and a surface reads exactly the fields it cares about
    (the CLI/web use ``cli_config_path``; the Python surface uses
    ``py_config_path`` + ``open_timeout_s``; the web surface uses the pre-resolved
    ``web_dist`` / ``web_dist_error``).
    """

    base_url: str
    workspace_id: str
    dataset_id: str | None
    dataset_name: str | None
    out_dir: Path
    py_config_path: Path
    cli_config_path: Path
    open_timeout_s: float
    web_dist: WebDist | None = None
    web_dist_error: TryoutError | None = None
    log: Any = print


def parse_surfaces(raw: str | None) -> list[str]:
    """Parse the ``--surface`` value into an ordered, de-duplicated list.

    Accepts ``all`` (expands to every known surface) or a comma-separated subset
    (``cli``, ``python``). Order is normalized to the canonical tour order so the
    output is stable regardless of how the caller spelled it. Unknown tokens
    raise a ``config`` ``TryoutError`` so a typo fails clearly rather than
    silently running nothing. The known surfaces come from the registry.
    """
    known = all_surfaces()
    if raw is None or raw.strip() == "" or raw.strip().lower() == "all":
        return list(known)
    requested: list[str] = []
    for token in raw.split(","):
        name = token.strip().lower()
        if not name:
            continue
        if name == "all":
            return list(known)
        if name not in known:
            raise TryoutError(
                "config",
                f"unknown surface {name!r}; choose from {', '.join(known)} or 'all'",
            )
        if name not in requested:
            requested.append(name)
    if not requested:
        raise TryoutError("config", "no surfaces selected")
    # Normalize to canonical order.
    return [surface for surface in known if surface in requested]


def surface_render_gate_failed(surface_record: dict[str, Any]) -> bool:
    """Did this surface declare a render gate, and did it fail?

    A *gate* is a promise that one specific property holds. If a gate can print
    FAIL under an OK headline and still exit 0, it is a suggestion, not a gate —
    so this feeds the run verdict.

    Deliberately narrow on both sides. It reads the surface's declared
    ``render_gate`` rather than its ``ok``, so the harness's existing lenient
    treatment of ordinary per-command and per-step failures is untouched; and it
    tests ``ok is False`` rather than falsiness, so a gate that is *unenforced*
    (no browser on this host, ``ok: true, gated: false``) or a surface with no
    gate at all is not swept up.
    """
    gate = surface_record.get("render_gate")
    return isinstance(gate, dict) and gate.get("ok") is False


def drive(
    *,
    out_dir: Path,
    fixture: str | None,
    workspace_name: str,
    surfaces: list[str],
    health_timeout_s: float,
    open_timeout_s: float,
    server_binary: Path | None = None,
    log=print,
) -> DriveOutcome:
    """Run one full drive cycle and return the record + exit code.

    Never raises ``TryoutError`` outward: every failure is caught, recorded into
    ``drive.json``, and turned into a non-zero exit code so the caller's behavior
    is uniform.
    """
    out_dir = out_dir.expanduser()
    if out_dir.exists() and not out_dir.is_dir():
        return _failure(
            out_dir=out_dir,
            error=TryoutError("config", f"--out path exists and is not a directory: {out_dir}"),
            surfaces=surfaces,
            fixture=fixture,
            log=log,
        )
    out_dir.mkdir(parents=True, exist_ok=True)

    # Per-run client config, isolated from the user's real ~/.config/lucida.
    py_config_path = out_dir / "client-config.json"
    cli_config_path = out_dir / "cli-config.json"

    started = time.monotonic()
    try:
        fixture_path = validate_fixture(fixture)
    except TryoutError as error:
        # Pre-boot bad fixture: nothing to tear down, but still write drive.json.
        return _failure(
            out_dir=out_dir, error=error, surfaces=surfaces, fixture=fixture, log=log
        )

    # The web surface needs the server to serve the SPA, which it only does when
    # booted with LUCIDA_WEB_DIST. Resolve (or build) the bundle BEFORE boot so we
    # can point the server at it. A resolution failure is NOT fatal to the whole
    # run: we boot anyway so cli/python still run, and the web surface records a
    # clean ran=False with this error.
    web_dist: WebDist | None = None
    web_dist_error: TryoutError | None = None
    if "web" in surfaces:
        try:
            web_dist = resolve_web_dist(log=log)
        except TryoutError as error:
            web_dist_error = error
            log(f"[tryout] web: SPA bundle unavailable ({error.message}); "
                "web surface will be skipped, other surfaces continue")

    server = ServerProcess(
        out_dir=out_dir,
        binary=server_binary,
        web_dist=(web_dist.path if web_dist is not None else None),
        health_timeout_s=health_timeout_s,
        log=log,
    )

    base_url: str | None = None
    ws_url: str | None = None
    server_log: Path | None = None
    db_path: Path | None = None
    pid: int | None = None
    workspace_id: str | None = None
    dataset_id: str | None = None
    dataset_name: str | None = None
    surface_results: dict[str, dict[str, Any]] = {}
    any_surface_failed = False
    teardown_state = "pending"

    try:
        with server:
            try:
                handle = server.start()
                base_url = handle.base_url
                ws_url = handle.ws_url
                server_log = handle.server_log
                db_path = handle.db_path
                pid = handle.pid

                # Reuse slice 1's bring-up surface: create the workspace and open
                # the fixture read-only via the maintained Python client.
                opened = create_workspace_and_open(
                    base_url=base_url,
                    workspace_name=workspace_name,
                    fixture=fixture_path,
                    config_path=py_config_path,
                    open_timeout=open_timeout_s,
                    log=log,
                )
                workspace_id = opened.workspace_id
                dataset_id = opened.dataset_id
                if opened.ws_url:
                    ws_url = opened.ws_url
                if opened.dataset:
                    dataset_name = opened.dataset.get("name")
            except TryoutError as error:
                # Bring-up failed -> no surface can be exercised. Reap now so the
                # record can report teardown, and return a non-zero failure.
                teardown_state = server.stop()
                eff_server_log = server_log or server.server_log_path
                return _failure(
                    out_dir=out_dir,
                    error=error,
                    surfaces=surfaces,
                    fixture=fixture_path if fixture_path is not None else fixture,
                    base_url=base_url,
                    ws_url=ws_url,
                    server_log=eff_server_log,
                    db_path=db_path or server.db_path,
                    pid=pid or server.pid,
                    workspace_id=workspace_id,
                    dataset_id=dataset_id,
                    teardown=teardown_state,
                    log=log,
                )

            # ---- the server is live and the fixture is open: run surfaces ----
            log(
                f"[tryout] driving surfaces {surfaces} against workspace "
                f"{workspace_id} (dataset {dataset_id})"
            )

            # One context, then iterate the registry generically: no per-surface
            # ladder. Each surface's registered ``run`` pulls what it needs.
            ctx = SurfaceContext(
                base_url=base_url,
                workspace_id=workspace_id,
                dataset_id=dataset_id,
                dataset_name=dataset_name,
                out_dir=out_dir,
                py_config_path=py_config_path,
                cli_config_path=cli_config_path,
                open_timeout_s=open_timeout_s,
                web_dist=web_dist,
                web_dist_error=web_dist_error,
                log=log,
            )
            for name in surfaces:
                surface = REGISTRY[name]
                result: SurfaceResult = surface.run(ctx)
                surface_results[name] = result.to_dict()
                # A surface that could not be exercised at all (ran=False) flips
                # the run not-ok; per-command/per-step failures do not.
                if not result.ran:
                    any_surface_failed = True
                # ...and so does a failed *render gate* (see
                # `surface_render_gate_failed` for why this is narrow).
                if surface_render_gate_failed(surface_results[name]):
                    any_surface_failed = True
                    gate = surface_results[name]["render_gate"]
                    log(
                        f"[tryout] {name} surface: render gate FAILED — "
                        f"{gate.get('reason') or 'no reason given'}"
                    )
    finally:
        # Defensive: guarantee the server is down even on an unexpected escape.
        teardown_state = server.stop()

    extra: dict[str, Any] = {
        "out_dir": str(out_dir),
        "surfaces": surface_results,
        "requested_surfaces": list(surfaces),
        "dataset_name": dataset_name,
        "elapsed_s": round(time.monotonic() - started, 3),
    }

    # ok iff bring-up succeeded (we got here), every requested surface ran
    # without a harness-level error, and no surface's declared render gate
    # failed. Per-command/per-step failures inside a surface are captured and do
    # NOT flip ok to false — but they ARE visible in each surface's passed/total
    # and ok fields.
    ok = not any_surface_failed
    record = _build_record(
        ok=ok,
        base_url=base_url,
        ws_url=ws_url,
        workspace_id=workspace_id,
        out_dir=out_dir,
        server_log=server_log,
        db_path=db_path,
        pid=pid,
        fixture=fixture_path if fixture_path is not None else fixture,
        dataset_id=dataset_id,
        teardown=teardown_state,
        extra=extra,
    )
    drive_json_path = _safe_write_drive_json(out_dir, record, log)
    if drive_json_path is not None:
        record.setdefault("drive_json", str(drive_json_path))
    exit_code = 0 if ok else 1
    return DriveOutcome(record=record, drive_json_path=drive_json_path, exit_code=exit_code)


def _build_record(
    *,
    ok: bool,
    base_url: str | None,
    ws_url: str | None,
    workspace_id: str | None,
    out_dir: Path,
    server_log: Path | None,
    db_path: Path | None,
    pid: int | None,
    fixture: str | None,
    dataset_id: str | None,
    teardown: str,
    extra: dict[str, Any],
) -> dict[str, Any]:
    """Assemble the drive record. Reuses slice 1's record shape for the shared
    keys (so a reader who knows ``up.json`` already knows most of ``drive.json``)
    and layers the drive-specific keys (``surfaces``, ...) on top via ``extra``.
    """
    return capture.build_record(
        ok=ok,
        base_url=base_url,
        ws_url=ws_url,
        workspace_id=workspace_id,
        out_dir=out_dir,
        server_log=server_log,
        db_path=db_path,
        pid=pid,
        fixture=fixture,
        dataset_id=dataset_id,
        # healthz is implied by a successful bring-up; keep the key for parity
        # with up.json so the shapes line up.
        healthz=base_url is not None and workspace_id is not None,
        teardown=teardown,
        extra=extra,
    )


def _failure(
    *,
    out_dir: Path,
    error: TryoutError,
    surfaces: list[str],
    fixture: str | None,
    base_url: str | None = None,
    ws_url: str | None = None,
    server_log: Path | None = None,
    db_path: Path | None = None,
    pid: int | None = None,
    workspace_id: str | None = None,
    dataset_id: str | None = None,
    teardown: str | None = None,
    log=print,
) -> DriveOutcome:
    """Build + persist a uniform failure record (bring-up or pre-boot failure)."""
    extra: dict[str, Any] = {
        "out_dir": str(out_dir),
        "surfaces": {},
        "requested_surfaces": list(surfaces),
        "error": error.to_error(),
    }
    record = capture.build_record(
        ok=False,
        base_url=base_url,
        ws_url=ws_url,
        workspace_id=workspace_id,
        out_dir=out_dir,
        server_log=server_log,
        db_path=db_path,
        pid=pid,
        fixture=fixture,
        dataset_id=dataset_id,
        healthz=False,
        teardown=teardown if teardown is not None else ("clean" if pid is not None else "n/a"),
        extra=extra,
    )
    drive_json_path = _safe_write_drive_json(out_dir, record, log)
    if drive_json_path is not None:
        record.setdefault("drive_json", str(drive_json_path))
    return DriveOutcome(record=record, drive_json_path=drive_json_path, exit_code=1)


def _safe_write_drive_json(out_dir: Path, record: dict[str, Any], log) -> Path | None:
    # Route through the one record writer (capture) so drive.json's on-disk JSON
    # formatting matches up.json and the stdout object exactly.
    try:
        return capture.write_record(out_dir, "drive.json", record)
    except OSError as error:
        log(f"[tryout] WARNING: could not write drive.json: {error}")
        return None
