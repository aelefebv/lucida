"""lucida agent tryout harness.

A small toolkit that brings up a live ``lucida-server`` from the current working
tree, reports how to reach it in machine-readable form, captures a server log,
and tears the server down cleanly.

Layering (so later CLI / Python / web surfaces slot in cleanly):
  * :mod:`tryout.cli`       — argv parsing, output, exit codes, signal handling
  * :mod:`tryout.bringup`   — the bring-up -> report -> teardown lifecycle
  * :mod:`tryout.server`    — boot / health-gate / reap the throwaway server
  * :mod:`tryout.surfaces`  — ways to drive the live server (python client today)
  * :mod:`tryout.capture`   — report record + on-disk artifacts (up.json)
  * :mod:`tryout.netutil`   — free-port allocation, /healthz polling
  * :mod:`tryout.errors`    — staged TryoutError
"""

from __future__ import annotations

__all__ = ["main"]

__version__ = "0.1.0"


def main(argv=None) -> int:
    # Imported lazily so `import tryout` stays cheap and side-effect free.
    from .cli import main as _main

    return _main(argv)
