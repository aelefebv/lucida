"""Synchronous HTTP client for interacting with the Lucida API."""

from __future__ import annotations

from typing import Any

import httpx

from lucida.models.api import (
    ApiError,
    DatasetOpenRequest,
    DatasetOpenResponse,
    SessionCreateRequest,
    SessionCreateResponse,
    ViewCreateRequest,
    ViewCreateResponse,
    ViewStateExportRequest,
    ViewStateExportResponse,
    ViewStateImportRequest,
    ViewStateImportResponse,
    ViewGetResponse,
    ViewUpdateRequest,
    ViewUpdateResponse,
)
from lucida.models.render import RenderImageRequest, RenderImageResponse, RenderOutputSpec
from lucida.models.view_state import ViewState
from lucida.runtime_config import RuntimeConfig, resolve_runtime_config


_PLANE_ROLES: dict[str, tuple[str, str, str]] = {
    "xy": ("x", "y", "z"),
    "xz": ("x", "z", "y"),
    "yz": ("y", "z", "x"),
}


class LucidaClientError(Exception):
    """Raised for request failures returned by the Lucida API."""
    pass


class LucidaClient:
    """Simple typed client for Lucida REST endpoints.

    Attributes
    ----------
    _client:
        Underlying :class:`httpx.Client`.
    _owns_client:
        True when this object owns and must close the underlying client.
    _runtime_config:
        Resolved runtime settings used for HTTP transport initialization.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float = 30.0,
        client: httpx.Client | None = None,
        runtime_config: RuntimeConfig | None = None,
    ) -> None:
        """Create a client bound to a base URL and optional transport.

        Parameters
        ----------
        base_url:
            Optional HTTP base URL override.
        timeout:
            Request timeout in seconds.
        client:
            Optional preconfigured :class:`httpx.Client`.
        runtime_config:
            Optional pre-resolved runtime configuration.
        """
        if client is None:
            self._runtime_config = runtime_config or resolve_runtime_config(
                base_url_override=base_url,
            )
            self._client = httpx.Client(base_url=self._runtime_config.base_url, timeout=timeout)
            self._owns_client = True
        else:
            self._runtime_config = runtime_config
            self._client = client
            self._owns_client = False

    def close(self) -> None:
        """Close the owned HTTP client transport."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "LucidaClient":
        """Return this client for context-manager usage."""
        return self

    def __exit__(self, _: Any, __: Any, ___: Any) -> None:
        """Close the client when exiting a ``with`` block."""
        self.close()

    def open_dataset(
        self,
        uri: str,
        dataset_id: str | None = None,
        session_id: str | None = None,
        include_full_raw_metadata: bool = False,
    ) -> DatasetOpenResponse:
        """Open a dataset and return a dataset summary response.

        Parameters
        ----------
        uri:
            Dataset URI or local path.
        dataset_id:
            Optional override for the generated dataset identifier.
        session_id:
            Optional session to attach the opened dataset.
        include_full_raw_metadata:
            Include full metadata payload when true.
        """
        request = DatasetOpenRequest(
            uri=uri,
            dataset_id=dataset_id,
            session_id=session_id,
            include_full_raw_metadata=include_full_raw_metadata,
        )
        payload = self._post("/dataset/open", request.model_dump(mode="json"))
        return DatasetOpenResponse.model_validate(payload)

    def create_session(self) -> SessionCreateResponse:
        """Create a new dataset/view session."""
        request = SessionCreateRequest()
        payload = self._post("/session/create", request.model_dump(mode="json"))
        return SessionCreateResponse.model_validate(payload)

    def create_view(
        self,
        *,
        dataset_id: str,
        session_id: str | None = None,
        mode: str = "2d",
        multiscale_name: str | None = None,
        viewport: dict[str, Any] | None = None,
        selectors: list[dict[str, Any]] | None = None,
        view_2d: dict[str, Any] | None = None,
    ) -> ViewCreateResponse:
        """Create a new view bound to a dataset and optional selectors.

        Parameters
        ----------
        dataset_id:
            ID of an already-open dataset.
        session_id:
            Optional session id to attach this view.
        mode:
            Render mode (currently ``2d``/``3d`` supported by service policy).
        multiscale_name:
            Optional target multiscale name within the dataset.
        viewport:
            Optional viewport override.
        selectors:
            Initial axis selector list.
        view_2d:
            Optional 2D view configuration.
        """
        request = ViewCreateRequest(
            dataset_id=dataset_id,
            session_id=session_id,
            mode=mode,
            multiscale_name=multiscale_name,
            viewport=viewport,
            selectors=selectors,
            view_2d=view_2d,
        )
        payload = self._post("/view/create", request.model_dump(mode="json"))
        return ViewCreateResponse.model_validate(payload)

    def get_view(self, *, view_id: str, session_id: str | None = None) -> ViewGetResponse:
        """Fetch the current state for an existing view.

        Parameters
        ----------
        view_id:
            View identifier.
        session_id:
            Optional session scoping guard.
        """
        response = self._client.get(
            f"/view/{view_id}",
            params={"session_id": session_id} if session_id is not None else None,
        )
        payload = self._validate_response(response)
        return ViewGetResponse.model_validate(payload)

    def update_view(
        self,
        *,
        view_id: str,
        patch: list[dict[str, Any]],
        session_id: str | None = None,
    ) -> ViewUpdateResponse:
        """Apply a JSON patch to an existing view state.

        Parameters
        ----------
        view_id:
            Target view id.
        patch:
            RFC6902 JSON patch operations.
        session_id:
            Optional session id to enforce scope.
        """
        request = ViewUpdateRequest(view_id=view_id, patch=patch, session_id=session_id)
        payload = self._post("/view/update", request.model_dump(mode="json"))
        return ViewUpdateResponse.model_validate(payload)

    def export_viewstate(
        self,
        *,
        view_id: str,
        session_id: str | None = None,
    ) -> ViewStateExportResponse:
        """Export a full persisted view state payload.

        Parameters
        ----------
        view_id:
            Source view identifier.
        session_id:
            Optional session scope guard.
        """
        request = ViewStateExportRequest(view_id=view_id, session_id=session_id)
        payload = self._post("/export/viewstate", request.model_dump(mode="json"))
        return ViewStateExportResponse.model_validate(payload)

    def import_viewstate(
        self,
        *,
        view_state: ViewState | dict[str, Any],
        session_id: str | None = None,
    ) -> ViewStateImportResponse:
        """Import a view state payload as a new persisted view.

        Parameters
        ----------
        view_state:
            Source view state payload.
        session_id:
            Optional target session id.
        """
        normalized_view_state = (
            view_state.model_dump(mode="json") if isinstance(view_state, ViewState) else view_state
        )
        request = ViewStateImportRequest(
            session_id=session_id,
            view_state=normalized_view_state,
        )
        payload = self._post("/import/viewstate", request.model_dump(mode="json"))
        return ViewStateImportResponse.model_validate(payload)

    def render_image(
        self,
        *,
        view_id: str | None = None,
        view_state: ViewState | dict[str, Any] | None = None,
        width_px: int,
        height_px: int,
        delivery: str = "inline_base64",
        file_path: str | None = None,
        session_id: str | None = None,
        request_id: str | None = None,
        overrides_json_patch: list[dict[str, Any]] | None = None,
    ) -> RenderImageResponse:
        """Render an image for an existing view.

        Parameters
        ----------
        view_id:
            Optional target view id for stateful rendering.
        view_state:
            Optional inline view state for stateless rendering.
        width_px:
            Output image width.
        height_px:
            Output image height.
        delivery:
            Output delivery mode: ``inline_base64`` or ``file_path``.
        file_path:
            Optional file path when ``delivery=file_path``.
        session_id:
            Optional session id to enforce scope.
        request_id:
            Optional caller-provided request id.
        overrides_json_patch:
            Optional RFC6902 patch applied ephemerally at render time.
        """
        normalized_view_state = (
            view_state.model_dump(mode="json") if isinstance(view_state, ViewState) else view_state
        )
        request = RenderImageRequest(
            view_id=view_id,
            view_state=normalized_view_state,
            session_id=session_id,
            request_id=request_id,
            overrides_json_patch=overrides_json_patch,
            output=RenderOutputSpec(
                width_px=width_px,
                height_px=height_px,
                delivery=delivery,
                file_path=file_path,
            ),
        )
        payload = self._post("/render/image", request.model_dump(mode="json"))
        return RenderImageResponse.model_validate(payload)

    def set_plane(
        self,
        *,
        view_id: str,
        plane: str,
        session_id: str | None = None,
    ) -> ViewUpdateResponse:
        """Set 2D plane while preserving projected world center."""
        view = self.get_view(view_id=view_id, session_id=session_id).view_state
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")

        patch = self._set_plane_patch(view=view.model_dump(mode="json"), plane=plane)
        return self.update_view(view_id=view_id, session_id=session_id, patch=patch)

    def pan(
        self,
        *,
        view_id: str,
        dx_px: float,
        dy_px: float,
        session_id: str | None = None,
    ) -> ViewUpdateResponse:
        """Pan camera in screen pixels."""
        view = self.get_view(view_id=view_id, session_id=session_id).view_state
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")

        zoom = float(view.view_2d.camera.zoom)
        pixel_ratio = float(view.viewport.pixel_ratio)
        if zoom <= 0:
            raise ValueError("zoom must be > 0.")

        delta_x = float(dx_px) / (zoom * pixel_ratio)
        delta_y = float(dy_px) / (zoom * pixel_ratio)
        center_x, center_y = view.view_2d.camera.center_world
        patch = [
            {
                "op": "replace",
                "path": "/view_2d/camera/center_world",
                "value": [float(center_x) + delta_x, float(center_y) + delta_y],
            }
        ]
        return self.update_view(view_id=view_id, session_id=session_id, patch=patch)

    def zoom(
        self,
        *,
        view_id: str,
        factor: float,
        session_id: str | None = None,
    ) -> ViewUpdateResponse:
        """Multiply camera zoom by the provided factor."""
        if factor <= 0:
            raise ValueError("zoom factor must be > 0.")

        view = self.get_view(view_id=view_id, session_id=session_id).view_state
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")

        next_zoom = float(view.view_2d.camera.zoom) * float(factor)
        patch = [{"op": "replace", "path": "/view_2d/camera/zoom", "value": next_zoom}]
        return self.update_view(view_id=view_id, session_id=session_id, patch=patch)

    def set_dim(
        self,
        *,
        view_id: str,
        axis: str,
        index: int,
        session_id: str | None = None,
        clamp: bool = True,
    ) -> ViewUpdateResponse:
        """Update a single-axis index selector.

        Parameters
        ----------
        view_id:
            Target view id.
        axis:
            Axis name to update.
        index:
            Axis index to apply.
        session_id:
            Optional session scope.
        clamp:
            Clamp out-of-range values into bounds when true.
        """
        selectors = self._selectors_with_replacement(
            view_id=view_id,
            axis=axis,
            replacement={"axis": axis, "kind": "index", "index": index, "clamp": clamp},
            session_id=session_id,
        )
        return self.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=[{"op": "replace", "path": "/selectors", "value": selectors}],
        )

    def set_axis_range(
        self,
        *,
        view_id: str,
        axis: str,
        start: int,
        end_exclusive: int,
        session_id: str | None = None,
        clamp: bool = True,
    ) -> ViewUpdateResponse:
        """Update an axis to a range selector.

        Parameters
        ----------
        view_id:
            Target view id.
        axis:
            Axis name to update.
        start:
            Range start index, inclusive.
        end_exclusive:
            Range end index, exclusive.
        session_id:
            Optional session scope.
        clamp:
            Clamp out-of-range values into bounds when true.
        """
        selectors = self._selectors_with_replacement(
            view_id=view_id,
            axis=axis,
            replacement={
                "axis": axis,
                "kind": "range",
                "start": start,
                "end_exclusive": end_exclusive,
                "clamp": clamp,
            },
            session_id=session_id,
        )
        return self.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=[{"op": "replace", "path": "/selectors", "value": selectors}],
        )

    def set_axis_set(
        self,
        *,
        view_id: str,
        axis: str,
        indices: list[int],
        session_id: str | None = None,
        clamp: bool = True,
    ) -> ViewUpdateResponse:
        """Update an axis to an explicit set of indices.

        Parameters
        ----------
        view_id:
            Target view id.
        axis:
            Axis name to update.
        indices:
            Replacement index set.
        session_id:
            Optional session scope.
        clamp:
            Clamp out-of-range values into bounds when true.
        """
        selectors = self._selectors_with_replacement(
            view_id=view_id,
            axis=axis,
            replacement={
                "axis": axis,
                "kind": "set",
                "indices": indices,
                "clamp": clamp,
            },
            session_id=session_id,
        )
        return self.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=[{"op": "replace", "path": "/selectors", "value": selectors}],
        )

    def _selectors_with_replacement(
        self,
        *,
        view_id: str,
        axis: str,
        replacement: dict[str, Any],
        session_id: str | None,
    ) -> list[dict[str, Any]]:
        """Load current selectors and replace one axis entry.

        Parameters
        ----------
        view_id:
            Target view identifier.
        axis:
            Axis name to replace.
        replacement:
            New selector payload.
        session_id:
            Optional session scope.
        """
        view = self.get_view(view_id=view_id, session_id=session_id).view_state
        selectors = [selector.model_dump(mode="json") for selector in view.selectors if selector.axis != axis]
        selectors.append(replacement)
        return selectors

    def _set_plane_patch(self, *, view: dict[str, Any], plane: str) -> list[dict[str, Any]]:
        if plane not in _PLANE_ROLES:
            raise ValueError(f"unsupported plane: {plane}")

        view_2d = view.get("view_2d")
        if not isinstance(view_2d, dict):
            raise ValueError("view has no 2d state.")

        current_plane = str(view_2d.get("plane", "xy"))
        if current_plane not in _PLANE_ROLES:
            current_plane = "xy"

        current_u_role, current_v_role, current_orth_role = _PLANE_ROLES[current_plane]
        target_u_role, target_v_role, target_orth_role = _PLANE_ROLES[plane]

        camera = view_2d.get("camera") or {}
        center_world = camera.get("center_world") or [0.0, 0.0]
        if len(center_world) != 2:
            center_world = [0.0, 0.0]

        slice_payload = view_2d.get("slice") or {}
        selectors = view.get("selectors") or []
        if not isinstance(selectors, list):
            selectors = []

        current_slice_index = slice_payload.get("index")
        if current_slice_index is None:
            current_slice_index = self._selector_index(selectors=selectors, axis=slice_payload.get("axis"))
        if current_slice_index is None:
            current_slice_index = 0

        role_values: dict[str, float] = {
            current_u_role: float(center_world[0]),
            current_v_role: float(center_world[1]),
            current_orth_role: float(current_slice_index),
        }

        new_center = [
            float(role_values.get(target_u_role, float(center_world[0]))),
            float(role_values.get(target_v_role, float(center_world[1]))),
        ]
        next_slice = dict(slice_payload)
        next_slice["index"] = int(round(role_values.get(target_orth_role, 0.0)))

        return [
            {"op": "replace", "path": "/view_2d/plane", "value": plane},
            {"op": "replace", "path": "/view_2d/camera/center_world", "value": new_center},
            {"op": "replace", "path": "/view_2d/slice", "value": next_slice},
        ]

    def _selector_index(self, *, selectors: list[dict[str, Any]], axis: Any) -> int | None:
        if not isinstance(axis, str):
            return None
        for selector in selectors:
            if not isinstance(selector, dict):
                continue
            if selector.get("axis") != axis:
                continue
            kind = selector.get("kind")
            if kind == "index" and isinstance(selector.get("index"), int):
                return int(selector["index"])
            if kind == "range" and isinstance(selector.get("start"), int):
                return int(selector["start"])
            if kind == "set" and isinstance(selector.get("indices"), list) and selector["indices"]:
                first = selector["indices"][0]
                if isinstance(first, int):
                    return int(first)
        return None

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """POST payload to the API and return the parsed JSON payload.

        Parameters
        ----------
        path:
            Relative endpoint path.
        payload:
            Request payload dictionary.
        """
        response = self._client.post(path, json=payload)
        return self._validate_response(response)

    def _validate_response(self, response: httpx.Response) -> dict[str, Any]:
        """Raise client-side errors for failed responses and return JSON.

        Parameters
        ----------
        response:
            HTTP response from the Lucida API.

        Returns
        -------
        dict[str, Any]
            Parsed JSON payload.
        """
        if response.is_error:
            try:
                api_error = ApiError.model_validate(response.json())
            except Exception:  # pragma: no cover - fallback
                response.raise_for_status()
            raise LucidaClientError(f"{api_error.code}: {api_error.message}") from None
        return response.json()
