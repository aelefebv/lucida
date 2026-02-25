"""Session command group."""

from __future__ import annotations

import json

import typer

from lucida.client import LucidaClientError
from lucida.errors import LucidaError

from .common import create_cli_client, emit_client_error, emit_exception, resolve_cli_base_url
from .context_state import load_cli_context, save_cli_context
from .daemon_bootstrap import DaemonBootstrapError, ensure_local_daemon_running

session_app = typer.Typer(no_args_is_help=True)


@session_app.command("create")
def session_create(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Create a new session via API."""
    resolved_base_url = resolve_cli_base_url(base_url)
    try:
        ensure_local_daemon_running(base_url=resolved_base_url)
        with create_cli_client(resolved_base_url) as client:
            response = client.create_session()
    except DaemonBootstrapError as exc:
        emit_exception(exc)
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(
            exc,
            code="session_create_failed",
        )

    payload = response.model_dump(mode="json")
    context = load_cli_context()
    context.session_id = payload["session_id"]
    context.dataset_id = None
    context.view_id = None
    save_cli_context(context)

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"session_id: {payload['session_id']}")
    typer.echo(f"created_at: {payload['created_at']}")


@session_app.command("use")
def session_use(
    session_id: str = typer.Option(..., "--session-id", help="Session id to set as default."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Set the default session id used by CLI commands."""
    context = load_cli_context()
    context.session_id = session_id
    context.dataset_id = None
    context.view_id = None
    save_cli_context(context)

    payload = context.to_payload()
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"session_id: {session_id}")
    typer.echo("dataset_id: (cleared)")
    typer.echo("view_id: (cleared)")


@session_app.command("current")
def session_current(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Show the default session id used by CLI commands."""
    context = load_cli_context()
    payload = context.to_payload()
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"session_id: {context.session_id or '(none)'}")
