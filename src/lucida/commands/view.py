"""View command group."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Literal

import typer

from lucida.client import LucidaClientError
from lucida.errors import LucidaError
from lucida.models.api import ViewCreateResponse, ViewStateImportResponse, ViewUpdateResponse
from lucida.models.view_state import ViewState, Viewport

from .common import (
    create_cli_client,
    emit_client_error,
    emit_exception,
    load_patch,
    load_selectors,
    load_view_2d,
    load_view_state,
)
from .context_state import (
    CliContext,
    load_cli_context,
    resolve_optional_identifier,
    resolve_required_identifier,
    save_cli_context,
)

view_app = typer.Typer(no_args_is_help=True)

ViewMutationResponse = ViewCreateResponse | ViewUpdateResponse | ViewStateImportResponse
SelectorHelper = Literal["index", "range", "set"]
NavigationHelper = Literal[
    "set-plane",
    "toggle-orthogonal-views",
    "pan",
    "zoom",
    "rotate-set",
    "rotate-delta",
]


@view_app.command("create")
def view_create(
    dataset_id: str | None = typer.Option(None, "--dataset-id", help="Dataset id."),
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
    """Create a new view and emit either JSON or a short text summary."""
    context = load_cli_context()
    try:
        resolved_dataset_id = resolve_required_identifier(
            dataset_id,
            context.dataset_id,
            name="dataset_id",
            hint="run `lucida dataset open` or `lucida dataset use` first",
        )
        resolved_session_id = resolve_optional_identifier(session_id, context.session_id)
        selectors_value = load_selectors(selectors_file, selectors_json)
        view_2d_value = load_view_2d(view_2d_file, view_2d_json)
        viewport = Viewport(width_px=width_px, height_px=height_px, pixel_ratio=pixel_ratio)

        with create_cli_client(base_url) as client:
            response = client.create_view(
                dataset_id=resolved_dataset_id,
                session_id=resolved_session_id,
                mode=mode,
                multiscale_name=multiscale_name,
                viewport=viewport.model_dump(mode="json"),
                selectors=[item.model_dump(mode="json") for item in selectors_value]
                if selectors_value is not None
                else None,
                view_2d=view_2d_value.model_dump(mode="json") if view_2d_value else None,
            )
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    payload = response.model_dump(mode="json")
    view_state = payload["view_state"]
    context.dataset_id = resolved_dataset_id
    context.view_id = view_state["view_id"]
    if isinstance(view_state.get("session_id"), str):
        context.session_id = view_state["session_id"]
    elif resolved_session_id is not None:
        context.session_id = resolved_session_id
    save_cli_context(context)

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"session_id: {view_state['session_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


@view_app.command("export")
def view_export(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
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
    """Export a full persisted view state."""
    context = load_cli_context()
    try:
        resolved_view_id = resolve_required_identifier(
            view_id,
            context.view_id,
            name="view_id",
            hint="run `lucida view create` or `lucida view use` first",
        )
        resolved_session_id = resolve_optional_identifier(session_id, context.session_id)
        with create_cli_client(base_url) as client:
            response = client.export_viewstate(
                view_id=resolved_view_id,
                session_id=resolved_session_id,
            )
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    payload = response.model_dump(mode="json")
    context.view_id = resolved_view_id
    if resolved_session_id is not None:
        context.session_id = resolved_session_id
    save_cli_context(context)

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
    """Import a view state as a new persisted view."""
    context = load_cli_context()
    try:
        view_state_value = load_view_state(view_state_file, view_state_json)
        if view_state_value is None:
            raise ValueError("view-state input is required.")
        resolved_session_id = resolve_optional_identifier(session_id, context.session_id)

        with create_cli_client(base_url) as client:
            response = client.import_viewstate(
                view_state=view_state_value.model_dump(mode="json"),
                session_id=resolved_session_id,
            )
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    payload = response.model_dump(mode="json")
    view_state = payload["view_state"]
    context.view_id = view_state["view_id"]
    if isinstance(view_state.get("session_id"), str):
        context.session_id = view_state["session_id"]
    elif resolved_session_id is not None:
        context.session_id = resolved_session_id
    datasets_payload = view_state.get("datasets")
    if isinstance(datasets_payload, list) and datasets_payload:
        first_dataset = datasets_payload[0]
        if isinstance(first_dataset, dict) and isinstance(first_dataset.get("dataset_id"), str):
            context.dataset_id = first_dataset["dataset_id"]
    save_cli_context(context)

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    typer.echo(f"import_id: {payload['import_id']}")
    typer.echo(f"imported_from_view_id: {payload['imported_from_view_id']}")
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


@view_app.command("update")
def view_update(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
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
    """Apply an RFC6902 JSON patch to a view."""
    context = load_cli_context()
    try:
        resolved_view_id = resolve_required_identifier(
            view_id,
            context.view_id,
            name="view_id",
            hint="run `lucida view create` or `lucida view use` first",
        )
        resolved_session_id = resolve_optional_identifier(session_id, context.session_id)
        patch = load_patch(patch_file, patch_json)
        with create_cli_client(base_url) as client:
            response = client.update_view(
                view_id=resolved_view_id,
                patch=patch,
                session_id=resolved_session_id,
                expected_state_version=expected_state_version,
            )
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    context.view_id = resolved_view_id
    if resolved_session_id is not None:
        context.session_id = resolved_session_id
    save_cli_context(context)

    _emit_view_update_response(response, output_json=output_json)


@view_app.command("dim")
def view_set_dim_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    axis: str = typer.Option(..., "--axis", help="Axis name."),
    index: int = typer.Option(..., "--index", help="Axis index."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    clamp: bool = typer.Option(True, "--clamp/--no-clamp", help="Enable clamping."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set a single-axis index selector value."""
    _execute_selector_command(
        helper="index",
        view_id=view_id,
        axis=axis,
        session_id=session_id,
        clamp=clamp,
        base_url=base_url,
        payload={"index": index},
        output_json=output_json,
    )


@view_app.command("range")
def view_set_range_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
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
    """Set an axis selector to an index range."""
    _execute_selector_command(
        helper="range",
        view_id=view_id,
        axis=axis,
        session_id=session_id,
        clamp=clamp,
        base_url=base_url,
        payload={"start": start, "end_exclusive": end_exclusive},
        output_json=output_json,
    )


@view_app.command("indices")
def view_set_indices_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    axis: str = typer.Option(..., "--axis", help="Axis name."),
    indices: list[int] = typer.Option(..., "--index", help="Repeat --index for each value."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    clamp: bool = typer.Option(True, "--clamp/--no-clamp", help="Enable clamping."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set an axis selector to an explicit set of indices."""
    _execute_selector_command(
        helper="set",
        view_id=view_id,
        axis=axis,
        session_id=session_id,
        clamp=clamp,
        base_url=base_url,
        payload={"indices": indices},
        output_json=output_json,
    )


@view_app.command("plane")
def view_set_plane_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    plane: str = typer.Option(..., "--plane", help="Plane: xy, xz, or yz."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set view plane while preserving projected center."""
    _execute_navigation_command(
        helper="set-plane",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"plane": plane},
        output_json=output_json,
    )


@view_app.command("orthogonal")
def view_set_orthogonal_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    enabled: bool = typer.Option(
        True,
        "--enabled/--disabled",
        help="Enable or disable fixed orthogonal tri-planar rendering.",
    ),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Toggle persistent orthogonal tri-planar rendering in 2D mode."""
    _execute_navigation_command(
        helper="toggle-orthogonal-views",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"enabled": enabled},
        output_json=output_json,
    )


@view_app.command("rotation")
def view_set_rotation(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    rotation_deg: float = typer.Option(..., "--rotation-deg", help="Absolute 2D rotation in degrees."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Set absolute 2D camera rotation."""
    _execute_navigation_command(
        helper="rotate-set",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"rotation_deg": rotation_deg},
        output_json=output_json,
    )


@view_app.command("pan")
def view_pan_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    dx_px: float = typer.Option(..., "--dx-px", help="Pan delta in screen pixels (x)."),
    dy_px: float = typer.Option(..., "--dy-px", help="Pan delta in screen pixels (y)."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Pan the 2D camera by pixel deltas."""
    _execute_navigation_command(
        helper="pan",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"dx_px": dx_px, "dy_px": dy_px},
        output_json=output_json,
    )


@view_app.command("zoom")
def view_zoom_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    factor: float = typer.Option(..., "--factor", help="Multiplicative zoom factor (>0)."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Multiply 2D camera zoom by factor."""
    _execute_navigation_command(
        helper="zoom",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"factor": factor},
        output_json=output_json,
    )


@view_app.command("rotate")
def view_rotate_group(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    delta_deg: float = typer.Option(..., "--delta-deg", help="Relative 2D rotation delta in degrees."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Apply a relative 2D camera rotation delta."""
    _execute_navigation_command(
        helper="rotate-delta",
        view_id=view_id,
        session_id=session_id,
        base_url=base_url,
        payload={"delta_deg": delta_deg},
        output_json=output_json,
    )


@view_app.command("state")
def view_state(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Fetch and print an existing view state."""
    context = load_cli_context()
    resolved_view_id, resolved_session_id = _resolve_view_scope_ids(
        context=context,
        view_id=view_id,
        session_id=session_id,
    )
    _emit_view_state(
        view_id=resolved_view_id,
        session_id=resolved_session_id,
        output_json=output_json,
        base_url=base_url,
    )
    _persist_view_scope_context(
        context=context,
        view_id=resolved_view_id,
        session_id=resolved_session_id,
    )


@view_app.command("selectors")
def view_selectors(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Fetch just the axis selectors for a view."""
    context = load_cli_context()
    try:
        resolved_view_id, resolved_session_id = _resolve_view_scope_ids(
            context=context,
            view_id=view_id,
            session_id=session_id,
        )
        view_state = _get_view_state(
            view_id=resolved_view_id,
            session_id=resolved_session_id,
            base_url=base_url,
        )
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    _persist_view_scope_context(
        context=context,
        view_id=resolved_view_id,
        session_id=resolved_session_id,
    )
    payload: dict[str, Any] = {
        "schema_version": 1,
        "view_id": view_state.view_id,
        "state_hash": view_state.state_hash,
        "state_version": view_state.state_version,
        "selectors": [selector.model_dump(mode="json") for selector in view_state.selectors],
    }
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"view_id: {payload['view_id']}")
    typer.echo(f"state_hash: {payload['state_hash']}")
    typer.echo(f"state_version: {payload['state_version']}")
    for selector in payload["selectors"]:
        typer.echo(f"selector: {json.dumps(selector, separators=(',', ':'))}")


@view_app.command("camera")
def view_camera(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Fetch 2D camera and viewport settings."""
    context = load_cli_context()
    try:
        resolved_view_id, resolved_session_id = _resolve_view_scope_ids(
            context=context,
            view_id=view_id,
            session_id=session_id,
        )
        view_state = _get_view_state(
            view_id=resolved_view_id,
            session_id=resolved_session_id,
            base_url=base_url,
        )
        if view_state.view_2d is None:
            raise ValueError("view has no 2d state.")
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    _persist_view_scope_context(
        context=context,
        view_id=resolved_view_id,
        session_id=resolved_session_id,
    )
    payload: dict[str, Any] = {
        "schema_version": 1,
        "view_id": view_state.view_id,
        "state_hash": view_state.state_hash,
        "state_version": view_state.state_version,
        "plane": view_state.view_2d.plane,
        "camera": view_state.view_2d.camera.model_dump(mode="json"),
        "viewport": view_state.viewport.model_dump(mode="json"),
    }
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"view_id: {payload['view_id']}")
    typer.echo(f"state_hash: {payload['state_hash']}")
    typer.echo(f"state_version: {payload['state_version']}")
    typer.echo(f"plane: {payload['plane']}")
    typer.echo(f"center_world: {payload['camera']['center_world']}")
    typer.echo(f"zoom: {payload['camera']['zoom']}")
    typer.echo(f"rotation_deg: {payload['camera']['rotation_deg']}")
    typer.echo(f"viewport: {payload['viewport']}")


@view_app.command("bounds")
def view_bounds(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Compute visible 2D world bounds from current view camera and viewport."""
    context = load_cli_context()
    try:
        resolved_view_id, resolved_session_id = _resolve_view_scope_ids(
            context=context,
            view_id=view_id,
            session_id=session_id,
        )
        view_state = _get_view_state(
            view_id=resolved_view_id,
            session_id=resolved_session_id,
            base_url=base_url,
        )
        payload = _build_visible_bounds_payload(view_state)
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    _persist_view_scope_context(
        context=context,
        view_id=resolved_view_id,
        session_id=resolved_session_id,
    )
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    bounds = payload["visible_bounds_world"]
    typer.echo(f"view_id: {payload['view_id']}")
    typer.echo(f"state_hash: {payload['state_hash']}")
    typer.echo(f"state_version: {payload['state_version']}")
    typer.echo(f"plane: {payload['plane']}")
    typer.echo(f"axes: {payload['axes']}")
    typer.echo(f"u_min: {bounds['u_min']}")
    typer.echo(f"u_max: {bounds['u_max']}")
    typer.echo(f"v_min: {bounds['v_min']}")
    typer.echo(f"v_max: {bounds['v_max']}")


@view_app.command("screenshot")
def view_screenshot(
    view_id: str | None = typer.Option(None, "--view-id", help="View id."),
    width_px: int | None = typer.Option(None, "--width-px", help="Output width in pixels."),
    height_px: int | None = typer.Option(None, "--height-px", help="Output height in pixels."),
    delivery: str = typer.Option(
        "file_path",
        "--delivery",
        help="Delivery mode: inline_base64 or file_path.",
    ),
    file_path: Path | None = typer.Option(
        None,
        "--file-path",
        help="Optional output path when --delivery file_path.",
    ),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    request_id: str | None = typer.Option(None, "--request-id", help="Optional request id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    """Render a screenshot for the active view state."""
    context = load_cli_context()
    try:
        resolved_view_id, resolved_session_id = _resolve_view_scope_ids(
            context=context,
            view_id=view_id,
            session_id=session_id,
        )
        if delivery not in {"inline_base64", "file_path"}:
            raise ValueError("delivery must be one of: inline_base64, file_path.")
        with create_cli_client(base_url) as client:
            view_state = client.get_view(
                view_id=resolved_view_id,
                session_id=resolved_session_id,
            ).view_state
            resolved_width_px = width_px if width_px is not None else view_state.viewport.width_px
            resolved_height_px = height_px if height_px is not None else view_state.viewport.height_px
            response = client.render_image(
                view_id=resolved_view_id,
                width_px=resolved_width_px,
                height_px=resolved_height_px,
                delivery=delivery,
                file_path=str(file_path) if file_path is not None else None,
                session_id=resolved_session_id,
                request_id=request_id,
            )
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    _persist_view_scope_context(
        context=context,
        view_id=resolved_view_id,
        session_id=resolved_session_id,
    )
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


@view_app.command("use")
def view_use(
    view_id: str = typer.Option(..., "--view-id", help="View id to set as default."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Set the default view id used by CLI commands."""
    context = load_cli_context()
    context.view_id = view_id
    save_cli_context(context)

    payload = context.to_payload()
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"view_id: {view_id}")


@view_app.command("current")
def view_current(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
) -> None:
    """Show the default view id used by CLI commands."""
    context = load_cli_context()
    payload = context.to_payload()
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"view_id: {context.view_id or '(none)'}")


def _get_view_state(*, view_id: str, session_id: str | None, base_url: str | None) -> ViewState:
    with create_cli_client(base_url) as client:
        response = client.get_view(view_id=view_id, session_id=session_id)
    return response.view_state


def _emit_view_state(
    *,
    view_id: str,
    session_id: str | None,
    output_json: bool,
    base_url: str | None,
) -> None:
    try:
        with create_cli_client(base_url) as client:
            response = client.get_view(view_id=view_id, session_id=session_id)
    except LucidaError as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)

    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


def _run_selector_helper(
    *,
    helper: SelectorHelper,
    view_id: str,
    axis: str,
    session_id: str | None,
    clamp: bool,
    base_url: str | None,
    payload: dict[str, Any],
) -> ViewUpdateResponse:
    try:
        with create_cli_client(base_url) as client:
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
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)
    raise AssertionError("unreachable")


def _run_navigation_helper(
    *,
    helper: NavigationHelper,
    view_id: str,
    session_id: str | None,
    base_url: str | None,
    payload: dict[str, Any],
) -> ViewUpdateResponse:
    try:
        with create_cli_client(base_url) as client:
            if helper == "set-plane":
                return client.set_plane(
                    view_id=view_id,
                    plane=payload["plane"],
                    session_id=session_id,
                )
            if helper == "toggle-orthogonal-views":
                return client.set_orthogonal_views(
                    view_id=view_id,
                    enabled=bool(payload["enabled"]),
                    session_id=session_id,
                )
            if helper == "pan":
                return client.pan(
                    view_id=view_id,
                    dx_px=float(payload["dx_px"]),
                    dy_px=float(payload["dy_px"]),
                    session_id=session_id,
                )
            if helper == "zoom":
                return client.zoom(
                    view_id=view_id,
                    factor=float(payload["factor"]),
                    session_id=session_id,
                )
            if helper == "rotate-set":
                return client.rotate(
                    view_id=view_id,
                    degrees=float(payload["rotation_deg"]),
                    session_id=session_id,
                )
            return client.rotate(
                view_id=view_id,
                delta_degrees=float(payload["delta_deg"]),
                session_id=session_id,
            )
    except (LucidaError, ValueError) as exc:
        emit_exception(exc)
    except LucidaClientError as exc:
        emit_client_error(exc)
    raise AssertionError("unreachable")


def _emit_view_update_response(response: ViewMutationResponse, *, output_json: bool) -> None:
    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


def _execute_selector_command(
    *,
    helper: SelectorHelper,
    view_id: str | None,
    axis: str,
    session_id: str | None,
    clamp: bool,
    base_url: str | None,
    payload: dict[str, Any],
    output_json: bool,
) -> None:
    context = load_cli_context()
    response = _with_view_scope_mutation(
        context=context,
        view_id=view_id,
        session_id=session_id,
        execute=lambda resolved_view_id, resolved_session_id: _run_selector_helper(
            helper=helper,
            view_id=resolved_view_id,
            axis=axis,
            session_id=resolved_session_id,
            clamp=clamp,
            base_url=base_url,
            payload=payload,
        ),
    )
    _emit_view_update_response(response, output_json=output_json)


def _execute_navigation_command(
    *,
    helper: NavigationHelper,
    view_id: str | None,
    session_id: str | None,
    base_url: str | None,
    payload: dict[str, Any],
    output_json: bool,
) -> None:
    context = load_cli_context()
    response = _with_view_scope_mutation(
        context=context,
        view_id=view_id,
        session_id=session_id,
        execute=lambda resolved_view_id, resolved_session_id: _run_navigation_helper(
            helper=helper,
            view_id=resolved_view_id,
            session_id=resolved_session_id,
            base_url=base_url,
            payload=payload,
        ),
    )
    _emit_view_update_response(response, output_json=output_json)


def _with_view_scope_mutation(
    *,
    context: CliContext,
    view_id: str | None,
    session_id: str | None,
    execute: Callable[[str, str | None], ViewMutationResponse],
) -> ViewMutationResponse:
    resolved_view_id, resolved_session_id = _resolve_view_scope_ids(
        context=context,
        view_id=view_id,
        session_id=session_id,
    )
    response = execute(resolved_view_id, resolved_session_id)
    _persist_view_scope_context(
        context=context,
        view_id=resolved_view_id,
        session_id=resolved_session_id,
    )
    return response


def _build_visible_bounds_payload(view_state: ViewState) -> dict[str, Any]:
    if view_state.view_2d is None:
        raise ValueError("view has no 2d state.")
    zoom = float(view_state.view_2d.camera.zoom)
    pixel_ratio = float(view_state.viewport.pixel_ratio)
    if zoom <= 0:
        raise ValueError("view zoom must be > 0.")
    if pixel_ratio <= 0:
        raise ValueError("viewport pixel_ratio must be > 0.")
    center_u, center_v = view_state.view_2d.camera.center_world
    width_world = float(view_state.viewport.width_px) / (zoom * pixel_ratio)
    height_world = float(view_state.viewport.height_px) / (zoom * pixel_ratio)
    half_width = width_world * 0.5
    half_height = height_world * 0.5
    axis_u, axis_v = _plane_axes(view_state.view_2d.plane)
    return {
        "schema_version": 1,
        "view_id": view_state.view_id,
        "session_id": view_state.session_id,
        "state_hash": view_state.state_hash,
        "state_version": view_state.state_version,
        "plane": view_state.view_2d.plane,
        "axes": {"u": axis_u, "v": axis_v},
        "center_world": {"u": float(center_u), "v": float(center_v)},
        "viewport": view_state.viewport.model_dump(mode="json"),
        "visible_bounds_world": {
            "u_min": float(center_u) - half_width,
            "u_max": float(center_u) + half_width,
            "v_min": float(center_v) - half_height,
            "v_max": float(center_v) + half_height,
        },
    }


def _plane_axes(plane: str) -> tuple[str, str]:
    if plane == "xy":
        return "x", "y"
    if plane == "xz":
        return "x", "z"
    if plane == "yz":
        return "y", "z"
    raise ValueError(f"unsupported plane: {plane}")


def _resolve_view_scope_ids(
    *,
    context: CliContext,
    view_id: str | None,
    session_id: str | None,
) -> tuple[str, str | None]:
    try:
        resolved_view_id = resolve_required_identifier(
            view_id,
            context.view_id,
            name="view_id",
            hint="run `lucida view create` or `lucida view use` first",
        )
        resolved_session_id = resolve_optional_identifier(session_id, context.session_id)
        return resolved_view_id, resolved_session_id
    except ValueError as exc:
        emit_exception(exc)
    raise AssertionError("unreachable")


def _persist_view_scope_context(
    *,
    context: CliContext,
    view_id: str,
    session_id: str | None,
) -> None:
    context.view_id = view_id
    if session_id is not None:
        context.session_id = session_id
    save_cli_context(context)
