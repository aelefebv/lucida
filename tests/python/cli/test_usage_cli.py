from __future__ import annotations

import json
import os
import uuid

from typer.testing import CliRunner

from lucida.cli import app
from lucida.client import LucidaClient


def _rust_backend_env(base_url: str) -> dict[str, str]:
    env = dict(os.environ)
    env["LUCIDA_BASE_URL"] = base_url
    return env


def test_usage_cli_commands(rust_daemon_base_url: str) -> None:
    run_id = f"cli-run-{uuid.uuid4().hex}"
    with LucidaClient(base_url=rust_daemon_base_url, agent_run_id=run_id) as client:
        client.create_session(agent_step_id="session")
        client.create_session(agent_step_id="session-2")

    runner = CliRunner()
    cli_env = _rust_backend_env(rust_daemon_base_url)

    events_result = runner.invoke(
        app,
        ["usage", "events", "--run-id", run_id, "--limit", "50", "--json"],
        env=cli_env,
    )
    assert events_result.exit_code == 0
    events_payload = json.loads(events_result.stdout)
    assert events_payload["schema_version"] == 1
    assert events_payload["events"]
    assert all(item["agent_run_id"] == run_id for item in events_payload["events"])

    runs_result = runner.invoke(
        app,
        ["usage", "runs", "--limit", "50", "--json"],
        env=cli_env,
    )
    assert runs_result.exit_code == 0
    runs_payload = json.loads(runs_result.stdout)
    assert runs_payload["schema_version"] == 1
    assert any(item["agent_run_id"] == run_id for item in runs_payload["runs"])

    run_result = runner.invoke(
        app,
        ["usage", "run", "--run-id", run_id, "--event-limit", "50", "--json"],
        env=cli_env,
    )
    assert run_result.exit_code == 0
    run_payload = json.loads(run_result.stdout)
    assert run_payload["schema_version"] == 1
    assert run_payload["run"]["agent_run_id"] == run_id
    assert run_payload["events"]

    stream_url_result = runner.invoke(
        app,
        ["usage", "stream-url", "--run-id", run_id],
        env=cli_env,
    )
    assert stream_url_result.exit_code == 0
    stream_url = stream_url_result.stdout.strip()
    assert "/usage/events/stream" in stream_url
    assert "run_id=" in stream_url
