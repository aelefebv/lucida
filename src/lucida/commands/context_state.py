"""Persistent CLI context for default session/dataset/view identifiers."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(slots=True)
class CliContext:
    """Locally persisted CLI defaults."""

    schema_version: int = 1
    session_id: str | None = None
    dataset_id: str | None = None
    view_id: str | None = None

    def to_payload(self) -> dict[str, object | None]:
        """Serialize context into a JSON-compatible payload."""
        return asdict(self)


def resolve_cli_context_path() -> Path:
    """Resolve the on-disk context path."""
    env_path = os.environ.get("LUCIDA_CLI_CONTEXT_PATH", "").strip()
    if env_path:
        return Path(env_path).expanduser()
    return Path.home() / ".config" / "lucida" / "cli-context.json"


def load_cli_context() -> CliContext:
    """Load persisted CLI defaults."""
    path = resolve_cli_context_path()
    if not path.exists():
        return CliContext()

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(
            f"Failed to read CLI context at {path}. "
            "Run `lucida context clear` to reset it."
        ) from exc

    if not isinstance(payload, dict):
        raise ValueError(
            f"Invalid CLI context at {path}. Run `lucida context clear` to reset it."
        )
    schema_version = payload.get("schema_version", 1)
    if schema_version != 1:
        raise ValueError(
            f"Unsupported CLI context schema_version={schema_version}. "
            "Run `lucida context clear` to reset it."
        )

    return CliContext(
        schema_version=1,
        session_id=_normalize_optional_id(payload.get("session_id"), "session_id", path),
        dataset_id=_normalize_optional_id(payload.get("dataset_id"), "dataset_id", path),
        view_id=_normalize_optional_id(payload.get("view_id"), "view_id", path),
    )


def save_cli_context(context: CliContext) -> None:
    """Persist CLI defaults to disk."""
    path = resolve_cli_context_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(context.to_payload(), indent=2), encoding="utf-8")


def clear_cli_context() -> CliContext:
    """Reset CLI defaults and persist empty state."""
    context = CliContext()
    save_cli_context(context)
    return context


def resolve_optional_identifier(explicit: str | None, fallback: str | None) -> str | None:
    """Resolve an optional identifier from explicit or context value."""
    return explicit if explicit is not None else fallback


def resolve_required_identifier(
    explicit: str | None,
    fallback: str | None,
    *,
    name: str,
    hint: str,
) -> str:
    """Resolve a required identifier from explicit or context value."""
    resolved = explicit if explicit is not None else fallback
    if resolved is None:
        raise ValueError(f"{name} is required. Provide --{name.replace('_', '-')} or {hint}.")
    return resolved


def _normalize_optional_id(value: object, name: str, path: Path) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(
            f"Invalid {name} in CLI context at {path}. "
            "Run `lucida context clear` to reset it."
        )
    normalized = value.strip()
    if not normalized:
        raise ValueError(
            f"Invalid empty {name} in CLI context at {path}. "
            "Run `lucida context clear` to reset it."
        )
    return normalized
