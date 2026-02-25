from __future__ import annotations

import time
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
    events_payload: dict[str, object] = {}
    deadline = time.time() + 5.0
    while True:
        events_payload = run_cli_json(
            runner,
            ["usage", "events", "--run-id", run_id, "--limit", "50", "--json"],
            env=query_env,
        )
        events = events_payload.get("events")
        if isinstance(events, list):
            step_ids = {str(item.get("agent_step_id")) for item in events}
            if "session" in step_ids and "session-2" in step_ids:
                break
        if time.time() >= deadline:
            break
        time.sleep(0.05)
    assert events_payload["schema_version"] == 1
    assert events_payload["events"]
    assert all(item["agent_run_id"] == run_id for item in events_payload["events"])
    assert any(item["agent_step_id"] == "session" for item in events_payload["events"])
    assert any(item["agent_step_id"] == "session-2" for item in events_payload["events"])

    runs_payload: dict[str, object] = {}
    deadline = time.time() + 5.0
    while True:
        runs_payload = run_cli_json(
            runner,
            ["usage", "runs", "--limit", "50", "--json"],
            env=query_env,
        )
        runs = runs_payload.get("runs")
        if isinstance(runs, list) and any(item.get("agent_run_id") == run_id for item in runs):
            break
        if time.time() >= deadline:
            break
        time.sleep(0.05)
    assert runs_payload["schema_version"] == 1
    assert any(item["agent_run_id"] == run_id for item in runs_payload["runs"])

    run_payload: dict[str, object] = {}
    deadline = time.time() + 5.0
    while True:
        run_payload = run_cli_json(
            runner,
            ["usage", "run", "--run-id", run_id, "--event-limit", "50", "--json"],
            env=query_env,
        )
        if run_payload.get("events"):
            break
        if time.time() >= deadline:
            break
        time.sleep(0.05)
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
