"""Scenarios: verify ONE lucida feature the way a user would, then capture it.

A *surface* (see :mod:`tryout.surfaces`) answers "does lucida's CLI / Python /
web layer work at all?"; a *scenario* answers "does this specific feature behave
correctly end-to-end?" — seed some collaborative state, drive the real SPA by
``data-testid`` like a person, and save named, content-bearing screenshots a
human (or an emailed report) can read.

One contract, one registry — mirroring surfaces
-----------------------------------------------

Each scenario is a small module that registers a :class:`Scenario` under
:data:`REGISTRY`. ``drive --scenario <name>`` looks it up and calls ``run(ctx)``;
``drive --scenario list`` prints the registered names + descriptions; an unknown
name is a clean error (exit 1). Adding a scenario is *one registration*, not an
edit in N places — exactly the surface-registry shape.

A scenario's ``run(ctx)`` is handed a fully booted env + helpers
(:class:`tryout.scenarios._runner.ScenarioContext`) and returns a uniform
:class:`ScenarioResult` (``name``/``ok``/``shots``/``notes``/``error``). The
framework (:mod:`tryout.scenarios._runner`) owns boot, the WS seed transport, the
Playwright launch/teardown, the ``shot`` capture, and the courier ``--email``
step — so a concrete scenario module is *pure steps*: a ``seed(ctx)`` that issues
document commands and a declarative UI ``program`` of testid-driven actions +
named shots. See :mod:`tryout.scenarios.mentions` for the reference scenario.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class ShotResult:
    """One captured screenshot: where it landed and whether it is content-bearing.

    ``nonblank`` is decided by the repo's own ``scripts/assert_png_nonblank.py``
    (the same checker the web surface uses), so a scenario's notion of "the UI
    actually rendered something" matches the project's.
    """

    name: str
    path: str | None
    nonblank: bool
    exists: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "nonblank": self.nonblank,
            "exists": self.exists,
        }


@dataclass
class ScenarioResult:
    """The uniform result every scenario's ``run`` returns.

    ``ok`` is the scenario's own verdict (e.g. mentions requires the badge +
    panel + chip shots to be non-blank). ``shots`` is the ordered list of
    captures; ``notes`` carries human-readable progress/diagnostics; ``error`` is
    a staged error envelope when the scenario could not complete. The framework
    writes this to ``DIR/<scenario>/scenario.json`` and folds it into the
    top-level drive JSON under ``scenario``.
    """

    name: str
    ok: bool = False
    shots: list[ShotResult] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    error: dict[str, Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "name": self.name,
            "ok": self.ok,
            "shots": [shot.to_dict() for shot in self.shots],
            "notes": list(self.notes),
        }
        if self.error is not None:
            record["error"] = self.error
        if self.extra:
            record["extra"] = self.extra
        return record


@dataclass(frozen=True)
class Scenario:
    """A registered scenario: its name/description plus how to run it.

    ``run`` takes the live :class:`tryout.scenarios._runner.ScenarioContext` and
    returns a :class:`ScenarioResult`. Keeping *how-to-run* next to the name here
    is what lets the ``drive --scenario`` dispatcher stay generic: it asks the
    registry for the named scenario and calls ``run`` — no per-scenario ladder.
    """

    name: str
    run: Callable[[Any], ScenarioResult]
    description: str = ""


# The registry of scenarios, in first-registered order. Populated by the
# ``register`` calls at the bottom of each scenario module (imported below); the
# ``drive --scenario`` dispatcher and ``--scenario list`` both read it, so adding
# a scenario is one registration.
REGISTRY: dict[str, Scenario] = {}
ORDER: list[str] = []


def register(scenario: Scenario) -> Scenario:
    """Add (or replace) a scenario in the registry, preserving first-seen order."""
    if scenario.name not in REGISTRY:
        ORDER.append(scenario.name)
    REGISTRY[scenario.name] = scenario
    return scenario


def registered_names() -> list[str]:
    """The known scenarios in registration order."""
    return list(ORDER)


def get(name: str) -> Scenario | None:
    """Look up a scenario by name (``None`` if unknown)."""
    return REGISTRY.get(name)


# Re-export the framework runner so callers (the CLI/drive layer) import from one
# place, and so a scenario module can `from . import ScenarioContext` etc.
from ._runner import (  # noqa: E402  (registry must be defined before runner imports it)
    ScenarioContext,
    UiStep,
    run_scenario,
    seed_documents,
)

# Importing each scenario module registers its Scenario in REGISTRY (see the
# module-level register(...) call at the bottom of each).
from . import mentions  # noqa: E402,F401


__all__ = [
    "Scenario",
    "ScenarioResult",
    "ShotResult",
    "REGISTRY",
    "register",
    "registered_names",
    "get",
    "ScenarioContext",
    "UiStep",
    "run_scenario",
    "seed_documents",
]
