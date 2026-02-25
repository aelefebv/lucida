"""Shared helpers for command-line modules."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, NoReturn

import typer

from lucida.client import LucidaClientError
from lucida.errors import LucidaError, as_api_error_payload
from lucida.models.view_state import AxisSelector, View2D, ViewState
from lucida.runtime_config import resolve_runtime_config


def load_patch(path: Path | None, raw_json: str | None) -> list[dict[str, Any]]:
    """Load a JSON patch array from file or inline JSON."""
    loaded = load_json_input(path=path, raw_json=raw_json, option_name="patch")
    if not isinstance(loaded, list):
        raise ValueError("patch input must contain a JSON array.")
    if not all(isinstance(item, dict) for item in loaded):
        raise ValueError("patch array elements must be objects.")
    return loaded


def load_view_state(path: Path | None, raw_json: str | None) -> ViewState | None:
    """Load an optional view-state payload from file or inline JSON."""
    loaded = load_json_input(
        path=path,
        raw_json=raw_json,
        option_name="view-state",
        allow_none=True,
    )
    if loaded is None:
        return None
    if not isinstance(loaded, dict):
        raise ValueError("view-state input must contain a JSON object.")
    return ViewState.model_validate(loaded)


def load_selectors(path: Path | None, raw_json: str | None) -> list[AxisSelector] | None:
    """Load an optional selector array from file or inline JSON."""
    loaded = load_json_input(
        path=path,
        raw_json=raw_json,
        option_name="selectors",
        allow_none=True,
    )
    if loaded is None:
        return None
    if not isinstance(loaded, list):
        raise ValueError("selectors input must contain a JSON array.")
    return [AxisSelector.model_validate(item) for item in loaded]


def load_view_2d(path: Path | None, raw_json: str | None) -> View2D | None:
    """Load an optional 2D view payload from file or inline JSON."""
    loaded = load_json_input(
        path=path,
        raw_json=raw_json,
        option_name="view2d",
        allow_none=True,
    )
    if loaded is None:
        return None
    if not isinstance(loaded, dict):
        raise ValueError("view2d input must contain a JSON object.")
    return View2D.model_validate(loaded)


def load_json_input(
    *,
    path: Path | None,
    raw_json: str | None,
    option_name: str,
    allow_none: bool = False,
) -> Any | None:
    """Load JSON from exactly one input source."""
    if path is not None and raw_json is not None:
        raise ValueError(
            f"Provide only one {option_name} source (file or inline JSON), not both."
        )
    if path is None and raw_json is None:
        if allow_none:
            return None
        raise ValueError(f"{option_name} input is required.")
    try:
        if path is not None:
            return json.loads(path.read_text(encoding="utf-8"))
        return json.loads(raw_json or "")
    except json.JSONDecodeError as exc:
        raise ValueError(f"{option_name} input must be valid JSON: {exc.msg}") from exc


def resolve_cli_base_url(base_url_override: str | None) -> str:
    """Resolve effective HTTP URL for CLI commands."""
    runtime = resolve_runtime_config(base_url_override=base_url_override)
    return runtime.base_url


def emit_exception(exc: Exception) -> NoReturn:
    """Emit a normalized error payload and terminate the command."""
    if isinstance(exc, LucidaError):
        typer.echo(json.dumps(as_api_error_payload(exc), indent=2))
    else:
        typer.echo(
            json.dumps(
                {"code": "invalid_request", "message": str(exc), "details": {}},
                indent=2,
            )
        )
    raise typer.Exit(code=1) from exc


def emit_client_error(
    exc: LucidaClientError,
    *,
    code: str = "client_request_failed",
    details: dict[str, Any] | None = None,
) -> NoReturn:
    """Emit a transport/client error payload and terminate the command."""
    typer.echo(
        json.dumps(
            {"code": code, "message": str(exc), "details": details or {}},
            indent=2,
        )
    )
    raise typer.Exit(code=1) from exc
