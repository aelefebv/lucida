from __future__ import annotations

import json

import typer

from lucida.client import LucidaClient, LucidaClientError
from lucida.errors import LucidaError, as_api_error_payload
from lucida.service.dataset_service import DatasetService

app = typer.Typer(no_args_is_help=True)
dataset_app = typer.Typer(no_args_is_help=True)
app.add_typer(dataset_app, name="dataset")


@dataset_app.command("open")
def dataset_open(
    uri: str = typer.Option(..., "--uri", help="OME-Zarr dataset URI or local path."),
    dataset_id: str | None = typer.Option(None, "--dataset-id", help="Optional dataset id."),
    full_raw_metadata: bool = typer.Option(
        False, "--full-raw-metadata", help="Include full raw metadata passthrough."
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    try:
        if base_url:
            with LucidaClient(base_url=base_url) as client:
                response = client.open_dataset(
                    uri=uri,
                    dataset_id=dataset_id,
                    include_full_raw_metadata=full_raw_metadata,
                )
        else:
            response = DatasetService().open_dataset(
                uri=uri,
                dataset_id=dataset_id,
                include_full_raw_metadata=full_raw_metadata,
            )
    except LucidaError as exc:
        typer.echo(json.dumps(as_api_error_payload(exc), indent=2))
        raise typer.Exit(code=1) from exc
    except LucidaClientError as exc:
        typer.echo(
            json.dumps(
                {
                    "code": "dataset_open_failed",
                    "message": str(exc),
                    "details": {"uri": uri},
                },
                indent=2,
            )
        )
        raise typer.Exit(code=1) from exc

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


def main() -> None:
    app()


if __name__ == "__main__":
    main()

