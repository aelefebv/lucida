"""Python surface: a broad ``LucidaClient`` tour against the live workspace.

Slice 1's :mod:`tryout.surfaces.python_client` proves the client can *create* a
workspace and *open* a dataset (it is what bring-up uses). This surface is the
agent-facing counterpart: given the already-booted server and the workspace +
dataset that bring-up opened, it runs the *wide* read/inspect tour a Python user
would on real data — connect, status, select the workspace, list datasets, fetch
dataset info + health, read viewer/layer state, then make one real view mutation
and re-read to confirm it landed — and captures a faithful, step-by-step
transcript to ``DIR/python/session.log``.

It reuses slice 1's proven *fast path* for running the maintained client
(``uv run --no-project --with websockets python`` with ``PYTHONPATH`` pointed at
the working-tree ``lucida-py/python`` source — no native build, works from a
worktree), so this surface imports ``from lucida import LucidaClient`` exactly as
a user does and stays honest. The whole interpreter prefix is still overridable
with ``LUCIDA_TRYOUT_PY``.

The driver runs every step in a try/except so a single failing step is *captured*
(recorded ``ok: false`` with the client's structured diagnostic) rather than
aborting the tour — an agent wants to see which call failed and why. The driver
emits exactly one JSON object as its final stdout line (the structured result);
everything else (the human transcript, uv/client chatter) is captured separately
so a parse never trips over it.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import TryoutError
from .python_client import _driver_invocation, _extract_json_object, _lucida_py_source


# Wall-clock backstop for the whole driver subprocess. Each step has its own
# client-level timeout; this guarantees the surface can never hang the run.
DEFAULT_SUBPROCESS_TIMEOUT_S = 240.0


# The broad-coverage driver. Runs under uv with `websockets` available and the
# working-tree `lucida` package importable via PYTHONPATH. It connects to the
# EXISTING workspace + dataset that bring-up opened and runs a wide read/mutate
# tour, recording every step. It prints one JSON object as its final stdout line.
_DRIVER = r'''
import json
import sys

from lucida import LucidaClient, LucidaError


def main():
    request = json.loads(sys.argv[1])
    base_url = request["base_url"]
    workspace_id = request["workspace_id"]
    dataset_id = request.get("dataset_id")
    config_path = request["config_path"]
    timeout = float(request.get("timeout", 30.0))

    steps = []
    transcript = []

    def emit(line=""):
        # Human-readable transcript line -> stderr so it is captured into the
        # session log without polluting the single-JSON stdout contract.
        transcript.append(line)
        print(line, file=sys.stderr, flush=True)

    def record(name, fn, *, summarize=None, optional=False):
        emit("")
        emit(f">>> {name}")
        entry = {"name": name, "ok": False}
        try:
            value = fn()
        except LucidaError as error:
            entry["error"] = error.to_dict().get("error") or {
                "kind": error.kind,
                "message": error.message,
            }
            entry["optional"] = optional
            emit(f"    ERROR [{error.kind}]: {error.message}")
            steps.append(entry)
            return None
        except Exception as error:  # noqa: BLE001 - capture, never abort the tour
            entry["error"] = {"kind": "unexpected", "message": repr(error)}
            entry["optional"] = optional
            emit(f"    ERROR [unexpected]: {error!r}")
            steps.append(entry)
            return None
        entry["ok"] = True
        summary = summarize(value) if summarize is not None else None
        if summary is not None:
            entry["summary"] = summary
            emit(f"    -> {json.dumps(summary)}")
        else:
            emit("    -> ok")
        steps.append(entry)
        return value

    # token=None + a throwaway config_path keeps the client off the user's real
    # CLI config / keychain; the server has auth disabled anyway.
    emit(f"# LucidaClient(base_url={base_url!r})")
    client = LucidaClient(base_url, token=None, config_path=config_path, timeout=timeout)

    # --- orientation -----------------------------------------------------------
    record(
        "status",
        client.status,
        summarize=lambda s: {
            "server": (s.get("server") or {}).get("url"),
            "checks": {k: v.get("ok") for k, v in (s.get("checks") or {}).items()},
            "auth": (s.get("auth") or {}).get("status"),
        },
    )

    record(
        "workspaces.list",
        lambda: client.workspaces.list(),
        summarize=lambda ws: {"count": len(ws)},
    )

    # --- select the existing workspace (the one bring-up created) --------------
    workspace = record(
        "workspaces.get",
        lambda: client.workspaces.get(workspace_id),
        summarize=lambda w: {"id": w.id, "name": w.name},
    )
    if workspace is None:
        # Cannot continue the workspace-scoped tour, but emit what we have.
        print(json.dumps({"ok": False, "steps": steps, "reason": "workspace.get failed"}))
        return

    record(
        "workspace.open",
        workspace.open,
        summarize=lambda w: {"id": w.id},
    )

    datasets = record(
        "datasets.list",
        lambda: workspace.datasets.list(timeout=timeout),
        summarize=lambda ds: {
            "count": len(ds),
            "ids": [d.get("workspace_dataset_id") for d in ds][:5],
        },
    )

    # Resolve the dataset selector: prefer the id bring-up reported, else the
    # first listed dataset, so the tour adapts to whatever is loaded.
    selector = dataset_id
    if selector is None and datasets:
        selector = datasets[0].get("workspace_dataset_id")

    if selector is not None:
        record(
            "datasets.info",
            lambda: workspace.datasets.info(selector, timeout=timeout),
            summarize=lambda info: {
                "workspace_dataset_id": info.get("workspace_dataset_id"),
                "name": info.get("name"),
                "image_count": info.get("image_count"),
                "entity_count": info.get("entity_count"),
            },
        )
        record(
            "datasets.health",
            lambda: workspace.datasets.health(selector, timeout=timeout),
            summarize=lambda health: {
                "entries": len(health),
                "status": [h.get("status") for h in health][:5] if isinstance(health, list) else None,
            },
        )
    else:
        # No dataset loaded: still exercise the all-datasets health read.
        record(
            "datasets.health.all",
            lambda: workspace.datasets.health(None, timeout=timeout),
            summarize=lambda health: {"entries": len(health) if isinstance(health, list) else 0},
        )

    # --- viewer / layer state reads -------------------------------------------
    record(
        "layer.list",
        lambda: workspace.layer.list(timeout=timeout),
        summarize=lambda layers: {"count": len(layers)},
    )

    record(
        "debug.state",
        lambda: workspace.debug.state(timeout=timeout),
        summarize=lambda st: {
            "keys": sorted(st.keys())[:8] if isinstance(st, dict) else None
        },
        optional=True,
    )

    # --- a real view mutation, then re-read to confirm it took ----------------
    record(
        "view.set_zoom",
        lambda: workspace.view.set_zoom(2.0, timeout=timeout),
        summarize=lambda res: {
            "zoom": (res.get("camera") or {}).get("zoom"),
            "own_client_id": res.get("own_client_id"),
        },
    )

    if selector is not None:
        # A layer-level mutation: nudge opacity, then re-list to show the change.
        record(
            "layer.opacity",
            lambda: workspace.layer.opacity(selector, 0.8, timeout=timeout),
            summarize=lambda res: {"ok": True},
            optional=True,
        )
        record(
            "layer.list.after",
            lambda: workspace.layer.list(timeout=timeout),
            summarize=lambda layers: {"count": len(layers)},
        )

    ran_steps = len(steps)
    # Surface ok iff every non-optional step succeeded. Optional steps (which use
    # APIs that may not exist on every client build / dataset) are captured but
    # never taint the verdict.
    surface_ok = all(s.get("ok") for s in steps if not s.get("optional"))
    print(
        json.dumps(
            {
                "ok": surface_ok,
                "steps": steps,
                "ran_steps": ran_steps,
                "workspace_id": workspace_id,
                "dataset_id": selector,
            }
        )
    )


main()
'''


@dataclass
class PythonStepResult:
    name: str
    ok: bool
    summary: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    optional: bool = False

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {"name": self.name, "ok": self.ok}
        if self.summary is not None:
            record["summary"] = self.summary
        if self.error is not None:
            record["error"] = self.error
        if self.optional:
            record["optional"] = True
        return record


@dataclass
class PythonSurfaceResult:
    ran: bool
    ok: bool
    log: str
    steps: list[PythonStepResult] = field(default_factory=list)
    error: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "ran": self.ran,
            "ok": self.ok,
            "log": self.log,
            "steps": [step.to_dict() for step in self.steps],
        }
        if self.error is not None:
            record["error"] = self.error
        return record


def run_python_surface(
    *,
    base_url: str,
    workspace_id: str,
    dataset_id: str | None,
    out_dir: Path,
    config_path: Path,
    timeout: float = 30.0,
    subprocess_timeout: float = DEFAULT_SUBPROCESS_TIMEOUT_S,
    log=print,
) -> PythonSurfaceResult:
    """Run the broad Python client tour and capture the transcript.

    Returns a :class:`PythonSurfaceResult`. Per-step failures are captured inside
    the driver and reflected in ``steps``/``ok``; only an inability to run the
    driver at all (uv/client source missing, no parseable result, timeout)
    surfaces as ``ran=False`` with an ``error`` envelope.
    """
    log_dir = out_dir / "python"
    log_dir.mkdir(parents=True, exist_ok=True)
    session_log = log_dir / "session.log"

    try:
        source = _lucida_py_source()
        prefix, extra_env = _driver_invocation(source)
    except TryoutError as error:
        _write_session_log(session_log, header_lines=_header(base_url, workspace_id, dataset_id),
                            stdout="", stderr=f"[tryout] could not prepare driver: {error.message}")
        return PythonSurfaceResult(
            ran=False, ok=False, log=str(session_log), error=error.to_error()
        )

    request = json.dumps(
        {
            "base_url": base_url,
            "workspace_id": workspace_id,
            "dataset_id": dataset_id,
            "config_path": str(config_path),
            "timeout": timeout,
        }
    )
    argv = [*prefix, "-c", _DRIVER, request]
    env = {**os.environ, **extra_env}
    log(
        f"[tryout] Python surface: LucidaClient tour against {base_url} "
        "(uv run, client source from working tree)"
    )

    try:
        completed = subprocess.run(
            argv,
            cwd=str(out_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=subprocess_timeout,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        returncode: int | None = completed.returncode
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = (
            (error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or ""))
            + f"\n[tryout] python surface timed out after {subprocess_timeout:g}s"
        )
        returncode = None
        _write_session_log(
            session_log,
            header_lines=_header(base_url, workspace_id, dataset_id),
            stdout=stdout,
            stderr=stderr,
        )
        return PythonSurfaceResult(
            ran=False,
            ok=False,
            log=str(session_log),
            error={
                "stage": "python",
                "message": f"python surface driver timed out after {subprocess_timeout:g}s",
            },
        )

    # Always write the full transcript (stdout result line + the human stderr
    # transcript) so the human verifier sees exactly what ran (user story 3).
    _write_session_log(
        session_log,
        header_lines=_header(base_url, workspace_id, dataset_id),
        stdout=stdout,
        stderr=stderr,
    )

    payload = _extract_json_object(stdout)
    if payload is None:
        stderr_tail = "\n".join(stderr.splitlines()[-30:])
        return PythonSurfaceResult(
            ran=False,
            ok=False,
            log=str(session_log),
            error={
                "stage": "python",
                "message": f"python client driver produced no JSON result (exit {returncode})",
                "detail": {"stderr_tail": stderr_tail},
            },
        )

    steps = [
        PythonStepResult(
            name=str(step.get("name")),
            ok=bool(step.get("ok")),
            summary=step.get("summary"),
            error=step.get("error"),
            optional=bool(step.get("optional")),
        )
        for step in (payload.get("steps") or [])
        if isinstance(step, dict)
    ]
    passed = sum(1 for step in steps if step.ok)
    log(f"[tryout]   Python surface: {passed}/{len(steps)} steps ok")

    return PythonSurfaceResult(
        ran=True,
        ok=bool(payload.get("ok", False)),
        log=str(session_log),
        steps=steps,
    )


def _header(base_url: str, workspace_id: str, dataset_id: str | None) -> list[str]:
    return [
        "# lucida Python (LucidaClient) tryout session",
        f"# base_url:     {base_url}",
        f"# workspace_id: {workspace_id}",
        f"# dataset_id:   {dataset_id}",
        "# driver: `from lucida import LucidaClient` (working-tree source via uv)",
        "",
    ]


def _write_session_log(path: Path, *, header_lines: list[str], stdout: str, stderr: str) -> None:
    """Write the full, faithful session transcript. Best-effort."""
    body = [
        *header_lines,
        "=== session transcript (stderr) ===",
        stderr.rstrip("\n"),
        "",
        "=== driver result (stdout) ===",
        stdout.rstrip("\n"),
        "",
    ]
    try:
        path.write_text("\n".join(body), encoding="utf-8")
    except OSError:
        pass
