"""Step 08 Python SDK client surface."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import time
from typing import Any

from lucida_core.errors import LucidaError as CoreLucidaError
from lucida_daemon import LucidaDaemon

from .events import EventSubscription
from .errors import InvalidParams, LucidaSdkError, Timeout, from_core_error
from .ids import make_idempotency_key, uuid7_str
from .registry import get_local_daemon, launch_or_get_local_daemon, shutdown_local_daemon as shutdown_in_registry
from .transport import InProcessDaemonTransport, LucidaTransport


DEFAULT_PROTOCOL_VERSION = "1.0.0"
DEFAULT_SUPPORTED_VERSIONS = {"min_version": "1.0.0", "max_version": "1.0.0"}
DEFAULT_CLIENT_NAME = "lucida-sdk"
DEFAULT_CLIENT_VERSION = "0.1.0"

RPC_METHODS: tuple[str, ...] = (
    "system.hello",
    "system.capabilities.get",
    "session.create",
    "session.close",
    "session.get",
    "dataset.open",
    "dataset.close",
    "dataset.get",
    "dataset.export",
    "layer.add_image",
    "layer.add_points",
    "layer.update",
    "layer.remove",
    "layer.get",
    "view.create",
    "view.close",
    "view.get",
    "view.bind_layer",
    "view.unbind_layer",
    "view.set_axis_index",
    "view.reorder_axes",
    "view.set_channel_order",
    "camera.set_mode",
    "camera.set_pose",
    "camera.get",
    "selection.get",
    "selection.set",
    "job.get",
    "job.cancel",
    "job.list",
    "events.subscribe",
    "command_log.export",
    "command_log.import",
    "command_log.replay",
)

MUTATING_METHODS: set[str] = {
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

SDK_ALIAS_METHODS: dict[str, str] = {
    "create_session": "session_create",
    "open_dataset": "dataset_open",
    "export_dataset": "dataset_export",
    "add_image_layer": "layer_add_image",
    "add_points_layer": "layer_add_points",
    "create_view": "view_create",
    "close_view": "view_close",
    "bind_layer_to_view": "view_bind_layer",
    "unbind_layer_from_view": "view_unbind_layer",
    "set_axis_index": "view_set_axis_index",
    "reorder_axes": "view_reorder_axes",
    "set_channel_order": "view_set_channel_order",
    "set_camera_mode": "camera_set_mode",
    "set_camera_pose": "camera_set_pose",
    "export_command_log": "command_log_export",
    "import_command_log": "command_log_import",
    "replay_command_log": "command_log_replay",
}


class LucidaClient:
    """Synchronous SDK client with typed error mapping and helper utilities."""

    def __init__(
        self,
        *,
        transport: LucidaTransport,
        protocol_version: str = DEFAULT_PROTOCOL_VERSION,
        client_name: str = DEFAULT_CLIENT_NAME,
        client_version: str = DEFAULT_CLIENT_VERSION,
    ) -> None:
        self._transport = transport
        self._protocol_version = protocol_version
        self._client_name = client_name
        self._client_version = client_version
        self._hello_response: dict[str, Any] | None = None
        self._capabilities_response: dict[str, Any] | None = None

    @property
    def protocol_version(self) -> str:
        return self._protocol_version

    @property
    def hello_response(self) -> dict[str, Any] | None:
        if self._hello_response is None:
            return None
        return dict(self._hello_response)

    @property
    def capabilities_response(self) -> dict[str, Any] | None:
        if self._capabilities_response is None:
            return None
        return dict(self._capabilities_response)

    def __enter__(self) -> LucidaClient:
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> bool:
        self.close()
        return False

    def close(self) -> None:
        self._transport.close()

    def dispatch(self, method: str, **params: Any) -> dict[str, Any]:
        return self._call(method, params)

    def poll_events(
        self,
        *,
        session_id: str,
        subscription_id: str,
        limit: int = 256,
    ) -> list[dict[str, Any]]:
        try:
            return self._transport.poll_events(
                session_id=session_id,
                subscription_id=subscription_id,
                limit=limit,
            )
        except CoreLucidaError as exc:
            raise from_core_error(exc) from exc

    def subscribe_events(
        self,
        *,
        session_id: str,
        topics: list[str],
    ) -> EventSubscription:
        response = self.events_subscribe(session_id=session_id, topics=topics)
        resolved_session = str(response["session_id"])
        resolved_subscription = str(response["subscription_id"])
        resolved_topics = [str(topic) for topic in response.get("topics", [])]
        transport_uri = str(response["transport_uri"])
        return EventSubscription(
            session_id=resolved_session,
            subscription_id=resolved_subscription,
            topics=resolved_topics,
            transport_uri=transport_uri,
            _poll_events_fn=self._poll_events_for_subscription,
        )

    @contextmanager
    def session_scope(
        self,
        *,
        label: str | None = None,
        preferred_view: str | None = None,
        idempotency_key: str | None = None,
    ) -> Iterator[str]:
        params: dict[str, Any] = {}
        if label is not None:
            params["label"] = label
        if preferred_view is not None:
            params["preferred_view"] = preferred_view
        if idempotency_key is not None:
            params["idempotency_key"] = idempotency_key

        session = self.session_create(**params)
        session_id = str(session["session_id"])
        try:
            yield session_id
        finally:
            try:
                self.session_close(session_id=session_id)
            except LucidaSdkError as exc:
                if exc.code not in {"LUCIDA_CONFLICT", "LUCIDA_NOT_FOUND"}:
                    raise

    def wait_for_job(
        self,
        *,
        session_id: str,
        job_id: str,
        timeout_s: float = 30.0,
        poll_interval_s: float = 0.05,
    ) -> dict[str, Any]:
        if timeout_s <= 0:
            raise InvalidParams("timeout_s must be positive", {"timeout_s": timeout_s})
        if poll_interval_s <= 0:
            raise InvalidParams(
                "poll_interval_s must be positive",
                {"poll_interval_s": poll_interval_s},
            )

        deadline = time.monotonic() + timeout_s
        while True:
            job = self.job_get(session_id=session_id, job_id=job_id)
            state = job.get("state")
            if state in {"completed", "failed", "cancelled"}:
                return job
            if time.monotonic() >= deadline:
                raise Timeout(
                    "Job did not reach a terminal state before timeout",
                    {"session_id": session_id, "job_id": job_id, "timeout_s": timeout_s},
                )
            time.sleep(poll_interval_s)

    def _poll_events_for_subscription(
        self,
        session_id: str,
        subscription_id: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        return self.poll_events(session_id=session_id, subscription_id=subscription_id, limit=limit)

    def _call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        payload = self._prepare_params(method, params)
        try:
            return self._transport.dispatch(method, payload)
        except CoreLucidaError as exc:
            raise from_core_error(exc) from exc

    def _prepare_params(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        payload = dict(params)
        payload.setdefault("protocol_version", self._protocol_version)
        payload.setdefault("request_id", uuid7_str())
        if method in MUTATING_METHODS and "idempotency_key" not in payload:
            payload["idempotency_key"] = make_idempotency_key()
        return payload

    def _perform_auto_hello(
        self,
        *,
        supported_versions: dict[str, str],
        transport: str,
    ) -> None:
        self._hello_response = self.system_hello(
            client_name=self._client_name,
            client_version=self._client_version,
            supported_versions=supported_versions,
            transport=transport,
        )
        self._capabilities_response = self.system_capabilities_get()


def _validate_supported_versions(supported_versions: dict[str, str] | None) -> dict[str, str]:
    candidate = supported_versions or DEFAULT_SUPPORTED_VERSIONS
    min_version = candidate.get("min_version")
    max_version = candidate.get("max_version")
    if not isinstance(min_version, str) or not min_version:
        raise InvalidParams(
            "supported_versions.min_version must be a non-empty string",
            {"supported_versions": candidate},
        )
    if not isinstance(max_version, str) or not max_version:
        raise InvalidParams(
            "supported_versions.max_version must be a non-empty string",
            {"supported_versions": candidate},
        )
    return {"min_version": min_version, "max_version": max_version}


def connect(
    *,
    local_ipc_uri: str | None = None,
    daemon: LucidaDaemon | None = None,
    transport: LucidaTransport | None = None,
    protocol_version: str = DEFAULT_PROTOCOL_VERSION,
    client_name: str = DEFAULT_CLIENT_NAME,
    client_version: str = DEFAULT_CLIENT_VERSION,
    supported_versions: dict[str, str] | None = None,
    hello_transport: str = "ipc",
) -> LucidaClient:
    if daemon is not None and transport is not None:
        raise InvalidParams(
            "connect accepts either daemon or transport, not both",
            {"daemon_provided": True, "transport_provided": True},
        )
    if transport is not None and local_ipc_uri is not None:
        raise InvalidParams(
            "connect cannot use local_ipc_uri when transport is provided directly",
            {"local_ipc_uri": local_ipc_uri},
        )
    if daemon is not None and local_ipc_uri is not None:
        raise InvalidParams(
            "connect cannot use local_ipc_uri when daemon is provided directly",
            {"local_ipc_uri": local_ipc_uri},
        )

    resolved_versions = _validate_supported_versions(supported_versions)

    try:
        if transport is not None:
            resolved_transport = transport
        elif daemon is not None:
            resolved_transport = InProcessDaemonTransport(daemon=daemon)
        else:
            resolved_transport = InProcessDaemonTransport(
                daemon=get_local_daemon(local_ipc_uri=local_ipc_uri),
            )
    except CoreLucidaError as exc:
        raise from_core_error(exc) from exc

    client = LucidaClient(
        transport=resolved_transport,
        protocol_version=protocol_version,
        client_name=client_name,
        client_version=client_version,
    )
    client._perform_auto_hello(
        supported_versions=resolved_versions,
        transport=hello_transport,
    )
    return client


def launch_or_connect(
    *,
    local_ipc_uri: str | None = None,
    protocol_version: str = DEFAULT_PROTOCOL_VERSION,
    client_name: str = DEFAULT_CLIENT_NAME,
    client_version: str = DEFAULT_CLIENT_VERSION,
    supported_versions: dict[str, str] | None = None,
    hello_transport: str = "ipc",
) -> LucidaClient:
    try:
        daemon, _created = launch_or_get_local_daemon(local_ipc_uri=local_ipc_uri)
    except CoreLucidaError as exc:
        raise from_core_error(exc) from exc

    return connect(
        daemon=daemon,
        protocol_version=protocol_version,
        client_name=client_name,
        client_version=client_version,
        supported_versions=supported_versions,
        hello_transport=hello_transport,
    )


def shutdown_local_daemon(*, local_ipc_uri: str | None = None) -> bool:
    return shutdown_in_registry(local_ipc_uri=local_ipc_uri)


def _build_rpc_method(method_name: str):
    method_attr = method_name.replace(".", "_")

    def _rpc(self: LucidaClient, **params: Any) -> dict[str, Any]:
        return self._call(method_name, params)

    _rpc.__name__ = method_attr
    _rpc.__qualname__ = f"LucidaClient.{method_attr}"
    _rpc.__doc__ = f"Protocol method wrapper for `{method_name}`."
    return _rpc


def _build_alias_method(alias_name: str, target_attr: str):
    def _alias(self: LucidaClient, **params: Any) -> dict[str, Any]:
        target = getattr(self, target_attr)
        return target(**params)

    _alias.__name__ = alias_name
    _alias.__qualname__ = f"LucidaClient.{alias_name}"
    _alias.__doc__ = f"Alias for `{target_attr}`."
    return _alias


for _rpc_method in RPC_METHODS:
    _rpc_attr = _rpc_method.replace(".", "_")
    setattr(LucidaClient, _rpc_attr, _build_rpc_method(_rpc_method))

for _alias_name, _target_attr in SDK_ALIAS_METHODS.items():
    setattr(LucidaClient, _alias_name, _build_alias_method(_alias_name, _target_attr))


__all__ = [
    "DEFAULT_CLIENT_NAME",
    "DEFAULT_CLIENT_VERSION",
    "DEFAULT_PROTOCOL_VERSION",
    "DEFAULT_SUPPORTED_VERSIONS",
    "LucidaClient",
    "MUTATING_METHODS",
    "RPC_METHODS",
    "connect",
    "launch_or_connect",
    "shutdown_local_daemon",
]

