from __future__ import annotations

import json
import os

from typer.testing import CliRunner

from lucida.cli import app


def _rust_backend_env(base_url: str) -> dict[str, str]:
    env = dict(os.environ)
    env["LUCIDA_BASE_URL"] = base_url
    return env


def test_cli_dataset_open_json(local_omezarr_uri: str, rust_daemon_base_url: str) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["dataset", "open", "--uri", local_omezarr_uri, "--json"],
        env=_rust_backend_env(rust_daemon_base_url),
    )

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["schema_version"] == 1
    assert payload["dataset_summary"]["schema_version"] == 1
    assert payload["dataset_summary"]["uri"].startswith("file://")


def test_cli_dataset_open_error_payload(invalid_omezarr_uri: str, rust_daemon_base_url: str) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["dataset", "open", "--uri", invalid_omezarr_uri, "--json"],
        env=_rust_backend_env(rust_daemon_base_url),
    )

    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["code"] == "dataset_open_failed"
    assert "invalid_omezarr" in payload["message"]
