from __future__ import annotations

from typer.testing import CliRunner

from cli_helpers import build_cli_env, run_cli_json
from lucida.io.dataset_id import generate_dataset_id
from lucida.io.uri import normalize_uri


def test_dataset_open_cli_integration_success(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    runner = CliRunner()
    payload = run_cli_json(
        runner,
        ["dataset", "open", "--uri", local_omezarr_uri, "--json"],
        env=build_cli_env(base_url=rust_daemon_base_url),
    )

    normalized_uri = normalize_uri(local_omezarr_uri)
    assert payload["schema_version"] == 1
    assert payload["dataset_summary"]["uri"] == normalized_uri
    assert payload["dataset_summary"]["dataset_id"] == generate_dataset_id(normalized_uri)


def test_dataset_open_cli_integration_error_payload(
    invalid_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    runner = CliRunner()
    payload = run_cli_json(
        runner,
        ["dataset", "open", "--uri", invalid_omezarr_uri, "--json"],
        env=build_cli_env(base_url=rust_daemon_base_url),
        expected_exit=1,
    )
    assert payload["code"] == "dataset_open_failed"
    assert "invalid_omezarr" in payload["message"]
