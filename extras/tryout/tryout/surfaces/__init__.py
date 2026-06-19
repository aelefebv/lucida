"""Surfaces: the ways the harness drives a live lucida.

Each surface is a thin adapter over the same booted ``ServerProcess``, so they
slot in here without touching the bring-up/teardown spine:

  * :mod:`tryout.surfaces.python_client` — the bring-up surface: create a
    workspace and open a dataset through the maintained ``LucidaClient`` (used by
    both ``up`` and ``drive``).
  * :mod:`tryout.surfaces.cli_surface` — drive the real ``lucida`` CLI through an
    agent-style tour, capturing every command (``drive``).
  * :mod:`tryout.surfaces.python_surface` — a broad ``LucidaClient`` read/mutate
    tour against the opened workspace, capturing a transcript (``drive``).

The web surface that comes next plugs in alongside these the same way.
"""

from __future__ import annotations

from .cli_surface import CliSurfaceResult, run_cli_surface
from .python_client import WorkspaceResult, create_workspace_and_open
from .python_surface import PythonSurfaceResult, run_python_surface

__all__ = [
    "WorkspaceResult",
    "create_workspace_and_open",
    "CliSurfaceResult",
    "run_cli_surface",
    "PythonSurfaceResult",
    "run_python_surface",
]
