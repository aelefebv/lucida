"""Synchronous HTTP client for interacting with the Lucida API."""

from __future__ import annotations

from typing import Any, Callable
from urllib.parse import urlencode

import httpx

from lucida.models.api import (
    ApiError,
    CapabilitiesResponse,
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
from lucida.models.render import (
    RenderImageRequest,
    RenderImageResponse,
    RenderOutputSpec,
)
from lucida.models.usage import (
    UsageEventsResponse,
    UsageRunDetailResponse,
    UsageRunsResponse,
)
from lucida.models.view_state import ViewState
from lucida.runtime_config import RuntimeConfig, resolve_runtime_config

_HEADER_AGENT_RUN_ID = "X-Lucida-Agent-Run-Id"
_HEADER_AGENT_STEP_ID = "X-Lucida-Agent-Step-Id"
_HEADER_AGENT_NAME = "X-Lucida-Agent-Name"


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
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        agent_run_id:
            Optional default agent run identifier sent as telemetry header.
        agent_step_id:
            Optional default agent step identifier sent as telemetry header.
        agent_name:
            Optional default agent name sent as telemetry header.
        """
        if client is None:
            self._runtime_config = runtime_config or resolve_runtime_config(
                base_url_override=base_url,
            )
            self._client = httpx.Client(
                base_url=self._runtime_config.base_url, timeout=timeout
            )
            self._owns_client = True
        else:
            self._runtime_config = runtime_config
            self._client = client
            self._owns_client = False
        self._default_agent_run_id = agent_run_id
        self._default_agent_step_id = agent_step_id
        self._default_agent_name = agent_name

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

    def _agent_headers(
        self,
        *,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> dict[str, str] | None:
        run_id = (
            agent_run_id if agent_run_id is not None else self._default_agent_run_id
        )
        step_id = (
            agent_step_id if agent_step_id is not None else self._default_agent_step_id
        )
        resolved_name = (
            agent_name if agent_name is not None else self._default_agent_name
        )

        headers: dict[str, str] = {}
        if run_id:
            headers[_HEADER_AGENT_RUN_ID] = run_id
        if step_id:
            headers[_HEADER_AGENT_STEP_ID] = step_id
        if resolved_name:
            headers[_HEADER_AGENT_NAME] = resolved_name
        return headers or None

    def open_dataset(
        self,
        uri: str,
        dataset_id: str | None = None,
        session_id: str | None = None,
        include_full_raw_metadata: bool = False,
        *,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        payload = self._post(
            "/dataset/open",
            request.model_dump(mode="json"),
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        return DatasetOpenResponse.model_validate(payload)

    def create_session(
        self,
        *,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> SessionCreateResponse:
        """Create a new dataset/view session."""
        request = SessionCreateRequest()
        payload = self._post(
            "/session/create",
            request.model_dump(mode="json"),
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        return SessionCreateResponse.model_validate(payload)

    def get_capabilities(self) -> CapabilitiesResponse:
        """Fetch runtime daemon capabilities."""
        payload = self._get("/capabilities")
        return CapabilitiesResponse.model_validate(payload)

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
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        payload = self._post(
            "/view/create",
            request.model_dump(mode="json"),
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        return ViewCreateResponse.model_validate(payload)

    def get_view(
        self,
        *,
        view_id: str,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> ViewGetResponse:
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
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        payload = self._validate_response(response)
        return ViewGetResponse.model_validate(payload)

    def update_view(
        self,
        *,
        view_id: str,
        patch: list[dict[str, Any]],
        expected_state_version: int | None = None,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> ViewUpdateResponse:
        """Apply a JSON patch to an existing view state.

        Parameters
        ----------
        view_id:
            Target view id.
        patch:
            RFC6902 JSON patch operations.
        expected_state_version:
            Optional optimistic concurrency guard for state version.
        session_id:
            Optional session id to enforce scope.
        """
        request = ViewUpdateRequest(
            view_id=view_id,
            patch=patch,
            session_id=session_id,
            expected_state_version=expected_state_version,
        )
        payload = self._post(
            "/view/update",
            request.model_dump(mode="json"),
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        return ViewUpdateResponse.model_validate(payload)

    def export_viewstate(
        self,
        *,
        view_id: str,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        payload = self._post(
            "/export/viewstate",
            request.model_dump(mode="json"),
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        return ViewStateExportResponse.model_validate(payload)

    def import_viewstate(
        self,
        *,
        view_state: ViewState | dict[str, Any],
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
            view_state.model_dump(mode="json")
            if isinstance(view_state, ViewState)
            else view_state
        )
        request = ViewStateImportRequest(
            session_id=session_id,
            view_state=normalized_view_state,
        )
        payload = self._post(
            "/import/viewstate",
            request.model_dump(mode="json"),
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        return ViewStateImportResponse.model_validate(payload)

    def render_image(
        self,
        *,
        view_id: str | None = None,
        view_state: ViewState | dict[str, Any] | None = None,
        width_px: int,
        height_px: int,
        format: str = "png",
        delivery: str = "inline_base64",
        file_path: str | None = None,
        session_id: str | None = None,
        request_id: str | None = None,
        overrides_json_patch: list[dict[str, Any]] | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        format:
            Output format: ``png`` or ``raw_rgba``.
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
            view_state.model_dump(mode="json")
            if isinstance(view_state, ViewState)
            else view_state
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
                format=format,
                delivery=delivery,
                file_path=file_path,
            ),
        )
        payload = self._post(
            "/render/image",
            request.model_dump(mode="json"),
            headers=self._agent_headers(
                agent_run_id=agent_run_id,
                agent_step_id=agent_step_id,
                agent_name=agent_name,
            ),
        )
        return RenderImageResponse.model_validate(payload)

    def set_plane(
        self,
        *,
        view_id: str,
        plane: str,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> ViewUpdateResponse:
        """Set 2D plane while preserving projected world center."""
        return self._update_view_from_current(
            view_id=view_id,
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
            patch_builder=lambda view: self._set_plane_patch(view=view, plane=plane),
        )

    def set_orthogonal_views(
        self,
        *,
        view_id: str,
        enabled: bool,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> ViewUpdateResponse:
        """Enable or disable fixed orthogonal tri-planar rendering in 2D mode."""
        return self._update_view_from_current(
            view_id=view_id,
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
            patch_builder=lambda view: self._orthogonal_views_patch(
                view=view,
                enabled=enabled,
            ),
        )

    def pan(
        self,
        *,
        view_id: str,
        dx_px: float,
        dy_px: float,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> ViewUpdateResponse:
        """Pan camera in screen pixels."""
        return self._update_view_from_current(
            view_id=view_id,
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
            patch_builder=lambda view: self._pan_patch(
                view=view, dx_px=dx_px, dy_px=dy_px
            ),
        )

    def zoom(
        self,
        *,
        view_id: str,
        factor: float,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> ViewUpdateResponse:
        """Multiply camera zoom by the provided factor."""
        if factor <= 0:
            raise ValueError("zoom factor must be > 0.")

        return self._update_view_from_current(
            view_id=view_id,
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
            patch_builder=lambda view: self._zoom_patch(view=view, factor=factor),
        )

    def rotate(
        self,
        *,
        view_id: str,
        degrees: float | None = None,
        delta_degrees: float | None = None,
        session_id: str | None = None,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
    ) -> ViewUpdateResponse:
        """Set or adjust 2D camera rotation.

        Exactly one of ``degrees`` or ``delta_degrees`` must be provided.
        """
        if (degrees is None) == (delta_degrees is None):
            raise ValueError("provide exactly one of degrees or delta_degrees.")

        return self._update_view_from_current(
            view_id=view_id,
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
            patch_builder=lambda view: self._rotate_patch(
                view=view,
                degrees=degrees,
                delta_degrees=delta_degrees,
            ),
        )

    def set_dim(
        self,
        *,
        view_id: str,
        axis: str,
        index: int,
        session_id: str | None = None,
        clamp: bool = True,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        return self._replace_selector(
            view_id=view_id,
            axis=axis,
            replacement={"axis": axis, "kind": "index", "index": index, "clamp": clamp},
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
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
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        return self._replace_selector(
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
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
        )

    def set_axis_set(
        self,
        *,
        view_id: str,
        axis: str,
        indices: list[int],
        session_id: str | None = None,
        clamp: bool = True,
        agent_run_id: str | None = None,
        agent_step_id: str | None = None,
        agent_name: str | None = None,
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
        return self._replace_selector(
            view_id=view_id,
            axis=axis,
            replacement={
                "axis": axis,
                "kind": "set",
                "indices": indices,
                "clamp": clamp,
            },
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
        )

    def list_usage_events(
        self,
        *,
        limit: int = 100,
        before_id: int | None = None,
        run_id: str | None = None,
        endpoint: str | None = None,
        status_code: int | None = None,
        from_ts: str | None = None,
        to_ts: str | None = None,
    ) -> UsageEventsResponse:
        """List usage telemetry events."""
        params: dict[str, Any] = {"limit": limit}
        if before_id is not None:
            params["before_id"] = before_id
        if run_id is not None:
            params["run_id"] = run_id
        if endpoint is not None:
            params["endpoint"] = endpoint
        if status_code is not None:
            params["status_code"] = status_code
        if from_ts is not None:
            params["from_ts"] = from_ts
        if to_ts is not None:
            params["to_ts"] = to_ts

        payload = self._get("/usage/events", params=params)
        return UsageEventsResponse.model_validate(payload)

    def list_usage_runs(
        self,
        *,
        limit: int = 50,
        before_start_ts: str | None = None,
    ) -> UsageRunsResponse:
        """List usage run aggregates."""
        params: dict[str, Any] = {"limit": limit}
        if before_start_ts is not None:
            params["before_start_ts"] = before_start_ts
        payload = self._get("/usage/runs", params=params)
        return UsageRunsResponse.model_validate(payload)

    def get_usage_run(
        self,
        *,
        run_id: str,
        event_limit: int = 200,
    ) -> UsageRunDetailResponse:
        """Fetch one run summary and recent events."""
        payload = self._get(f"/usage/runs/{run_id}", params={"limit": event_limit})
        return UsageRunDetailResponse.model_validate(payload)

    def usage_events_stream_url(self, *, run_id: str | None = None) -> str:
        """Build the SSE stream URL for usage events."""
        base_url = str(self._client.base_url).rstrip("/")
        if run_id is None:
            return f"{base_url}/usage/events/stream"
        return f"{base_url}/usage/events/stream?{urlencode({'run_id': run_id})}"

    def _replace_selector(
        self,
        *,
        view_id: str,
        axis: str,
        replacement: dict[str, Any],
        session_id: str | None,
        agent_run_id: str | None,
        agent_step_id: str | None,
        agent_name: str | None,
    ) -> ViewUpdateResponse:
        """Replace one selector entry by axis and submit a view update.

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
        return self._update_view_from_current(
            view_id=view_id,
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
            patch_builder=lambda view: [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": self._selectors_with_replacement(
                        view=view,
                        axis=axis,
                        replacement=replacement,
                    ),
                }
            ],
        )

    def _selectors_with_replacement(
        self,
        *,
        view: ViewState,
        axis: str,
        replacement: dict[str, Any],
    ) -> list[dict[str, Any]]:
        selectors = [
            selector.model_dump(mode="json")
            for selector in view.selectors
            if selector.axis != axis
        ]
        selectors.append(replacement)
        return selectors

    def _set_plane_patch(self, *, view: ViewState, plane: str) -> list[dict[str, Any]]:
        if plane not in _PLANE_ROLES:
            raise ValueError(f"unsupported plane: {plane}")
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")
        view_2d = view.view_2d
        current_plane = view_2d.plane
        if current_plane not in _PLANE_ROLES:
            current_plane = "xy"

        current_u_role, current_v_role, current_orth_role = _PLANE_ROLES[current_plane]
        target_u_role, target_v_role, target_orth_role = _PLANE_ROLES[plane]

        center_world = list(view_2d.camera.center_world)
        if len(center_world) != 2:
            center_world = [0.0, 0.0]

        slice_payload = (
            view_2d.slice.model_dump(mode="json") if view_2d.slice is not None else {}
        )
        selectors = [selector.model_dump(mode="json") for selector in view.selectors]
        slice_axis = view_2d.slice.axis if view_2d.slice is not None else None
        current_slice_index = view_2d.slice.index if view_2d.slice is not None else None
        if current_slice_index is None:
            current_slice_index = self._selector_index(
                selectors=selectors, axis=slice_axis
            )
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
            {
                "op": "replace",
                "path": "/view_2d/camera/center_world",
                "value": new_center,
            },
            {"op": "replace", "path": "/view_2d/slice", "value": next_slice},
        ]

    def _pan_patch(
        self, *, view: ViewState, dx_px: float, dy_px: float
    ) -> list[dict[str, Any]]:
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")

        zoom = float(view.view_2d.camera.zoom)
        pixel_ratio = float(view.viewport.pixel_ratio)
        if zoom <= 0:
            raise ValueError("zoom must be > 0.")

        delta_x = float(dx_px) / (zoom * pixel_ratio)
        delta_y = float(dy_px) / (zoom * pixel_ratio)
        center_x, center_y = view.view_2d.camera.center_world
        return [
            {
                "op": "replace",
                "path": "/view_2d/camera/center_world",
                "value": [float(center_x) + delta_x, float(center_y) + delta_y],
            }
        ]

    def _orthogonal_views_patch(
        self,
        *,
        view: ViewState,
        enabled: bool,
    ) -> list[dict[str, Any]]:
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")
        return [
            {
                "op": "replace",
                "path": "/view_2d/orthogonal_views_enabled",
                "value": bool(enabled),
            }
        ]

    def _zoom_patch(self, *, view: ViewState, factor: float) -> list[dict[str, Any]]:
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")
        next_zoom = float(view.view_2d.camera.zoom) * float(factor)
        return [{"op": "replace", "path": "/view_2d/camera/zoom", "value": next_zoom}]

    def _rotate_patch(
        self,
        *,
        view: ViewState,
        degrees: float | None,
        delta_degrees: float | None,
    ) -> list[dict[str, Any]]:
        if view.view_2d is None:
            raise ValueError("view has no 2d state.")
        current_rotation = float(view.view_2d.camera.rotation_deg)
        next_rotation = (
            float(degrees)
            if degrees is not None
            else current_rotation + float(delta_degrees)
        )
        return [
            {
                "op": "replace",
                "path": "/view_2d/camera/rotation_deg",
                "value": next_rotation,
            }
        ]

    def _update_view_from_current(
        self,
        *,
        view_id: str,
        session_id: str | None,
        patch_builder: Callable[[ViewState], list[dict[str, Any]]],
        agent_run_id: str | None,
        agent_step_id: str | None,
        agent_name: str | None,
    ) -> ViewUpdateResponse:
        view = self.get_view(
            view_id=view_id,
            session_id=session_id,
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
        ).view_state
        patch = patch_builder(view)
        return self.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=patch,
            expected_state_version=int(view.state_version),
            agent_run_id=agent_run_id,
            agent_step_id=agent_step_id,
            agent_name=agent_name,
        )

    def _selector_index(
        self, *, selectors: list[dict[str, Any]], axis: Any
    ) -> int | None:
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
            if (
                kind == "set"
                and isinstance(selector.get("indices"), list)
                and selector["indices"]
            ):
                first = selector["indices"][0]
                if isinstance(first, int):
                    return int(first)
        return None

    def _get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """GET JSON payload from the API and return parsed response."""
        try:
            response = self._client.get(path, params=params, headers=headers)
            return self._validate_response(response)
        except LucidaClientError:
            raise
        except httpx.HTTPError as exc:
            raise LucidaClientError(str(exc)) from exc

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """POST payload to the API and return the parsed JSON payload.

        Parameters
        ----------
        path:
            Relative endpoint path.
        payload:
            Request payload dictionary.
        headers:
            Optional HTTP headers for agent tracing metadata.
        """
        try:
            response = self._client.post(path, json=payload, headers=headers)
            return self._validate_response(response)
        except LucidaClientError:
            raise
        except httpx.HTTPError as exc:
            raise LucidaClientError(str(exc)) from exc

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
