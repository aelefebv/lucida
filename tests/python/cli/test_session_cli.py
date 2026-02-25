from __future__ import annotations

from contextlib import suppress
import socket
import time
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from cli_helpers import build_cli_env, run_cli_json
from lucida.commands.daemon_bootstrap import is_managed_daemon_running, stop_managed_daemon


def test_session_create_autostarts_local_daemon(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CliRunner()
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    cli_env = build_cli_env(
        base_url=base_url,
        context_path=str(tmp_path / "cli-context.json"),
    )
    monkeypatch.setenv("LUCIDA_DAEMON_STATE_PATH", cli_env["LUCIDA_DAEMON_STATE_PATH"])
    try:
        payload = run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
        assert str(payload["session_id"])
        assert str(payload["created_at"])
        assert is_managed_daemon_running(base_url)

        assert _healthz_ok(base_url)
    finally:
        with suppress(Exception):
            stop_managed_daemon(base_url)


def test_stop_command_stops_autostarted_daemon(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CliRunner()
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    cli_env = build_cli_env(
        base_url=base_url,
        context_path=str(tmp_path / "cli-context.json"),
    )
    monkeypatch.setenv("LUCIDA_DAEMON_STATE_PATH", cli_env["LUCIDA_DAEMON_STATE_PATH"])
    try:
        run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
        assert _healthz_ok(base_url)

        stop_payload = run_cli_json(runner, ["stop", "--json"], env=cli_env)
        assert stop_payload["status"] == "stopped"
        assert stop_payload["base_url"] == base_url
        assert isinstance(stop_payload["pid"], int)
        assert _wait_for_healthz_down(base_url)

        no_daemon_payload = run_cli_json(runner, ["stop", "--json"], env=cli_env)
        assert no_daemon_payload["status"] == "not_managed"
    finally:
        with suppress(Exception):
            stop_managed_daemon(base_url)


def test_stop_command_can_stop_unmanaged_local_daemon(
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    cli_env = build_cli_env(
        base_url=base_url,
        context_path=str(tmp_path / "cli-context.json"),
    )
    state_path = Path(cli_env["LUCIDA_DAEMON_STATE_PATH"])
    try:
        run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
        assert _healthz_ok(base_url)

        # Simulate an existing daemon with no managed PID record.
        with suppress(FileNotFoundError):
            state_path.unlink()

        stop_payload = run_cli_json(runner, ["stop", "--json"], env=cli_env)
        assert stop_payload["status"] == "stopped"
        assert stop_payload["base_url"] == base_url
        assert isinstance(stop_payload["pid"], int)
        assert _wait_for_healthz_down(base_url)
    finally:
        with suppress(Exception):
            stop_managed_daemon(base_url)


def test_stop_aliases_close_and_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CliRunner()
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    cli_env = build_cli_env(
        base_url=base_url,
        context_path=str(tmp_path / "cli-context.json"),
    )
    monkeypatch.setenv("LUCIDA_DAEMON_STATE_PATH", cli_env["LUCIDA_DAEMON_STATE_PATH"])
    try:
        run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
        assert _healthz_ok(base_url)
        close_payload = run_cli_json(runner, ["close", "--json"], env=cli_env)
        assert close_payload["status"] == "stopped"
        assert _wait_for_healthz_down(base_url)

        run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
        assert _healthz_ok(base_url)
        exit_payload = run_cli_json(runner, ["exit", "--json"], env=cli_env)
        assert exit_payload["status"] == "stopped"
        assert _wait_for_healthz_down(base_url)
    finally:
        with suppress(Exception):
            stop_managed_daemon(base_url)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _healthz_ok(base_url: str) -> bool:
    try:
        response = httpx.get(f"{base_url}/healthz", timeout=1.0)
    except httpx.HTTPError:
        return False
    if response.status_code != 200:
        return False
    payload = response.json()
    return isinstance(payload, dict) and payload.get("status") == "ok"


def _wait_for_healthz_down(base_url: str, timeout_s: float = 5.0) -> bool:
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        if not _healthz_ok(base_url):
            return True
        time.sleep(0.1)
    return not _healthz_ok(base_url)
