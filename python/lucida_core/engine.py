"""Deterministic in-memory ND state engine with Step 3 IO extensions."""

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


ProtocolVersion = "1.0.0"


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
    outbox: list[dict[str, Any]] = field(default_factory=list)
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
                    "outbox": deepcopy(session.outbox),
                }
            )
        return {"sessions": sessions}

    def events_for_session(self, session_id: str) -> list[dict[str, Any]]:
        session = self._require_session(session_id)
        return deepcopy(session.outbox)

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
            "command_log_replay": False,
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
            selection={},
        )

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
        return {"session_id": session.session_id, "layer_id": layer_id, "job": accepted}

    def _layer_add_points(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        layer_id = self._uuid()
        layer = LayerState(
            layer_id=layer_id,
            layer_type="points",
            name=params.get("name"),
            visible=True,
            opacity=1.0,
            data_ref=params["data_ref"],
            attributes=deepcopy(params.get("attributes", {})),
        )
        session.layers[layer_id] = layer
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
        return {"session_id": session.session_id, "layer_id": layer_id, "job": accepted}

    def _layer_update(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        layer = self._require_layer(session, params["layer_id"])
        patch = params["patch"]
        if not isinstance(patch, dict):
            raise invalid_params("patch must be an object", {"layer_id": layer.layer_id})
        if "visible" in patch:
            if not isinstance(patch["visible"], bool):
                raise invalid_params("patch.visible must be boolean", {})
            layer.visible = patch["visible"]
        if "opacity" in patch:
            opacity = patch["opacity"]
            if not isinstance(opacity, (int, float)) or not (0 <= float(opacity) <= 1):
                raise invalid_params("patch.opacity must be between 0 and 1", {})
            layer.opacity = float(opacity)
        if "name" in patch:
            if not isinstance(patch["name"], str):
                raise invalid_params("patch.name must be string", {})
            layer.name = patch["name"]
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
        return {"layer_id": layer.layer_id, "updated_at": updated_at}

    def _layer_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        layer = self._require_layer(session, params["layer_id"])
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
        return {"session_id": session.session_id, "view_id": view_id, "created_at": created_at}

    def _view_close(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        del session.views[view.view_id]
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
        return {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "layer_id": layer.layer_id,
            "bound_at": bound_at,
        }

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
        return {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "layer_id": params["layer_id"],
            "unbound_at": unbound_at,
        }

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
        return {"session_id": session.session_id, "view_id": view.view_id, "axis_index": {"axis": axis, "index": index}, "updated_at": updated_at}

    def _view_reorder_axes(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        order = params.get("order")
        if not isinstance(order, list) or not all(isinstance(axis, str) for axis in order):
            raise invalid_params("order must be an array of axis labels", {})
        if len(order) != len(view.axis_order) or sorted(order) != sorted(view.axis_order):
            raise invalid_params("order must be a permutation of current axes", {"current": view.axis_order, "requested": order})
        view.axis_order = list(order)
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": "view axis order updated",
            },
        )
        return {"session_id": session.session_id, "view_id": view.view_id, "order": list(view.axis_order)}

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
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "view",
                "object_id": view.view_id,
                "change_summary": "view channel order updated",
            },
        )
        return {"session_id": session.session_id, "view_id": view.view_id, "channel_order": list(view.channel_order)}

    def _camera_set_mode(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        mode = params.get("mode")
        if mode not in {"panzoom", "arcball", "freefly"}:
            raise invalid_params("mode must be one of panzoom, arcball, freefly", {"mode": mode})
        view.camera_mode = str(mode)
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "camera",
                "object_id": view.view_id,
                "change_summary": f"camera mode set to {mode}",
            },
        )
        return {"session_id": session.session_id, "view_id": view.view_id, "mode": view.camera_mode}

    def _camera_set_pose(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        pose = params.get("pose")
        if not isinstance(pose, dict):
            raise invalid_params("pose must be an object", {})
        view.camera_pose = deepcopy(pose)
        self._emit_event(
            session,
            "state.changed",
            {
                "object_type": "camera",
                "object_id": view.view_id,
                "change_summary": "camera pose updated",
            },
        )
        return {"session_id": session.session_id, "view_id": view.view_id, "pose": deepcopy(view.camera_pose)}

    def _camera_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        return {
            "session_id": session.session_id,
            "view_id": view.view_id,
            "mode": view.camera_mode,
            "pose": deepcopy(view.camera_pose),
        }

    def _selection_get(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        return {"session_id": session.session_id, "view_id": view.view_id, "selection": deepcopy(view.selection)}

    def _selection_set(self, params: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(params["session_id"])
        view = self._require_view(session, params["view_id"])
        selection = params.get("selection")
        if not isinstance(selection, dict):
            raise invalid_params("selection must be an object", {})
        layer_id = params.get("layer_id")
        if layer_id is not None:
            self._require_layer(session, layer_id)
        view.selection = deepcopy(selection)
        self._emit_event(
            session,
            "selection.changed",
            {
                "layer_id": layer_id,
                "selection": deepcopy(selection),
            }
            if layer_id is not None
            else {"selection": deepcopy(selection)},
        )
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

    def _unsupported_command_log(self, params: dict[str, Any], method: str) -> dict[str, Any]:
        self._require_session(params["session_id"])
        raise unsupported(
            "Command log operations are not implemented in Step 2",
            {"method": method, "step": "step-09"},
        )

    def _command_log_export(self, params: dict[str, Any]) -> dict[str, Any]:
        return self._unsupported_command_log(params, "command_log.export")

    def _command_log_import(self, params: dict[str, Any]) -> dict[str, Any]:
        return self._unsupported_command_log(params, "command_log.import")

    def _command_log_replay(self, params: dict[str, Any]) -> dict[str, Any]:
        return self._unsupported_command_log(params, "command_log.replay")
