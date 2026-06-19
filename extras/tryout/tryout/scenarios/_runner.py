"""The scenario framework: boot, seed, drive the UI, capture, (email), reap.

This is the shared spine every scenario runs on — the counterpart to
:mod:`tryout.drive` for surfaces. A concrete scenario module stays *pure steps*:
it declares a :class:`ScenarioSpec` (a ``seed`` that returns document commands, a
``program`` of testid-driven UI steps + named shots, the localStorage pins to
install before load, and an ``ok`` verdict over the captured shots). The
framework owns everything else and is the single place the hermetic guarantees
live:

  * **Boot** — reuse slice-1's :class:`tryout.server.ServerProcess` (free port,
    throwaway DB, ``LUCIDA_AUTH=disabled``) booted with ``LUCIDA_WEB_DIST`` so the
    SPA is served, then slice-1's :func:`create_workspace_and_open` to make the
    workspace + open the fixture read-only. The scenario gets ``base_url``,
    ``ws_url``, ``workspace_id``, and the real ``wds-…`` ``dataset_id``.
  * **Seed transport** — :mod:`tryout.scenarios._ws` pushes the scenario's
    document commands over the workspace WS and awaits acks.
  * **Browser** — :mod:`tryout.scenarios._browser` launches one system-Chrome
    Playwright session (the slice-3 launch config), installs the scenario's
    localStorage pins via ``addInitScript`` BEFORE load, and runs the declarative
    UI program, capturing each ``shot`` into ``DIR/<scenario>/<name>.png``.
  * **Capture verdict** — each shot is checked non-blank via the repo's own
    ``scripts/assert_png_nonblank.py``.
  * **Email** — :mod:`tryout.scenarios._courier` bundles the shots + a summary and
    (dry-run by default) hands them to courier.
  * **Reap** — the server is reaped on every path (``with ServerProcess`` +
    a defensive ``stop()``); the browser driver runs in its own process group
    with a hard timeout, so neither the server nor any browser child is orphaned.

A scenario error is graceful: we record it, write whatever shots exist + the
``scenario.json``, and the caller exits non-zero.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from ..errors import TryoutError
from ..server import ServerProcess
from ..surfaces import create_workspace_and_open
from ..web import WebDist, resolve_web_dist
from . import ScenarioResult, ShotResult
from ._browser import UiStep, drive_ui_program
from ._courier import EmailResult, not_attempted, send_email
from ._ws import seed_over_ws


@dataclass
class ScenarioContext:
    """Everything a scenario needs from one booted, fixture-loaded lucida.

    Built once the server is up and the dataset is open, then handed to the
    scenario's ``seed`` and ``program`` builders. ``seed_documents`` and ``shot``
    are convenience handles bound to this run (the framework also drives them, but
    a scenario can call ``ctx.seed_documents([...])`` directly for ad-hoc seeding).
    """

    base_url: str
    ws_url: str
    workspace_id: str
    dataset_id: str | None
    dataset_name: str | None
    out_dir: Path
    scenario_dir: Path
    shots_dir: Path
    config_path: Path
    web_dist: WebDist | None
    open_timeout_s: float
    log: Any = print

    @property
    def workspace_url(self) -> str:
        """The SPA workspace URL the server serves: ``{base_url}/w/{id}``."""
        return f"{self.base_url.rstrip('/')}/w/{self.workspace_id}"

    def seed_documents(self, commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Send document commands over the workspace WS and await their acks."""
        return seed_over_ws(
            ws_url=self.ws_url,
            commands=commands,
            log_path=self.scenario_dir / "ws-seed.log",
            log=self.log,
        )


@dataclass(frozen=True)
class ScenarioSpec:
    """The pure-steps declaration a scenario module provides to the framework.

    Keeping these as plain callables/data (rather than a base class with methods)
    is what makes a scenario module tiny: it returns commands and steps, the
    framework does the rest. ``init_scripts`` are JS strings run via
    ``addInitScript`` before page load (e.g. ``localStorage.setItem(...)``).
    ``ok`` decides the scenario verdict from the captured shots (e.g. require the
    badge/panel/chip shots non-blank).
    """

    name: str
    seed: Callable[[ScenarioContext], list[dict[str, Any]]]
    program: Callable[[ScenarioContext], list[UiStep]]
    init_scripts: Callable[[ScenarioContext], list[str]] = lambda ctx: []
    ok: Callable[[dict[str, ShotResult]], bool] = lambda shots: all(
        s.nonblank for s in shots.values()
    )
    summary: Callable[[ScenarioContext, "ScenarioResult"], str] | None = None
    url: Callable[[ScenarioContext], str] | None = None


def run_scenario(ctx: ScenarioContext, spec: ScenarioSpec) -> ScenarioResult:
    """Run one scenario's pure steps against the booted ctx: seed -> drive -> verdict.

    Returns a :class:`ScenarioResult`. Never raises for an in-scenario failure
    (seed/UI): it records the staged error, keeps whatever shots exist, and lets
    ``ok`` stay false. (Boot/teardown live in the caller :func:`drive_scenario`.)
    """
    result = ScenarioResult(name=spec.name)
    notes = result.notes

    # 1) Seed collaborative state over WS (the scenario decides what).
    try:
        commands = spec.seed(ctx)
    except TryoutError as error:
        result.error = error.to_error()
        notes.append(f"seed planning failed: {error.message}")
        _finalize_shots(result, spec, ctx, [])
        return result

    if commands:
        try:
            acks = ctx.seed_documents(commands)
            notes.append(f"seeded {len(acks)} document command(s)")
        except TryoutError as error:
            result.error = error.to_error()
            notes.append(f"WS seed failed: {error.message}")
            _finalize_shots(result, spec, ctx, [])
            return result
    else:
        notes.append("no seed commands")

    # 2) Drive the SPA via the generic UI program (testid-driven).
    steps = spec.program(ctx)
    init_scripts = spec.init_scripts(ctx)
    url = spec.url(ctx) if spec.url is not None else ctx.workspace_url
    try:
        outcome = drive_ui_program(
            url=url,
            shots_dir=ctx.shots_dir,
            steps=steps,
            init_scripts=init_scripts,
            work_dir=ctx.scenario_dir,
            log=ctx.log,
        )
    except TryoutError as error:
        result.error = error.to_error()
        notes.append(f"browser could not be provisioned: {error.message}")
        _finalize_shots(result, spec, ctx, [])
        return result

    result.extra["ui"] = outcome.to_dict()
    notes.append(f"UI program: {outcome.reason}")
    if not outcome.ran:
        # A required UI step failed; record it but still finalize whatever shots
        # were captured so the human has partial evidence.
        result.error = {"stage": "ui", "message": outcome.reason}

    # 3) Finalize shots: which expected shots exist + are non-blank.
    _finalize_shots(result, spec, ctx, outcome.shots_taken)

    # 4) The scenario's own verdict over its shots (only if the UI completed).
    shot_index = {shot.name: shot for shot in result.shots}
    if outcome.ran:
        result.ok = spec.ok(shot_index)
    else:
        result.ok = False
    return result


def _expected_shot_names(spec: ScenarioSpec, ctx: ScenarioContext) -> list[str]:
    """The shot names the program declares (in order), deduplicated."""
    names: list[str] = []
    for step in spec.program(ctx):
        if step.action == "shot" and step.name and step.name not in names:
            names.append(step.name)
    return names


def _finalize_shots(
    result: ScenarioResult,
    spec: ScenarioSpec,
    ctx: ScenarioContext,
    taken: Sequence[str],
) -> None:
    """Populate ``result.shots`` from the expected shot names + on-disk PNGs."""
    # Lazy import to avoid a cycle at module import time.
    from ..surfaces.web_surface import png_is_nonblank

    taken_set = set(taken)
    for name in _expected_shot_names(spec, ctx):
        path = ctx.shots_dir / f"{name}.png"
        exists = path.is_file()
        nonblank = png_is_nonblank(path) if exists else False
        result.shots.append(
            ShotResult(
                name=name,
                path=str(path) if exists else None,
                nonblank=nonblank,
                exists=exists or (name in taken_set),
            )
        )


def seed_documents(ctx: ScenarioContext, commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Module-level convenience: seed via the context (re-exported for scenarios)."""
    return ctx.seed_documents(commands)


# --------------------------------------------------------------------------- #
# The full lifecycle: boot -> run the scenario -> (email) -> reap.
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class ScenarioOutcome:
    record: dict[str, Any]
    scenario_json_path: Path | None
    exit_code: int


def drive_scenario(
    *,
    spec: ScenarioSpec,
    out_dir: Path,
    fixture_path: Path | None,
    workspace_name: str,
    health_timeout_s: float,
    open_timeout_s: float,
    email: bool,
    email_send: bool,
    server_binary: Path | None = None,
    log=print,
) -> ScenarioOutcome:
    """Boot a live lucida, run ``spec`` against it, optionally email, reap.

    Mirrors :func:`tryout.drive.drive`'s lifecycle: the ``with ServerProcess``
    block plus a defensive ``stop()`` guarantee the server is reaped on every
    path. The scenario JSON is written on success and failure. Returns a uniform
    record + exit code (non-zero if bring-up failed or the scenario was not ok).
    """
    scenario_dir = out_dir / spec.name
    # Shots land directly in DIR/<scenario>/<name>.png (the contract path). The
    # scenario dir also holds the run's logs (ws-seed.log, ui-driver.log,
    # email.log) and scenario.json — all the evidence for one scenario in one
    # place a human can open.
    shots_dir = scenario_dir
    scenario_dir.mkdir(parents=True, exist_ok=True)
    config_path = out_dir / "scenario-config.json"

    started = time.monotonic()

    # The SPA must be served, so resolve the web bundle BEFORE boot (same as the
    # web surface). A scenario inherently needs the UI, so a missing bundle is a
    # hard scenario error (recorded, non-zero) rather than a silent skip.
    web_dist: WebDist | None = None
    try:
        web_dist = resolve_web_dist(log=log)
    except TryoutError as error:
        return _scenario_failure(
            scenario_name=spec.name,
            out_dir=out_dir,
            scenario_dir=scenario_dir,
            error=error,
            log=log,
        )

    server = ServerProcess(
        out_dir=out_dir,
        binary=server_binary,
        web_dist=web_dist.path if web_dist is not None else None,
        health_timeout_s=health_timeout_s,
        log=log,
    )

    base_url: str | None = None
    ws_url: str | None = None
    workspace_id: str | None = None
    dataset_id: str | None = None
    dataset_name: str | None = None
    scenario_result: ScenarioResult | None = None
    email_result: EmailResult = not_attempted()
    teardown_state = "pending"

    try:
        with server:
            try:
                handle = server.start()
                base_url = handle.base_url
                ws_url = handle.ws_url

                opened = create_workspace_and_open(
                    base_url=base_url,
                    workspace_name=workspace_name,
                    fixture=str(fixture_path) if fixture_path is not None else None,
                    config_path=config_path,
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
                teardown_state = server.stop()
                return _scenario_failure(
                    scenario_name=spec.name,
                    out_dir=out_dir,
                    scenario_dir=scenario_dir,
                    error=error,
                    base_url=base_url,
                    ws_url=ws_url,
                    workspace_id=workspace_id,
                    dataset_id=dataset_id,
                    teardown=teardown_state,
                    log=log,
                )

            ctx = ScenarioContext(
                base_url=base_url,
                ws_url=ws_url,
                workspace_id=workspace_id,
                dataset_id=dataset_id,
                dataset_name=dataset_name,
                out_dir=out_dir,
                scenario_dir=scenario_dir,
                shots_dir=shots_dir,
                config_path=config_path,
                web_dist=web_dist,
                open_timeout_s=open_timeout_s,
                log=log,
            )
            log(
                f"[tryout] running scenario {spec.name!r} against workspace "
                f"{workspace_id} (dataset {dataset_id})"
            )
            scenario_result = run_scenario(ctx, spec)

            # Email step (bundle shots + summary -> courier). Dry-run by default.
            if email:
                shot_paths = [Path(s.path) for s in scenario_result.shots if s.path]
                summary = _build_summary(spec, ctx, scenario_result)
                email_result = send_email(
                    scenario_name=spec.name,
                    shots=shot_paths,
                    summary=summary,
                    out_dir=scenario_dir,
                    send=email_send,
                    log=log,
                )
    finally:
        teardown_state = server.stop()

    elapsed = round(time.monotonic() - started, 3)

    # Write the scenario.json (the scenario result alone) for the human verifier.
    if scenario_result is not None:
        _safe_write_json(scenario_dir / "scenario.json", scenario_result.to_dict(), log)

    scenario_ok = bool(scenario_result is not None and scenario_result.ok)
    record = _build_record(
        scenario_result=scenario_result,
        email_result=email_result if email else not_attempted(),
        base_url=base_url,
        ws_url=ws_url,
        workspace_id=workspace_id,
        dataset_id=dataset_id,
        dataset_name=dataset_name,
        out_dir=out_dir,
        scenario_dir=scenario_dir,
        server_log=server.server_log_path,
        teardown=teardown_state,
        elapsed_s=elapsed,
        ok=scenario_ok,
    )
    scenario_json_path = _safe_write_json(out_dir / "drive.json", record, log)
    if scenario_json_path is not None:
        record.setdefault("drive_json", str(scenario_json_path))
    return ScenarioOutcome(
        record=record,
        scenario_json_path=scenario_json_path,
        exit_code=0 if scenario_ok else 1,
    )


def _build_summary(spec: ScenarioSpec, ctx: ScenarioContext, result: ScenarioResult) -> str:
    if spec.summary is not None:
        return spec.summary(ctx, result)
    lines = [
        f"lucida tryout — scenario '{spec.name}': {'OK' if result.ok else 'NOT OK'}",
        f"workspace: {ctx.workspace_id}  dataset: {ctx.dataset_id}",
        f"url: {ctx.workspace_url}",
        "",
        "Shots:",
    ]
    for shot in result.shots:
        mark = "non-blank" if shot.nonblank else ("blank" if shot.exists else "missing")
        lines.append(f"  - {shot.name}: {mark}")
    if result.notes:
        lines.append("")
        lines.append("Notes:")
        lines += [f"  - {note}" for note in result.notes]
    return "\n".join(lines)


def _build_record(
    *,
    scenario_result: ScenarioResult | None,
    email_result: EmailResult,
    base_url: str | None,
    ws_url: str | None,
    workspace_id: str | None,
    dataset_id: str | None,
    dataset_name: str | None,
    out_dir: Path,
    scenario_dir: Path,
    server_log: Path | None,
    teardown: str,
    elapsed_s: float,
    ok: bool,
) -> dict[str, Any]:
    """Assemble the top-level drive JSON for a ``--scenario`` run.

    Folds the scenario result under ``scenario`` and the email outcome under
    ``email``, alongside the run metadata a reader expects from a drive record
    (workspace/dataset/server_log/teardown).
    """
    return {
        "ok": ok,
        "mode": "scenario",
        "base_url": base_url,
        "ws_url": ws_url,
        "workspace_id": workspace_id,
        "dataset_id": dataset_id,
        "dataset_name": dataset_name,
        "out_dir": str(out_dir),
        "scenario_dir": str(scenario_dir),
        "server_log": str(server_log) if server_log is not None else None,
        "teardown": teardown,
        "elapsed_s": elapsed_s,
        "scenario": scenario_result.to_dict() if scenario_result is not None else None,
        "email": email_result.to_dict(),
    }


def _scenario_failure(
    *,
    scenario_name: str,
    out_dir: Path,
    scenario_dir: Path,
    error: TryoutError,
    base_url: str | None = None,
    ws_url: str | None = None,
    workspace_id: str | None = None,
    dataset_id: str | None = None,
    teardown: str | None = None,
    log=print,
) -> ScenarioOutcome:
    """Build + persist a uniform failure record (boot / bundle / bring-up failure)."""
    scenario_result = ScenarioResult(
        name=scenario_name,
        ok=False,
        error=error.to_error(),
        notes=[f"scenario could not start: {error.message}"],
    )
    _safe_write_json(scenario_dir / "scenario.json", scenario_result.to_dict(), log)
    record = _build_record(
        scenario_result=scenario_result,
        email_result=not_attempted(),
        base_url=base_url,
        ws_url=ws_url,
        workspace_id=workspace_id,
        dataset_id=dataset_id,
        dataset_name=None,
        out_dir=out_dir,
        scenario_dir=scenario_dir,
        server_log=None,
        teardown=teardown if teardown is not None else "n/a",
        elapsed_s=0.0,
        ok=False,
    )
    record["error"] = error.to_error()
    path = _safe_write_json(out_dir / "drive.json", record, log)
    if path is not None:
        record.setdefault("drive_json", str(path))
    return ScenarioOutcome(record=record, scenario_json_path=path, exit_code=1)


def _safe_write_json(path: Path, record: dict[str, Any], log) -> Path | None:
    import json

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path
    except OSError as error:
        log(f"[tryout] WARNING: could not write {path.name}: {error}")
        return None
