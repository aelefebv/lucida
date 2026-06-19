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

from .bringup import bring_up
from .errors import TryoutError


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
        # failure record so even an interrupt yields a usable artifact.
        record = {
            "ok": False,
            "base_url": None,
            "ws_url": None,
            "workspace_id": None,
            "out_dir": str(out_dir),
            "server_log": None,
            "db_path": None,
            "pid": None,
            "fixture": fixture,
            "dataset_id": None,
            "healthz": False,
            "teardown": "clean",
            "error": {
                "stage": "signal",
                "message": f"interrupted by signal {interrupted.signum}",
            },
        }
        _emit(record, as_json=args.json, log=log)
        return 130
    finally:
        _restore_signal_handlers(previous_handlers)

    _emit(outcome.record, as_json=args.json, log=log)
    return outcome.exit_code


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
