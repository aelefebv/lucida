"""WS seed transport: push document commands onto a live workspace, await acks.

A scenario seeds collaborative state (pins, comments, …) the way the SPA does:
over the workspace WebSocket, as ``{"type":"command","command":{...}}`` envelopes
(``lucida_core::protocol::ClientMessage::Command``), each confirmed by the
server's ``{"type":"ack","seq":N}`` reply. We reuse the *exact* wire protocol and
the same websockets transport the maintained Python client uses — we do NOT
re-implement HTTP/WS — by running a tiny driver under
``uv run --no-project --with websockets python`` (mirroring
:mod:`tryout.surfaces.python_client`). That keeps the harness honest and means a
scenario expresses seeding as a plain list of command dicts, not socket plumbing.

The driver:
  * connects to ``ws_url`` (``ws://host:port/ws/workspaces/<id>``),
  * waits for the initial ``snapshot``,
  * sends each command and waits for its ``ack`` (acks are sequenced, so we count
    one ack per command rather than matching ids — the server acks only the
    sender, in order),
  * prints exactly one JSON result object on its final stdout line.

Everything is captured to ``DIR/<scenario>/ws-seed.log`` for the human verifier.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from ..errors import TryoutError
from ..surfaces._subproc import run_group, scan_json_line
from ..surfaces.python_client import driver_invocation, lucida_py_source


# Inline driver: reuse `websockets` (the same dep the client uses for WS) to send
# document-command envelopes and await acks. Prints one JSON result line at the
# end. Resilient by construction: any failure prints {"ok": false, "error": ...}.
_SEED_DRIVER = r'''
import asyncio
import json
import sys

import websockets


async def _recv_json(ws, timeout):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    if isinstance(raw, bytes):
        raise RuntimeError("unexpected binary WebSocket message")
    return json.loads(raw)


async def _await_snapshot(ws, timeout):
    # The server sends a `snapshot` first on connect; skip anything else.
    while True:
        message = await _recv_json(ws, timeout)
        if message.get("type") == "snapshot":
            return message
        if message.get("type") == "workspace_archived":
            raise RuntimeError("workspace is archived")


async def _await_ack(ws, timeout):
    # Acks are sent only to the sender, in send order. Skip broadcasts/presence
    # noise and return the next ack (carrying its seq).
    while True:
        message = await _recv_json(ws, timeout)
        if message.get("type") == "ack":
            return message.get("seq")


def _connect(url, timeout):
    kwargs = {"max_size": None, "open_timeout": timeout, "close_timeout": timeout}
    try:
        return websockets.connect(url, **kwargs)
    except TypeError:
        # Older websockets without open_timeout/close_timeout kwargs.
        return websockets.connect(url, max_size=None)


async def main():
    request = json.loads(sys.argv[1])
    ws_url = request["ws_url"]
    commands = request["commands"]
    timeout = float(request.get("timeout", 30.0))

    sent = []
    try:
        async with _connect(ws_url, timeout) as ws:
            snapshot = await _await_snapshot(ws, timeout)
            for command in commands:
                envelope = {"type": "command", "command": command}
                await ws.send(json.dumps(envelope, separators=(",", ":")))
                seq = await _await_ack(ws, timeout)
                sent.append({"type": command.get("type"), "seq": seq})
    except Exception as error:  # noqa: BLE001 - report any failure structurally
        print(json.dumps({
            "ok": False,
            "error": {"stage": "seed", "message": "{}: {}".format(type(error).__name__, error)},
            "acked": len(sent),
            "sent": sent,
        }))
        raise SystemExit(0)

    print(json.dumps({"ok": True, "acked": len(sent), "sent": sent}))


asyncio.run(main())
'''


def seed_over_ws(
    *,
    ws_url: str,
    commands: list[dict[str, Any]],
    log_path: Path,
    timeout: float = 30.0,
    subprocess_timeout: float = 90.0,
    log=print,
) -> list[dict[str, Any]]:
    """Send each command over ``ws_url`` and wait for its ack.

    Reuses the maintained-client transport machinery (``uv run --no-project
    --with websockets python`` + the working-tree ``lucida`` package on
    ``PYTHONPATH``) so we ride the same WS stack a real user would. Returns the
    list of ``{"type", "seq"}`` acks. Raises :class:`TryoutError` (stage
    ``seed``) on any failure so the scenario records it and writes whatever shots
    exist.
    """
    if not commands:
        return []

    source = lucida_py_source()
    prefix, extra_env = driver_invocation(source)
    request = json.dumps({"ws_url": ws_url, "commands": commands, "timeout": timeout})
    argv = [*prefix, "-c", _SEED_DRIVER, request]

    env = {**os.environ, **extra_env}
    log(f"[tryout] scenario seed: sending {len(commands)} document command(s) over {ws_url}")
    try:
        completed = run_group(
            argv,
            cwd=str(log_path.parent),
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
            + f"\n[tryout] WS seed timed out after {subprocess_timeout:g}s"
        )
        _write_seed_log(log_path, argv, stdout, stderr, None)
        raise TryoutError("seed", f"WS seed timed out after {subprocess_timeout:g}s") from error

    _write_seed_log(log_path, argv, stdout, stderr, returncode)

    payload = scan_json_line(stdout, accept=lambda candidate: "ok" in candidate)
    if payload is None:
        stderr_tail = "\n".join(stderr.splitlines()[-20:])
        raise TryoutError(
            "seed",
            f"WS seed driver produced no result (exit {returncode})",
            detail={"stderr_tail": stderr_tail},
        )
    if not payload.get("ok", False):
        error = payload.get("error") or {}
        raise TryoutError(
            str(error.get("stage") or "seed"),
            str(error.get("message") or "WS seed reported failure"),
            detail={"acked": payload.get("acked"), "sent": payload.get("sent")},
        )

    sent = payload.get("sent") or []
    log(f"[tryout]   seeded {payload.get('acked')} command(s) (acks received)")
    return sent


def _write_seed_log(
    path: Path, argv: list[str], stdout: str, stderr: str, returncode: int | None
) -> None:
    lines = [
        "# lucida scenario WS seed log",
        f"# exit_code: {returncode}",
        "$ uv run --no-project --with websockets python -c <seed-driver> <request>",
        "",
        "--- stdout ---",
        stdout.rstrip("\n"),
        "",
        "--- stderr ---",
        stderr.rstrip("\n"),
        "",
    ]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass
