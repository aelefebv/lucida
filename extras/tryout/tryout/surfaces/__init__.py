"""Surfaces: the ways the harness drives a live lucida.

Today there is one — :mod:`tryout.surfaces.python_client`, which creates a
workspace and opens a dataset through the maintained ``LucidaClient``. Later
slices add CLI and web surfaces alongside it; each is a thin adapter over the
same booted ``ServerProcess``, so they slot in here without touching the
bring-up/teardown spine.
"""

from __future__ import annotations

from .python_client import WorkspaceResult, create_workspace_and_open

__all__ = ["WorkspaceResult", "create_workspace_and_open"]
