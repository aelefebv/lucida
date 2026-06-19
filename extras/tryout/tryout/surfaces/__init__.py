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
  * :mod:`tryout.surfaces.web_surface` — capture the real rendered viewer as a
    non-blank screenshot via the product CLI, plus a best-effort real-SPA
    full-page capture + browser console via Playwright (``drive``).

One contract, one registry
--------------------------

Every drive surface returns a :class:`SurfaceResult`: one uniform shape —
``name``, ``ran``, ``ok``, ``passed``, ``total``, ``error``, plus an ``extra``
bag for surface-specific facts and an ``artifacts`` list of files it wrote — so
``drive`` and ``report`` can iterate over surfaces *generically* rather than
branching per surface. Its :meth:`SurfaceResult.to_dict` returns the exact JSON
each surface has always emitted (the per-surface payload), so the registry adds
structure without changing a single output key.

Each surface registers a :class:`Surface` describing how to build/run it under
:data:`REGISTRY`; :func:`drive` loops the registry and :mod:`tryout.report`
renders from it, so adding a surface is one registration, not edits in N places.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ._subproc import run_group, scan_json_line, shquote


@dataclass
class SurfaceResult:
    """The uniform result every drive surface conforms to.

    The uniform fields (``name``/``ran``/``ok``/``passed``/``total``/``error``)
    are what the registry-driven :func:`tryout.drive.drive` loop and the
    :mod:`tryout.report` renderer read, so neither needs to know which concrete
    surface produced the result. Surface-specific payload (a CLI command table, a
    Python step list, web screenshots) lives in subclass fields; ``extra`` and
    ``artifacts`` carry anything cross-cutting.

    Crucially, :meth:`to_dict` returns the *exact* JSON keys the surface has
    always emitted (subclasses override :meth:`payload`), so introducing this base
    class does not change ``drive``/``report`` output at all — it only gives the
    pieces a common spine.
    """

    name: str = ""
    ran: bool = False
    ok: bool = False
    error: dict[str, Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    artifacts: list[str] = field(default_factory=list)

    @property
    def passed(self) -> int:
        """How many captured units (commands/steps/captures) succeeded.

        Subclasses with a notion of pass/total override this; the default is a
        binary mapping of ``ok`` so a surface that has no sub-units still reports
        a coherent count.
        """
        return 1 if self.ok else 0

    @property
    def total(self) -> int:
        return 1

    def payload(self) -> dict[str, Any]:
        """The surface-specific JSON body. Subclasses override to emit their exact
        historical keys; the default carries only the uniform fields."""
        record: dict[str, Any] = {"ran": self.ran, "ok": self.ok}
        if self.error is not None:
            record["error"] = self.error
        return record

    def to_dict(self) -> dict[str, Any]:
        """The object that lands in ``drive.json`` under ``surfaces.<name>``.

        Defers to :meth:`payload` so each surface emits exactly the keys it always
        has. (The uniform fields are read off the object directly by the registry/
        report; they are not forced into the JSON, preserving the shape.)
        """
        return self.payload()


@dataclass(frozen=True)
class Surface:
    """A registered drive surface: its name plus how to run it.

    ``run`` takes the live-run context (:class:`tryout.drive.SurfaceContext`) and
    returns a :class:`SurfaceResult`. Keeping the *how-to-run* next to the name
    here is what lets :func:`tryout.drive.drive` iterate generically: it asks the
    registry for each requested surface and calls ``run`` — no per-surface ladder.
    """

    name: str
    run: Callable[..., SurfaceResult]
    description: str = ""


# The registry of drive surfaces, in a stable tour order. The web surface comes
# last so the CLI/Python tours (which can mutate view state) run first and a
# maintainer's screenshot reflects the post-tour state too. Populated by
# :func:`register` calls below; :func:`tryout.drive.drive` and
# :mod:`tryout.report` both read it so adding a surface is one registration.
REGISTRY: dict[str, Surface] = {}
ORDER: list[str] = []


def register(surface: Surface) -> Surface:
    """Add (or replace) a surface in the registry, preserving first-seen order."""
    if surface.name not in REGISTRY:
        ORDER.append(surface.name)
    REGISTRY[surface.name] = surface
    return surface


def registered_names() -> list[str]:
    """The known drive surfaces in canonical tour order."""
    return list(ORDER)


# Bring-up surface (used by both ``up`` and ``drive`` to create the workspace and
# open the fixture). It is not a registry drive surface — it is the spine the
# drive surfaces run *against* — so it is re-exported but not registered.
from .python_client import (  # noqa: E402  (import after base classes are defined)
    WorkspaceResult,
    create_workspace_and_open,
    driver_invocation,
    extract_result_object,
    lucida_py_source,
)

# Importing each surface module registers its Surface in REGISTRY (see the
# module-level register(...) call at the bottom of each).
from .cli_surface import CliSurfaceResult, run_cli_surface  # noqa: E402
from .python_surface import PythonSurfaceResult, run_python_surface  # noqa: E402
from .web_surface import WebSurfaceResult, run_web_surface  # noqa: E402


__all__ = [
    "SurfaceResult",
    "Surface",
    "REGISTRY",
    "register",
    "registered_names",
    "run_group",
    "scan_json_line",
    "shquote",
    "WorkspaceResult",
    "create_workspace_and_open",
    "driver_invocation",
    "extract_result_object",
    "lucida_py_source",
    "CliSurfaceResult",
    "run_cli_surface",
    "PythonSurfaceResult",
    "run_python_surface",
    "WebSurfaceResult",
    "run_web_surface",
]
