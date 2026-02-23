from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer

from lucida.client import LucidaClient, LucidaClientError
from lucida.errors import LucidaError, as_api_error_payload
from lucida.models.view_state import AxisSelector, View2D, Viewport
from lucida.service.dataset_service import DatasetService

app = typer.Typer(no_args_is_help=True)
dataset_app = typer.Typer(no_args_is_help=True)
session_app = typer.Typer(no_args_is_help=True)
view_app = typer.Typer(no_args_is_help=True)
app.add_typer(dataset_app, name="dataset")
app.add_typer(session_app, name="session")
app.add_typer(view_app, name="view")

_LOCAL_SERVICE = DatasetService()


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
    try:
        if base_url:
            with LucidaClient(base_url=base_url) as client:
                response = client.open_dataset(
                    uri=uri,
                    dataset_id=dataset_id,
                    session_id=session_id,
                    include_full_raw_metadata=full_raw_metadata,
                )
        else:
            response = _LOCAL_SERVICE.open_dataset(
                uri=uri,
                dataset_id=dataset_id,
                session_id=session_id,
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


@session_app.command("create")
def session_create(
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    try:
        if base_url:
            with LucidaClient(base_url=base_url) as client:
                response = client.create_session()
        else:
            response = _LOCAL_SERVICE.create_session()
    except LucidaError as exc:
        typer.echo(json.dumps(as_api_error_payload(exc), indent=2))
        raise typer.Exit(code=1) from exc
    except LucidaClientError as exc:
        typer.echo(
            json.dumps(
                {"code": "session_not_found", "message": str(exc), "details": {}},
                indent=2,
            )
        )
        raise typer.Exit(code=1) from exc

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
    view_2d_file: Path | None = typer.Option(
        None, "--view2d-file", help="Optional JSON file with view_2d object."
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    try:
        selectors_value = _load_selectors(selectors_file)
        view_2d_value = _load_view_2d(view_2d_file)
        viewport = Viewport(width_px=width_px, height_px=height_px, pixel_ratio=pixel_ratio)

        if base_url:
            with LucidaClient(base_url=base_url) as client:
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
        else:
            response = _LOCAL_SERVICE.create_view(
                dataset_id=dataset_id,
                session_id=session_id,
                mode=mode,
                multiscale_name=multiscale_name,
                viewport=viewport,
                selectors=selectors_value,
                view_2d=view_2d_value,
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
    try:
        if base_url:
            with LucidaClient(base_url=base_url) as client:
                response = client.get_view(view_id=view_id, session_id=session_id)
        else:
            response = _LOCAL_SERVICE.get_view(view_id=view_id, session_id=session_id)
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


@view_app.command("update")
def view_update(
    view_id: str = typer.Option(..., "--view-id", help="View id."),
    patch_file: Path = typer.Option(..., "--patch-file", help="JSON file containing RFC6902 patch."),
    session_id: str | None = typer.Option(None, "--session-id", help="Optional session id."),
    output_json: bool = typer.Option(False, "--json", help="Emit JSON response."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Optional API server base URL to use HTTP mode."
    ),
) -> None:
    try:
        patch = _load_patch(patch_file)
        if base_url:
            with LucidaClient(base_url=base_url) as client:
                response = client.update_view(view_id=view_id, patch=patch, session_id=session_id)
        else:
            response = _LOCAL_SERVICE.update_view(view_id=view_id, patch=patch, session_id=session_id)
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
    try:
        if base_url:
            with LucidaClient(base_url=base_url) as client:
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

        view = _LOCAL_SERVICE.get_view(view_id=view_id, session_id=session_id).view_state
        selectors = [item.model_dump(mode="json") for item in view.selectors if item.axis != axis]
        if helper == "index":
            selectors.append({"axis": axis, "kind": "index", "index": payload["index"], "clamp": clamp})
        elif helper == "range":
            selectors.append(
                {
                    "axis": axis,
                    "kind": "range",
                    "start": payload["start"],
                    "end_exclusive": payload["end_exclusive"],
                    "clamp": clamp,
                }
            )
        else:
            selectors.append({"axis": axis, "kind": "set", "indices": payload["indices"], "clamp": clamp})
        return _LOCAL_SERVICE.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=[{"op": "replace", "path": "/selectors", "value": selectors}],
        )
    except LucidaError as exc:
        _emit_exception(exc)
    except LucidaClientError as exc:
        _emit_client_error(exc)
    raise AssertionError("unreachable")


def _emit_view_update_response(response: Any, *, output_json: bool) -> None:
    payload = response.model_dump(mode="json")
    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    view_state = payload["view_state"]
    typer.echo(f"view_id: {view_state['view_id']}")
    typer.echo(f"state_hash: {view_state['state_hash']}")
    typer.echo(f"state_version: {view_state['state_version']}")


def _load_patch(path: Path) -> list[dict[str, Any]]:
    loaded = json.loads(path.read_text())
    if not isinstance(loaded, list):
        raise ValueError("patch file must contain a JSON array.")
    if not all(isinstance(item, dict) for item in loaded):
        raise ValueError("patch array elements must be objects.")
    return loaded


def _load_selectors(path: Path | None) -> list[AxisSelector] | None:
    if path is None:
        return None
    loaded = json.loads(path.read_text())
    if not isinstance(loaded, list):
        raise ValueError("selectors file must contain a JSON array.")
    return [AxisSelector.model_validate(item) for item in loaded]


def _load_view_2d(path: Path | None) -> View2D | None:
    if path is None:
        return None
    loaded = json.loads(path.read_text())
    if not isinstance(loaded, dict):
        raise ValueError("view2d file must contain a JSON object.")
    return View2D.model_validate(loaded)


def _emit_exception(exc: Exception) -> None:
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


def _emit_client_error(exc: LucidaClientError) -> None:
    typer.echo(
        json.dumps(
            {"code": "dataset_open_failed", "message": str(exc), "details": {}},
            indent=2,
        )
    )
    raise typer.Exit(code=1) from exc


def main() -> None:
    app()


if __name__ == "__main__":
    main()
