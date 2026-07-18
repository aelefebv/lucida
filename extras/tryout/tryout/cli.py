"""Command-line surface for the tryout harness.

Owns argv parsing, the JSON-vs-human stdout split, exit codes, and signal
handling. The lifecycle itself lives in :mod:`tryout.bringup`; this layer stays
thin so the contract surface (``up --once --json --out DIR [--fixture PATH]``)
is easy to read in one place.

Output contract under ``--json``: exactly one JSON object on stdout — the
machine-readable result. All human chatter goes to stderr, so a caller can pipe
stdout straight into ``json.load`` without filtering. On failure under ``--json``
we still print one object, with ``ok: false`` and an ``error`` field.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any

from . import capture
from .bringup import bring_up
from .drive import drive as run_drive, parse_surfaces
from .errors import TryoutError
from .report import run_report
from .surfaces import registered_names


PROG = "tryout.py"
DEFAULT_HEALTH_TIMEOUT_S = 90.0
DEFAULT_OPEN_TIMEOUT_S = 300.0


class _Stderr:
    """A ``log`` callable that writes to stderr so stdout stays pure JSON."""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled

    def __call__(self, message: str) -> None:
        if self.enabled:
            print(message, file=sys.stderr, flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "lucida agent tryout harness: bring up a live lucida-server from the "
            "current working tree, report how to reach it, then tear it down."
        ),
        epilog=(
            "Environment:\n"
            "  LUCIDA_TRYOUT_SERVER_BIN  reuse this prebuilt lucida-server (skip the build)\n"
            "  LUCIDA_TRYOUT_CLI         reuse this prebuilt lucida CLI binary\n"
            "  LUCIDA_TRYOUT_FIXTURE     default --fixture path\n"
            "  LUCIDA_TRYOUT_UV          uv binary used to drive the lucida-py client\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.set_defaults(func=None)
    subparsers = parser.add_subparsers(dest="command", metavar="<command>")

    up = subparsers.add_parser(
        "up",
        help="bring up a live lucida, report it, and (with --once) tear it down",
        description=(
            "Build (or reuse) lucida-server, boot it on a free port with a "
            "throwaway DB and auth disabled, wait for /healthz, create a "
            "workspace, optionally open a fixture read-only, write DIR/server.log "
            "and DIR/up.json, print the result, then tear the server down."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    up.add_argument(
        "--out",
        required=True,
        metavar="DIR",
        help="output directory for server.log and up.json (created if absent)",
    )
    up.add_argument(
        "--fixture",
        metavar="PATH",
        default=None,
        help="OME-Zarr dataset to open read-only (default: $LUCIDA_TRYOUT_FIXTURE)",
    )
    up.add_argument(
        "--json",
        action="store_true",
        help="print one JSON object to stdout (else a human-readable summary)",
    )
    up.add_argument(
        "--once",
        action="store_true",
        help="tear the server down and exit after capturing (the only mode today)",
    )
    up.add_argument(
        "--workspace-name",
        default=None,
        metavar="NAME",
        help="name for the created workspace (default: auto-generated)",
    )
    up.add_argument(
        "--health-timeout",
        type=float,
        default=DEFAULT_HEALTH_TIMEOUT_S,
        metavar="SECONDS",
        help=f"seconds to wait for /healthz (default: {DEFAULT_HEALTH_TIMEOUT_S:g})",
    )
    up.add_argument(
        "--open-timeout",
        type=float,
        default=DEFAULT_OPEN_TIMEOUT_S,
        metavar="SECONDS",
        help=f"seconds to wait for dataset open (default: {DEFAULT_OPEN_TIMEOUT_S:g})",
    )
    up.set_defaults(func=_cmd_up)

    drive = subparsers.add_parser(
        "drive",
        help="bring up a live lucida, exercise its CLI, Python, and web surfaces, capture, tear down",
        description=(
            "Bring up a live lucida (free port, throwaway DB, auth disabled, "
            "fixture opened read-only), then drive a representative agent tour of "
            "the requested surface(s) against the real opened dataset: a sequence "
            "of `lucida` CLI commands, a `LucidaClient` Python session, and/or the "
            "web surface (a non-blank screenshot of the real rendered viewer via "
            "`lucida viewer screenshot`, plus a best-effort real-SPA full-page "
            "capture + browser console). Each CLI command is captured to "
            "DIR/cli/NN-<name>.log, the Python session to DIR/python/session.log, "
            "and the web images to DIR/web/. The full result is written to "
            "DIR/drive.json and printed. A failing command or browser hiccup is "
            "captured without aborting the remaining tour; any required "
            "command, client step, or render failure makes the final verdict "
            "non-zero. The server is always reaped."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    drive.add_argument(
        "--out",
        required=False,
        default=None,
        metavar="DIR",
        help=(
            "output directory for drive.json, server.log, cli/*.log, "
            "python/session.log, web/*.png (required except for "
            "`--scenario list`)"
        ),
    )
    drive.add_argument(
        "--fixture",
        metavar="PATH",
        default=None,
        help="OME-Zarr dataset to open read-only (default: $LUCIDA_TRYOUT_FIXTURE)",
    )
    drive.add_argument(
        "--surface",
        metavar="SURFACES",
        default="all",
        help="comma-separated surfaces to exercise: cli, python, web, or all (default: all)",
    )
    drive.add_argument(
        "--scenario",
        metavar="NAME",
        default=None,
        help=(
            "instead of surfaces, run a named end-to-end scenario (seed -> drive the "
            "real UI by data-testid -> capture named shots). Use 'list' to print "
            "the available scenarios."
        ),
    )
    drive.add_argument(
        "--email",
        action="store_true",
        help=(
            "with --scenario: bundle the captured shots + a summary and hand them to "
            "courier. DRY-RUN by default (preview only, sends nothing)."
        ),
    )
    drive.add_argument(
        "--email-send",
        action="store_true",
        help="with --email: actually send the email (default is dry-run preview only)",
    )
    drive.add_argument(
        "--json",
        action="store_true",
        help="print one JSON object to stdout (else a human-readable summary)",
    )
    drive.add_argument(
        "--workspace-name",
        default=None,
        metavar="NAME",
        help="name for the created workspace (default: auto-generated)",
    )
    drive.add_argument(
        "--health-timeout",
        type=float,
        default=DEFAULT_HEALTH_TIMEOUT_S,
        metavar="SECONDS",
        help=f"seconds to wait for /healthz (default: {DEFAULT_HEALTH_TIMEOUT_S:g})",
    )
    drive.add_argument(
        "--open-timeout",
        type=float,
        default=DEFAULT_OPEN_TIMEOUT_S,
        metavar="SECONDS",
        help=f"seconds to wait for dataset open (default: {DEFAULT_OPEN_TIMEOUT_S:g})",
    )
    drive.set_defaults(func=_cmd_drive)

    report = subparsers.add_parser(
        "report",
        help="run every surface and emit a self-contained PASS/FAIL report.html (+ report.md)",
        description=(
            "The capstone: exercise every surface (reuse `drive --surface all`: "
            "CLI + Python + web) against the opened fixture, then consolidate the "
            "run into a single, self-contained report a human opens to verify "
            "lucida works. Writes report.html (web screenshots EMBEDDED inline as "
            "base64 data-URIs so the file opens/shares standalone, a CLI command "
            "table with exit codes, the Python steps, run metadata, and an obvious "
            "overall PASS/FAIL) plus a report.md mirror, alongside the raw "
            "artifacts (server.log, cli/*.log, python/session.log, web/*.png, "
            "drive.json). With no --out, evidence lands in a gitignored, "
            "timestamped <repo>/.tmp/tryout/<ts>/. The report is written on a failed "
            "run too (a bad fixture or a surface that errored — it shows what failed); "
            "exit is non-zero if the run wasn't fully ok. (An operator interrupt with "
            "Ctrl-C still reaps the server cleanly but may skip the report write.) "
            "Hermetic + always-reaped, reusing prebuilt artifacts."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    report.add_argument(
        "--out",
        metavar="DIR",
        default=None,
        help=(
            "output directory for report.html/report.md + raw artifacts "
            "(default: gitignored <repo>/.tmp/tryout/<timestamp>/)"
        ),
    )
    report.add_argument(
        "--fixture",
        metavar="PATH",
        default=None,
        help="OME-Zarr dataset to open read-only (default: $LUCIDA_TRYOUT_FIXTURE)",
    )
    report.add_argument(
        "--surface",
        metavar="SURFACES",
        default="all",
        help="comma-separated surfaces to exercise: cli, python, web, or all (default: all)",
    )
    report.add_argument(
        "--json",
        action="store_true",
        help="print one JSON object to stdout (else a human-readable summary)",
    )
    report.add_argument(
        "--workspace-name",
        default=None,
        metavar="NAME",
        help="name for the created workspace (default: auto-generated)",
    )
    report.add_argument(
        "--health-timeout",
        type=float,
        default=DEFAULT_HEALTH_TIMEOUT_S,
        metavar="SECONDS",
        help=f"seconds to wait for /healthz (default: {DEFAULT_HEALTH_TIMEOUT_S:g})",
    )
    report.add_argument(
        "--open-timeout",
        type=float,
        default=DEFAULT_OPEN_TIMEOUT_S,
        metavar="SECONDS",
        help=f"seconds to wait for dataset open (default: {DEFAULT_OPEN_TIMEOUT_S:g})",
    )
    report.set_defaults(func=_cmd_report)
    return parser


def _default_workspace_name() -> str:
    return f"lucida-tryout-{time.strftime('%Y%m%d-%H%M%S')}"


def _emit(record: dict[str, Any], *, as_json: bool, log: _Stderr) -> None:
    """Print the result: one JSON object on stdout, or a human summary."""
    if as_json:
        # Exactly one object on stdout. Sorted keys = stable, diffable output.
        print(json.dumps(record, indent=2, sort_keys=True))
        return
    _emit_human(record, log)


def _emit_human(record: dict[str, Any], log: _Stderr) -> None:
    ok = record.get("ok")
    if ok:
        lines = [
            "lucida tryout: UP",
            f"  base_url    : {record.get('base_url')}",
            f"  ws_url      : {record.get('ws_url')}",
            f"  workspace   : {record.get('workspace_id')}",
            f"  dataset     : {record.get('dataset_id')}",
            f"  fixture     : {record.get('fixture')}",
            f"  server_log  : {record.get('server_log')}",
            f"  db_path     : {record.get('db_path')}",
            f"  pid         : {record.get('pid')}",
            f"  out_dir     : {record.get('out_dir')}",
            f"  teardown    : {record.get('teardown')}",
        ]
    else:
        error = record.get("error") or {}
        lines = [
            "lucida tryout: FAILED",
            f"  stage       : {error.get('stage')}",
            f"  message     : {error.get('message')}",
            f"  server_log  : {record.get('server_log')}",
            f"  out_dir     : {record.get('out_dir')}",
            f"  teardown    : {record.get('teardown')}",
        ]
    # Human summary goes to stdout (there's no JSON to protect in this mode).
    print("\n".join(lines))


def _cmd_up(args: argparse.Namespace) -> int:
    log = _Stderr(enabled=True)
    out_dir = Path(args.out)
    fixture = args.fixture or os.environ.get("LUCIDA_TRYOUT_FIXTURE")
    workspace_name = args.workspace_name or _default_workspace_name()

    if not args.once:
        # Only --once exists today; be explicit rather than silently differing.
        log(
            "[tryout] note: only --once mode is implemented; "
            "the server is always torn down after capture."
        )

    # Install a signal handler so SIGINT/SIGTERM unwinds through the
    # ServerProcess context manager (teardown) instead of a hard exit that
    # would orphan the child. We translate the signal into KeyboardInterrupt by
    # raising SystemExit from within bring_up's finally chain via an exception.
    outcome_holder: dict[str, Any] = {}

    def _on_signal(signum, _frame):
        # Raising here propagates through bring_up's `with`/`finally`, reaping
        # the server, then we exit non-zero. Avoid doing real work in-handler.
        raise _Interrupted(signum)

    previous_handlers = _install_signal_handlers(_on_signal)
    try:
        outcome = bring_up(
            out_dir=out_dir,
            fixture=fixture,
            workspace_name=workspace_name,
            health_timeout_s=args.health_timeout,
            open_timeout_s=args.open_timeout,
            log=log,
        )
    except _Interrupted as interrupted:
        # The server has already been reaped by bring_up's finally. Emit a clean
        # failure record (same contract shape, via the one record builder) so even
        # an interrupt yields a usable artifact.
        record = capture.build_record(
            ok=False,
            base_url=None,
            ws_url=None,
            workspace_id=None,
            out_dir=out_dir,
            server_log=None,
            db_path=None,
            pid=None,
            fixture=fixture,
            dataset_id=None,
            healthz=False,
            teardown="clean",
            extra={
                "error": {
                    "stage": "signal",
                    "message": f"interrupted by signal {interrupted.signum}",
                }
            },
        )
        _emit(record, as_json=args.json, log=log)
        return 130
    finally:
        _restore_signal_handlers(previous_handlers)

    _emit(outcome.record, as_json=args.json, log=log)
    return outcome.exit_code


def _cmd_drive(args: argparse.Namespace) -> int:
    log = _Stderr(enabled=True)
    fixture = args.fixture or os.environ.get("LUCIDA_TRYOUT_FIXTURE")
    workspace_name = args.workspace_name or _default_workspace_name()

    # --scenario takes a different path: run ONE named end-to-end scenario
    # (seed -> drive the real UI by testid -> capture) instead of the surface
    # tour. It owns its own bring-up/teardown + JSON shape. `--scenario list`
    # needs no --out; everything else does.
    if args.scenario is not None:
        if args.scenario.strip().lower() != "list" and not args.out:
            return _missing_out(args, log)
        out_dir = Path(args.out) if args.out else None
        return _cmd_drive_scenario(args, log=log, out_dir=out_dir, fixture=fixture,
                                   workspace_name=workspace_name)

    if not args.out:
        return _missing_out(args, log)
    out_dir = Path(args.out)

    # Parse --surface up front so a typo fails clearly (and, under --json, as a
    # uniform error envelope) before we boot anything.
    try:
        surfaces = parse_surfaces(args.surface)
    except TryoutError as error:
        record = {
            "ok": False,
            "out_dir": str(out_dir),
            "surfaces": {},
            "teardown": "n/a",
            "error": error.to_error(),
        }
        _emit_drive(record, as_json=args.json, log=log)
        return 1

    def _on_signal(signum, _frame):
        raise _Interrupted(signum)

    previous_handlers = _install_signal_handlers(_on_signal)
    try:
        outcome = run_drive(
            out_dir=out_dir,
            fixture=fixture,
            workspace_name=workspace_name,
            surfaces=surfaces,
            health_timeout_s=args.health_timeout,
            open_timeout_s=args.open_timeout,
            log=log,
        )
    except _Interrupted as interrupted:
        # The server has already been reaped by drive()'s finally. Emit a clean
        # failure record so even an interrupt yields a usable artifact.
        record = {
            "ok": False,
            "out_dir": str(out_dir),
            "workspace_id": None,
            "dataset_id": None,
            "surfaces": {},
            "teardown": "clean",
            "error": {
                "stage": "signal",
                "message": f"interrupted by signal {interrupted.signum}",
            },
        }
        _emit_drive(record, as_json=args.json, log=log)
        return 130
    finally:
        _restore_signal_handlers(previous_handlers)

    _emit_drive(outcome.record, as_json=args.json, log=log)
    return outcome.exit_code


def _emit_drive(record: dict[str, Any], *, as_json: bool, log: _Stderr) -> None:
    if as_json:
        print(json.dumps(record, indent=2, sort_keys=True))
        return
    _emit_drive_human(record, log)


def _emit_drive_human(record: dict[str, Any], log: _Stderr) -> None:
    ok = record.get("ok")
    surfaces = record.get("surfaces") or {}
    lines = [
        f"lucida tryout drive: {'OK' if ok else 'FAILED'}",
        f"  out_dir     : {record.get('out_dir')}",
        f"  workspace   : {record.get('workspace_id')}",
        f"  dataset     : {record.get('dataset_id')}",
        f"  server_log  : {record.get('server_log')}",
        f"  teardown    : {record.get('teardown')}",
    ]
    cli = surfaces.get("cli")
    if cli is not None:
        if cli.get("ran"):
            lines.append(
                f"  cli         : {cli.get('passed')}/{cli.get('total')} ok"
                f" -> {cli.get('log_dir')}"
            )
            for command in cli.get("commands", []):
                mark = "ok" if command.get("ok") else f"exit {command.get('exit_code')}"
                lines.append(f"      - {command.get('name'):<20} {mark}")
        else:
            err = (cli.get("error") or {}).get("message")
            lines.append(f"  cli         : DID NOT RUN ({err})")
    py = surfaces.get("python")
    if py is not None:
        if py.get("ran"):
            steps = py.get("steps", [])
            passed = sum(1 for step in steps if step.get("ok"))
            lines.append(
                f"  python      : {passed}/{len(steps)} steps ok -> {py.get('log')}"
            )
            for step in steps:
                mark = "ok" if step.get("ok") else "ERR"
                lines.append(f"      - {step.get('name'):<20} {mark}")
        else:
            err = (py.get("error") or {}).get("message")
            lines.append(f"  python      : DID NOT RUN ({err})")
    web = surfaces.get("web")
    if web is not None:
        if web.get("ran"):
            verdict = "ok (viewer + DPR1/2 canvas)" if web.get("ok") else "FAILED render gate"
            lines.append(f"  web         : {verdict}")
            lines.append(f"      viewer    : {web.get('viewer_png')}")
            lines.append(f"      url       : {web.get('viewer_url')}")
            for capture in web.get("captures", []):
                if capture.get("ok"):
                    mark = "non-blank"
                else:
                    mark = (capture.get("detail") or {}).get("reason") or "failed"
                lines.append(f"      - {capture.get('name'):<18} {mark}")
            real_spa = web.get("real_spa") or {}
            if real_spa.get("arms"):
                lines.append(
                    f"      browser   : {'passed' if real_spa.get('ok') else 'FAILED'} DPR1/2 matrix"
                )
                for arm in real_spa.get("arms", []):
                    dpr = arm.get("device_scale_factor")
                    mark = "ok" if arm.get("ok") else arm.get("reason") or "failed"
                    lines.append(
                        f"      - DPR{dpr:<13} {mark} -> {arm.get('canvas_png')}"
                    )
                    lines.append(f"        console       -> {arm.get('console_log')}")
            elif real_spa.get("captured"):
                nb = real_spa.get("spa_png_nonblank")
                tag = "non-blank" if nb else ("blank" if nb is False else "")
                lines.append(f"      real-SPA  : captured {tag} -> {real_spa.get('spa_png')}")
            else:
                lines.append(f"      browser   : FAILED ({real_spa.get('reason')})")
        else:
            err = (web.get("error") or {}).get("message")
            lines.append(f"  web         : DID NOT RUN ({err})")
    error = record.get("error")
    if error:
        lines.append(f"  error       : [{error.get('stage')}] {error.get('message')}")
    print("\n".join(lines))


def _missing_out(args: argparse.Namespace, log: "_Stderr") -> int:
    """Uniform error when ``drive`` was invoked without the required ``--out``."""
    message = "drive requires --out DIR (except for `--scenario list`)"
    if getattr(args, "json", False):
        print(json.dumps(
            {"ok": False, "error": {"stage": "config", "message": message}, "teardown": "n/a"},
            indent=2, sort_keys=True,
        ))
    else:
        print(f"lucida tryout drive: FAILED (config): {message}", file=sys.stderr)
    return 2


# --------------------------------------------------------------------------- #
# drive --scenario: run ONE named end-to-end scenario.
# --------------------------------------------------------------------------- #

def _cmd_drive_scenario(
    args: argparse.Namespace,
    *,
    log: "_Stderr",
    out_dir: Path,
    fixture: str | None,
    workspace_name: str,
) -> int:
    # Imported here (not at module top) so the scenario package — which imports
    # Playwright/courier helpers — is only loaded when actually running a
    # scenario, keeping `up`/`drive --surface` startup lean.
    from .scenarios import get as get_scenario, registered_names as scenario_names
    from .scenarios._runner import drive_scenario
    from .bringup import validate_fixture

    name = args.scenario.strip()

    # `--scenario list` prints the available scenarios and exits cleanly.
    if name.lower() == "list":
        return _emit_scenario_list(as_json=args.json)

    scenario = get_scenario(name)
    if scenario is None:
        known = scenario_names()
        message = (
            f"unknown scenario {name!r}; choose from {', '.join(known) or '(none)'} "
            f"or 'list'"
        )
        if args.json:
            print(json.dumps(
                {"ok": False, "mode": "scenario", "scenario": {"name": name, "ok": False},
                 "error": {"stage": "config", "message": message}},
                indent=2, sort_keys=True,
            ))
        else:
            print(f"lucida tryout drive --scenario: FAILED (config): {message}", file=sys.stderr)
        return 1

    # --email-send implies --email (you can't send without bundling). Be lenient.
    email = bool(args.email or args.email_send)

    # Validate the fixture before booting so a bad path fails clearly.
    try:
        fixture_path_str = validate_fixture(fixture)
    except TryoutError as error:
        record = {
            "ok": False,
            "mode": "scenario",
            "out_dir": str(out_dir),
            "scenario": {"name": name, "ok": False},
            "email": {"attempted": False, "dry_run": True, "sent": False, "attachments": []},
            "error": error.to_error(),
        }
        _emit_scenario(record, as_json=args.json, log=log)
        return 1
    fixture_path = Path(fixture_path_str) if fixture_path_str else None

    def _on_signal(signum, _frame):
        raise _Interrupted(signum)

    previous_handlers = _install_signal_handlers(_on_signal)
    try:
        outcome = drive_scenario(
            spec=_spec_for(scenario),
            out_dir=out_dir,
            fixture_path=fixture_path,
            workspace_name=workspace_name,
            health_timeout_s=args.health_timeout,
            open_timeout_s=args.open_timeout,
            email=email,
            email_send=bool(args.email_send),
            log=log,
        )
    except _Interrupted as interrupted:
        record = {
            "ok": False,
            "mode": "scenario",
            "out_dir": str(out_dir),
            "scenario": {"name": name, "ok": False},
            "email": {"attempted": False, "dry_run": True, "sent": False, "attachments": []},
            "error": {"stage": "signal", "message": f"interrupted by signal {interrupted.signum}"},
        }
        _emit_scenario(record, as_json=args.json, log=log)
        return 130
    finally:
        _restore_signal_handlers(previous_handlers)

    _emit_scenario(outcome.record, as_json=args.json, log=log)
    return outcome.exit_code


def _spec_for(scenario):
    """Resolve the :class:`ScenarioSpec` a registered scenario drives.

    The registry stores ``Scenario(name, run, description)`` to mirror the surface
    registry; the framework's :func:`drive_scenario` wants the pure-steps spec. We
    look it up from the scenario's own module (each module exposes ``SPEC``).
    """
    import importlib

    module = importlib.import_module(scenario.run.__module__)
    spec = getattr(module, "SPEC", None)
    if spec is None:
        raise TryoutError("config", f"scenario {scenario.name!r} has no SPEC to drive")
    return spec


def _emit_scenario_list(*, as_json: bool) -> int:
    from .scenarios import REGISTRY, registered_names as scenario_names

    names = scenario_names()
    if as_json:
        print(json.dumps(
            {
                "ok": True,
                "mode": "scenario",
                "scenarios": [
                    {"name": n, "description": REGISTRY[n].description} for n in names
                ],
            },
            indent=2, sort_keys=True,
        ))
        return 0
    if not names:
        print("lucida tryout: no scenarios registered")
        return 0
    print("lucida tryout scenarios:")
    for n in names:
        print(f"  {n:<14} {REGISTRY[n].description}")
    return 0


def _emit_scenario(record: dict[str, Any], *, as_json: bool, log: "_Stderr") -> None:
    if as_json:
        print(json.dumps(record, indent=2, sort_keys=True))
        return
    _emit_scenario_human(record)


def _emit_scenario_human(record: dict[str, Any]) -> None:
    ok = record.get("ok")
    scenario = record.get("scenario") or {}
    email = record.get("email") or {}
    lines = [
        f"lucida tryout scenario '{scenario.get('name')}': {'OK' if ok else 'FAILED'}",
        f"  out_dir     : {record.get('out_dir')}",
        f"  workspace   : {record.get('workspace_id')}",
        f"  dataset     : {record.get('dataset_id')}",
        f"  scenario_dir: {record.get('scenario_dir')}",
        f"  server_log  : {record.get('server_log')}",
        f"  teardown    : {record.get('teardown')}",
    ]
    for shot in scenario.get("shots", []):
        mark = "non-blank" if shot.get("nonblank") else ("blank" if shot.get("exists") else "missing")
        lines.append(f"      - {shot.get('name'):<16} {mark}")
    if email.get("attempted"):
        mode = "dry-run (nothing sent)" if email.get("dry_run") else ("SENT" if email.get("sent") else "send FAILED")
        lines.append(f"  email       : {mode} ({len(email.get('attachments', []))} attachment(s))")
        if email.get("reason"):
            lines.append(f"                {email.get('reason')}")
    error = record.get("error") or (scenario.get("error") if isinstance(scenario, dict) else None)
    if error:
        lines.append(f"  error       : [{error.get('stage')}] {error.get('message')}")
    print("\n".join(lines))


def _cmd_report(args: argparse.Namespace) -> int:
    log = _Stderr(enabled=True)
    # --out is OPTIONAL for report: when omitted we write to a gitignored,
    # timestamped <repo>/.tmp/tryout/<ts>/ (the run_report layer picks it).
    out_dir = Path(args.out) if args.out else None
    fixture = args.fixture or os.environ.get("LUCIDA_TRYOUT_FIXTURE")
    workspace_name = args.workspace_name or _default_workspace_name()

    # Parse --surface up front so a typo fails clearly before we boot anything.
    try:
        surfaces = parse_surfaces(args.surface)
    except TryoutError as error:
        record = {
            "ok": False,
            "out_dir": str(out_dir) if out_dir is not None else None,
            "report_html": None,
            "report_md": None,
            "surfaces": {},
            "error": error.to_error(),
        }
        _emit_report(record, as_json=args.json, log=log)
        return 1

    def _on_signal(signum, _frame):
        raise _Interrupted(signum)

    previous_handlers = _install_signal_handlers(_on_signal)
    try:
        outcome = run_report(
            out_dir=out_dir,
            fixture=fixture,
            workspace_name=workspace_name,
            surfaces=surfaces,
            health_timeout_s=args.health_timeout,
            open_timeout_s=args.open_timeout,
            log=log,
        )
    except _Interrupted as interrupted:
        # The server was reaped by run_report -> drive()'s finally. Emit a clean
        # failure record so even an interrupt yields a usable result.
        record = {
            "ok": False,
            "out_dir": str(out_dir) if out_dir is not None else None,
            "report_html": None,
            "report_md": None,
            "surfaces": {},
            "workspace_id": None,
            "dataset_id": None,
            "error": {
                "stage": "signal",
                "message": f"interrupted by signal {interrupted.signum}",
            },
        }
        _emit_report(record, as_json=args.json, log=log)
        return 130
    finally:
        _restore_signal_handlers(previous_handlers)

    _emit_report(outcome.record, as_json=args.json, log=log)
    return outcome.exit_code


def _emit_report(record: dict[str, Any], *, as_json: bool, log: _Stderr) -> None:
    if as_json:
        print(json.dumps(record, indent=2, sort_keys=True))
        return
    _emit_report_human(record)


def _web_summary_detail(surf: dict[str, Any]) -> str:
    return "viewer non-blank" if surf.get("viewer_png_nonblank") else "viewer BLANK/missing"


def _count_summary_detail(surf: dict[str, Any]) -> str:
    return f"{surf.get('passed')}/{surf.get('total')} ok"


# Per-surface "extra detail" for the human report line, keyed by surface name —
# the web surface reports a render verdict, the others a pass count. Dispatching
# by name (matching the surface registry order) keeps this free of an
# `if name == "web"` branch.
_REPORT_SUMMARY_DETAIL = {
    "cli": _count_summary_detail,
    "python": _count_summary_detail,
    "web": _web_summary_detail,
}


def _emit_report_human(record: dict[str, Any]) -> None:
    ok = record.get("ok")
    surfaces = record.get("surfaces") or {}
    lines = [
        f"lucida tryout report: {'PASS' if ok else 'FAIL'}",
        f"  out_dir     : {record.get('out_dir')}",
        f"  report.html : {record.get('report_html')}",
        f"  report.md   : {record.get('report_md')}",
        f"  workspace   : {record.get('workspace_id')}",
        f"  dataset     : {record.get('dataset_id')}",
        f"  base_url    : {record.get('base_url')}",
        f"  teardown    : {record.get('teardown')}",
    ]
    for name in registered_names():
        surf = surfaces.get(name)
        if surf is None:
            continue
        if not surf.get("ran"):
            err = surf.get("error") or "did not run"
            lines.append(f"  {name:<11} : DID NOT RUN ({err})")
            continue
        verdict = "PASS" if surf.get("ok") else "FAIL"
        detail = _REPORT_SUMMARY_DETAIL.get(name, _count_summary_detail)
        lines.append(f"  {name:<11} : {verdict} ({detail(surf)})")
    error = record.get("error")
    if error:
        lines.append(f"  error       : [{error.get('stage')}] {error.get('message')}")
    print("\n".join(lines))


class _Interrupted(BaseException):
    """Raised from a signal handler to unwind teardown then exit non-zero."""

    def __init__(self, signum: int):
        super().__init__(signum)
        self.signum = signum


def _install_signal_handlers(handler):
    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            previous[sig] = signal.signal(sig, handler)
        except (ValueError, OSError):
            # Not in main thread or unsupported; skip — teardown still runs via
            # the context manager on normal exceptions.
            previous[sig] = None
    return previous


def _restore_signal_handlers(previous) -> None:
    for sig, prev in previous.items():
        if prev is not None:
            try:
                signal.signal(sig, prev)
            except (ValueError, OSError):
                pass


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.func is None:
        parser.print_help(sys.stderr)
        return 2
    try:
        return args.func(args)
    except TryoutError as error:
        # Last-resort guard: bring_up normally catches these, but if one escapes
        # (e.g. from arg handling), emit a uniform failure rather than a stack.
        record = {
            "ok": False,
            "error": error.to_error(),
            "teardown": "n/a",
        }
        as_json = getattr(args, "json", False)
        if as_json:
            print(json.dumps(record, indent=2, sort_keys=True))
        else:
            print(f"lucida tryout: FAILED ({error.stage}): {error.message}", file=sys.stderr)
        return 1
