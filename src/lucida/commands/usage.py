"""Usage telemetry command group."""

from __future__ import annotations

import json

import typer

from lucida.client import LucidaClient, LucidaClientError
from lucida.errors import LucidaError

from .common import emit_client_error, emit_exception, resolve_cli_base_url

usage_app = typer.Typer(no_args_is_help=True)


@usage_app.command("events")
def usage_events(
    limit: int = typer.Option(100, "--limit", min=1, help="Maximum number of events."),
    before_id: int | None = typer.Option(None, "--before-id", help="Return events before this id."),
    run_id: str | None = typer.Option(None, "--run-id", help="Filter by agent run id."),
    endpoint: str | None = typer.Option(None, "--endpoint", help="Filter by endpoint path."),
    status_code: int | None = typer.Option(None, "--status-code", help="Filter by HTTP status code."),
    from_ts: str | None = typer.Option(None, "--from-ts", help="RFC3339 lower timestamp bound."),
    to_ts: str | None = typer.Option(None, "--to-ts", help="RFC3339 upper timestamp bound."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """List usage telemetry events."""
    try:
        resolved_base_url = resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.list_usage_events(
                limit=limit,
                before_id=before_id,
                run_id=run_id,
                endpoint=endpoint,
                status_code=status_code,
                from_ts=from_ts,
                to_ts=to_ts,
            )
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    events = payload["events"]
    typer.echo(f"events: {len(events)}")
    for event in events:
        typer.echo(
            f"{event['id']} {event['occurred_at_utc']} {event['method']} {event['endpoint']} {event['status_code']}"
        )


@usage_app.command("runs")
def usage_runs(
    limit: int = typer.Option(50, "--limit", min=1, help="Maximum number of runs."),
    before_start_ts: str | None = typer.Option(
        None, "--before-start-ts", help="RFC3339 upper bound for run start timestamp."
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """List usage run aggregates."""
    try:
        resolved_base_url = resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.list_usage_runs(limit=limit, before_start_ts=before_start_ts)
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    runs = payload["runs"]
    typer.echo(f"runs: {len(runs)}")
    for run in runs:
        typer.echo(
            f"{run['agent_run_id']} events={run['event_count']} errors={run['error_count']} renders={run['render_count']}"
        )


@usage_app.command("run")
def usage_run(
    run_id: str = typer.Option(..., "--run-id", help="Agent run id."),
    event_limit: int = typer.Option(200, "--event-limit", min=1, help="Maximum events in run detail."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Fetch one usage run summary and recent events."""
    try:
        resolved_base_url = resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.get_usage_run(run_id=run_id, event_limit=event_limit)
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    run = payload["run"]
    typer.echo(f"run_id: {run['agent_run_id']}")
    typer.echo(f"event_count: {run['event_count']}")
    typer.echo(f"error_count: {run['error_count']}")
    typer.echo(f"render_count: {run['render_count']}")
    typer.echo(f"events_returned: {len(payload['events'])}")


@usage_app.command("stream-url")
def usage_stream_url(
    run_id: str | None = typer.Option(None, "--run-id", help="Optional run id filter."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Build the usage events SSE stream URL."""
    try:
        resolved_base_url = resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            stream_url = client.usage_events_stream_url(run_id=run_id)
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    typer.echo(stream_url)
