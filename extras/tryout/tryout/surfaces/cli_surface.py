"""CLI surface: drive the real ``lucida`` binary through an agent-style tour.

This surface runs the *actual* CLI an end user is handed — the prebuilt binary
(``LUCIDA_TRYOUT_CLI``) or ``cargo run -p lucida-cli --`` from the working tree —
against the already-booted, fixture-loaded server. It is deliberately a *broad*
tour: the commands an agent reaches for first when it lands on a fresh lucida and
wants to understand what is there and nudge it — identity/health, workspace and
dataset discovery, dataset info + health, viewer state, and a real mutation —
exercised in BOTH human and ``--json`` form so the captured logs show how the CLI
actually talks.

Design choices that keep it honest and reusable:

  * **Captured, not fatal.** Each command's argv + stdout + stderr + exit code is
    written to ``DIR/cli/NN-<name>.log`` and recorded in the result. A non-zero
    exit is *data* (an agent wants to see what failed), so the tour continues and
    the surface only reports a harness-level error if it could not run the CLI at
    all (binary missing / build failed).
  * **Hermetic.** Every invocation gets ``--server`` pointed at the throwaway
    server and ``LUCIDA_CONFIG_PATH`` redirected into the out dir, so the run
    never reads or writes the user's real ``~/.config/lucida/config.json`` or
    persists a default workspace/token anywhere durable.
  * **Separable.** The tour is a plain list of :class:`CliStep` values built by
    :func:`plan_cli_tour`; the runner just executes and captures. The web surface
    that comes next plugs in the same way.
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


# Per-command wall-clock ceiling. The viewer/state commands open a WS and wait
# for a snapshot; the default CLI timeouts are tens of seconds, so this is a
# generous backstop that still guarantees the tour can never hang.
DEFAULT_COMMAND_TIMEOUT_S = 90.0


@dataclass(frozen=True)
class CliStep:
    """One planned CLI invocation.

    ``name`` is the stable, filesystem-safe slug used for ``NN-<name>.log`` and
    the result entry. ``args`` are the CLI args *after* the injected globals
    (``--server`` and any ``--json``); the runner prepends the binary and the
    connection globals so the plan stays about intent, not plumbing.
    ``allow_failure`` marks steps whose non-zero exit is expected-ish on some
    datasets (so it never taints the harness verdict), but every step is captured
    regardless.
    """

    name: str
    args: tuple[str, ...]
    as_json: bool = False
    allow_failure: bool = False


@dataclass
class CliCommandResult:
    name: str
    argv: list[str]
    exit_code: int | None
    ok: bool
    log: str
    duration_s: float
    timed_out: bool = False


@dataclass
class CliSurfaceResult:
    ran: bool
    ok: bool
    log_dir: str
    commands: list[CliCommandResult] = field(default_factory=list)
    error: dict[str, Any] | None = None

    @property
    def passed(self) -> int:
        return sum(1 for command in self.commands if command.ok)

    @property
    def total(self) -> int:
        return len(self.commands)

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "ran": self.ran,
            "ok": self.ok,
            "log_dir": self.log_dir,
            "passed": self.passed,
            "total": self.total,
            "commands": [
                {
                    "name": command.name,
                    "argv": command.argv,
                    "exit_code": command.exit_code,
                    "ok": command.ok,
                    "log": command.log,
                    "duration_s": command.duration_s,
                    **({"timed_out": True} if command.timed_out else {}),
                }
                for command in self.commands
            ],
        }
        if self.error is not None:
            record["error"] = self.error
        return record


def resolve_cli_invocation(*, log=print) -> tuple[list[str], bool]:
    """Return the argv-prefix that runs the lucida CLI, and whether it is prebuilt.

    Fast path (the loop the spec calls out): ``LUCIDA_TRYOUT_CLI`` points at a
    prebuilt binary -> use it directly. Otherwise fall back to
    ``cargo run -p lucida-cli --`` from the working tree so the CLI reflects this
    checkout's code (matching how :mod:`tryout.server` resolves the server).
    """
    pointed = os.environ.get("LUCIDA_TRYOUT_CLI")
    if pointed:
        candidate = Path(pointed)
        if not candidate.is_file():
            raise TryoutError(
                "config",
                f"LUCIDA_TRYOUT_CLI points at a non-existent file: {candidate}",
            )
        if not os.access(candidate, os.X_OK):
            raise TryoutError(
                "config",
                f"LUCIDA_TRYOUT_CLI is not executable: {candidate}",
            )
        return [str(candidate)], True

    cargo = shutil.which("cargo")
    if cargo is None:
        raise TryoutError(
            "config",
            "cargo not found on PATH; install the Rust toolchain or set "
            "LUCIDA_TRYOUT_CLI to a prebuilt lucida CLI binary",
        )
    log(
        "[tryout] LUCIDA_TRYOUT_CLI unset; driving the CLI via "
        "`cargo run -p lucida-cli --` (working tree). Set LUCIDA_TRYOUT_CLI to skip the build."
    )
    return [cargo, "run", "--quiet", "-p", "lucida-cli", "--"], False


def plan_cli_tour(
    *,
    workspace_id: str,
    dataset_id: str | None,
    dataset_name: str | None,
) -> list[CliStep]:
    """Build the representative agent tour as an ordered list of steps.

    The order mirrors how an agent gets oriented on a fresh lucida: confirm the
    server + identity, discover workspaces, scope into the workspace, discover
    datasets, inspect a dataset's info + health, read viewer state, then make one
    real change and re-read state to show it took. Both ``status`` (human) and
    ``status --json`` (machine) appear so the logs document each output mode, and
    a state mutation (``view set-zoom``) plus a layer read round out coverage.

    Steps that target a specific dataset are only added when the fixture actually
    opened one (``dataset_id`` present), so a no-fixture run still produces a
    coherent, all-passing discovery tour rather than guaranteed failures.
    """
    # Prefer the stable workspace-local dataset id as the selector; fall back to
    # the human name only if the id is somehow absent.
    selector = dataset_id or dataset_name

    steps: list[CliStep] = [
        # --- orientation: who/where am I, is the server healthy? -------------
        CliStep("status", ("status",)),
        CliStep("status-json", ("status",), as_json=True),
        CliStep("server-status-json", ("server", "status"), as_json=True),
        # --- discovery: workspaces -------------------------------------------
        CliStep("workspace-list", ("workspace", "list"), as_json=True),
        CliStep("workspace-info", ("workspace", "info", workspace_id), as_json=True),
        # --- discovery: datasets in the workspace ----------------------------
        CliStep("dataset-list", ("dataset", "list",), as_json=True),
        CliStep("dataset-list-human", ("dataset", "list")),
    ]

    if selector is not None:
        steps += [
            # info + health on the real opened dataset (the heart of the tour)
            CliStep("dataset-info", ("dataset", "info", selector), as_json=True),
            CliStep("dataset-health", ("dataset", "health", selector), as_json=True),
        ]
    else:
        # No dataset opened: still exercise the all-datasets health view.
        steps.append(CliStep("dataset-health-all", ("dataset", "health"), as_json=True))

    steps += [
        # --- viewer state read (human + json) --------------------------------
        CliStep("viewer-state", ("viewer", "state"), as_json=True),
        CliStep("layout-list", ("layout", "list"), as_json=True),
        CliStep("saved-view-list", ("saved-view", "list"), as_json=True),
        # --- a real state mutation, then re-read to prove it took ------------
        CliStep("view-set-zoom", ("view", "set-zoom", "--value", "2.0"), as_json=True),
        CliStep("layer-list", ("layer", "list"), as_json=True),
        CliStep("viewer-state-after", ("viewer", "state"), as_json=True),
    ]

    if selector is not None:
        # A layer-level mutation against the real dataset: bump opacity, then
        # confirm via a follow-up layer list. Marked allow_failure so an
        # unusual dataset shape can't taint the verdict — but it is captured.
        steps += [
            CliStep(
                "layer-opacity",
                ("layer", "opacity", selector, "0.8"),
                as_json=True,
                allow_failure=True,
            ),
        ]

    return steps


def run_cli_surface(
    *,
    base_url: str,
    workspace_id: str,
    dataset_id: str | None,
    dataset_name: str | None,
    out_dir: Path,
    config_path: Path,
    command_timeout_s: float = DEFAULT_COMMAND_TIMEOUT_S,
    log=print,
) -> CliSurfaceResult:
    """Run the CLI tour against ``base_url`` and capture every command.

    Returns a :class:`CliSurfaceResult`. Raises nothing for per-command failures
    (those are captured); only a true inability to run the CLI surfaces as
    ``ran=False`` with an ``error`` envelope so the orchestrator can mark the
    overall run not-ok and exit non-zero (the surface "could not be exercised at
    all").
    """
    log_dir = out_dir / "cli"
    # Start clean so reusing --out across runs can't mix stale per-command logs
    # (different fixtures/plans renumber commands); drive.json stays authoritative.
    import shutil as _shutil
    _shutil.rmtree(log_dir, ignore_errors=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    try:
        prefix, prebuilt = resolve_cli_invocation(log=log)
    except TryoutError as error:
        return CliSurfaceResult(
            ran=False,
            ok=False,
            log_dir=str(log_dir),
            error=error.to_error(),
        )

    # Hermetic CLI config: a throwaway file in the out dir. The CLI persists
    # default workspace/token here (never the user's real config), and we never
    # need to read it back — every command carries explicit globals.
    cli_config = config_path
    env = dict(os.environ)
    env["LUCIDA_CONFIG_PATH"] = str(cli_config)
    # Belt-and-suspenders: also redirect XDG/HOME-derived config discovery so a
    # build of the CLI that ignored LUCIDA_CONFIG_PATH still can't touch the real
    # config tree. LUCIDA_CONFIG_PATH wins, but these bound the blast radius.
    env["XDG_CONFIG_HOME"] = str(out_dir / "xdg-config")

    steps = plan_cli_tour(
        workspace_id=workspace_id,
        dataset_id=dataset_id,
        dataset_name=dataset_name,
    )
    log(
        f"[tryout] CLI surface: {len(steps)} commands against {base_url} "
        f"({'prebuilt binary' if prebuilt else 'cargo run'})"
    )

    commands: list[CliCommandResult] = []
    for index, step in enumerate(steps, start=1):
        result = _run_one(
            index=index,
            step=step,
            prefix=prefix,
            base_url=base_url,
            workspace_id=workspace_id,
            env=env,
            log_dir=log_dir,
            cwd=out_dir,
            command_timeout_s=command_timeout_s,
            log=log,
        )
        commands.append(result)

    # The surface "ran". It is ok iff every *non-allow_failure* command exited 0;
    # an allow_failure command's non-zero exit is captured but never taints ok.
    surface_ok = all(
        command.ok
        for command, step in zip(commands, steps)
        if not step.allow_failure
    )
    return CliSurfaceResult(
        ran=True,
        ok=surface_ok,
        log_dir=str(log_dir),
        commands=commands,
    )


def _run_one(
    *,
    index: int,
    step: CliStep,
    prefix: Sequence[str],
    base_url: str,
    workspace_id: str,
    env: dict[str, str],
    log_dir: Path,
    cwd: Path,
    command_timeout_s: float,
    log,
) -> CliCommandResult:
    """Execute one CLI command, write its log file, and return the record.

    Connection globals (``--server``, ``--workspace``) are injected here so the
    plan stays about intent. ``--json`` is injected for steps that asked for it.
    A timeout is itself a captured failure (never a hang): we record exit_code
    None + ``timed_out`` and move on.
    """
    argv = [
        *prefix,
        "--server",
        base_url,
        "--workspace",
        workspace_id,
    ]
    if step.as_json:
        argv.append("--json")
    argv += list(step.args)

    log_path = log_dir / f"{index:02d}-{step.name}.log"
    started = time.monotonic()
    timed_out = False
    try:
        completed = subprocess.run(
            argv,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=command_timeout_s,
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
            + f"\n[tryout] command timed out after {command_timeout_s:g}s"
        )
    except OSError as error:
        # Failed to even spawn (e.g. binary vanished mid-run). Capture it.
        timed_out = False
        exit_code = None
        stdout = ""
        stderr = f"[tryout] failed to execute command: {error}"

    duration = round(time.monotonic() - started, 3)
    ok = exit_code == 0
    _write_command_log(
        log_path,
        argv=argv,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_s=duration,
        timed_out=timed_out,
    )

    status_word = "ok" if ok else (f"exit {exit_code}" if exit_code is not None else "no-exit")
    log(f"[tryout]   [{index:02d}] {step.name}: {status_word} ({duration:g}s)")

    return CliCommandResult(
        name=step.name,
        argv=argv,
        exit_code=exit_code,
        ok=ok,
        log=str(log_path),
        duration_s=duration,
        timed_out=timed_out,
    )


def _write_command_log(
    path: Path,
    *,
    argv: Sequence[str],
    exit_code: int | None,
    stdout: str,
    stderr: str,
    duration_s: float,
    timed_out: bool,
) -> None:
    """Write a single faithful, human-readable capture for one command.

    Format is greppable and complete (user story 3): a header with the exact
    argv + outcome, then the verbatim stdout and stderr blocks. We also persist a
    one-line JSON header so a machine can parse the outcome without re-running.
    """
    header = {
        "argv": list(argv),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_s": duration_s,
    }
    lines = [
        "# lucida CLI tryout capture",
        "# " + json.dumps(header),
        "$ " + " ".join(_shquote(part) for part in argv),
        f"# exit_code: {exit_code}" + ("  (timed out)" if timed_out else ""),
        f"# duration_s: {duration_s}",
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
        # Capture is best-effort; the in-memory result still records the outcome.
        pass


def _shquote(value: str) -> str:
    """Minimal shell-quoting for the human ``$ ...`` line (display only)."""
    if value and all(
        char.isalnum() or char in "@%+=:,./-_" for char in value
    ):
        return value
    return "'" + value.replace("'", "'\\''") + "'"
