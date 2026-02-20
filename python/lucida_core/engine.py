"""Deterministic in-memory ND state engine with Step 3/4/5/6 extensions."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import uuid
from typing import Any, Callable

from .errors import (
    LucidaError,
    conflict,
    internal,
    invalid_params,
    io_failure,
    not_found,
    timeout,
    unsupported,
    version_mismatch,
)
from .command_log import (
    COMMAND_LOG_METHODS,
    CommandLogStorageError,
    CommandLogStore,
    CommandLogValidationError,
    build_command_record,
    build_event_record,
    canonicalize_logged_event,
    canonicalize_runtime_event,
    group_replay_steps,
    method_params_from_request,
    validate_records,
)
from .io import (
    CacheManager,
    DatasetMetadata,
    IOScheduler,
    IOBackendError,
    MissingDependencyError,
    SchedulerTimeout,
    detect_backend,
    export_dataset_local_v05,
    open_dataset_metadata,
)
from .io.backends import _canonical_dataset_id
from .io.metadata import AxisMapError
from .io.scheduler import CancelToken, CancelledError
from .render2d import (
    FramePlan2D,
    InvalidationKind,
    Render2DInvalidationScheduler,
    build_frame_plan_2d,
    frame_plan_to_dict,
    panzoom_state_from_pose,
    panzoom_state_to_pose,
)
from .render2d.controls import PanZoomState
from .render3d import (
    FramePlan3D,
    Render3DInvalidationScheduler,
    build_frame_plan_3d,
    canonicalize_camera_pose_3d,
    frame_plan_3d_to_dict,
)
from .render_points import (
    FramePlanPoints,
    RenderPointsInvalidationScheduler,
    build_frame_plan_points,
    frame_plan_points_to_dict,
)


ProtocolVersion = "1.0.0"
POINT_SELECTION_INLINE_CAP = 4096
_DATAREF_DEFAULT_TTL_MS = 60_000
_DATAREF_CHECKSUM_PLACEHOLDER = "0" * 64


MUTATING_METHODS = {
    "session.create",
    "session.close",
    "dataset.open",
    "dataset.close",
    "dataset.export",
    "layer.add_image",
    "layer.add_points",
    "layer.update",
    "layer.remove",
    "view.create",
    "view.close",
    "view.bind_layer",
    "view.unbind_layer",
    "view.set_axis_index",
    "view.reorder_axes",
    "view.set_channel_order",
    "camera.set_mode",
    "camera.set_pose",
    "selection.set",
    "job.cancel",
    "command_log.import",
    "command_log.replay",
}


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _uuid_v7() -> str:
    return str(uuid.uuid7())


def _parse_semver(version: str) -> tuple[int, int, int]:
    major, minor, patch = version.split(".")
    return int(major), int(minor), int(patch)


def _is_version_compatible(min_version: str, max_version: str, target: str) -> bool:
    low = _parse_semver(min_version)
    high = _parse_semver(max_version)
    val = _parse_semver(target)
    return low <= val <= high


def _dataset_to_metadata(dataset: "DatasetState") -> DatasetMetadata:
    return DatasetMetadata(
        backend=dataset.backend if dataset.backend in {"local", "http", "s3", "gcs", "synthetic"} else "local",
        uri=dataset.uri,
        axis_labels=list(dataset.axis_labels),
        shape=list(dataset.shape),
        dtype=dataset.dtype,
        transform={"scale": list(dataset.transform["scale"]), "translate": list(dataset.transform["translate"])},
        read_only=dataset.read_only,
        ngff_version=dataset.ngff_version,
        zarr_format=dataset.zarr_format,
        multiscales=deepcopy(dataset.multiscales),
        cache_snapshot=deepcopy(dataset.cache_snapshot),
    )


@dataclass
class DatasetState:
    dataset_id: str
    uri: str
    axis_labels: list[str]
    shape: list[int]
    dtype: str
    transform: dict[str, list[float]]
    read_only: bool
    backend: str = "synthetic"
    ngff_version: str = "synthetic"
    zarr_format: int = 2
    multiscales: list[dict[str, Any]] = field(default_factory=list)
    cache_snapshot: dict[str, Any] = field(default_factory=dict)


@dataclass
class LayerState:
    layer_id: str
    layer_type: str
    name: str | None
    visible: bool
    opacity: float
    dataset_id: str | None = None
    channel: int | None = None
    transform: dict[str, list[float]] | None = None
    data_ref: dict[str, Any] | None = None
    point_id_ref: dict[str, Any] | None = None
    edges_ref: dict[str, Any] | None = None
    attribute_table_ref: dict[str, Any] | None = None
    attribute_columns: list[str] = field(default_factory=list)
    coordinate_axes: list[str] = field(default_factory=list)
    attributes: dict[str, Any] = field(default_factory=dict)
    patch: dict[str, Any] = field(default_factory=dict)


@dataclass
class ViewState:
    view_id: str
    label: str | None
    axis_order: list[str]
    axis_indices: dict[str, int]
    channel_order: list[int]
    bound_layer_ids: list[str]
    camera_mode: str
    camera_pose: dict[str, Any]
    selection: dict[str, Any]


@dataclass
class JobState:
    job_id: str
    state: str
    submitted_at: str
    started_at: str | None = None
    completed_at: str | None = None
    error: dict[str, Any] | None = None


@dataclass
class SubscriptionState:
    subscription_id: str
    topics: list[str]
    transport_uri: str


@dataclass
class SessionState:
    session_id: str
    created_at: str
    label: str | None
    state: str = "active"
    datasets: dict[str, DatasetState] = field(default_factory=dict)
    layers: dict[str, LayerState] = field(default_factory=dict)
    views: dict[str, ViewState] = field(default_factory=dict)
    jobs: dict[str, JobState] = field(default_factory=dict)
    subscriptions: dict[str, SubscriptionState] = field(default_factory=dict)
    pending_job_ops: dict[str, Callable[[], dict[str, Any]]] = field(default_factory=dict)
    job_cancel_tokens: dict[str, CancelToken] = field(default_factory=dict)
    frame_plans: dict[str, FramePlan2D] = field(default_factory=dict)
    frame_plans_3d: dict[str, FramePlan3D] = field(default_factory=dict)
    frame_plans_points: dict[str, FramePlanPoints] = field(default_factory=dict)
    outbox: list[dict[str, Any]] = field(default_factory=list)
    command_journal: list[dict[str, Any]] = field(default_factory=list)
    imported_logs: dict[str, dict[str, Any]] = field(default_factory=dict)
    session_seq: int = 0


@dataclass
class RuntimeState:
    sessions: dict[str, SessionState] = field(default_factory=dict)
    idempotency_cache: dict[tuple[str, str, str], dict[str, Any]] = field(default_factory=dict)


class SequenceUUIDFactory:
    """Deterministic UUIDv7 generator for tests."""

    def __init__(self, seed: int = 1) -> None:
        self._counter = seed

    def __call__(self) -> str:
        tail = f"{self._counter:012x}"
        self._counter += 1
        return f"0194c8f0-c7fa-7a2d-8abc-{tail}"


class SequenceClock:
    """Deterministic clock for tests."""

    def __init__(self, start: datetime | None = None, tick_seconds: int = 1) -> None:
        self._current = start or datetime(2026, 1, 1, tzinfo=UTC)
        self._delta = timedelta(seconds=tick_seconds)

    def __call__(self) -> str:
        out = self._current.isoformat().replace("+00:00", "Z")
        self._current = self._current + self._delta
        return out


class NDStateEngine:
    """Pure command dispatcher over deterministic in-memory runtime state."""

    def __init__(
        self,
        *,
        clock: Callable[[], str] | None = None,
        uuid_factory: Callable[[], str] | None = None,
        cache_manager: CacheManager | None = None,
        io_scheduler: IOScheduler | None = None,
    ) -> None:
        self._clock = clock or _utc_now_iso
        self._uuid = uuid_factory or _uuid_v7
        self._state = RuntimeState()
        self._cache = cache_manager or CacheManager()
        self._scheduler = io_scheduler or IOScheduler()
        self._command_log_store = CommandLogStore()
        self._render2d_scheduler = Render2DInvalidationScheduler()
        self._render3d_scheduler = Render3DInvalidationScheduler()
        self._render_points_scheduler = RenderPointsInvalidationScheduler()
        self._handlers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
            "system.hello": self._system_hello,
            "system.capabilities.get": self._system_capabilities_get,
            "session.create": self._session_create,
            "session.close": self._session_close,
            "session.get": self._session_get,
            "dataset.open": self._dataset_open,
            "dataset.close": self._dataset_close,
            "dataset.export": self._dataset_export,
            "dataset.get": self._dataset_get,
            "layer.add_image": self._layer_add_image,
            "layer.add_points": self._layer_add_points,
            "layer.update": self._layer_update,
            "layer.remove": self._layer_remove,
            "layer.get": self._layer_get,
            "view.create": self._view_create,
            "view.close": self._view_close,
            "view.get": self._view_get,
            "view.bind_layer": self._view_bind_layer,
            "view.unbind_layer": self._view_unbind_layer,
            "view.set_axis_index": self._view_set_axis_index,
            "view.reorder_axes": self._view_reorder_axes,
            "view.set_channel_order": self._view_set_channel_order,
            "camera.set_mode": self._camera_set_mode,
            "camera.set_pose": self._camera_set_pose,
            "camera.get": self._camera_get,
            "selection.get": self._selection_get,
            "selection.set": self._selection_set,
            "job.get": self._job_get,
            "job.cancel": self._job_cancel,
            "job.list": self._job_list,
            "events.subscribe": self._events_subscribe,
            "command_log.export": self._command_log_export,
            "command_log.import": self._command_log_import,
            "command_log.replay": self._command_log_replay,
        }

    def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Execute one protocol method and return the method result payload."""
        if method not in self._handlers:
            raise invalid_params(
                "Unknown method",
                {"method": method},
            )
        self._validate_protocol(params)

        cache_key: tuple[str, str, str] | None = None
        if method in MUTATING_METHODS:
            idempotency_key = params.get("idempotency_key")
            if not isinstance(idempotency_key, str) or not idempotency_key:
                raise invalid_params(
                    "Mutating methods require idempotency_key",
                    {"method": method},
                )
            session_scope = str(params.get("session_id", "__system__"))
            cache_key = (session_scope, method, idempotency_key)
            cached = self._state.idempotency_cache.get(cache_key)
            if cached is not None:
                return deepcopy(cached)

        journal_session: SessionState | None = None
        journal_outbox_offset: int | None = None
        if method not in COMMAND_LOG_METHODS:
            session_id = params.get("session_id")
            if isinstance(session_id, str):
                candidate = self._state.sessions.get(session_id)
                if candidate is not None:
                    journal_session = candidate
                    journal_outbox_offset = len(candidate.outbox)

        handler = self._handlers[method]
        try:
            result = handler(params)
        except LucidaError as exc:
            self._emit_error_event(params, exc)
            raise
        except Exception as exc:  # pragma: no cover, defensive fallback
            wrapped = internal("Unhandled runtime error", {"method": method, "error": str(exc)})
            self._emit_error_event(params, wrapped)
            raise wrapped from exc

        if cache_key is not None:
            self._state.idempotency_cache[cache_key] = deepcopy(result)
        if journal_session is not None and journal_outbox_offset is not None:
            self._record_command_journal_entry(
                session=journal_session,
                method=method,
                params=params,
                outbox_offset=journal_outbox_offset,
            )
        return deepcopy(result)

    def snapshot(self) -> dict[str, Any]:
        """Return a deterministic snapshot for tests and replay checks."""
        sessions: list[dict[str, Any]] = []
        for session_id in sorted(self._state.sessions):
            session = self._state.sessions[session_id]
            sessions.append(
                {
                    "session_id": session.session_id,
                    "state": session.state,
                    "created_at": session.created_at,
                    "label": session.label,
                    "session_seq": session.session_seq,
                    "datasets": {
                        dataset_id: {
                            "uri": dataset.uri,
                            "backend": dataset.backend,
                            "axis_labels": dataset.axis_labels,
                            "shape": dataset.shape,
                            "dtype": dataset.dtype,
                            "transform": dataset.transform,
                            "ngff_version": dataset.ngff_version,
                            "zarr_format": dataset.zarr_format,
                        }
                        for dataset_id, dataset in sorted(session.datasets.items())
                    },
                    "layers": {
                        layer_id: {
                            "layer_type": layer.layer_type,
                            "dataset_id": layer.dataset_id,
                            "name": layer.name,
                            "visible": layer.visible,
                            "opacity": layer.opacity,
                            "data_ref": deepcopy(layer.data_ref),
                            "point_id_ref": deepcopy(layer.point_id_ref),
                            "edges_ref": deepcopy(layer.edges_ref),
                            "attribute_table_ref": deepcopy(layer.attribute_table_ref),
                            "attribute_columns": list(layer.attribute_columns),
                            "coordinate_axes": list(layer.coordinate_axes),
                            "patch": deepcopy(layer.patch),
                        }
                        for layer_id, layer in sorted(session.layers.items())
                    },
                    "views": {
                        view_id: {
                            "axis_order": view.axis_order,
                            "axis_indices": view.axis_indices,
                            "channel_order": view.channel_order,
                            "bound_layer_ids": view.bound_layer_ids,
                            "camera_mode": view.camera_mode,
                            "selection": view.selection,
                        }
                        for view_id, view in sorted(session.views.items())
                    },
                    "jobs": {
                        job_id: {
                            "state": job.state,
                            "submitted_at": job.submitted_at,
                            "started_at": job.started_at,
                            "completed_at": job.completed_at,
                        }
                        for job_id, job in sorted(session.jobs.items())
                    },
                    "subscriptions": {
                        subscription_id: {
                            "topics": subscription.topics,
                            "transport_uri": subscription.transport_uri,
                        }
                        for subscription_id, subscription in sorted(session.subscriptions.items())
                    },
                    "frame_plans": {
                        view_id: frame_plan_to_dict(plan)
                        for view_id, plan in sorted(session.frame_plans.items())
                    },
                    "frame_plans_3d": {
                        view_id: frame_plan_3d_to_dict(plan)
                        for view_id, plan in sorted(session.frame_plans_3d.items())
                    },
                    "frame_plans_points": {
                        view_id: frame_plan_points_to_dict(plan)
                        for view_id, plan in sorted(session.frame_plans_points.items())
                    },
                    "outbox": deepcopy(session.outbox),
                    "command_journal": deepcopy(session.command_journal),
                    "imported_logs": {
                        import_id: {
                            "source_uri": staged["source_uri"],
                            "record_count": staged["record_count"],
                            "command_count": staged["command_count"],
                            "event_count": staged["event_count"],
                            "imported_at": staged["imported_at"],
                        }
                        for import_id, staged in sorted(session.imported_logs.items())
                    },
                }
            )
        return {"sessions": sessions}

    def events_for_session(self, session_id: str) -> list[dict[str, Any]]:
        session = self._require_session(session_id)
        return deepcopy(session.outbox)

    def session_state(self, session_id: str) -> str | None:
        session = self._state.sessions.get(session_id)
        if session is None:
            return None
        return session.state

    def drop_session(self, session_id: str) -> bool:
        session = self._state.sessions.pop(session_id, None)
        if session is None:
            return False
        self._state.idempotency_cache = {
            key: value
            for key, value in self._state.idempotency_cache.items()
            if key[0] != session_id
        }
        return True

    def frame_plan_for_view(self, session_id: str, view_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        self._require_view(session, view_id)
        plan = session.frame_plans.get(view_id)
        if plan is None:
            raise not_found("Frame plan does not exist for view", {"session_id": session_id, "view_id": view_id})
        return frame_plan_to_dict(plan)

    def frame_plan_3d_for_view(self, session_id: str, view_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        self._require_view(session, view_id)
        plan = session.frame_plans_3d.get(view_id)
        if plan is None:
            raise not_found("3D frame plan does not exist for view", {"session_id": session_id, "view_id": view_id})
        return frame_plan_3d_to_dict(plan)

    def frame_plan_points_for_view(self, session_id: str, view_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        self._require_view(session, view_id)
        plan = session.frame_plans_points.get(view_id)
        if plan is None:
            raise not_found("Points frame plan does not exist for view", {"session_id": session_id, "view_id": view_id})
        return frame_plan_points_to_dict(plan)

    def _validate_protocol(self, params: dict[str, Any]) -> None:
        version = params.get("protocol_version")
        if not isinstance(version, str):
            raise invalid_params("Missing protocol_version", {})
        if version != ProtocolVersion:
            raise version_mismatch(
                "Unsupported protocol version",
                {"requested": version, "supported": ProtocolVersion},
            )

    def _capabilities(self) -> dict[str, bool]:
        return {
            "async_jobs": True,
            "dedicated_event_stream": True,
            "idempotency_keys": True,
            "dataref_oob": True,
            "total_ordered_events": True,
            "command_log_replay": True,
        }

    def _require_session(self, session_id: str) -> SessionState:
        session = self._state.sessions.get(session_id)
        if session is None:
            raise not_found("Session does not exist", {"session_id": session_id})
        return session

    def _require_dataset(self, session: SessionState, dataset_id: str) -> DatasetState:
        dataset = session.datasets.get(dataset_id)
        if dataset is None:
            raise not_found("Dataset does not exist", {"session_id": session.session_id, "dataset_id": dataset_id})
        return dataset

    def _require_layer(self, session: SessionState, layer_id: str) -> LayerState:
        layer = session.layers.get(layer_id)
        if layer is None:
            raise not_found("Layer does not exist", {"session_id": session.session_id, "layer_id": layer_id})
        return layer

    def _require_view(self, session: SessionState, view_id: str) -> ViewState:
        view = session.views.get(view_id)
        if view is None:
            raise not_found("View does not exist", {"session_id": session.session_id, "view_id": view_id})
        return view

    def _emit_event(self, session: SessionState, event_type: str, payload: dict[str, Any]) -> None:
        session.session_seq += 1
        event = {
            "protocol_version": ProtocolVersion,
            "session_id": session.session_id,
            "event_id": self._uuid(),
            "event_type": event_type,
            "session_seq": session.session_seq,
            "emitted_at": self._clock(),
            "payload": payload,
        }
        session.outbox.append(event)

    def _emit_error_event(self, params: dict[str, Any], exc: LucidaError) -> None:
        session_id = params.get("session_id")
        if not isinstance(session_id, str):
            return
        session = self._state.sessions.get(session_id)
        if session is None:
            return
        self._emit_event(session, "error", {"error": exc.envelope()})

    def _record_command_journal_entry(
        self,
        *,
        session: SessionState,
        method: str,
        params: dict[str, Any],
        outbox_offset: int,
    ) -> None:
        if method in COMMAND_LOG_METHODS:
            return
        protocol_version = params.get("protocol_version")
        request_id = params.get("request_id")
        if not isinstance(protocol_version, str) or not isinstance(request_id, str):
            return
        request: dict[str, Any] = {
            "protocol_version": protocol_version,
            "request_id": request_id,
            "params": method_params_from_request(params),
        }
        idempotency_key = params.get("idempotency_key")
        if isinstance(idempotency_key, str) and idempotency_key:
            request["idempotency_key"] = idempotency_key
        entry = {
            "recorded_at": self._clock(),
            "correlation_id": self._uuid(),
            "method": method,
            "request": request,
            "events": [deepcopy(event) for event in session.outbox[outbox_offset:]],
        }
        session.command_journal.append(entry)

    def _parse_timeout_ms(self, value: Any) -> int | None:
        if value is None:
            return None
        if not isinstance(value, int) or value <= 0:
            raise invalid_params("timeout_ms must be a positive integer", {"timeout_ms": value})
        return value

    def _parse_max_retries(self, value: Any) -> int | None:
        if value is None:
            return None
        if not isinstance(value, int) or value < 0:
            raise invalid_params("max_retries must be a non-negative integer", {"max_retries": value})
        return value

    def _dataset_from_uri(
        self,
        *,
        uri: str,
        read_only: bool,
        axis_map: dict[str, str] | None,
        timeout_ms: int | None,
        max_retries: int | None,
    ) -> DatasetState:
        try:
            metadata = self._scheduler.execute(
                lambda: open_dataset_metadata(
                    uri=uri,
                    read_only=read_only,
                    axis_map=axis_map,
                    cache=self._cache,
                ),
                timeout_ms=timeout_ms,
                max_retries=max_retries,
            )
        except AxisMapError as exc:
            raise invalid_params("axis_map is invalid", {"uri": uri, "error": str(exc)}) from exc
        except MissingDependencyError as exc:
            backend = detect_backend(uri)
            raise unsupported(
                "Optional backend dependency is not installed",
                {"uri": uri, "backend": backend, "dependency_error": str(exc)},
            ) from exc
        except SchedulerTimeout as exc:
            raise timeout("dataset.open timed out", {"uri": uri, "error": str(exc)}) from exc
        except IOBackendError as exc:
            message = str(exc)
            if "unsupported dataset URI scheme" in message:
                raise unsupported("Dataset backend is unsupported", {"uri": uri, "error": message}) from exc
            raise io_failure("dataset.open backend IO failed", {"uri": uri, "error": message}) from exc
        except Exception as exc:
            raise io_failure("dataset.open backend IO failed", {"uri": uri, "error": str(exc)}) from exc

        return DatasetState(
            dataset_id=_canonical_dataset_id(uri),
            uri=uri,
            axis_labels=list(metadata.axis_labels),
            shape=list(metadata.shape),
            dtype=metadata.dtype,
            transform={"scale": list(metadata.transform["scale"]), "translate": list(metadata.transform["translate"])},
            read_only=read_only,
            backend=metadata.backend,
            ngff_version=metadata.ngff_version,
            zarr_format=metadata.zarr_format,
            multiscales=deepcopy(metadata.multiscales),
            cache_snapshot=deepcopy(metadata.cache_snapshot),
        )

    def _default_view_state(self, view_id: str, label: str | None, axis_order: list[str]) -> ViewState:
        axis_indices = {axis: 0 for axis in axis_order}
        return ViewState(
            view_id=view_id,
            label=label,
            axis_order=axis_order,
            axis_indices=axis_indices,
            channel_order=[0],
            bound_layer_ids=[],
            camera_mode="panzoom",
            camera_pose={
                "position": [0.0, 0.0, 1.0],
                "target": [0.0, 0.0, 0.0],
                "up": [0.0, 1.0, 0.0],
                "fov_degrees": 45.0,
            },
            selection=self._new_empty_selection_state(),
        )

    def _new_empty_selection_state(self) -> dict[str, Any]:
        timestamp = self._clock()
        return {
            "selection_version": 1,
            "query": {"mode": "ids", "combine": "replace", "ids": []},
            "resolved": {"count": 0, "selected_point_ids": []},
            "created_at": timestamp,
            "updated_at": timestamp,
        }

    def _dataset_axis_size(self, dataset: DatasetState, axis: str) -> int | None:
        if axis not in dataset.axis_labels:
            return None
        index = dataset.axis_labels.index(axis)
        return dataset.shape[index]

    def _layer_dataset(self, session: SessionState, layer: LayerState) -> DatasetState | None:
        if layer.dataset_id is None:
            return None
        return session.datasets.get(layer.dataset_id)

    def _datasets_compatible(self, left: DatasetState, right: DatasetState) -> bool:
        return (
            left.axis_labels == right.axis_labels
            and left.shape == right.shape
            and left.transform == right.transform
        )

    def _canonical_panzoom_pose(self, pose: dict[str, Any], *, strict: bool) -> dict[str, Any]:
        try:
            panzoom = panzoom_state_from_pose(deepcopy(pose))
        except ValueError as exc:
            if strict:
                raise invalid_params("pose is invalid for panzoom mode", {"error": str(exc)}) from exc
            panzoom = PanZoomState(center_x=0.0, center_y=0.0, zoom=1.0)
        return panzoom_state_to_pose(panzoom)

    def _canonical_3d_pose(self, pose: dict[str, Any], *, mode: str, strict: bool) -> dict[str, Any]:
        try:
            return canonicalize_camera_pose_3d(deepcopy(pose), mode=mode, strict=strict)
        except ValueError as exc:
            if strict:
                raise invalid_params(f"pose is invalid for {mode} mode", {"error": str(exc)}) from exc
            return canonicalize_camera_pose_3d({}, mode=mode, strict=False)

    def _validate_step5_render_patch(self, layer: LayerState, patch: dict[str, Any]) -> list[str]:
        style_reasons: list[str] = []
        render_keys = {"render_mode", "iso_threshold", "density_scale", "sample_step"}
        touched_render_keys = sorted(render_keys.intersection(patch.keys()))
        if touched_render_keys and layer.layer_type != "image":
            raise invalid_params(
                "Step 05 render controls apply only to image layers",
                {"layer_id": layer.layer_id, "layer_type": layer.layer_type, "keys": touched_render_keys},
            )

        if "render_mode" in patch:
            render_mode = patch["render_mode"]
            if not isinstance(render_mode, str) or render_mode not in {"mip", "alpha", "iso"}:
                raise invalid_params("patch.render_mode must be one of mip, alpha, iso", {"value": render_mode})
            style_reasons.append("layer.update.render_mode")

        if "iso_threshold" in patch:
            iso_threshold = patch["iso_threshold"]
            if not isinstance(iso_threshold, (int, float)) or not (0 <= float(iso_threshold) <= 1):
                raise invalid_params("patch.iso_threshold must be between 0 and 1", {"value": iso_threshold})
            style_reasons.append("layer.update.iso_threshold")

        if "density_scale" in patch:
            density_scale = patch["density_scale"]
            if not isinstance(density_scale, (int, float)) or not (float(density_scale) > 0):
                raise invalid_params("patch.density_scale must be greater than 0", {"value": density_scale})
            style_reasons.append("layer.update.density_scale")

        if "sample_step" in patch:
            sample_step = patch["sample_step"]
            if not isinstance(sample_step, (int, float)) or not (float(sample_step) > 0):
                raise invalid_params("patch.sample_step must be greater than 0", {"value": sample_step})
            style_reasons.append("layer.update.sample_step")

        return style_reasons

    def _dtype_kind(self, dtype: str) -> str:
        normalized = dtype.strip().lower()
        if normalized and normalized[0] in {"<", ">", "|", "="}:
            normalized = normalized[1:]

        numeric_aliases = {
            "f2": "float",
            "f4": "float",
            "f8": "float",
            "f16": "float",
            "f32": "float",
            "f64": "float",
            "i1": "int",
            "i2": "int",
            "i4": "int",
            "i8": "int",
            "u1": "int",
            "u2": "int",
            "u4": "int",
            "u8": "int",
        }
        if normalized in numeric_aliases:
            return numeric_aliases[normalized]
        if normalized.startswith("float"):
            return "float"
        if normalized.startswith("int") or normalized.startswith("uint"):
            return "int"
        return "other"

    def _validate_dataref(self, *, field: str, data_ref: Any, rank: int, dtype_kind: str | None = None) -> tuple[list[int], str]:
        if not isinstance(data_ref, dict):
            raise invalid_params(f"{field} must be an object", {})
        shape_value = data_ref.get("shape")
        if not isinstance(shape_value, list) or len(shape_value) != rank:
            raise invalid_params(f"{field}.shape must contain exactly {rank} dimensions", {})
        if not all(isinstance(item, int) and item > 0 for item in shape_value):
            raise invalid_params(f"{field}.shape values must be positive integers", {})
        shape = [int(item) for item in shape_value]

        dtype = data_ref.get("dtype")
        if not isinstance(dtype, str) or not dtype.strip():
            raise invalid_params(f"{field}.dtype must be a non-empty string", {})
        kind = self._dtype_kind(dtype)
        if dtype_kind == "numeric" and kind not in {"int", "float"}:
            raise invalid_params(f"{field}.dtype must be numeric", {"dtype": dtype})
        if dtype_kind == "integer" and kind != "int":
            raise invalid_params(f"{field}.dtype must be integer", {"dtype": dtype})
        return (shape, dtype)

    def _validate_points_filter_predicate(self, predicate: Any, *, path: str = "points_filter") -> None:
        if not isinstance(predicate, dict):
            raise invalid_params(f"{path} must be an object", {})
        op = predicate.get("op")
        if not isinstance(op, str):
            raise invalid_params(f"{path}.op must be a string", {})

        if op in {"and", "or"}:
            predicates = predicate.get("predicates")
            if not isinstance(predicates, list) or not predicates:
                raise invalid_params(f"{path}.predicates must be a non-empty array", {})
            for idx, child in enumerate(predicates):
                self._validate_points_filter_predicate(child, path=f"{path}.predicates[{idx}]")
            return

        if op == "not":
            self._validate_points_filter_predicate(predicate.get("predicate"), path=f"{path}.predicate")
            return

        if op == "range":
            field = predicate.get("field")
            minimum = predicate.get("min")
            maximum = predicate.get("max")
            if not isinstance(field, str) or not field:
                raise invalid_params(f"{path}.field must be a non-empty string", {})
            if minimum is None and maximum is None:
                raise invalid_params(f"{path} requires at least one of min or max", {})
            if minimum is not None and not isinstance(minimum, (int, float)):
                raise invalid_params(f"{path}.min must be numeric", {})
            if maximum is not None and not isinstance(maximum, (int, float)):
                raise invalid_params(f"{path}.max must be numeric", {})
            if isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) and float(minimum) > float(maximum):
                raise invalid_params(f"{path}.min must be <= max", {})
            return

        if op == "in":
            field = predicate.get("field")
            values = predicate.get("values")
            if not isinstance(field, str) or not field:
                raise invalid_params(f"{path}.field must be a non-empty string", {})
            if not isinstance(values, list) or not values:
                raise invalid_params(f"{path}.values must be a non-empty array", {})
            allowed_types = (str, int, float, bool)
            if not all(isinstance(value, allowed_types) for value in values):
                raise invalid_params(f"{path}.values must contain primitive values", {})
            return

        if op == "eq":
            field = predicate.get("field")
            if not isinstance(field, str) or not field:
                raise invalid_params(f"{path}.field must be a non-empty string", {})
            value = predicate.get("value")
            if not isinstance(value, (str, int, float, bool)):
                raise invalid_params(f"{path}.value must be a primitive value", {})
            return

        if op == "exists":
            field = predicate.get("field")
            if not isinstance(field, str) or not field:
                raise invalid_params(f"{path}.field must be a non-empty string", {})
            return

        raise invalid_params(f"{path}.op is unsupported", {"op": op})

    def _validate_step6_points_patch(self, layer: LayerState, patch: dict[str, Any]) -> list[str]:
        style_reasons: list[str] = []
        points_keys = {"points_filter", "color_by", "color_map", "lod_cell_px", "lod_max_points", "point_size"}
        touched_points_keys = sorted(points_keys.intersection(patch.keys()))
        if touched_points_keys and layer.layer_type != "points":
            raise invalid_params(
                "Step 06 points controls apply only to points layers",
                {"layer_id": layer.layer_id, "layer_type": layer.layer_type, "keys": touched_points_keys},
            )

        if "points_filter" in patch:
            points_filter = patch["points_filter"]
            if points_filter is not None:
                self._validate_points_filter_predicate(points_filter)
            style_reasons.append("layer.update.points_filter")

        if "color_by" in patch:
            if not isinstance(patch["color_by"], str) or not patch["color_by"]:
                raise invalid_params("patch.color_by must be a non-empty string", {})
            style_reasons.append("layer.update.color_by")

        if "color_map" in patch:
            if not isinstance(patch["color_map"], str) or not patch["color_map"]:
                raise invalid_params("patch.color_map must be a non-empty string", {})
            style_reasons.append("layer.update.color_map")

        if "lod_cell_px" in patch:
            lod_cell_px = patch["lod_cell_px"]
            if not isinstance(lod_cell_px, int) or lod_cell_px <= 0:
                raise invalid_params("patch.lod_cell_px must be a positive integer", {})
            style_reasons.append("layer.update.lod_cell_px")

        if "lod_max_points" in patch:
            lod_max_points = patch["lod_max_points"]
            if not isinstance(lod_max_points, int) or lod_max_points <= 0:
                raise invalid_params("patch.lod_max_points must be a positive integer", {})
            style_reasons.append("layer.update.lod_max_points")

        if "point_size" in patch:
            point_size = patch["point_size"]
            if not isinstance(point_size, (int, float)) or float(point_size) <= 0:
                raise invalid_params("patch.point_size must be greater than 0", {})
            style_reasons.append("layer.update.point_size")

        return style_reasons

    def _selection_ids_data_ref(self, *, session_id: str, view_id: str, count: int) -> dict[str, Any]:
        return {
            "kind": "uri",
            "uri": f"memory://{session_id}/{view_id}/selection_ids",
            "dtype": "uint64",
            "shape": [max(count, 1)],
            "endianness": "little",
            "compression": "none",
            "ttl_ms": _DATAREF_DEFAULT_TTL_MS,
            "checksum_sha256": _DATAREF_CHECKSUM_PLACEHOLDER,
        }

    def _canonical_selection_state(
        self,
        *,
        session: SessionState,
        view: ViewState,
        selection: dict[str, Any],
    ) -> dict[str, Any]:
        if "selection_version" in selection:
            selection_version = selection.get("selection_version")
            if not isinstance(selection_version, int) or selection_version <= 0:
                raise invalid_params("selection.selection_version must be a positive integer", {})

            query = selection.get("query")
            if not isinstance(query, dict):
                raise invalid_params("selection.query must be an object", {})
            mode = query.get("mode")
            if mode not in {"box", "lasso", "predicate", "ids"}:
                raise invalid_params("selection.query.mode must be one of box, lasso, predicate, ids", {})
            combine = query.get("combine")
            if combine is None:
                query["combine"] = "replace"
            elif combine not in {"replace", "union", "intersect", "subtract"}:
                raise invalid_params("selection.query.combine is invalid", {})
            if "predicate" in query and query.get("predicate") is not None:
                self._validate_points_filter_predicate(query.get("predicate"), path="selection.query.predicate")

            resolved = selection.get("resolved")
            if not isinstance(resolved, dict):
                raise invalid_params("selection.resolved must be an object", {})
            resolved_count = resolved.get("count")
            if not isinstance(resolved_count, int) or resolved_count < 0:
                raise invalid_params("selection.resolved.count must be a non-negative integer", {})

            selected_ids = resolved.get("selected_point_ids")
            selected_ids_ref = resolved.get("selected_point_ids_ref")
            if selected_ids is not None and selected_ids_ref is not None:
                raise invalid_params("selection.resolved cannot include both selected_point_ids and selected_point_ids_ref", {})

            if selected_ids is not None:
                if not isinstance(selected_ids, list) or not all(isinstance(item, int) and item >= 0 for item in selected_ids):
                    raise invalid_params("selection.resolved.selected_point_ids must be an array of non-negative integers", {})
                dedup_ids = sorted(set(int(item) for item in selected_ids))
                if len(dedup_ids) > POINT_SELECTION_INLINE_CAP:
                    raise invalid_params(
                        f"selection.resolved.selected_point_ids exceeds inline cap {POINT_SELECTION_INLINE_CAP}",
                        {},
                    )
                resolved = {
                    "count": int(resolved_count),
                    "selected_point_ids": dedup_ids,
                }
            elif selected_ids_ref is not None:
                self._validate_dataref(field="selection.resolved.selected_point_ids_ref", data_ref=selected_ids_ref, rank=1, dtype_kind="integer")
                resolved = {
                    "count": int(resolved_count),
                    "selected_point_ids_ref": deepcopy(selected_ids_ref),
                }
            else:
                resolved = {"count": int(resolved_count)}

            updated_at = selection.get("updated_at")
            if updated_at is not None and not isinstance(updated_at, str):
                raise invalid_params("selection.updated_at must be an RFC3339 timestamp string", {})
            created_at = selection.get("created_at")
            if created_at is not None and not isinstance(created_at, str):
                raise invalid_params("selection.created_at must be an RFC3339 timestamp string", {})

            canonical = {
                "selection_version": int(selection_version),
                "query": deepcopy(query),
                "resolved": resolved,
                "updated_at": str(updated_at or self._clock()),
            }
            if created_at is not None:
                canonical["created_at"] = str(created_at)
            return canonical

        indices = selection.get("indices", selection.get("ids"))
        dedup_ids: list[int] = []
        if isinstance(indices, list):
            dedup_ids = sorted({int(item) for item in indices if isinstance(item, int) and item >= 0})
        resolved: dict[str, Any] = {"count": len(dedup_ids)}
        if len(dedup_ids) <= POINT_SELECTION_INLINE_CAP:
            resolved["selected_point_ids"] = list(dedup_ids)
        else:
            resolved["selected_point_ids_ref"] = self._selection_ids_data_ref(
                session_id=session.session_id,
                view_id=view.view_id,
                count=len(dedup_ids),
            )
        timestamp = self._clock()
        return {
            "selection_version": 1,
            "query": {"mode": "ids", "combine": "replace", "ids": list(dedup_ids)},
            "resolved": resolved,
            "created_at": timestamp,
            "updated_at": timestamp,
        }

    def _selection_linked_image_context(self, *, view: ViewState, selection_state: dict[str, Any]) -> dict[str, Any]:
        query = selection_state.get("query")
        resolved = selection_state.get("resolved")
        bbox_min: list[float] = [0.0, 0.0, 0.0]
        bbox_max: list[float] = [0.0, 0.0, 0.0]

        if isinstance(query, dict):
            box_world = query.get("box_world")
            if isinstance(box_world, dict):
                min_value = box_world.get("min")
                max_value = box_world.get("max")
                if (
                    isinstance(min_value, list)
                    and isinstance(max_value, list)
                    and len(min_value) == len(max_value)
                    and min_value
                    and all(isinstance(v, (int, float)) for v in min_value)
                    and all(isinstance(v, (int, float)) for v in max_value)
                ):
                    bbox_min = [float(v) for v in min_value]
                    bbox_max = [float(v) for v in max_value]
            elif isinstance(query.get("lasso_world"), list) and query.get("lasso_world"):
                lasso = query.get("lasso_world")
                assert isinstance(lasso, list)  # narrowed above
                points = [point for point in lasso if isinstance(point, list) and all(isinstance(v, (int, float)) for v in point)]
                if points:
                    dims = len(points[0])
                    dims = max(2, min(dims, 3))
                    mins = [float("inf")] * dims
                    maxs = [float("-inf")] * dims
                    for point in points:
                        for idx in range(dims):
                            value = float(point[idx])
                            mins[idx] = min(mins[idx], value)
                            maxs[idx] = max(maxs[idx], value)
                    bbox_min = mins
                    bbox_max = maxs

        if bbox_min == [0.0, 0.0, 0.0] and bbox_max == [0.0, 0.0, 0.0] and isinstance(resolved, dict):
            selected_ids = resolved.get("selected_point_ids")
            if isinstance(selected_ids, list) and selected_ids:
                first = float(min(selected_ids))
                last = float(max(selected_ids))
                bbox_min = [first, 0.0, 0.0]
                bbox_max = [last, 1.0, 1.0]

        dims = min(len(bbox_min), len(bbox_max))
        dims = max(2, min(dims, 3))
        bbox_min = bbox_min[:dims]
        bbox_max = bbox_max[:dims]
        centroid = [(bbox_min[idx] + bbox_max[idx]) * 0.5 for idx in range(dims)]
        return {
            "centroid_world": centroid,
            "bbox_world": {"min": bbox_min, "max": bbox_max},
            "slice_hint": {axis: int(index) for axis, index in sorted(view.axis_indices.items())},
        }

    def _points_state_summary(self, layer: LayerState) -> dict[str, Any]:
        point_count = 0
        edge_count = 0
        if isinstance(layer.data_ref, dict):
            shape = layer.data_ref.get("shape")
            if isinstance(shape, list) and shape and isinstance(shape[0], int):
                point_count = int(shape[0])
        if isinstance(layer.edges_ref, dict):
            shape = layer.edges_ref.get("shape")
            if isinstance(shape, list) and shape and isinstance(shape[0], int):
                edge_count = int(shape[0])

        patch = layer.patch if isinstance(layer.patch, dict) else {}
        lod_cell_px = patch.get("lod_cell_px", 2)
        lod_max_points = patch.get("lod_max_points", 250_000)
        active_filter = patch.get("points_filter")
        return {
            "point_count": point_count,
            "edge_count": edge_count,
            "attribute_columns": list(layer.attribute_columns),
            "active_lod": {
                "lod_cell_px": int(lod_cell_px) if isinstance(lod_cell_px, int) else 2,
                "lod_max_points": int(lod_max_points) if isinstance(lod_max_points, int) else 250_000,
            },
            "active_filter": deepcopy(active_filter) if isinstance(active_filter, dict) else None,
        }

    def _mark_view_invalidation(
        self,
        session: SessionState,
        *,
        view_id: str,
        kind: InvalidationKind,
        reason: str,
    ) -> None:
        if view_id not in session.views:
            return
        self._render2d_scheduler.mark(
            session_id=session.session_id,
            view_id=view_id,
            kind=kind,
            reason=reason,
        )
        self._render3d_scheduler.mark(
            session_id=session.session_id,
            view_id=view_id,
            kind=kind,
            reason=reason,
        )
        self._render_points_scheduler.mark(
            session_id=session.session_id,
            view_id=view_id,
            kind=kind,
            reason=reason,
        )

    def _mark_session_views_invalidation(self, session: SessionState, *, kind: InvalidationKind, reason: str) -> None:
        for view_id in sorted(session.views):
            self._mark_view_invalidation(session, view_id=view_id, kind=kind, reason=reason)

    def _mark_layer_views_invalidation(
        self,
        session: SessionState,
        *,
        layer_id: str,
        kind: InvalidationKind,
        reason: str,
    ) -> None:
        for view_id in sorted(session.views):
            view = session.views[view_id]
            if layer_id in view.bound_layer_ids:
                self._mark_view_invalidation(session, view_id=view_id, kind=kind, reason=reason)

    def _plan_view_if_invalidated(self, session: SessionState, view_id: str) -> None:
        view = session.views.get(view_id)
        if view is None:
            return
        ticket_2d = self._render2d_scheduler.consume(session_id=session.session_id, view_id=view_id)
        if ticket_2d is not None:
            previous_2d = session.frame_plans.get(view_id)
            plan_2d = build_frame_plan_2d(session=session, view=view, ticket=ticket_2d, previous_plan=previous_2d)
            session.frame_plans[view_id] = plan_2d

        ticket_3d = self._render3d_scheduler.consume(session_id=session.session_id, view_id=view_id)
        if ticket_3d is not None:
            previous_3d = session.frame_plans_3d.get(view_id)
            plan_3d = build_frame_plan_3d(session=session, view=view, ticket=ticket_3d, previous_plan=previous_3d)
            session.frame_plans_3d[view_id] = plan_3d

        ticket_points = self._render_points_scheduler.consume(session_id=session.session_id, view_id=view_id)
        if ticket_points is not None:
            previous_points = session.frame_plans_points.get(view_id)
            plan_points = build_frame_plan_points(
                session=session,
                view=view,
                ticket=ticket_points,
                previous_plan=previous_points,
            )
            session.frame_plans_points[view_id] = plan_points

    def _plan_views(self, session: SessionState, view_ids: list[str]) -> None:
        for view_id in sorted(set(view_ids)):
            self._plan_view_if_invalidated(session, view_id)

    def _apply_job_lifecycle(self, session: SessionState, job_id: str) -> dict[str, Any]:
        accepted_at = self._clock()
        job = JobState(
            job_id=job_id,
            state="queued",
            submitted_at=accepted_at,
        )
        session.jobs[job_id] = job
        self._emit_event(session, "job.lifecycle", {"job_id": job_id, "state": "queued"})

        job.state = "running"
        job.started_at = self._clock()
        self._emit_event(session, "job.lifecycle", {"job_id": job_id, "state": "running"})
        self._emit_event(session, "job.progress", {"job_id": job_id, "progress": 0.5, "message": "halfway"})

        job.state = "completed"
        job.completed_at = self._clock()
        self._emit_event(session, "job.progress", {"job_id": job_id, "progress": 1.0, "message": "done"})
        self._emit_event(session, "job.lifecycle", {"job_id": job_id, "state": "completed"})

        return {"job_id": job_id, "accepted_at": accepted_at, "state": "queued"}

    def _job_accept(self, session: SessionState, job_id: str) -> dict[str, Any]:
        accepted_at = self._clock()
        session.jobs[job_id] = JobState(
            job_id=job_id,
            state="queued",
            submitted_at=accepted_at,
        )
        self._emit_event(session, "job.lifecycle", {"job_id": job_id, "state": "queued"})
        return {"job_id": job_id, "accepted_at": accepted_at, "state": "queued"}

    def _job_start(self, session: SessionState, job_id: str) -> JobState:
        job = session.jobs[job_id]
        if job.state != "queued":
            return job
        job.state = "running"
        job.started_at = self._clock()
        self._emit_event(session, "job.lifecycle", {"job_id": job_id, "state": "running"})
        return job

    def _job_complete(self, session: SessionState, job_id: str, message: str = "done") -> None:
        job = session.jobs[job_id]
        if job.state in {"completed", "failed", "cancelled"}:
            return
        self._emit_event(session, "job.progress", {"job_id": job_id, "progress": 1.0, "message": message})
        job.state = "completed"
        job.completed_at = self._clock()
        self._emit_event(session, "job.lifecycle", {"job_id": job_id, "state": "completed"})
        session.pending_job_ops.pop(job_id, None)
        session.job_cancel_tokens.pop(job_id, None)

    def _job_fail(self, session: SessionState, job_id: str, exc: LucidaError) -> None:
        job = session.jobs[job_id]
        if job.state in {"completed", "failed", "cancelled"}:
            return
        job.state = "failed"
        job.completed_at = self._clock()
        job.error = exc.envelope()
        self._emit_event(
            session,
            "job.lifecycle",
            {"job_id": job_id, "state": "failed", "error": exc.envelope()},
        )
        session.pending_job_ops.pop(job_id, None)
        session.job_cancel_tokens.pop(job_id, None)

    def _run_pending_job(self, session: SessionState, job_id: str) -> None:
        op = session.pending_job_ops.get(job_id)
        if op is None:
            return
        job = session.jobs.get(job_id)
        if job is None or job.state in {"cancelled", "completed", "failed"}:
            session.pending_job_ops.pop(job_id, None)
            session.job_cancel_tokens.pop(job_id, None)
            return
        self._job_start(session, job_id)
        self._emit_event(session, "job.progress", {"job_id": job_id, "progress": 0.5, "message": "running"})
        try:
            op()
        except CancelledError:
            token = session.job_cancel_tokens.get(job_id)
            if token is not None:
                token.cancel()
            job.state = "cancelled"
            if job.completed_at is None:
                job.completed_at = self._clock()
            self._emit_event(session, "job.lifecycle", {"job_id": job_id, "state": "cancelled"})
            session.pending_job_ops.pop(job_id, None)
            session.job_cancel_tokens.pop(job_id, None)
            return
        except LucidaError as exc:
            self._job_fail(session, job_id, exc)
            return
        except Exception as exc:  # pragma: no cover - defensive fallback
            self._job_fail(
                session,
                job_id,
                io_failure(
                    "Job operation failed",
                    {"job_id": job_id, "error": str(exc)},
                ),
            )
            return
        self._job_complete(session, job_id)

    def _system_hello(self, params: dict[str, Any]) -> dict[str, Any]:
        supported = params.get("supported_versions")
        if not isinstance(supported, dict):
            raise invalid_params("supported_versions is required", {})
        min_version = supported.get("min_version")
        max_version = supported.get("max_version")
        if not isinstance(min_version, str) or not isinstance(max_version, str):
            raise invalid_params("supported_versions range must be strings", {})
        if not _is_version_compatible(min_version, max_version, ProtocolVersion):
            raise version_mismatch(
                "No compatible protocol version",
                {"client_min": min_version, "client_max": max_version, "server": ProtocolVersion},
            )
        return {
            "selected_version": ProtocolVersion,
            "daemon_name": "lucida-step3",
            "daemon_version": ProtocolVersion,
            "capabilities": self._capabilities(),
            "event_stream": "ws",
            "server_time": self._clock(),
        }

    def _system_capabilities_get(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "selected_version": ProtocolVersion,
            "capabilities": self._capabilities(),
            "inline_payload_limit_bytes": 65536,
        }

    def _session_create(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = self._uuid()
        created_at = self._clock()
        session = SessionState(
            session_id=session_id,
            created_at=created_at,
            label=params.get("label"),
        )
        default_view = self._default_view_state(self._uuid(), "default", ["t", "c", "z", "y", "x"])
        session.views[default_view.view_id] = default_view
        self._mark_view_invalidation(
            session,
            view_id=default_view.view_id,
            kind=InvalidationKind.FULL,
            reason="session.create",
        )
        self._plan_view_if_invalidated(session, default_view.view_id)
        self._state.sessions[session_id] = session
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "session",
                "object_id": session_id,
                "change_summary": "session created",
            },
        )
        return {"session_id": session_id, "created_at": created_at, "label": session.label}

    def _session_close(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        session.state = "closed"
        closed_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "session",
                "object_id": session.session_id,
                "change_summary": "session closed",
            },
        )
        return {"session_id": session.session_id, "closed_at": closed_at}

    def _session_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        out = {
            "session_id": session.session_id,
            "state": session.state,
            "created_at": session.created_at,
        }
        if session.label:
            out["label"] = session.label
        return out

    def _dataset_open(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        uri = params["uri"]
        axis_map = params.get("axis_map")
        if axis_map is not None and not isinstance(axis_map, dict):
            raise invalid_params("axis_map must be an object", {"axis_map": axis_map})
        timeout_ms = self._parse_timeout_ms(params.get("timeout_ms"))
        max_retries = self._parse_max_retries(params.get("max_retries"))
        dataset = self._dataset_from_uri(
            uri=uri,
            read_only=bool(params["read_only"]),
            axis_map=axis_map,
            timeout_ms=timeout_ms,
            max_retries=max_retries,
        )
        if dataset.dataset_id in session.datasets:
            raise conflict("Dataset already open in session", {"dataset_id": dataset.dataset_id})
        session.datasets[dataset.dataset_id] = dataset
        self._mark_session_views_invalidation(session, kind=InvalidationKind.FULL, reason="dataset.open")
        job_id = self._uuid()
        accepted = self._apply_job_lifecycle(session, job_id)
        self._emit_event(
            session,
            "dataset.opened",
            {
                "dataset_id": dataset.dataset_id,
                "uri": dataset.uri,
                "backend": dataset.backend,
            },
        )
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "dataset",
                "object_id": dataset.dataset_id,
                "change_summary": "dataset opened",
            },
        )
        self._plan_views(session, list(session.views))
        return {"session_id": session.session_id, "job": accepted}

    def _dataset_export(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        dataset = self._require_dataset(session, params["dataset_id"])
        destination_uri = params["destination_uri"]
        if not isinstance(destination_uri, str) or not destination_uri:
            raise invalid_params("destination_uri must be a non-empty string", {"destination_uri": destination_uri})

        overwrite = bool(params.get("overwrite", False))
        timeout_ms = self._parse_timeout_ms(params.get("timeout_ms"))
        max_retries = self._parse_max_retries(params.get("max_retries"))
        job_id = self._uuid()
        accepted = self._job_accept(session, job_id)
        cancel_token = CancelToken()
        session.job_cancel_tokens[job_id] = cancel_token

        def operation() -> dict[str, Any]:
            if cancel_token.cancelled:
                raise CancelledError("dataset export cancelled")
            try:
                self._scheduler.execute(
                    lambda: export_dataset_local_v05(
                        _dataset_to_metadata(dataset),
                        destination_uri=destination_uri,
                        overwrite=overwrite,
                    ),
                    timeout_ms=timeout_ms,
                    max_retries=max_retries,
                    cancel_token=cancel_token,
                )
            except CancelledError:
                raise
            except SchedulerTimeout as exc:
                raise timeout(
                    "dataset.export timed out",
                    {"dataset_id": dataset.dataset_id, "destination_uri": destination_uri, "error": str(exc)},
                ) from exc
            except MissingDependencyError as exc:
                raise unsupported(
                    "Export backend dependency is not installed",
                    {"dataset_id": dataset.dataset_id, "destination_uri": destination_uri, "error": str(exc)},
                ) from exc
            except FileExistsError as exc:
                raise conflict(
                    "Export destination already exists",
                    {"dataset_id": dataset.dataset_id, "destination_uri": destination_uri, "error": str(exc)},
                ) from exc
            except IOBackendError as exc:
                message = str(exc)
                if "supports local filesystem" in message:
                    raise unsupported(
                        "dataset.export destination backend is unsupported",
                        {"dataset_id": dataset.dataset_id, "destination_uri": destination_uri, "error": message},
                    ) from exc
                raise io_failure(
                    "dataset.export failed",
                    {"dataset_id": dataset.dataset_id, "destination_uri": destination_uri, "error": message},
                ) from exc
            except LucidaError:
                raise
            except Exception as exc:
                raise io_failure(
                    "dataset.export failed",
                    {"dataset_id": dataset.dataset_id, "destination_uri": destination_uri, "error": str(exc)},
                ) from exc

            self._emit_event(
                session,
                "dataset.exported",
                {
                    "dataset_id": dataset.dataset_id,
                    "destination_uri": destination_uri,
                    "job_id": job_id,
                },
            )
            self._emit_event(
                session,
                "state.changed",
                {
                    "object_type": "dataset",
                    "object_id": dataset.dataset_id,
                    "change_summary": "dataset exported",
                },
            )
            return {"session_id": session.session_id, "job_id": job_id}

        session.pending_job_ops[job_id] = operation
        return {"session_id": session.session_id, "job": accepted}

    def _dataset_close(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        dataset = self._require_dataset(session, params["dataset_id"])
        layer_refs = [layer.layer_id for layer in session.layers.values() if layer.dataset_id == dataset.dataset_id]
        if layer_refs:
            raise conflict(
                "Dataset is still referenced by layers",
                {"dataset_id": dataset.dataset_id, "layer_ids": layer_refs},
            )
        del session.datasets[dataset.dataset_id]
        self._mark_session_views_invalidation(session, kind=InvalidationKind.FULL, reason="dataset.close")
        closed_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "dataset",
                "object_id": dataset.dataset_id,
                "change_summary": "dataset closed",
            },
        )
        self._plan_views(session, list(session.views))
        return {"dataset_id": dataset.dataset_id, "closed_at": closed_at}

    def _dataset_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        dataset = self._require_dataset(session, params["dataset_id"])
        dataset.cache_snapshot = self._cache.snapshot()
        return {
            "session_id": session.session_id,
            "dataset_id": dataset.dataset_id,
            "uri": dataset.uri,
            "axis_labels": dataset.axis_labels,
            "shape": dataset.shape,
            "dtype": dataset.dtype,
            "transform": dataset.transform,
            "backend": dataset.backend,
            "ngff": {
                "ngff_version": dataset.ngff_version,
                "zarr_format": dataset.zarr_format,
                "multiscales": deepcopy(dataset.multiscales),
            },
            "cache": deepcopy(dataset.cache_snapshot),
        }

    def _layer_add_image(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        self._require_dataset(session, params["dataset_id"])
        layer_id = self._uuid()
        layer = LayerState(
            layer_id=layer_id,
            layer_type="image",
            name=params.get("name"),
            visible=True,
            opacity=1.0,
            dataset_id=params["dataset_id"],
            channel=params.get("channel"),
            transform=params.get("transform"),
        )
        session.layers[layer_id] = layer
        self._mark_session_views_invalidation(session, kind=InvalidationKind.FULL, reason="layer.add_image")
        job_id = self._uuid()
        accepted = self._apply_job_lifecycle(session, job_id)
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "layer",
                "object_id": layer_id,
                "change_summary": "image layer added",
            },
        )
        self._plan_views(session, list(session.views))
        return {"session_id": session.session_id, "layer_id": layer_id, "job": accepted}

    def _layer_add_points(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        data_ref = params.get("data_ref")
        data_shape, _data_dtype = self._validate_dataref(field="data_ref", data_ref=data_ref, rank=2, dtype_kind="numeric")
        point_count = int(data_shape[0])
        coord_dim = int(data_shape[1])
        if coord_dim < 2:
            raise invalid_params("data_ref.shape[1] must be >= 2 for point coordinates", {})

        point_id_ref = params.get("point_id_ref")
        if point_id_ref is not None:
            point_id_shape, _ = self._validate_dataref(
                field="point_id_ref",
                data_ref=point_id_ref,
                rank=1,
                dtype_kind="integer",
            )
            if point_id_shape[0] != point_count:
                raise invalid_params(
                    "point_id_ref length must match data_ref point count",
                    {"point_count": point_count, "point_id_count": point_id_shape[0]},
                )

        edges_ref = params.get("edges_ref")
        if edges_ref is not None:
            edge_shape, _ = self._validate_dataref(
                field="edges_ref",
                data_ref=edges_ref,
                rank=2,
                dtype_kind="integer",
            )
            if edge_shape[1] != 2:
                raise invalid_params("edges_ref.shape[1] must be 2", {})

        attribute_table_ref = params.get("attribute_table_ref")
        attribute_columns = params.get("attribute_columns", [])
        if attribute_columns is None:
            attribute_columns = []
        if not isinstance(attribute_columns, list) or not all(isinstance(item, str) and item for item in attribute_columns):
            raise invalid_params("attribute_columns must be an array of non-empty strings", {})
        if len(set(attribute_columns)) != len(attribute_columns):
            raise invalid_params("attribute_columns must be unique", {})

        if attribute_table_ref is not None:
            attr_shape, _ = self._validate_dataref(
                field="attribute_table_ref",
                data_ref=attribute_table_ref,
                rank=2,
            )
            if attr_shape[0] != point_count:
                raise invalid_params(
                    "attribute_table_ref row count must match data_ref point count",
                    {"point_count": point_count, "attribute_rows": attr_shape[0]},
                )
            if attribute_columns and attr_shape[1] != len(attribute_columns):
                raise invalid_params(
                    "attribute_columns length must match attribute_table_ref.shape[1]",
                    {"columns": len(attribute_columns), "table_columns": attr_shape[1]},
                )

        coordinate_axes = params.get("coordinate_axes")
        if coordinate_axes is None:
            canonical_axes = ["x", "y", "z"]
            coordinate_axes = [canonical_axes[idx] if idx < len(canonical_axes) else f"axis_{idx}" for idx in range(coord_dim)]
        if not isinstance(coordinate_axes, list) or not all(isinstance(axis, str) and axis for axis in coordinate_axes):
            raise invalid_params("coordinate_axes must be an array of non-empty strings", {})
        if len(coordinate_axes) != coord_dim:
            raise invalid_params(
                "coordinate_axes length must match data_ref.shape[1]",
                {"coordinate_axes": len(coordinate_axes), "dimensions": coord_dim},
            )
        if len(set(coordinate_axes)) != len(coordinate_axes):
            raise invalid_params("coordinate_axes must be unique", {})

        attributes = params.get("attributes", {})
        if not isinstance(attributes, dict):
            raise invalid_params("attributes must be an object", {})

        layer_id = self._uuid()
        layer = LayerState(
            layer_id=layer_id,
            layer_type="points",
            name=params.get("name"),
            visible=True,
            opacity=1.0,
            data_ref=deepcopy(data_ref),
            point_id_ref=deepcopy(point_id_ref),
            edges_ref=deepcopy(edges_ref),
            attribute_table_ref=deepcopy(attribute_table_ref),
            attribute_columns=list(attribute_columns),
            coordinate_axes=list(coordinate_axes),
            attributes=deepcopy(attributes),
        )
        session.layers[layer_id] = layer
        self._mark_session_views_invalidation(session, kind=InvalidationKind.FULL, reason="layer.add_points")
        job_id = self._uuid()
        accepted = self._apply_job_lifecycle(session, job_id)
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "layer",
                "object_id": layer_id,
                "change_summary": "points layer added",
            },
        )
        self._plan_views(session, list(session.views))
        return {"session_id": session.session_id, "layer_id": layer_id, "job": accepted}

    def _layer_update(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        layer = self._require_layer(session, params["layer_id"])
        patch = params["patch"]
        if not isinstance(patch, dict):
            raise invalid_params("patch must be an object", {"layer_id": layer.layer_id})
        style_reasons: list[str] = []
        if "visible" in patch:
            if not isinstance(patch["visible"], bool):
                raise invalid_params("patch.visible must be boolean", {})
            layer.visible = patch["visible"]
            style_reasons.append("layer.update.visible")
        if "opacity" in patch:
            opacity = patch["opacity"]
            if not isinstance(opacity, (int, float)) or not (0 <= float(opacity) <= 1):
                raise invalid_params("patch.opacity must be between 0 and 1", {})
            layer.opacity = float(opacity)
            style_reasons.append("layer.update.opacity")
        if "name" in patch:
            if not isinstance(patch["name"], str):
                raise invalid_params("patch.name must be string", {})
            layer.name = patch["name"]
        style_reasons.extend(self._validate_step5_render_patch(layer, patch))
        style_reasons.extend(self._validate_step6_points_patch(layer, patch))
        layer.patch.update(deepcopy(patch))
        updated_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "layer",
                "object_id": layer.layer_id,
                "change_summary": "layer updated",
            },
        )
        if style_reasons:
            for reason in style_reasons:
                self._mark_layer_views_invalidation(
                    session,
                    layer_id=layer.layer_id,
                    kind=InvalidationKind.STYLE,
                    reason=reason,
                )
            self._plan_views(session, list(session.views))
        return {"layer_id": layer.layer_id, "updated_at": updated_at}

    def _layer_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        layer = self._require_layer(session, params["layer_id"])
        self._mark_session_views_invalidation(session, kind=InvalidationKind.FULL, reason="layer.remove")
        del session.layers[layer.layer_id]
        for view in session.views.values():
            if layer.layer_id in view.bound_layer_ids:
                view.bound_layer_ids = [layer_id for layer_id in view.bound_layer_ids if layer_id != layer.layer_id]
        removed_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "layer",
                "object_id": layer.layer_id,
                "change_summary": "layer removed",
            },
        )
        self._plan_views(session, list(session.views))
        return {"layer_id": layer.layer_id, "removed_at": removed_at}

    def _layer_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        layer = self._require_layer(session, params["layer_id"])
        out = {
            "layer_id": layer.layer_id,
            "layer_type": layer.layer_type,
            "visible": layer.visible,
            "opacity": layer.opacity,
        }
        if layer.name:
            out["name"] = layer.name
        if layer.layer_type == "points":
            out["points_state"] = self._points_state_summary(layer)
        return out

    def _view_create(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view_id = self._uuid()
        axis_order = ["t", "c", "z", "y", "x"]
        if session.datasets:
            first_dataset = next(iter(session.datasets.values()))
            axis_order = list(first_dataset.axis_labels)
        view = self._default_view_state(view_id, params.get("label"), axis_order)
        session.views[view_id] = view
        self._mark_view_invalidation(
            session,
            view_id=view_id,
            kind=InvalidationKind.FULL,
            reason="view.create",
        )
        created_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view_id,
                "change_summary": "view created",
            },
        )
        self._plan_view_if_invalidated(session, view_id)
        return {"session_id": session.session_id, "view_id": view_id, "created_at": created_at}

    def _view_close(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        del session.views[view.view_id]
        session.frame_plans.pop(view.view_id, None)
        session.frame_plans_3d.pop(view.view_id, None)
        session.frame_plans_points.pop(view.view_id, None)
        closed_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": "view closed",
            },
        )
        return {"session_id": session.session_id, "view_id": view.view_id, "closed_at": closed_at}

    def _view_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        return {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "axis_order": list(view.axis_order),
            "axis_indices": dict(view.axis_indices),
            "channel_order": list(view.channel_order),
            "bound_layer_ids": list(view.bound_layer_ids),
        }

    def _view_bind_layer(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        layer = self._require_layer(session, params["layer_id"])
        candidate_dataset = self._layer_dataset(session, layer)
        if candidate_dataset is not None:
            for layer_id in view.bound_layer_ids:
                existing_layer = self._require_layer(session, layer_id)
                existing_dataset = self._layer_dataset(session, existing_layer)
                if existing_dataset is None:
                    continue
                if not self._datasets_compatible(existing_dataset, candidate_dataset):
                    raise conflict(
                        "Layer dataset is incompatible with this view",
                        {
                            "view_id": view.view_id,
                            "layer_id": layer.layer_id,
                            "existing_layer_id": existing_layer.layer_id,
                        },
                    )
        if layer.layer_id not in view.bound_layer_ids:
            view.bound_layer_ids.append(layer.layer_id)
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.FULL,
            reason="view.bind_layer",
        )
        bound_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": "layer bound to view",
            },
        )
        out = {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "layer_id": layer.layer_id,
            "bound_at": bound_at,
        }
        self._plan_view_if_invalidated(session, view.view_id)
        return out

    def _view_unbind_layer(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        self._require_layer(session, params["layer_id"])
        if params["layer_id"] not in view.bound_layer_ids:
            raise not_found(
                "Layer is not bound to this view",
                {"view_id": view.view_id, "layer_id": params["layer_id"]},
            )
        view.bound_layer_ids = [layer_id for layer_id in view.bound_layer_ids if layer_id != params["layer_id"]]
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.FULL,
            reason="view.unbind_layer",
        )
        unbound_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": "layer unbound from view",
            },
        )
        out = {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "layer_id": params["layer_id"],
            "unbound_at": unbound_at,
        }
        self._plan_view_if_invalidated(session, view.view_id)
        return out

    def _view_set_axis_index(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        axis_index = params.get("axis_index")
        if not isinstance(axis_index, dict):
            raise invalid_params("axis_index must be an object", {})
        axis = axis_index.get("axis")
        index = axis_index.get("index")
        if not isinstance(axis, str) or not isinstance(index, int):
            raise invalid_params("axis_index.axis and axis_index.index are required", {})
        if axis not in view.axis_order:
            raise invalid_params("axis is not in current view axis order", {"axis": axis})
        if index < 0:
            raise invalid_params("axis index must be non-negative", {"axis": axis, "index": index})
        for layer_id in view.bound_layer_ids:
            layer = self._require_layer(session, layer_id)
            dataset = self._layer_dataset(session, layer)
            if dataset is None:
                continue
            axis_size = self._dataset_axis_size(dataset, axis)
            if axis_size is not None and index >= axis_size:
                raise invalid_params(
                    "axis index exceeds dataset bounds",
                    {"axis": axis, "index": index, "max_index": axis_size - 1},
                )
        view.axis_indices[axis] = index
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.SLICE,
            reason="view.set_axis_index",
        )
        updated_at = self._clock()
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": f"axis {axis} index set to {index}",
            },
        )
        out = {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "axis_index": {"axis": axis, "index": index},
            "updated_at": updated_at,
        }
        self._plan_view_if_invalidated(session, view.view_id)
        return out

    def _view_reorder_axes(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        order = params.get("order")
        if not isinstance(order, list) or not all(isinstance(axis, str) for axis in order):
            raise invalid_params("order must be an array of axis labels", {})
        if len(order) != len(view.axis_order) or sorted(order) != sorted(view.axis_order):
            raise invalid_params("order must be a permutation of current axes", {"current": view.axis_order, "requested": order})
        view.axis_order = list(order)
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.FULL,
            reason="view.reorder_axes",
        )
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": "view axis order updated",
            },
        )
        out = {"session_id": session.session_id, "view_id": view.view_id, "order": list(view.axis_order)}
        self._plan_view_if_invalidated(session, view.view_id)
        return out

    def _view_set_channel_order(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        channel_order = params.get("channel_order")
        if not isinstance(channel_order, list) or not all(isinstance(idx, int) for idx in channel_order):
            raise invalid_params("channel_order must be an array of integers", {})
        if len(set(channel_order)) != len(channel_order):
            raise invalid_params("channel_order must be unique", {})
        if any(idx < 0 for idx in channel_order):
            raise invalid_params("channel_order cannot contain negative indexes", {})
        max_channel = None
        for layer_id in view.bound_layer_ids:
            layer = self._require_layer(session, layer_id)
            dataset = self._layer_dataset(session, layer)
            if dataset is None:
                continue
            channel_size = self._dataset_axis_size(dataset, "c")
            if channel_size is not None:
                max_channel = channel_size if max_channel is None else min(max_channel, channel_size)
        if max_channel is not None and any(idx >= max_channel for idx in channel_order):
            raise invalid_params("channel_order exceeds channel bounds", {"max_channels": max_channel})
        view.channel_order = list(channel_order)
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.SLICE,
            reason="view.set_channel_order",
        )
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": "view channel order updated",
            },
        )
        out = {"session_id": session.session_id, "view_id": view.view_id, "channel_order": list(view.channel_order)}
        self._plan_view_if_invalidated(session, view.view_id)
        return out

    def _camera_set_mode(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        mode = params.get("mode")
        if mode not in {"panzoom", "arcball", "freefly"}:
            raise invalid_params("mode must be one of panzoom, arcball, freefly", {"mode": mode})
        view.camera_mode = str(mode)
        if view.camera_mode == "panzoom":
            view.camera_pose = self._canonical_panzoom_pose(view.camera_pose, strict=False)
        else:
            view.camera_pose = self._canonical_3d_pose(view.camera_pose, mode=view.camera_mode, strict=False)
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.CAMERA,
            reason="camera.set_mode",
        )
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "camera",
                "object_id": view.view_id,
                "change_summary": f"camera mode set to {mode}",
            },
        )
        out = {"session_id": session.session_id, "view_id": view.view_id, "mode": view.camera_mode}
        self._plan_view_if_invalidated(session, view.view_id)
        return out

    def _camera_set_pose(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        pose = params.get("pose")
        if not isinstance(pose, dict):
            raise invalid_params("pose must be an object", {})
        if view.camera_mode == "panzoom":
            view.camera_pose = self._canonical_panzoom_pose(pose, strict=True)
        else:
            view.camera_pose = self._canonical_3d_pose(pose, mode=view.camera_mode, strict=True)
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.CAMERA,
            reason="camera.set_pose",
        )
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "camera",
                "object_id": view.view_id,
                "change_summary": "camera pose updated",
            },
        )
        out = {"session_id": session.session_id, "view_id": view.view_id, "pose": deepcopy(view.camera_pose)}
        self._plan_view_if_invalidated(session, view.view_id)
        return out

    def _camera_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        if view.camera_mode == "panzoom":
            view.camera_pose = self._canonical_panzoom_pose(view.camera_pose, strict=False)
        else:
            view.camera_pose = self._canonical_3d_pose(view.camera_pose, mode=view.camera_mode, strict=False)
        return {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "mode": view.camera_mode,
            "pose": deepcopy(view.camera_pose),
        }

    def _selection_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        if not isinstance(view.selection, dict) or not view.selection:
            view.selection = self._new_empty_selection_state()
        return {"session_id": session.session_id, "view_id": view.view_id, "selection": deepcopy(view.selection)}

    def _selection_set(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        selection = params.get("selection")
        if not isinstance(selection, dict):
            raise invalid_params("selection must be an object", {})

        previous_selection = view.selection if isinstance(view.selection, dict) else {}
        previous_version = previous_selection.get("selection_version")
        if not isinstance(previous_version, int) or previous_version < 0:
            previous_version = 0
        created_at = previous_selection.get("created_at") if isinstance(previous_selection.get("created_at"), str) else None

        canonical_selection = self._canonical_selection_state(
            session=session,
            view=view,
            selection=selection,
        )
        if "selection_version" not in selection:
            canonical_selection["selection_version"] = previous_version + 1
        if created_at is not None:
            canonical_selection["created_at"] = created_at

        layer_id = params.get("layer_id")
        if layer_id is not None:
            self._require_layer(session, layer_id)
        view.selection = deepcopy(canonical_selection)

        resolved = canonical_selection.get("resolved", {})
        resolved_count = resolved.get("count", 0) if isinstance(resolved, dict) else 0
        payload: dict[str, Any] = {
            "view_id": view.view_id,
            "selection_version": int(canonical_selection["selection_version"]),
            "query": deepcopy(canonical_selection.get("query", {})),
            "resolved_count": int(resolved_count) if isinstance(resolved_count, int) and resolved_count >= 0 else 0,
            "linked_image_context": self._selection_linked_image_context(
                view=view,
                selection_state=canonical_selection,
            ),
            "selection": deepcopy(canonical_selection),
        }
        selected_point_ids = resolved.get("selected_point_ids") if isinstance(resolved, dict) else None
        selected_point_ids_ref = resolved.get("selected_point_ids_ref") if isinstance(resolved, dict) else None
        if isinstance(selected_point_ids, list):
            payload["selected_point_ids"] = list(selected_point_ids[:POINT_SELECTION_INLINE_CAP])
        if isinstance(selected_point_ids_ref, dict):
            payload["selected_point_ids_ref"] = deepcopy(selected_point_ids_ref)
        if layer_id is not None:
            payload["layer_id"] = layer_id

        self._emit_event(
            session,
            "selection.changed",
            payload,
        )
        self._mark_view_invalidation(
            session,
            view_id=view.view_id,
            kind=InvalidationKind.STYLE,
            reason="selection.set",
        )
        self._plan_view_if_invalidated(session, view.view_id)
        return {"session_id": session.session_id, "view_id": view.view_id, "selection": deepcopy(view.selection)}

    def _job_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        job = session.jobs.get(params["job_id"])
        if job is None:
            raise not_found("Job does not exist", {"session_id": session.session_id, "job_id": params["job_id"]})
        if job.state in {"queued", "running"} and params["job_id"] in session.pending_job_ops:
            self._run_pending_job(session, params["job_id"])
            job = session.jobs[params["job_id"]]
        out: dict[str, Any] = {
            "session_id": session.session_id,
            "job_id": job.job_id,
            "state": job.state,
            "submitted_at": job.submitted_at,
        }
        if job.started_at:
            out["started_at"] = job.started_at
        if job.completed_at:
            out["completed_at"] = job.completed_at
        if job.error:
            out["error"] = deepcopy(job.error)
        return out

    def _job_cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        job = session.jobs.get(params["job_id"])
        if job is None:
            raise not_found("Job does not exist", {"session_id": session.session_id, "job_id": params["job_id"]})
        if job.state in {"completed", "failed", "cancelled"}:
            raise conflict("Completed jobs cannot be cancelled", {"job_id": job.job_id, "state": job.state})
        token = session.job_cancel_tokens.get(job.job_id)
        if token is not None:
            token.cancel()
        session.pending_job_ops.pop(job.job_id, None)
        session.job_cancel_tokens.pop(job.job_id, None)
        job.state = "cancelled"
        if job.completed_at is None:
            job.completed_at = self._clock()
        self._emit_event(session, "job.lifecycle", {"job_id": job.job_id, "state": "cancelled"})
        return {"session_id": session.session_id, "job_id": job.job_id, "state": "cancelled"}

    def _job_list(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        state_filter = params.get("state")
        for job_id in sorted(session.pending_job_ops):
            job_state = session.jobs.get(job_id)
            if job_state is not None and job_state.state in {"queued", "running"}:
                self._run_pending_job(session, job_id)
        jobs = []
        for job_id in sorted(session.jobs):
            job = session.jobs[job_id]
            if state_filter and job.state != state_filter:
                continue
            jobs.append(
                {
                    "job_id": job.job_id,
                    "state": job.state,
                    "submitted_at": job.submitted_at,
                }
            )
        return {"session_id": session.session_id, "jobs": jobs}

    def _events_subscribe(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        topics = params.get("topics")
        if not isinstance(topics, list) or not topics:
            raise invalid_params("topics must be a non-empty array", {})
        if not all(isinstance(topic, str) for topic in topics):
            raise invalid_params("topics values must be strings", {})
        subscription_id = self._uuid()
        transport_uri = f"memory://{session.session_id}/{subscription_id}"
        subscription = SubscriptionState(
            subscription_id=subscription_id,
            topics=list(topics),
            transport_uri=transport_uri,
        )
        session.subscriptions[subscription_id] = subscription
        return {
            "session_id": session.session_id,
            "subscription_id": subscription_id,
            "topics": list(topics),
            "transport_uri": transport_uri,
        }

    def _command_log_records_for_export(self, session: SessionState) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        seq = 1
        for entry in session.command_journal:
            command_record = build_command_record(
                seq=seq,
                recorded_at=str(entry["recorded_at"]),
                correlation_id=str(entry["correlation_id"]),
                method=str(entry["method"]),
                request=deepcopy(entry["request"]),
            )
            records.append(command_record)
            seq += 1

            raw_events = entry.get("events", [])
            if isinstance(raw_events, list):
                for event in raw_events:
                    if not isinstance(event, dict):
                        continue
                    event_record = build_event_record(
                        seq=seq,
                        recorded_at=str(event.get("emitted_at", entry["recorded_at"])),
                        correlation_id=str(entry["correlation_id"]),
                        event=deepcopy(event),
                    )
                    records.append(event_record)
                    seq += 1
        return records

    def _deepcopy_or_identity(self, value: Any) -> Any:
        try:
            return deepcopy(value)
        except Exception:  # pragma: no cover - defensive fallback
            return value

    def _clone_for_replay(self) -> NDStateEngine:
        clone = NDStateEngine(
            clock=self._deepcopy_or_identity(self._clock),
            uuid_factory=self._deepcopy_or_identity(self._uuid),
            cache_manager=self._deepcopy_or_identity(self._cache),
            io_scheduler=self._deepcopy_or_identity(self._scheduler),
        )
        clone._state = deepcopy(self._state)
        clone._command_log_store = self._command_log_store
        return clone

    def _load_and_validate_log_records(self, source_uri: str) -> list[dict[str, Any]]:
        try:
            raw_records = self._command_log_store.read_records(uri=source_uri)
        except CommandLogStorageError as exc:
            message = str(exc)
            if "Unsupported command log URI scheme" in message:
                raise unsupported(
                    "Command log URI scheme is unsupported",
                    {"source_uri": source_uri, "error": message},
                ) from exc
            if "does not exist" in message:
                raise not_found("Command log source does not exist", {"source_uri": source_uri, "error": message}) from exc
            raise io_failure(
                "Command log source_uri is unavailable",
                {"source_uri": source_uri, "error": message},
                retryable=False,
            ) from exc
        except CommandLogValidationError as exc:
            raise invalid_params("Command log validation failed", {"source_uri": source_uri, "error": str(exc)}) from exc
        try:
            return validate_records(raw_records, protocol_version=ProtocolVersion)
        except CommandLogValidationError as exc:
            message = str(exc)
            if "Unsupported command protocol_version" in message or "Unsupported event protocol_version" in message:
                raise version_mismatch(
                    "Command log protocol version is incompatible",
                    {"source_uri": source_uri, "error": message, "supported": ProtocolVersion},
                ) from exc
            raise invalid_params("Command log validation failed", {"source_uri": source_uri, "error": message}) from exc

    def _validate_replay_target(self, *, records: list[dict[str, Any]], session_id: str) -> None:
        for record in records:
            if record["kind"] != "command":
                continue
            method = str(record["method"])
            if method in COMMAND_LOG_METHODS:
                raise invalid_params("Replay logs must not contain command_log.* methods", {"method": method})
            request = record["request"]
            params = request["params"]
            command_session_id = params.get("session_id")
            if not isinstance(command_session_id, str):
                raise invalid_params(
                    "Replay command records must include request.params.session_id",
                    {"method": method},
                )
            if command_session_id != session_id:
                raise conflict(
                    "Replay command targets a different session_id",
                    {
                        "method": method,
                        "command_session_id": command_session_id,
                        "target_session_id": session_id,
                    },
                )

    def _replay_command_stream(
        self,
        *,
        session: SessionState,
        replay_id: str,
        source_uri: str,
        dry_run: bool,
    ) -> None:
        applied_commands = 0
        total_commands = 0
        self._emit_event(
            session,
            "command_log.replay",
            {
                "replay_id": replay_id,
                "state": "started",
                "applied_commands": applied_commands,
                "total_commands": total_commands,
            },
        )

        try:
            records = self._load_and_validate_log_records(source_uri)
            self._validate_replay_target(records=records, session_id=session.session_id)
            try:
                steps = group_replay_steps(records)
            except CommandLogValidationError as exc:
                raise invalid_params(
                    "Replay command/event grouping failed",
                    {"source_uri": source_uri, "error": str(exc)},
                ) from exc
            total_commands = len(steps)
            target_engine = self._clone_for_replay() if dry_run else self
            target_session = target_engine._require_session(session.session_id)

            for step in steps:
                command = step.command
                request = command["request"]
                replay_params = deepcopy(request["params"])
                replay_params["protocol_version"] = request["protocol_version"]
                replay_params["request_id"] = request["request_id"]
                idempotency_key = request.get("idempotency_key")
                if isinstance(idempotency_key, str):
                    replay_params["idempotency_key"] = idempotency_key

                baseline_events = len(target_session.outbox)
                method = str(command["method"])
                target_engine.dispatch(method, replay_params)

                emitted = target_session.outbox[baseline_events:]
                expected = [canonicalize_logged_event(record) for record in step.expected_events]
                actual = [canonicalize_runtime_event(event) for event in emitted]
                if expected != actual:
                    raise conflict(
                        "Replay determinism validation failed",
                        {
                            "replay_id": replay_id,
                            "method": method,
                            "expected_events": expected,
                            "actual_events": actual,
                        },
                    )

                applied_commands += 1
                self._emit_event(
                    session,
                    "command_log.replay",
                    {
                        "replay_id": replay_id,
                        "state": "progress",
                        "applied_commands": applied_commands,
                        "total_commands": total_commands,
                    },
                )

            self._emit_event(
                session,
                "command_log.replay",
                {
                    "replay_id": replay_id,
                    "state": "completed",
                    "applied_commands": applied_commands,
                    "total_commands": total_commands,
                },
            )
        except LucidaError:
            self._emit_event(
                session,
                "command_log.replay",
                {
                    "replay_id": replay_id,
                    "state": "failed",
                    "applied_commands": applied_commands,
                    "total_commands": total_commands,
                },
            )
            raise
        except Exception as exc:  # pragma: no cover - defensive fallback
            self._emit_event(
                session,
                "command_log.replay",
                {
                    "replay_id": replay_id,
                    "state": "failed",
                    "applied_commands": applied_commands,
                    "total_commands": total_commands,
                },
            )
            raise internal(
                "Replay operation failed",
                {"replay_id": replay_id, "source_uri": source_uri, "error": str(exc)},
            ) from exc

    def _command_log_export(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        destination_uri = params.get("destination_uri")
        if not isinstance(destination_uri, str) or not destination_uri:
            raise invalid_params("destination_uri must be a non-empty string", {"destination_uri": destination_uri})
        records = self._command_log_records_for_export(session)
        try:
            record_count = self._command_log_store.write_records(uri=destination_uri, records=records)
        except CommandLogStorageError as exc:
            message = str(exc)
            if "Unsupported command log URI scheme" in message:
                raise unsupported(
                    "Command log URI scheme is unsupported",
                    {"destination_uri": destination_uri, "error": message},
                ) from exc
            raise io_failure(
                "Failed to write command log destination",
                {"destination_uri": destination_uri, "error": message},
                retryable=False,
            ) from exc
        return {
            "session_id": session.session_id,
            "destination_uri": destination_uri,
            "record_count": record_count,
        }

    def _command_log_import(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        source_uri = params.get("source_uri")
        if not isinstance(source_uri, str) or not source_uri:
            raise invalid_params("source_uri must be a non-empty string", {"source_uri": source_uri})

        import_id = self._uuid()
        job_id = self._uuid()
        accepted = self._job_accept(session, job_id)

        def operation() -> dict[str, Any]:
            records = self._load_and_validate_log_records(source_uri)
            command_count = sum(1 for record in records if record["kind"] == "command")
            event_count = sum(1 for record in records if record["kind"] == "event")
            session.imported_logs[import_id] = {
                "source_uri": source_uri,
                "record_count": len(records),
                "command_count": command_count,
                "event_count": event_count,
                "imported_at": self._clock(),
                "records": deepcopy(records),
            }
            return {"session_id": session.session_id, "import_id": import_id}

        session.pending_job_ops[job_id] = operation
        return {"session_id": session.session_id, "import_id": import_id, "job": accepted}

    def _command_log_replay(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        source_uri = params.get("source_uri")
        if not isinstance(source_uri, str) or not source_uri:
            raise invalid_params("source_uri must be a non-empty string", {"source_uri": source_uri})
        dry_run = params.get("dry_run")
        if not isinstance(dry_run, bool):
            raise invalid_params("dry_run must be boolean", {"dry_run": dry_run})

        replay_id = self._uuid()
        job_id = self._uuid()
        accepted = self._job_accept(session, job_id)

        def operation() -> dict[str, Any]:
            self._replay_command_stream(
                session=session,
                replay_id=replay_id,
                source_uri=source_uri,
                dry_run=dry_run,
            )
            return {"session_id": session.session_id, "replay_id": replay_id}

        session.pending_job_ops[job_id] = operation
        return {"session_id": session.session_id, "replay_id": replay_id, "job": accepted}
