from __future__ import annotations

import json

from typer.testing import CliRunner

from cli_helpers import build_cli_env, run_cli


def test_cli_dataset_open_json(local_omezarr_uri: str, rust_daemon_base_url: str) -> None:
    runner = CliRunner()
    result = run_cli(
        runner,
        ["dataset", "open", "--uri", local_omezarr_uri, "--json"],
        env=build_cli_env(base_url=rust_daemon_base_url),
    )

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["schema_version"] == 1
    assert payload["dataset_summary"]["schema_version"] == 1
    assert payload["dataset_summary"]["uri"].startswith("file://")


def test_cli_dataset_open_error_payload(invalid_omezarr_uri: str, rust_daemon_base_url: str) -> None:
    runner = CliRunner()
    result = run_cli(
        runner,
        ["dataset", "open", "--uri", invalid_omezarr_uri, "--json"],
        env=build_cli_env(base_url=rust_daemon_base_url),
    )

    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["code"] == "dataset_open_failed"
    assert "invalid_omezarr" in payload["message"]
