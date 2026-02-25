"""Dataset command group."""

from __future__ import annotations

import json

import typer

from lucida.client import LucidaClient, LucidaClientError
from lucida.errors import LucidaError

from .common import emit_client_error, emit_exception, resolve_cli_base_url

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
    try:
        resolved_base_url = resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.open_dataset(
                uri=uri,
                dataset_id=dataset_id,
                session_id=session_id,
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
