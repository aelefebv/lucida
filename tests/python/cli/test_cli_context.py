from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from cli_helpers import build_cli_env, run_cli_json


def test_cli_context_default_resolution_flow(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    context_path = tmp_path / "cli-context.json"
    cli_env = build_cli_env(
        base_url=rust_daemon_base_url,
        context_path=str(context_path),
    )

    session_payload = run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
    session_id = str(session_payload["session_id"])

    context_payload = run_cli_json(runner, ["context", "show", "--json"], env=cli_env)
    assert context_payload["session_id"] == session_id
    assert context_payload["dataset_id"] is None
    assert context_payload["view_id"] is None
    assert Path(context_payload["context_path"]) == context_path

    dataset_payload = run_cli_json(
        runner,
        ["dataset", "open", "--uri", local_omezarr_uri, "--json"],
        env=cli_env,
    )
    dataset_id = str(dataset_payload["dataset_summary"]["dataset_id"])

    context_payload = run_cli_json(runner, ["context", "show", "--json"], env=cli_env)
    assert context_payload["session_id"] == session_id
    assert context_payload["dataset_id"] == dataset_id
    assert context_payload["view_id"] is None

    view_payload = run_cli_json(
        runner,
        ["view", "create", "--mode", "2d", "--json"],
        env=cli_env,
    )
    view_id = str(view_payload["view_state"]["view_id"])
    assert str(view_payload["view_state"]["session_id"]) == session_id

    context_payload = run_cli_json(runner, ["context", "show", "--json"], env=cli_env)
    assert context_payload["session_id"] == session_id
    assert context_payload["dataset_id"] == dataset_id
    assert context_payload["view_id"] == view_id

    pan_payload = run_cli_json(
        runner,
        ["view", "pan", "--dx-px", "8", "--dy-px", "-4", "--json"],
        env=cli_env,
    )
    assert pan_payload["view_state"]["view_id"] == view_id

    screenshot_payload = run_cli_json(
        runner,
        [
            "view",
            "screenshot",
            "--width-px",
            "40",
            "--height-px",
            "30",
            "--delivery",
            "inline_base64",
            "--json",
        ],
        env=cli_env,
    )
    assert screenshot_payload["status"] == "ok"

    render_payload = run_cli_json(
        runner,
        [
            "render",
            "image",
            "--width-px",
            "64",
            "--height-px",
            "48",
            "--json",
        ],
        env=cli_env,
    )
    assert render_payload["status"] == "ok"
    assert render_payload["view_id"] == view_id


def test_cli_context_use_and_clear(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    context_path = tmp_path / "cli-context.json"
    cli_env = build_cli_env(
        base_url=rust_daemon_base_url,
        context_path=str(context_path),
    )

    session_payload = run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
    session_id = str(session_payload["session_id"])
    dataset_payload = run_cli_json(
        runner,
        [
            "dataset",
            "open",
            "--uri",
            local_omezarr_uri,
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    dataset_id = str(dataset_payload["dataset_summary"]["dataset_id"])
    view_payload = run_cli_json(
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
        env=cli_env,
    )
    view_id = str(view_payload["view_state"]["view_id"])

    second_session_payload = run_cli_json(runner, ["session", "create", "--json"], env=cli_env)
    second_session_id = str(second_session_payload["session_id"])
    assert second_session_id != session_id

    used_session_payload = run_cli_json(
        runner,
        ["session", "use", "--session-id", session_id, "--json"],
        env=cli_env,
    )
    assert used_session_payload["session_id"] == session_id
    assert used_session_payload["dataset_id"] is None
    assert used_session_payload["view_id"] is None

    used_dataset_payload = run_cli_json(
        runner,
        ["dataset", "use", "--dataset-id", dataset_id, "--json"],
        env=cli_env,
    )
    assert used_dataset_payload["dataset_id"] == dataset_id
    assert used_dataset_payload["view_id"] is None

    used_view_payload = run_cli_json(
        runner,
        ["view", "use", "--view-id", view_id, "--json"],
        env=cli_env,
    )
    assert used_view_payload["view_id"] == view_id

    cleared_payload = run_cli_json(runner, ["context", "clear", "--json"], env=cli_env)
    assert cleared_payload["session_id"] is None
    assert cleared_payload["dataset_id"] is None
    assert cleared_payload["view_id"] is None

    missing_dataset_payload = run_cli_json(
        runner,
        ["view", "create", "--json"],
        env=cli_env,
        expected_exit=1,
    )
    assert missing_dataset_payload["code"] == "invalid_request"
    assert "dataset_id is required" in missing_dataset_payload["message"]

    missing_view_payload = run_cli_json(
        runner,
        ["view", "pan", "--dx-px", "1", "--dy-px", "1", "--json"],
        env=cli_env,
        expected_exit=1,
    )
    assert missing_view_payload["code"] == "invalid_request"
    assert "view_id is required" in missing_view_payload["message"]
