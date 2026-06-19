"""Workspace + dataset surface, driven through the maintained Python client.

This surface is deliberately *thin*: it does not re-implement the HTTP/WS
protocol. It runs a small driver under ``uv`` that uses
``from lucida import LucidaClient`` — the same client a real Python user is
handed, with all its diagnostics and retry/timeout handling. That keeps the
harness honest (it exercises the actual client) and means later "python surface"
slices extend this one path rather than a parallel client.

Why ``uv run --no-project --with websockets`` + ``PYTHONPATH`` to the
working-tree ``lucida-py/python`` source, rather than ``uv run --project
lucida-py``: ``LucidaClient`` is pure Python over HTTP/WS — only ``websockets``
is needed for dataset open. Building the project would compile the maturin
native extension (``PyScene``/``PyStore``), which the client does not use, is
slow, and fails outright from a git *worktree* (the worktree's ``lucida-py``
Cargo manifest isn't a member of the worktree's Cargo workspace). Pointing
``PYTHONPATH`` at the source is both faster and *more* faithful to "reflect my
working tree" — it imports this tree's client code directly. If a caller has a
fully built ``lucida-py`` env they prefer, ``LUCIDA_TRYOUT_PY`` overrides the
whole invocation.

The driver prints exactly one JSON object on its last stdout line; everything
else (client logs, uv noise) is captured separately so a parse never trips over
it. On any failure the driver emits ``{"ok": false, "error": {...}}`` with the
client's structured diagnostic, which we re-raise as a staged ``TryoutError``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import TryoutError
from ..server import repo_root
from ._subproc import run_group, scan_json_line


# The driver runs under uv with `websockets` available (required for dataset
# open over WS) and the working-tree `lucida` package importable via PYTHONPATH.
# It is an inline string so it ships with the harness and needs no extra file on
# disk in the target env. It prints exactly one JSON object as its final line.
_DRIVER = r'''
import json
import sys

from lucida import LucidaClient, LucidaError


def _fail(stage, message, *, detail=None):
    error = {"stage": stage, "message": message}
    if detail is not None:
        error["detail"] = detail
    print(json.dumps({"ok": False, "error": error}))
    raise SystemExit(0)


def main():
    request = json.loads(sys.argv[1])
    base_url = request["base_url"]
    workspace_name = request["workspace_name"]
    fixture = request.get("fixture")
    config_path = request["config_path"]
    timeout = float(request.get("timeout", 60.0))
    open_timeout = float(request.get("open_timeout", 300.0))

    # token=None + a throwaway config_path keeps the client from reading the
    # user's real CLI config or keychain; the server has auth disabled anyway.
    client = LucidaClient(base_url, token=None, config_path=config_path, timeout=timeout)

    try:
        status = client.status()
    except LucidaError as error:
        _fail("status", str(error), detail=error.to_dict().get("error"))

    try:
        workspace = client.workspaces.create(workspace_name)
        workspace = client.workspaces.get(workspace.id)
        workspace.open()
    except LucidaError as error:
        _fail("workspace", str(error), detail=error.to_dict().get("error"))

    result = {
        "ok": True,
        "workspace_id": workspace.id,
        "workspace_name": workspace.name,
        "web_url": workspace.web_url,
        "ws_url": workspace.ws_url,
        "dataset_id": None,
        "dataset": None,
        "status_checks": status.get("checks") if isinstance(status, dict) else None,
    }

    if fixture:
        # Datasets are opened read-only: the client issues open_remote_dataset,
        # which makes the server read the OME-Zarr source; nothing writes back to
        # the fixture path. We pass the absolute local path (the repo's
        # conventional form; the server normalizes it).
        try:
            opened = workspace.datasets.open(fixture, timeout=open_timeout)
        except LucidaError as error:
            _fail("dataset", str(error), detail=error.to_dict().get("error"))
        dataset_id = opened.get("workspace_dataset_id")
        result["dataset_id"] = dataset_id
        result["dataset"] = {
            "workspace_dataset_id": dataset_id,
            "name": opened.get("name"),
            "image_count": opened.get("image_count"),
            "entity_count": opened.get("entity_count"),
            "source": opened.get("source"),
        }

    print(json.dumps(result))


main()
'''


@dataclass(frozen=True)
class WorkspaceResult:
    workspace_id: str
    workspace_name: str
    web_url: str
    ws_url: str
    dataset_id: str | None
    dataset: dict[str, Any] | None


def lucida_py_source() -> Path:
    """Path to the pure-Python ``lucida`` package source in the working tree.

    Public because the Python *surface* (:mod:`tryout.surfaces.python_surface`)
    drives the same client the same way and reuses this resolution.
    """
    source = repo_root() / "lucida-py" / "python"
    if not (source / "lucida" / "client.py").is_file():
        raise TryoutError(
            "config",
            f"lucida client source not found under {source}; cannot drive the Python client",
        )
    return source


def _uv_binary() -> str:
    override = os.environ.get("LUCIDA_TRYOUT_UV")
    if override:
        if not Path(override).exists():
            raise TryoutError("config", f"LUCIDA_TRYOUT_UV does not exist: {override}")
        return override
    uv = shutil.which("uv")
    if uv is None:
        raise TryoutError(
            "config",
            "uv not found on PATH; install uv or set LUCIDA_TRYOUT_UV "
            "(it drives the lucida-py client environment)",
        )
    return uv


def driver_invocation(source: Path) -> tuple[list[str], dict[str, str]]:
    """Build the (argv-prefix, extra-env) that runs python with the client importable.

    Default: ``uv run --no-project --with websockets python`` with
    ``PYTHONPATH`` pointed at the working-tree client source — fast, hermetic,
    no native build. Override the whole interpreter prefix with
    ``LUCIDA_TRYOUT_PY`` (whitespace-split, e.g.
    ``"uv run --project lucida-py python"``), in which case we still prepend the
    source to ``PYTHONPATH`` so the working-tree client wins.

    Public because the Python *surface* reuses the same proven invocation.
    """
    env = {"PYTHONPATH": _pythonpath_with(source)}
    override = os.environ.get("LUCIDA_TRYOUT_PY")
    if override and override.strip():
        return override.split(), env
    uv = _uv_binary()
    prefix = [uv, "run", "--no-project", "--with", "websockets", "python"]
    return prefix, env


def _pythonpath_with(source: Path) -> str:
    existing = os.environ.get("PYTHONPATH")
    if existing:
        return f"{source}{os.pathsep}{existing}"
    return str(source)


def extract_result_object(text: str) -> dict[str, Any] | None:
    """Return the client driver's result object from ``text``.

    The driver prints its result as a single ``json.dumps`` line (no indent) as
    the final stdout line, but uv/websockets may emit chatter before it. We use
    the shared :func:`tryout.surfaces.scan_json_line`, accepting the first
    whole-line object that carries a top-level ``"ok"`` key — line-oriented so it
    never latches onto a *nested* object like ``status_checks.healthz`` that also
    contains ``"ok"``. Public + shared by both the bring-up surface and the Python
    surface (one scanner, not three copies).
    """
    return scan_json_line(text, accept=lambda candidate: "ok" in candidate)


def create_workspace_and_open(
    *,
    base_url: str,
    workspace_name: str,
    fixture: str | None,
    config_path: Path,
    timeout: float = 60.0,
    open_timeout: float = 300.0,
    subprocess_timeout: float = 360.0,
    log=print,
) -> WorkspaceResult:
    """Create a workspace (and optionally open ``fixture`` read-only) via the client.

    Runs the driver in the ``lucida-py`` uv env. Raises ``TryoutError`` with a
    precise stage tag on any failure so the caller's teardown + JSON-error path
    stays uniform.
    """
    source = lucida_py_source()
    prefix, extra_env = driver_invocation(source)
    request = json.dumps(
        {
            "base_url": base_url,
            "workspace_name": workspace_name,
            "fixture": fixture,
            "config_path": str(config_path),
            "timeout": timeout,
            "open_timeout": open_timeout,
        }
    )
    argv = [*prefix, "-c", _DRIVER, request]
    env = {**os.environ, **extra_env}
    log(
        "[tryout] driving workspace create"
        + (" + dataset open" if fixture else "")
        + " via lucida Python client (uv run, client source from working tree)"
    )
    try:
        # Shared run_group: own process group + group-kill on timeout/signal, so
        # the uv child (and any interpreter it spawns) is never orphaned.
        completed = run_group(
            argv,
            # Run from the source dir's *parent*-neutral cwd: the harness out
            # dir, so uv doesn't auto-discover a project pyproject.toml.
            cwd=str(config_path.parent),
            env=env,
            capture_output=True,
            text=True,
            timeout=subprocess_timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise TryoutError(
            "workspace",
            f"python client driver timed out after {subprocess_timeout:g}s",
        ) from error

    payload = extract_result_object(completed.stdout)
    if payload is None:
        # No parseable result: surface what we can so the failure is debuggable.
        stderr_tail = "\n".join((completed.stderr or "").splitlines()[-30:])
        stdout_tail = "\n".join((completed.stdout or "").splitlines()[-10:])
        raise TryoutError(
            "workspace",
            "python client driver produced no JSON result "
            f"(exit {completed.returncode})",
            detail={"stderr_tail": stderr_tail, "stdout_tail": stdout_tail},
        )

    if not payload.get("ok", False):
        error = payload.get("error") or {}
        stage = str(error.get("stage") or "workspace")
        message = str(error.get("message") or "python client driver reported failure")
        raise TryoutError(stage, message, detail=error.get("detail"))

    return WorkspaceResult(
        workspace_id=str(payload["workspace_id"]),
        workspace_name=str(payload.get("workspace_name") or payload["workspace_id"]),
        web_url=str(payload.get("web_url") or ""),
        ws_url=str(payload.get("ws_url") or ""),
        dataset_id=payload.get("dataset_id"),
        dataset=payload.get("dataset"),
    )
