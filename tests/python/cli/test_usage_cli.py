from __future__ import annotations

import uuid

from typer.testing import CliRunner

from cli_helpers import build_cli_env, run_cli, run_cli_json


def test_usage_cli_commands(rust_daemon_base_url: str) -> None:
    run_id = f"cli-run-{uuid.uuid4().hex}"
    runner = CliRunner()
    session_one_env = build_cli_env(
        base_url=rust_daemon_base_url,
        agent_run_id=run_id,
        agent_step_id="session",
        agent_name="pytest-cli",
    )
    run_cli_json(runner, ["session", "create", "--json"], env=session_one_env)

    session_two_env = build_cli_env(
        base_url=rust_daemon_base_url,
        agent_run_id=run_id,
        agent_step_id="session-2",
        agent_name="pytest-cli",
    )
    run_cli_json(runner, ["session", "create", "--json"], env=session_two_env)

    query_env = build_cli_env(base_url=rust_daemon_base_url)
    events_payload = run_cli_json(
        runner,
        ["usage", "events", "--run-id", run_id, "--limit", "50", "--json"],
        env=query_env,
    )
    assert events_payload["schema_version"] == 1
    assert events_payload["events"]
    assert all(item["agent_run_id"] == run_id for item in events_payload["events"])
    assert any(item["agent_step_id"] == "session" for item in events_payload["events"])
    assert any(item["agent_step_id"] == "session-2" for item in events_payload["events"])

    runs_payload = run_cli_json(
        runner,
        ["usage", "runs", "--limit", "50", "--json"],
        env=query_env,
    )
    assert runs_payload["schema_version"] == 1
    assert any(item["agent_run_id"] == run_id for item in runs_payload["runs"])

    run_payload = run_cli_json(
        runner,
        ["usage", "run", "--run-id", run_id, "--event-limit", "50", "--json"],
        env=query_env,
    )
    assert run_payload["schema_version"] == 1
    assert run_payload["run"]["agent_run_id"] == run_id
    assert run_payload["events"]

    stream_url_result = run_cli(
        runner,
        ["usage", "stream-url", "--run-id", run_id],
        env=query_env,
    )
    assert stream_url_result.exit_code == 0
    stream_url = stream_url_result.stdout.strip()
    assert "/usage/events/stream" in stream_url
    assert "run_id=" in stream_url
