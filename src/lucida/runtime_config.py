"""Runtime backend configuration for CLI/client execution modes."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal, Mapping

BackendKind = Literal["python", "rust"]
ConfigSource = Literal["override", "env", "default"]

DEFAULT_PYTHON_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_RUST_BASE_URL = "http://127.0.0.1:3000"


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """Resolved runtime configuration for backend and transport.

    Attributes
    ----------
    backend:
        Selected backend kind.
    backend_source:
        Source used to resolve the backend.
    base_url:
        Effective HTTP base URL for remote transport.
    base_url_source:
        Source used to resolve ``base_url``.
    """

    backend: BackendKind
    backend_source: ConfigSource
    base_url: str
    base_url_source: ConfigSource

    @property
    def use_http(self) -> bool:
        """Return whether runtime should use HTTP transport.

        Rust always uses HTTP in Milestone 0. Python uses HTTP only when a base URL is
        explicitly provided via CLI override or environment configuration.
        """
        if self.backend == "rust":
            return True
        return self.base_url_source != "default"


def resolve_runtime_config(
    *,
    backend_override: BackendKind | str | None = None,
    base_url_override: str | None = None,
    env: Mapping[str, str] | None = None,
) -> RuntimeConfig:
    """Resolve backend/base-url runtime config with fixed precedence.

    Precedence is:
    1. Explicit runtime override (``backend_override``).
    2. CLI/client base URL override (``base_url_override``).
    3. Environment (``LUCIDA_BACKEND``, ``LUCIDA_BASE_URL``).
    4. Defaults.
    """

    env_values = dict(env if env is not None else os.environ)

    backend, backend_source = _resolve_backend(
        backend_override=backend_override,
        env_backend=env_values.get("LUCIDA_BACKEND"),
    )
    base_url, base_url_source = _resolve_base_url(
        backend=backend,
        base_url_override=base_url_override,
        env_base_url=env_values.get("LUCIDA_BASE_URL"),
    )

    return RuntimeConfig(
        backend=backend,
        backend_source=backend_source,
        base_url=base_url,
        base_url_source=base_url_source,
    )


def _resolve_backend(
    *,
    backend_override: BackendKind | str | None,
    env_backend: str | None,
) -> tuple[BackendKind, ConfigSource]:
    override_value = _normalize_value(backend_override)
    if override_value is not None:
        return _normalize_backend(override_value), "override"

    env_value = _normalize_value(env_backend)
    if env_value is not None:
        return _normalize_backend(env_value), "env"

    return "python", "default"


def _resolve_base_url(
    *,
    backend: BackendKind,
    base_url_override: str | None,
    env_base_url: str | None,
) -> tuple[str, ConfigSource]:
    override_value = _normalize_value(base_url_override)
    if override_value is not None:
        return override_value, "override"

    env_value = _normalize_value(env_base_url)
    if env_value is not None:
        return env_value, "env"

    if backend == "rust":
        return DEFAULT_RUST_BASE_URL, "default"
    return DEFAULT_PYTHON_BASE_URL, "default"


def _normalize_backend(value: str) -> BackendKind:
    normalized = value.strip().lower()
    if normalized in {"python", "rust"}:
        return normalized
    raise ValueError("backend must be one of: python, rust.")


def _normalize_value(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    return stripped
