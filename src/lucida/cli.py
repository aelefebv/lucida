"""Typer-based command line interface for Rust-daemon HTTP usage."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer

from lucida.client import LucidaClient, LucidaClientError
from lucida.errors import LucidaError, as_api_error_payload
from lucida.models.view_state import AxisSelector, View2D, ViewState, Viewport
from lucida.runtime_config import resolve_runtime_config

app = typer.Typer(no_args_is_help=True)
dataset_app = typer.Typer(no_args_is_help=True)
session_app = typer.Typer(no_args_is_help=True)
view_app = typer.Typer(no_args_is_help=True)
render_app = typer.Typer(no_args_is_help=True)
usage_app = typer.Typer(no_args_is_help=True)
app.add_typer(dataset_app, name="dataset")
app.add_typer(session_app, name="session")
app.add_typer(view_app, name="view")
app.add_typer(render_app, name="render")
app.add_typer(usage_app, name="usage")

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
    """Open a dataset locally or via API and print a compact summary.

    Parameters
    ----------
    uri:
        OME-Zarr dataset URI or local filesystem path.
    dataset_id:
        Optional explicit dataset identifier.
    session_id:
        Optional session id to scope dataset attachment.
    full_raw_metadata:
        Return full raw metadata payloads when true.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    try:
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.open_dataset(
                uri=uri,
                dataset_id=dataset_id,
                session_id=session_id,
                include_full_raw_metadata=full_raw_metadata,
            )
    except LucidaError as exc:
        typer.echo(json.dumps(as_api_error_payload(exc), indent=2))
        raise typer.Exit(code=1) from exc
    except LucidaClientError as exc:
        _emit_client_error(
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


@session_app.command("create")
def session_create(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Create a new session via API.

    Parameters
    ----------
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    try:
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.create_session()
    except LucidaError as exc:
        typer.echo(json.dumps(as_api_error_payload(exc), indent=2))
        raise typer.Exit(code=1) from exc
    except LucidaClientError as exc:
        _emit_client_error(
            exc,
            code="session_create_failed",
        )

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"session_id: {payload['session_id']}")
    typer.echo(f"created_at: {payload['created_at']}")


@view_app.command("create")
def view_create(
    dataset_id: str = typer.Option(..., "--dataset-id", help="Dataset id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    mode: str = typer.Option("2d", "--mode", help="Render mode."),
    multiscale_name: str | None = typer.Option(
        None, "--multiscale-name", help="Optional multiscale name."
    ),
    width_px: int = typer.Option(1024, "--width-px", help="Viewport width."),
    height_px: int = typer.Option(1024, "--height-px", help="Viewport height."),
    pixel_ratio: float = typer.Option(1.0, "--pixel-ratio", help="Viewport pixel ratio."),
    selectors_file: Path | None = typer.Option(
        None, "--selectors-file", help="Optional JSON file with selector list."
    ),
    selectors_json: str | None = typer.Option(
        None, "--selectors-json", help="Optional inline JSON array with selector list."
    ),
    view_2d_file: Path | None = typer.Option(
        None, "--view2d-file", help="Optional JSON file with view_2d object."
    ),
    view_2d_json: str | None = typer.Option(
        None, "--view2d-json", help="Optional inline JSON object with view_2d payload."
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Create a new view and emit either JSON or a short text summary.

    Parameters
    ----------
    dataset_id:
        Target dataset identifier.
    session_id:
        Optional session id to scope the view.
    mode:
        Render mode (currently ``2d``/``3d`` accepted by schema).
    multiscale_name:
        Optional target multiscale name.
    width_px:
        Requested viewport width in pixels.
    height_px:
        Requested viewport height in pixels.
    pixel_ratio:
        Device pixel ratio.
    selectors_file:
        Optional JSON file containing selector definitions.
    view_2d_file:
        Optional JSON file containing `view_2d`.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    try:
        selectors_value = _load_selectors(selectors_file, selectors_json)
        view_2d_value = _load_view_2d(view_2d_file, view_2d_json)
        viewport = Viewport(width_px=width_px, height_px=height_px, pixel_ratio=pixel_ratio)

        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.create_view(
                dataset_id=dataset_id,
                session_id=session_id,
                mode=mode,
                multiscale_name=multiscale_name,
                viewport=viewport.model_dump(mode="json"),
                selectors=[item.model_dump(mode="json") for item in selectors_value]
                if selectors_value is not None
                else None,
                view_2d=view_2d_value.model_dump(mode="json") if view_2d_value else None,
            )
    except (LucidaError, ValueError) as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"session_id: {view_state['session_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


@view_app.command("get")
def view_get(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Fetch and print an existing view state.

    Parameters
    ----------
    view_id:
        Target view identifier.
    session_id:
        Optional session id to scope lookup.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    try:
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.get_view(view_id=view_id, session_id=session_id)
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


@view_app.command("export")
def view_export(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    out: Path | None = typer.Option(
        None,
        "--out",
        help="Optional output file path for exported view_state JSON payload.",
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Export a full persisted view state.

    Parameters
    ----------
    view_id:
        Source view identifier.
    session_id:
        Optional session id for scope checks.
    out:
        Optional file path for writing import-ready ``view_state`` JSON.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    try:
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.export_viewstate(view_id=view_id, session_id=session_id)
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload["view_state"], indent=2), encoding="utf-8")

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    typer.echo(f"export_id: {payload['export_id']}")
    typer.echo(f"source_view_id: {payload['source_view_id']}")
    if out is not None:
        typer.echo(f"out: {out}")


@view_app.command("import")
def view_import(
    view_state_file: Path | None = typer.Option(
        None,
        "--view-state-file",
        help="JSON file containing the serialized ViewState payload to import.",
    ),
    view_state_json: str | None = typer.Option(
        None,
        "--view-state-json",
        help="Inline JSON object containing the serialized ViewState payload to import.",
    ),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Import a view state as a new persisted view.

    Parameters
    ----------
    view_state_file:
        JSON file path containing a full ``ViewState`` object.
    session_id:
        Optional target session id.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    try:
        view_state_value = _load_view_state(view_state_file, view_state_json)
        if view_state_value is None:
            raise ValueError("view-state input is required.")

        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.import_viewstate(
                view_state=view_state_value.model_dump(mode="json"),
                session_id=session_id,
            )
    except (LucidaError, ValueError) as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    typer.echo(f"import_id: {payload['import_id']}")
    typer.echo(f"imported_from_view_id: {payload['imported_from_view_id']}")
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


@view_app.command("update")
def view_update(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    patch_file: Path | None = typer.Option(
        None, "--patch-file", help="JSON file containing RFC6902 patch."
    ),
    patch_json: str | None = typer.Option(
        None, "--patch-json", help="Inline JSON array containing RFC6902 patch."
    ),
    expected_state_version: int | None = typer.Option(
        None,
        "--expected-state-version",
        min=0,
        help="Optional optimistic concurrency guard for current state version.",
    ),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Apply an RFC6902 JSON patch to a view.

    Parameters
    ----------
    view_id:
        Target view identifier.
    patch_file:
        Path containing JSON array patch operations.
    session_id:
        Optional session id for scoping.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    try:
        patch = _load_patch(patch_file, patch_json)
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.update_view(
                view_id=view_id,
                patch=patch,
                session_id=session_id,
                expected_state_version=expected_state_version,
            )
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


@view_app.command("set-dim")
def view_set_dim(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    axis: str = typer.Option(..., "--axis", help="Axis name."),
    index: int = typer.Option(..., "--index", help="Axis index."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    clamp: bool = typer.Option(True, "--clamp/--no-clamp", help="Enable clamping."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set a single-axis index selector value.

    Parameters
    ----------
    view_id:
        Target view identifier.
    axis:
        Axis name to set.
    index:
        New index value.
    session_id:
        Optional session id for scoping.
    clamp:
        Clamp values to axis bounds when true.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    response = _run_selector_helper(
        helper="index",
        view_id=view_id,
        axis=axis,
        session_id=session_id,
        clamp=clamp,
        base_url=base_url,
        payload={"index": index},
    )
    _emit_view_update_response(response, output_json=output_json)


@view_app.command("set-range")
def view_set_range(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    axis: str = typer.Option(..., "--axis", help="Axis name."),
    start: int = typer.Option(..., "--start", help="Range start."),
    end_exclusive: int = typer.Option(..., "--end-exclusive", help="Range end exclusive."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    clamp: bool = typer.Option(True, "--clamp/--no-clamp", help="Enable clamping."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set an axis selector to an index range.

    Parameters
    ----------
    view_id:
        Target view identifier.
    axis:
        Axis name to set.
    start:
        Start offset (inclusive).
    end_exclusive:
        End offset (exclusive).
    session_id:
        Optional session id for scoping.
    clamp:
        Clamp values to axis bounds when true.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    response = _run_selector_helper(
        helper="range",
        view_id=view_id,
        axis=axis,
        session_id=session_id,
        clamp=clamp,
        base_url=base_url,
        payload={"start": start, "end_exclusive": end_exclusive},
    )
    _emit_view_update_response(response, output_json=output_json)


@view_app.command("set-set")
def view_set_set(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    axis: str = typer.Option(..., "--axis", help="Axis name."),
    indices: list[int] = typer.Option(..., "--index", help="Repeat --index for each value."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    clamp: bool = typer.Option(True, "--clamp/--no-clamp", help="Enable clamping."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set an axis selector to an explicit set of indices.

    Parameters
    ----------
    view_id:
        Target view identifier.
    axis:
        Axis name to set.
    indices:
        New index values.
    session_id:
        Optional session id for scoping.
    clamp:
        Clamp values to axis bounds when true.
    output_json:
        Emit machine-readable JSON output.
    base_url:
        Optional HTTP base URL for API mode.
    """
    response = _run_selector_helper(
        helper="set",
        view_id=view_id,
        axis=axis,
        session_id=session_id,
        clamp=clamp,
        base_url=base_url,
        payload={"indices": indices},
    )
    _emit_view_update_response(response, output_json=output_json)


@view_app.command("set-plane")
def view_set_plane(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    plane: str = typer.Option(..., "--plane", help="Plane: xy, xz, or yz."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set view plane while preserving projected center."""
    response = _run_navigation_helper(
        helper="set-plane",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"plane": plane},
    )
    _emit_view_update_response(response, output_json=output_json)


@view_app.command("pan")
def view_pan(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    dx_px: float = typer.Option(..., "--dx-px", help="Pan delta in screen pixels (x)."),
    dy_px: float = typer.Option(..., "--dy-px", help="Pan delta in screen pixels (y)."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Pan the 2D camera by pixel deltas."""
    response = _run_navigation_helper(
        helper="pan",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"dx_px": dx_px, "dy_px": dy_px},
    )
    _emit_view_update_response(response, output_json=output_json)


@view_app.command("zoom")
def view_zoom(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    factor: float = typer.Option(..., "--factor", help="Multiplicative zoom factor (>0)."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Multiply 2D camera zoom by factor."""
    response = _run_navigation_helper(
        helper="zoom",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"factor": factor},
    )
    _emit_view_update_response(response, output_json=output_json)


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
    try:
        has_view_state = view_state_file is not None or view_state_json is not None
        if (view_id is None) == (not has_view_state):
            raise ValueError("Provide exactly one of --view-id or one view-state input.")
        if delivery not in {"inline_base64", "file_path"}:
            raise ValueError("delivery must be one of: inline_base64, file_path.")

        view_state_value = (
            _load_view_state(view_state_file, view_state_json) if has_view_state else None
        )
        overrides = (
            _load_patch(patch_file, patch_json)
            if patch_file is not None or patch_json is not None
            else None
        )
        file_path_value = str(file_path) if file_path is not None else None
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.render_image(
                view_id=view_id,
                view_state=(
                    view_state_value.model_dump(mode="json")
                    if view_state_value is not None
                    else None
                ),
                width_px=width_px,
                height_px=height_px,
                delivery=delivery,
                file_path=file_path_value,
                session_id=session_id,
                request_id=request_id,
                overrides_json_patch=overrides,
            )
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)
    except ValueError as exc:
        _emit_exception(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"render_id: {payload['render_id']}")
    typer.echo(f"request_id: {payload['request_id']}")
    typer.echo(f"status: {payload['status']}")
    typer.echo(f"image_sha256: {payload['images'][0]['sha256']}")
    if "file_path" in payload["images"][0]:
        typer.echo(f"file_path: {payload['images'][0]['file_path']}")


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
        resolved_base_url = _resolve_cli_base_url(base_url)
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
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

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
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.list_usage_runs(limit=limit, before_start_ts=before_start_ts)
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

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
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            response = client.get_usage_run(run_id=run_id, event_limit=event_limit)
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

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
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            stream_url = client.usage_events_stream_url(run_id=run_id)
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)

    typer.echo(stream_url)


def _run_selector_helper(
    *,
    helper: str,
    view_id: str,
    axis: str,
    session_id: str | None,
    clamp: bool,
    base_url: str | None,
    payload: dict[str, Any],
) -> Any:
    """Build a selector update and apply it via HTTP client.

    Parameters
    ----------
    helper:
        Selector mode: ``index``, ``range``, or ``set``.
    view_id:
        Target view identifier.
    axis:
        Axis name being updated.
    session_id:
        Optional session scope.
    clamp:
        Apply clamping for out-of-bounds values.
    base_url:
        Optional API endpoint base URL.
    payload:
        Parsed selector payload from CLI argument parsing.
    """
    try:
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            if helper == "index":
                return client.set_dim(
                    view_id=view_id,
                    axis=axis,
                    index=payload["index"],
                    session_id=session_id,
                    clamp=clamp,
                )
            if helper == "range":
                return client.set_axis_range(
                    view_id=view_id,
                    axis=axis,
                    start=payload["start"],
                    end_exclusive=payload["end_exclusive"],
                    session_id=session_id,
                    clamp=clamp,
                )
            return client.set_axis_set(
                view_id=view_id,
                axis=axis,
                indices=payload["indices"],
                session_id=session_id,
                clamp=clamp,
            )
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)
    raise AssertionError("unreachable")


def _run_navigation_helper(
    *,
    helper: str,
    view_id: str,
    session_id: str | None,
    base_url: str | None,
    payload: dict[str, Any],
) -> Any:
    """Run pan/zoom/plane operations via HTTP client."""
    try:
        resolved_base_url = _resolve_cli_base_url(base_url)
        with LucidaClient(base_url=resolved_base_url) as client:
            if helper == "set-plane":
                return client.set_plane(
                    view_id=view_id,
                    plane=payload["plane"],
                    session_id=session_id,
                )
            if helper == "pan":
                return client.pan(
                    view_id=view_id,
                    dx_px=float(payload["dx_px"]),
                    dy_px=float(payload["dy_px"]),
                    session_id=session_id,
                )
            return client.zoom(
                view_id=view_id,
                factor=float(payload["factor"]),
                session_id=session_id,
            )
    except (LucidaError, ValueError) as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)
    raise AssertionError("unreachable")


def _emit_view_update_response(response: Any, *, output_json: bool) -> None:
    """Write a view update response in requested output format.

    Parameters
    ----------
    response:
        Response model from a successful view update.
    output_json:
        If true, emit JSON string.
    """
    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


def _load_patch(path: Path | None, raw_json: str | None) -> list[dict[str, Any]]:
    loaded = _load_json_input(path=path, raw_json=raw_json, option_name="patch")
    if not isinstance(loaded, list):
        raise ValueError("patch input must contain a JSON array.")
    if not all(isinstance(item, dict) for item in loaded):
        raise ValueError("patch array elements must be objects.")
    return loaded


def _load_view_state(path: Path | None, raw_json: str | None) -> ViewState | None:
    loaded = _load_json_input(
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


def _load_selectors(path: Path | None, raw_json: str | None) -> list[AxisSelector] | None:
    loaded = _load_json_input(
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


def _load_view_2d(path: Path | None, raw_json: str | None) -> View2D | None:
    loaded = _load_json_input(
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


def _load_json_input(
    *,
    path: Path | None,
    raw_json: str | None,
    option_name: str,
    allow_none: bool = False,
) -> Any | None:
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


def _resolve_cli_base_url(base_url_override: str | None) -> str:
    """Resolve effective HTTP URL for CLI commands.

    Rust backend always uses HTTP transport.
    """
    runtime = resolve_runtime_config(base_url_override=base_url_override)
    return runtime.base_url


def _emit_exception(exc: Exception) -> None:
    """Emit a normalized Lucida exception payload and exit with error.

    Parameters
    ----------
    exc:
        Exception raised by command execution.
    """
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


def _emit_client_error(
    exc: LucidaClientError,
    *,
    code: str = "client_request_failed",
    details: dict[str, Any] | None = None,
) -> None:
    """Emit a generic client transport error and exit.

    Parameters
    ----------
    exc:
        HTTP/client transport exception.
    """
    typer.echo(
        json.dumps(
            {"code": code, "message": str(exc), "details": details or {}},
            indent=2,
        )
    )
    raise typer.Exit(code=1) from exc


def main() -> None:
    """Launch the Typer application."""
    app()


if __name__ == "__main__":
    main()
