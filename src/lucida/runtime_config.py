"""Runtime URL configuration for Rust-daemon transport."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal, Mapping

ConfigSource = Literal["override", "env", "default"]
DEFAULT_RUST_BASE_URL = "http://127.0.0.1:3000"


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """Resolved runtime configuration for daemon transport.

    Attributes
    ----------
    base_url:
        Effective HTTP base URL for remote transport.
    base_url_source:
        Source used to resolve ``base_url``.
    """

    base_url: str
    base_url_source: ConfigSource


def resolve_runtime_config(
    *,
    base_url_override: str | None = None,
    env: Mapping[str, str] | None = None,
) -> RuntimeConfig:
    """Resolve base-url runtime config with fixed precedence.

    Precedence is:
    1. CLI/client base URL override (``base_url_override``).
    2. Environment (``LUCIDA_BASE_URL``).
    3. Defaults.
    """

    env_values = dict(env if env is not None else os.environ)
    base_url, base_url_source = _resolve_base_url(
        base_url_override=base_url_override,
        env_base_url=env_values.get("LUCIDA_BASE_URL"),
    )

    return RuntimeConfig(
        base_url=base_url,
        base_url_source=base_url_source,
    )


def _resolve_base_url(
    *,
    base_url_override: str | None,
    env_base_url: str | None,
) -> tuple[str, ConfigSource]:
    override_value = _normalize_value(base_url_override)
    if override_value is not None:
        return override_value, "override"

    env_value = _normalize_value(env_base_url)
    if env_value is not None:
        return env_value, "env"

    return DEFAULT_RUST_BASE_URL, "default"


def _normalize_value(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    return stripped
