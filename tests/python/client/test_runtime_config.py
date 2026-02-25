from __future__ import annotations

from lucida.client import LucidaClient
from lucida.commands.common import resolve_cli_base_url
from lucida.runtime_config import DEFAULT_RUST_BASE_URL, resolve_runtime_config


def test_runtime_config_defaults_to_rust_url() -> None:
    resolved = resolve_runtime_config(env={})
    assert resolved.base_url == DEFAULT_RUST_BASE_URL
    assert resolved.base_url_source == "default"


def test_runtime_config_env_base_url() -> None:
    resolved = resolve_runtime_config(env={"LUCIDA_BASE_URL": "http://127.0.0.1:9922"})
    assert resolved.base_url == "http://127.0.0.1:9922"
    assert resolved.base_url_source == "env"


def test_runtime_config_precedence_override_then_env() -> None:
    resolved = resolve_runtime_config(
        base_url_override="http://127.0.0.1:9911",
        env={"LUCIDA_BASE_URL": "http://127.0.0.1:9922"},
    )
    assert resolved.base_url == "http://127.0.0.1:9911"
    assert resolved.base_url_source == "override"


def test_runtime_config_ignores_blank_values() -> None:
    resolved = resolve_runtime_config(base_url_override="  ", env={"LUCIDA_BASE_URL": "   "})
    assert resolved.base_url == DEFAULT_RUST_BASE_URL
    assert resolved.base_url_source == "default"


def test_cli_runtime_transport_resolution(monkeypatch) -> None:
    monkeypatch.delenv("LUCIDA_BASE_URL", raising=False)
    assert resolve_cli_base_url(None) == DEFAULT_RUST_BASE_URL

    monkeypatch.setenv("LUCIDA_BASE_URL", "http://127.0.0.1:9933")
    assert resolve_cli_base_url(None) == "http://127.0.0.1:9933"

    assert resolve_cli_base_url("http://127.0.0.1:9944") == "http://127.0.0.1:9944"


def test_client_runtime_base_url_defaults(monkeypatch) -> None:
    monkeypatch.delenv("LUCIDA_BASE_URL", raising=False)
    client = LucidaClient()
    try:
        assert str(client._client.base_url).rstrip("/") == DEFAULT_RUST_BASE_URL
    finally:
        client.close()


def test_client_runtime_env_base_url(monkeypatch) -> None:
    monkeypatch.setenv("LUCIDA_BASE_URL", "http://127.0.0.1:9955")
    client = LucidaClient()
    try:
        assert str(client._client.base_url).rstrip("/") == "http://127.0.0.1:9955"
    finally:
        client.close()
