from __future__ import annotations

import json
import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from typer.testing import CliRunner, Result

from lucida.cli import app


@dataclass(frozen=True, slots=True)
class ViewContext:
    session_id: str
    dataset_id: str
    view_id: str


def build_cli_env(
    *,
    base_url: str,
    context_path: str | None = None,
    daemon_state_path: str | None = None,
    agent_run_id: str | None = None,
    agent_step_id: str | None = None,
    agent_name: str | None = None,
) -> dict[str, str]:
    env = dict(os.environ)
    env["LUCIDA_BASE_URL"] = base_url
    env.pop("LUCIDA_AGENT_RUN_ID", None)
    env.pop("LUCIDA_AGENT_STEP_ID", None)
    env.pop("LUCIDA_AGENT_NAME", None)
    env.pop("LUCIDA_CLI_CONTEXT_PATH", None)
    env.pop("LUCIDA_DAEMON_STATE_PATH", None)
    resolved_context_path = context_path or str(
        Path(tempfile.gettempdir()) / f"lucida-cli-context-{uuid.uuid4().hex}.json"
    )
    resolved_daemon_state_path = daemon_state_path or str(
        Path(tempfile.gettempdir()) / f"lucida-daemon-state-{uuid.uuid4().hex}.json"
    )
    env["LUCIDA_CLI_CONTEXT_PATH"] = resolved_context_path
    env["LUCIDA_DAEMON_STATE_PATH"] = resolved_daemon_state_path
    if agent_run_id:
        env["LUCIDA_AGENT_RUN_ID"] = agent_run_id
    if agent_step_id:
        env["LUCIDA_AGENT_STEP_ID"] = agent_step_id
    if agent_name:
        env["LUCIDA_AGENT_NAME"] = agent_name
    return env


def run_cli(
    runner: CliRunner,
    args: list[str],
    *,
    env: dict[str, str],
) -> Result:
    return runner.invoke(app, args, env=env)


def run_cli_json(
    runner: CliRunner,
    args: list[str],
    *,
    env: dict[str, str],
    expected_exit: int = 0,
) -> dict[str, Any]:
    result = run_cli(runner, args, env=env)
    assert result.exit_code == expected_exit, result.stdout
    return json.loads(result.stdout)


def create_view_context(
    runner: CliRunner,
    *,
    env: dict[str, str],
    dataset_uri: str,
) -> ViewContext:
    session_payload = run_cli_json(
        runner,
        ["session", "create", "--json"],
        env=env,
    )
    session_id = str(session_payload["session_id"])

    open_payload = run_cli_json(
        runner,
        [
            "dataset",
            "open",
            "--uri",
            dataset_uri,
            "--session-id",
            session_id,
            "--json",
        ],
        env=env,
    )
    dataset_id = str(open_payload["dataset_summary"]["dataset_id"])

    create_payload = run_cli_json(
        runner,
        [
            "view",
            "create",
            "--dataset-id",
            dataset_id,
            "--session-id",
            session_id,
            "--json",
        ],
        env=env,
    )
    view_id = str(create_payload["view_state"]["view_id"])

    return ViewContext(session_id=session_id, dataset_id=dataset_id, view_id=view_id)
