"""The bring-up -> report -> teardown orchestration.

This module owns the *lifecycle as a whole*; :mod:`tryout.server` owns the
server process, :mod:`tryout.surfaces` owns talking to it, and :mod:`tryout.cli`
owns argv and output formatting. Keeping the lifecycle here (rather than in the
CLI) means later headful/daemon modes can reuse the exact same orchestration.

Invariants enforced here:
  * The server is reaped on every path — the ``with ServerProcess(...)`` block
    guarantees it on success, failure, exception, and (via the CLI's signal
    handler) on SIGINT/SIGTERM.
  * ``up.json`` is written on success *and* failure, so the human verifier
    always has an artifact (user story 2), and it always mirrors stdout.
  * Fixtures are validated before boot and opened read-only.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import capture
from .errors import TryoutError
from .server import ServerProcess
from .surfaces import create_workspace_and_open


@dataclass(frozen=True)
class BringUpOutcome:
    record: dict[str, Any]
    up_json_path: Path | None
    exit_code: int


def validate_fixture(fixture: str | None) -> str | None:
    """Resolve + sanity-check the fixture path. Returns the absolute path or None.

    We fail *before* boot on an obviously bad fixture (missing path) so we don't
    spend time booting a server we'll only tear down — but we keep the check
    light (existence + directory-ish) and let the server be the authority on
    whether it's a valid OME-Zarr, since that's its job and its diagnostics are
    richer than ours.

    Public because ``drive`` (a sibling lifecycle) validates the fixture the same
    way before boot; one shared check, not two.
    """
    if not fixture:
        return None
    path = Path(fixture).expanduser()
    if not path.exists():
        raise TryoutError(
            "fixture",
            f"fixture does not exist: {path}",
            detail={"fixture": str(path)},
        )
    return str(path.resolve())


def bring_up(
    *,
    out_dir: Path,
    fixture: str | None,
    workspace_name: str,
    health_timeout_s: float,
    open_timeout_s: float,
    server_binary: Path | None = None,
    log=print,
) -> BringUpOutcome:
    """Run one full bring-up cycle and return the record + exit code.

    Never raises ``TryoutError`` outward: every failure is caught, recorded into
    ``up.json``, and turned into a non-zero exit code so the caller's behavior is
    uniform. (Truly unexpected exceptions still propagate, but teardown has
    already run via the context manager.)
    """
    out_dir = out_dir.expanduser()
    # Fail gracefully (JSON error envelope, not a raw traceback) if --out names an
    # existing non-directory — a bad-input edge that should flow through up.json too.
    if out_dir.exists() and not out_dir.is_dir():
        return _failure_outcome(
            out_dir=out_dir,
            error=TryoutError("config", f"--out path exists and is not a directory: {out_dir}"),
            base_url=None, ws_url=None, server_log=None, db_path=None, pid=None,
            healthz=False, workspace_id=None, dataset_id=None, fixture=fixture,
            extra={}, log=log,
        )
    out_dir.mkdir(parents=True, exist_ok=True)

    # Per-run client config lives under the out dir, isolating it from the
    # user's real ~/.config/lucida/config.json (safe-by-default).
    config_path = out_dir / "client-config.json"

    base_url: str | None = None
    ws_url: str | None = None
    server_log: Path | None = None
    db_path: Path | None = None
    pid: int | None = None
    healthz = False
    workspace_id: str | None = None
    dataset_id: str | None = None
    extra: dict[str, Any] = {}

    started = time.monotonic()
    try:
        fixture_path = validate_fixture(fixture)
    except TryoutError as error:
        # Pre-boot failure: nothing to tear down, but still write up.json.
        return _failure_outcome(
            out_dir=out_dir,
            error=error,
            base_url=None,
            ws_url=None,
            server_log=None,
            db_path=None,
            pid=None,
            healthz=False,
            workspace_id=None,
            dataset_id=None,
            fixture=fixture,
            extra={},
            log=log,
        )

    server = ServerProcess(
        out_dir=out_dir,
        binary=server_binary,
        health_timeout_s=health_timeout_s,
        log=log,
    )
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
                healthz = handle.healthz
                extra["health_elapsed_s"] = handle.health_elapsed_s

                result = create_workspace_and_open(
                    base_url=base_url,
                    workspace_name=workspace_name,
                    fixture=fixture_path,
                    config_path=config_path,
                    open_timeout=open_timeout_s,
                    log=log,
                )
                workspace_id = result.workspace_id
                dataset_id = result.dataset_id
                # Prefer the client-reported ws_url (carries scheme/host exactly
                # as the client will reconnect), falling back to the handle's.
                if result.ws_url:
                    ws_url = result.ws_url
                extra["web_url"] = result.web_url
                if result.dataset is not None:
                    extra["dataset"] = result.dataset
                extra["elapsed_s"] = round(time.monotonic() - started, 3)
            except TryoutError as error:
                # In-band failure (possibly after a partial boot): teardown also
                # runs on exiting the `with`, but do it now so the record can
                # report it. If start() raised mid-boot the success-path locals
                # were never assigned, so fall back to the server's best-known
                # facts — a server WAS spawned and server.log WAS written, and the
                # human verifier needs that log path most precisely when boot fails.
                teardown_state = server.stop()
                eff_server_log = server_log or server.server_log_path
                eff_db_path = db_path or server.db_path
                eff_pid = pid or server.pid
                failure_extra = dict(extra)
                if eff_pid is not None:
                    failure_extra["teardown_at_failure"] = teardown_state
                return _failure_outcome(
                    out_dir=out_dir,
                    error=error,
                    base_url=base_url,
                    ws_url=ws_url,
                    server_log=eff_server_log,
                    db_path=eff_db_path,
                    pid=eff_pid,
                    healthz=healthz,
                    workspace_id=workspace_id,
                    dataset_id=dataset_id,
                    fixture=fixture_path if fixture_path is not None else fixture,
                    extra=failure_extra,
                    log=log,
                )
    finally:
        # Defensive: even if an unexpected exception escaped the with-block,
        # make sure the server is down before we leave this frame.
        teardown_state = server.stop()

    record = capture.build_record(
        ok=True,
        base_url=base_url,
        ws_url=ws_url,
        workspace_id=workspace_id,
        out_dir=out_dir,
        server_log=server_log,
        db_path=db_path,
        pid=pid,
        fixture=fixture_path if fixture_path is not None else fixture,
        dataset_id=dataset_id,
        healthz=healthz,
        teardown=teardown_state,
        extra=extra,
    )
    up_json_path = _safe_write_up_json(out_dir, record, log)
    if up_json_path is not None:
        record.setdefault("up_json", str(up_json_path))
    return BringUpOutcome(record=record, up_json_path=up_json_path, exit_code=0)


def _failure_outcome(
    *,
    out_dir: Path,
    error: TryoutError,
    base_url: str | None,
    ws_url: str | None,
    server_log: Path | None,
    db_path: Path | None,
    pid: int | None,
    healthz: bool,
    workspace_id: str | None,
    dataset_id: str | None,
    fixture: str | None,
    extra: dict[str, Any],
    log,
) -> BringUpOutcome:
    enriched = {**extra, "error": error.to_error()}
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
        healthz=healthz,
        # teardown is "clean" whenever we reached and reaped a server; for a
        # pre-boot failure there was nothing to tear down.
        teardown="clean" if pid is not None else "n/a",
        extra=enriched,
    )
    up_json_path = _safe_write_up_json(out_dir, record, log)
    if up_json_path is not None:
        record.setdefault("up_json", str(up_json_path))
    return BringUpOutcome(record=record, up_json_path=up_json_path, exit_code=1)


def _safe_write_up_json(out_dir: Path, record: dict[str, Any], log) -> Path | None:
    try:
        return capture.write_record(out_dir, "up.json", record)
    except OSError as error:
        log(f"[tryout] WARNING: could not write up.json: {error}")
        return None
