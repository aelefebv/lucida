from __future__ import annotations

import json
import os

from typer.testing import CliRunner

from lucida.cli import app


def _python_backend_env() -> dict[str, str]:
    env = dict(os.environ)
    env["LUCIDA_BACKEND"] = "python"
    env.pop("LUCIDA_BASE_URL", None)
    return env


def test_cli_dataset_open_json(local_omezarr_uri: str) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["dataset", "open", "--uri", local_omezarr_uri, "--json"],
        env=_python_backend_env(),
    )

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["schema_version"] == 1
    assert payload["dataset_summary"]["schema_version"] == 1
    assert payload["dataset_summary"]["uri"].startswith("file://")


def test_cli_dataset_open_error_payload(invalid_omezarr_uri: str) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["dataset", "open", "--uri", invalid_omezarr_uri, "--json"],
        env=_python_backend_env(),
    )

    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["code"] == "invalid_omezarr"
    assert payload["message"]
    assert "details" in payload
