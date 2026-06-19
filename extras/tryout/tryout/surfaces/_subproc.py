"""One shared subprocess spine for every surface.

Before this module the three surfaces each carried their own subprocess plumbing
and three near-identical copies of a "scan stdout bottom-up for the driver's JSON
result line" helper. That divergence is the orphan risk the coherence audit
flagged: the web surface reaped its browser children via an own-process-group
helper, but the CLI and Python surfaces used a plain :func:`subprocess.run`, so a
timeout there could leave a grandchild behind. This module is the single place
all of that lives:

  * :func:`run_group` — ``subprocess.run`` semantics, but the child gets its OWN
    process group and on a timeout OR an interrupting signal the WHOLE group is
    SIGKILLed, so nothing the child spawned (a browser under node, a renderer
    under the product CLI) is ever orphaned. It mirrors the server spine's reap
    (:mod:`tryout.server`) and re-raises :class:`subprocess.TimeoutExpired` with
    the captured output exactly like ``subprocess.run`` so existing handlers keep
    working unchanged.
  * :func:`scan_json_line` — the bottom-up, whole-line scan for the single JSON
    object a driver prints as its final stdout line. Line-oriented (rather than
    scanning every ``{``) so it never latches onto a *nested* object; the caller
    supplies the ``accept`` predicate that identifies its result object (e.g.
    "has an ``ok`` key", "has a ``captured`` key", "has a ``url`` key").
  * :func:`shquote` — minimal shell-quoting for the human ``$ ...`` line written
    into every capture log (display only).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
from typing import Any, Callable, Sequence


def run_group(
    argv: Sequence[str],
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    capture_output: bool = False,
    text: bool = False,
    timeout: float | None = None,
    input: Any | None = None,
) -> subprocess.CompletedProcess:
    """``subprocess.run`` but the child gets its OWN process group, and on a
    timeout OR an interrupting signal the WHOLE group is SIGKILLed.

    Why: any surface may spawn a child that itself spawns more processes — the
    product CLI launches headless Chrome; the Playwright driver launches node +
    Chrome; even ``cargo run`` forks a build child. A plain ``subprocess.run``
    that times out only kills the direct child and can leave grandchildren
    orphaned. Putting the child in its own session (``start_new_session=True``)
    lets us ``killpg`` the entire group, mirroring the server spine's reap.

    Re-raises :class:`subprocess.TimeoutExpired` with captured ``output``/
    ``stderr`` exactly like ``subprocess.run`` so existing per-surface timeout
    handlers keep working without change.
    """
    stdout = subprocess.PIPE if capture_output else None
    stderr = subprocess.PIPE if capture_output else None
    proc = subprocess.Popen(
        list(argv),
        cwd=cwd,
        env=env,
        stdout=stdout,
        stderr=stderr,
        text=text,
        start_new_session=True,
    )

    def _kill_group() -> None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    try:
        out, err = proc.communicate(input=input, timeout=timeout)
        return subprocess.CompletedProcess(list(argv), proc.returncode, out, err)
    except subprocess.TimeoutExpired:
        _kill_group()
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:
            out, err = (None, None)
        raise subprocess.TimeoutExpired(list(argv), timeout, output=out, stderr=err)
    except BaseException:
        # An interrupting signal (SIGINT/SIGTERM) unwinds through here; reap the
        # whole group before propagating so no child is left behind.
        _kill_group()
        raise


def scan_json_line(
    text: str,
    *,
    accept: Callable[[dict[str, Any]], bool],
) -> dict[str, Any] | None:
    """Return the driver's result object from ``text`` (its final JSON line).

    A driver prints its structured result as a single ``json.dumps`` line (no
    indent) as the final stdout line, but uv/npm/websockets/etc. may emit chatter
    before it. We scan *whole lines* from the bottom up and return the first that
    parses to a ``dict`` for which ``accept`` is true. Whole-line matching (rather
    than scanning every ``{``) avoids latching onto a *nested* object — e.g. a
    ``status_checks.healthz`` that also contains ``"ok"``. ``accept`` lets each
    caller name the key that identifies *its* result object.
    """
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not (line.startswith("{") and line.endswith("}")):
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and accept(candidate):
            return candidate
    return None


def shquote(value: str) -> str:
    """Minimal shell-quoting for the human ``$ ...`` line (display only)."""
    if value and all(char.isalnum() or char in "@%+=:,./-_" for char in value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"
