"""CLI context command group."""

from __future__ import annotations

import json

import typer

from .context_state import clear_cli_context, load_cli_context, resolve_cli_context_path

context_app = typer.Typer(no_args_is_help=True)


@context_app.command("show")
def context_show(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Show current CLI defaults."""
    context = load_cli_context()
    payload = {
        "schema_version": context.schema_version,
        "session_id": context.session_id,
        "dataset_id": context.dataset_id,
        "view_id": context.view_id,
        "context_path": str(resolve_cli_context_path()),
    }
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    typer.echo(f"context_path: {payload['context_path']}")
    typer.echo(f"session_id: {payload['session_id'] or '(none)'}")
    typer.echo(f"dataset_id: {payload['dataset_id'] or '(none)'}")
    typer.echo(f"view_id: {payload['view_id'] or '(none)'}")


@context_app.command("clear")
def context_clear(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Clear current CLI defaults."""
    context = clear_cli_context()
    payload = {
        "schema_version": context.schema_version,
        "session_id": context.session_id,
        "dataset_id": context.dataset_id,
        "view_id": context.view_id,
        "context_path": str(resolve_cli_context_path()),
    }
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    typer.echo("context cleared")
    typer.echo(f"context_path: {payload['context_path']}")
