"""Session command group."""

from __future__ import annotations

import json

import typer

from lucida.client import LucidaClientError
from lucida.errors import LucidaError

from .common import create_cli_client, emit_client_error, emit_exception

session_app = typer.Typer(no_args_is_help=True)


@session_app.command("create")
def session_create(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Create a new session via API."""
    try:
        with create_cli_client(base_url) as client:
            response = client.create_session()
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(
            exc,
            code="session_create_failed",
        )

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"session_id: {payload['session_id']}")
    typer.echo(f"created_at: {payload['created_at']}")
