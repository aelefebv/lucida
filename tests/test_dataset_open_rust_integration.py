from __future__ import annotations

import json
import os

import httpx
from typer.testing import CliRunner

from lucida.cli import app
from lucida.client import LucidaClient
from lucida.io.uri import normalize_uri
from lucida.service.dataset_service import generate_dataset_id


def test_dataset_open_rust_endpoint_success(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    response = httpx.post(
        f"{rust_daemon_base_url}/dataset/open",
        json={"schema_version": 1, "uri": local_omezarr_uri},
        timeout=30.0,
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == 1
    normalized_uri = normalize_uri(local_omezarr_uri)
    assert payload["dataset_summary"]["uri"] == normalized_uri
    assert payload["dataset_summary"]["dataset_id"] == generate_dataset_id(normalized_uri)


def test_dataset_open_rust_client_success(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    with LucidaClient(base_url=rust_daemon_base_url, backend="rust") as client:
        response = client.open_dataset(local_omezarr_uri)
    assert response.schema_version == 1
    assert response.dataset_summary.uri == normalize_uri(local_omezarr_uri)
    assert response.dataset_summary.dataset_id == generate_dataset_id(response.dataset_summary.uri)


def test_dataset_open_rust_cli_success(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    runner = CliRunner()
    env = dict(os.environ)
    env["LUCIDA_BACKEND"] = "rust"
    env["LUCIDA_BASE_URL"] = rust_daemon_base_url
    result = runner.invoke(app, ["dataset", "open", "--uri", local_omezarr_uri, "--json"], env=env)
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["schema_version"] == 1
    assert payload["dataset_summary"]["uri"] == normalize_uri(local_omezarr_uri)


def test_dataset_open_rust_cli_error_payload(
    invalid_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    runner = CliRunner()
    env = dict(os.environ)
    env["LUCIDA_BACKEND"] = "rust"
    env["LUCIDA_BASE_URL"] = rust_daemon_base_url
    result = runner.invoke(app, ["dataset", "open", "--uri", invalid_omezarr_uri, "--json"], env=env)
    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["code"] == "dataset_open_failed"
    assert "invalid_omezarr" in payload["message"]
