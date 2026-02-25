"""Dataset command group."""

from __future__ import annotations

import json

import typer

from lucida.client import LucidaClientError
from lucida.errors import LucidaError

from .common import create_cli_client, emit_client_error, emit_exception
from .context_state import (
    load_cli_context,
    resolve_optional_identifier,
    save_cli_context,
)

dataset_app = typer.Typer(no_args_is_help=True)


@dataset_app.command("open")
def dataset_open(
    uri: str = typer.Option(..., "--uri", help="OME-Zarr dataset URI or local path."),
    dataset_id: str | None = typer.Option(None, "--dataset-id", help="Optional dataset id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    full_raw_metadata: bool = typer.Option(
        False, "--full-raw-metadata", help="Include full raw metadata passthrough."
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Open a dataset locally or via API and print a compact summary."""
    context = load_cli_context()
    resolved_session_id = resolve_optional_identifier(session_id, context.session_id)

    try:
        with create_cli_client(base_url) as client:
            response = client.open_dataset(
                uri=uri,
                dataset_id=dataset_id,
                session_id=resolved_session_id,
                include_full_raw_metadata=full_raw_metadata,
            )
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(
            exc,
            code="dataset_open_failed",
            details={"uri": uri},
        )

    payload = response.model_dump(mode="json")
    opened_dataset_id = payload["dataset_summary"]["dataset_id"]
    context.dataset_id = opened_dataset_id
    context.view_id = None
    if resolved_session_id is not None:
        context.session_id = resolved_session_id
    save_cli_context(context)

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    summary = payload["dataset_summary"]
    typer.echo(f"dataset_id: {summary['dataset_id']}")
    typer.echo(f"uri: {summary['uri']}")
    typer.echo(f"dtype: {summary['dtype']}")
    typer.echo(f"shape: {summary['shape']}")
    typer.echo(f"multiscales: {len(summary['multiscales'])}")
    typer.echo(f"warnings: {len(payload['warnings'])}")


@dataset_app.command("use")
def dataset_use(
    dataset_id: str = typer.Option(..., "--dataset-id", help="Dataset id to set as default."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Set the default dataset id used by CLI commands."""
    context = load_cli_context()
    context.dataset_id = dataset_id
    context.view_id = None
    save_cli_context(context)

    payload = context.to_payload()
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"dataset_id: {dataset_id}")
    typer.echo("view_id: (cleared)")


@dataset_app.command("current")
def dataset_current(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Show the default dataset id used by CLI commands."""
    context = load_cli_context()
    payload = context.to_payload()
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"dataset_id: {context.dataset_id or '(none)'}")
