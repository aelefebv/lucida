from __future__ import annotations

import os

from lucida.client import LucidaClient
from lucida.cli import _resolve_cli_base_url
from lucida.runtime_config import (
    DEFAULT_PYTHON_BASE_URL,
    DEFAULT_RUST_BASE_URL,
    resolve_runtime_config,
)


def test_runtime_config_defaults_to_rust_http_mode() -> None:
    resolved = resolve_runtime_config(env={})
    assert resolved.backend == "rust"
    assert resolved.base_url == DEFAULT_RUST_BASE_URL
    assert resolved.use_http is True


def test_runtime_config_env_rust_uses_http_default_url() -> None:
    resolved = resolve_runtime_config(env={"LUCIDA_BACKEND": "rust"})
    assert resolved.backend == "rust"
    assert resolved.base_url == DEFAULT_RUST_BASE_URL
    assert resolved.use_http is True


def test_runtime_config_precedence_override_then_env() -> None:
    resolved = resolve_runtime_config(
        backend_override="python",
        base_url_override="http://127.0.0.1:9911",
        env={"LUCIDA_BACKEND": "rust", "LUCIDA_BASE_URL": "http://127.0.0.1:9922"},
    )
    assert resolved.backend == "python"
    assert resolved.base_url == "http://127.0.0.1:9911"
    assert resolved.backend_source == "override"
    assert resolved.base_url_source == "override"
    assert resolved.use_http is True


def test_runtime_config_env_python_uses_local_mode_default_url() -> None:
    resolved = resolve_runtime_config(env={"LUCIDA_BACKEND": "python"})
    assert resolved.backend == "python"
    assert resolved.base_url == DEFAULT_PYTHON_BASE_URL
    assert resolved.use_http is False


def test_cli_runtime_transport_resolution(monkeypatch) -> None:
    monkeypatch.delenv("LUCIDA_BACKEND", raising=False)
    monkeypatch.delenv("LUCIDA_BASE_URL", raising=False)
    assert _resolve_cli_base_url(None) == DEFAULT_RUST_BASE_URL

    monkeypatch.setenv("LUCIDA_BACKEND", "rust")
    assert _resolve_cli_base_url(None) == DEFAULT_RUST_BASE_URL

    monkeypatch.setenv("LUCIDA_BACKEND", "python")
    monkeypatch.delenv("LUCIDA_BASE_URL", raising=False)
    assert _resolve_cli_base_url(None) is None

    monkeypatch.setenv("LUCIDA_BACKEND", "python")
    monkeypatch.setenv("LUCIDA_BASE_URL", "http://127.0.0.1:9933")
    assert _resolve_cli_base_url(None) == "http://127.0.0.1:9933"

    assert _resolve_cli_base_url("http://127.0.0.1:9944") == "http://127.0.0.1:9944"


def test_client_runtime_backend_defaults() -> None:
    previous_backend = os.environ.get("LUCIDA_BACKEND")
    previous_base_url = os.environ.get("LUCIDA_BASE_URL")
    try:
        os.environ["LUCIDA_BACKEND"] = "rust"
        os.environ.pop("LUCIDA_BASE_URL", None)
        client = LucidaClient()
        assert str(client._client.base_url).rstrip("/") == DEFAULT_RUST_BASE_URL
        client.close()
    finally:
        if previous_backend is None:
            os.environ.pop("LUCIDA_BACKEND", None)
        else:
            os.environ["LUCIDA_BACKEND"] = previous_backend
        if previous_base_url is None:
            os.environ.pop("LUCIDA_BASE_URL", None)
        else:
            os.environ["LUCIDA_BASE_URL"] = previous_base_url
