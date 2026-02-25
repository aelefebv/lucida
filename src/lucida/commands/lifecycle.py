"""Top-level daemon lifecycle commands."""

from __future__ import annotations

import json

import typer

from .common import emit_exception, resolve_cli_base_url
from .daemon_bootstrap import DaemonBootstrapError, stop_managed_daemon


def stop_command(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to target."
    ),
) -> None:
    """Stop the managed local daemon for the resolved base URL."""
    resolved_base_url = resolve_cli_base_url(base_url)
    try:
        result = stop_managed_daemon(resolved_base_url)
    except DaemonBootstrapError as exc:
        emit_exception(exc)

    payload = result.to_payload()
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    if result.status == "stopped":
        typer.echo(f"stopped daemon at {result.base_url} (pid={result.pid})")
        return
    if result.status == "not_running":
        typer.echo(f"managed daemon for {result.base_url} is already stopped (pid={result.pid})")
        return
    typer.echo(f"no managed daemon for {result.base_url}")


def close_command(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to target."
    ),
) -> None:
    """Alias for ``lucida stop``."""
    stop_command(output_json=output_json, base_url=base_url)


def exit_command(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to target."
    ),
) -> None:
    """Alias for ``lucida stop``."""
    stop_command(output_json=output_json, base_url=base_url)
