#!/usr/bin/env python3
"""Entrypoint for the lucida agent tryout harness.

Run directly with the stdlib python — no install, no extra deps:

    python3 extras/tryout/tryout.py up --once --json --out DIR [--fixture PATH]

This is intentionally a thin shim: it makes the sibling ``tryout`` package
importable regardless of the current working directory, then hands off to
``tryout.cli``. All real logic lives in the package so later slices can grow it
(surfaces/, capture/report) without bloating this file.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `import tryout` resolve to the package next to this file, no matter where
# the harness is invoked from (agents and tests call it by absolute path).
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from tryout.cli import main  # noqa: E402  (path shim must run first)


if __name__ == "__main__":
    raise SystemExit(main())
