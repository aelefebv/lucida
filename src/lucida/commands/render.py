"""Render command group."""

from __future__ import annotations

import json
from pathlib import Path

import typer

from lucida.client import LucidaClientError
from lucida.errors import LucidaError

from .common import (
    create_cli_client,
    emit_client_error,
    emit_exception,
    load_patch,
    load_view_state,
)
from .context_state import (
    load_cli_context,
    resolve_optional_identifier,
    resolve_required_identifier,
    save_cli_context,
)

render_app = typer.Typer(no_args_is_help=True)


@render_app.command("image")
def render_image(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    view_state_file: Path | None = typer.Option(
        None,
        "--view-state-file",
        help="Optional JSON file containing a full ViewState object.",
    ),
    view_state_json: str | None = typer.Option(
        None,
        "--view-state-json",
        help="Optional inline JSON object containing a full ViewState object.",
    ),
    width_px: int = typer.Option(..., "--width-px", help="Output width in pixels."),
    height_px: int = typer.Option(..., "--height-px", help="Output height in pixels."),
    delivery: str = typer.Option(
        "inline_base64",
        "--delivery",
        help="Delivery mode: inline_base64 or file_path.",
    ),
    file_path: Path | None = typer.Option(
        None,
        "--file-path",
        help="Optional file output path when --delivery file_path.",
    ),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    request_id: str | None = typer.Option(None, "--request-id", help="Optional request id."),
    patch_file: Path | None = typer.Option(
        None,
        "--patch-file",
        help="Optional JSON file with render-time RFC6902 overrides.",
    ),
    patch_json: str | None = typer.Option(
        None,
        "--patch-json",
        help="Optional inline JSON array with render-time RFC6902 overrides.",
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Render a PNG image for a view."""
    context = load_cli_context()
    try:
        has_view_state = view_state_file is not None or view_state_json is not None
        if has_view_state and view_id is not None:
            raise ValueError("Provide exactly one of --view-id or one view-state input.")
        resolved_view_id: str | None = None
        if not has_view_state:
            resolved_view_id = resolve_required_identifier(
                view_id,
                context.view_id,
                name="view_id",
                hint="run `lucida view create` or `lucida view use` first",
            )

        resolved_session_id = resolve_optional_identifier(session_id, context.session_id)
        if delivery not in {"inline_base64", "file_path"}:
            raise ValueError("delivery must be one of: inline_base64, file_path.")

        view_state_value = (
            load_view_state(view_state_file, view_state_json) if has_view_state else None
        )
        overrides = (
            load_patch(patch_file, patch_json)
            if patch_file is not None or patch_json is not None
            else None
        )
        file_path_value = str(file_path) if file_path is not None else None
        with create_cli_client(base_url) as client:
            response = client.render_image(
                view_id=resolved_view_id,
                view_state=(
                    view_state_value.model_dump(mode="json")
                    if view_state_value is not None
                    else None
                ),
                width_px=width_px,
                height_px=height_px,
                delivery=delivery,
                file_path=file_path_value,
                session_id=resolved_session_id,
                request_id=request_id,
                overrides_json_patch=overrides,
            )
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)
    except ValueError as exc:
        emit_exception(exc)

    payload = response.model_dump(mode="json")
    if resolved_view_id is not None:
        context.view_id = resolved_view_id
    if resolved_session_id is not None:
        context.session_id = resolved_session_id
    save_cli_context(context)

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"render_id: {payload['render_id']}")
    typer.echo(f"request_id: {payload['request_id']}")
    typer.echo(f"status: {payload['status']}")
    typer.echo(f"image_sha256: {payload['images'][0]['sha256']}")
    if "file_path" in payload["images"][0]:
        typer.echo(f"file_path: {payload['images'][0]['file_path']}")
