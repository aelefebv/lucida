"""Step 07 daemon runtime integrating connection/session/event orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import uuid
from typing import Any, Callable

from lucida_core import NDStateEngine
from lucida_core.engine import MUTATING_METHODS
from lucida_core.errors import LucidaError, conflict, invalid_params, not_found, unsupported

from .config import DaemonConfig
from .connection import ConnectionState
from .events import EventPublisher
from .ipc import LocalIpcAdapter
from .router import SessionRouter


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _uuid_v7() -> str:
    return str(uuid.uuid7())


@dataclass(frozen=True)
class SessionOwner:
    connection_id: str
    client_name: str | None
    client_version: str | None
    recorded_at: str


class LucidaDaemon:
    """Connection-aware daemon wrapper around the deterministic core engine."""

    def __init__(
        self,
        *,
        engine: NDStateEngine | None = None,
        config: DaemonConfig | None = None,
        clock: Callable[[], datetime] | None = None,
        uuid_factory: Callable[[], str] | None = None,
    ) -> None:
        self._engine = engine or NDStateEngine()
        self._config = config or DaemonConfig()
        self._clock = clock or _utc_now
        self._uuid = uuid_factory or _uuid_v7
        self._router = SessionRouter()
        self._events = EventPublisher(queue_capacity=self._config.event_queue_capacity)
        self._ipc = LocalIpcAdapter(local_ipc_uri=self._config.local_ipc_uri)
        self._connections: dict[str, ConnectionState] = {}
        self._session_event_offsets: dict[str, int] = {}
        self._session_closed_at: dict[str, datetime] = {}
        self._session_owners: dict[str, SessionOwner] = {}

    def start(self) -> dict[str, str]:
        self._config.validate()
        if self._config.remote_bind.enabled:
            raise unsupported(
                "Remote listener startup is not implemented in lucida-daemon; use lucida_gateway for Step 11 remote access",
                {"step": "step-11", "transport": self._config.remote_bind.transport},
            )
        return self._ipc.start()

    def stop(self) -> None:
        self._ipc.stop()
        self._connections.clear()
        self._session_event_offsets.clear()
        self._session_closed_at.clear()
        self._session_owners.clear()

    def connect(self, *, connection_id: str | None = None) -> str:
        self._ipc.ensure_started()
        resolved = connection_id or self._uuid()
        if resolved in self._connections:
            raise conflict("Connection already exists", {"connection_id": resolved})
        self._connections[resolved] = ConnectionState(
            connection_id=resolved,
            connected_at=self._clock(),
        )
        return resolved

    def disconnect(self, connection_id: str) -> None:
        self._ipc.ensure_started()
        if connection_id not in self._connections:
            raise not_found("Connection does not exist", {"connection_id": connection_id})
        self._connections.pop(connection_id, None)
        self._events.drop_connection(connection_id)

    def session_owner(self, session_id: str) -> dict[str, str | None] | None:
        owner = self._session_owners.get(session_id)
        if owner is None:
            return None
        return {
            "connection_id": owner.connection_id,
            "client_name": owner.client_name,
            "client_version": owner.client_version,
            "recorded_at": owner.recorded_at,
        }

    def snapshot(self) -> dict[str, Any]:
        return self._engine.snapshot()

    def frame_plan_for_view(self, *, session_id: str, view_id: str) -> dict[str, Any]:
        return self._engine.frame_plan_for_view(session_id, view_id)

    def dispatch(self, connection_id: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._ipc.ensure_started()
        self.run_retention_gc()
        conn = self._require_connection(connection_id)
        self._enforce_handshake(conn, method)
        session_id = params.get("session_id") if isinstance(params.get("session_id"), str) else None
        self._validate_closed_session_access(method=method, session_id=session_id)

        with self._router.route(method=method, session_id=session_id):
            result = self._engine.dispatch(method, params)

        if method == "system.hello":
            conn.record_hello(params=params, result=result)
            return result

        if method == "session.create":
            new_session_id = str(result["session_id"])
            self._record_session_owner(session_id=new_session_id, connection=conn)
            self._publish_session_events(new_session_id)
            return result

        if method == "events.subscribe":
            self._register_subscription(connection_id=connection_id, result=result)

        if session_id is not None:
            if method == "session.close":
                self._session_closed_at[session_id] = self._clock()
            self._publish_session_events(session_id)
        return result

    def poll_events(
        self,
        *,
        connection_id: str,
        session_id: str,
        subscription_id: str,
        limit: int = 256,
    ) -> list[dict[str, Any]]:
        self._ipc.ensure_started()
        self.run_retention_gc()
        self._require_connection(connection_id)
        return self._events.poll(
            connection_id=connection_id,
            session_id=session_id,
            subscription_id=subscription_id,
            limit=limit,
        )

    def run_retention_gc(self, *, now: datetime | None = None) -> list[str]:
        current = now or self._clock()
        retention = timedelta(seconds=self._config.closed_session_retention_seconds)
        dropped: list[str] = []
        for session_id, closed_at in list(self._session_closed_at.items()):
            if current - closed_at < retention:
                continue
            self._engine.drop_session(session_id)
            self._session_closed_at.pop(session_id, None)
            self._session_event_offsets.pop(session_id, None)
            self._session_owners.pop(session_id, None)
            self._events.drop_session(session_id)
            dropped.append(session_id)
        return sorted(dropped)

    def _require_connection(self, connection_id: str) -> ConnectionState:
        conn = self._connections.get(connection_id)
        if conn is None:
            raise not_found("Connection does not exist", {"connection_id": connection_id})
        return conn

    def _enforce_handshake(self, connection: ConnectionState, method: str) -> None:
        if method == "system.hello":
            return
        if connection.handshake_complete:
            return
        raise invalid_params(
            "system.hello must be the first command on a new connection",
            {"method": method, "connection_id": connection.connection_id},
        )

    def _validate_closed_session_access(self, *, method: str, session_id: str | None) -> None:
        if session_id is None:
            return
        state = self._engine.session_state(session_id)
        if state is None:
            return
        if state != "closed":
            return
        if method == "session.close":
            raise conflict("Session is already closed", {"session_id": session_id})
        if method in MUTATING_METHODS:
            raise conflict(
                "Session is closed and does not accept mutating commands",
                {"session_id": session_id, "method": method},
            )

    def _record_session_owner(self, *, session_id: str, connection: ConnectionState) -> None:
        self._session_owners[session_id] = SessionOwner(
            connection_id=connection.connection_id,
            client_name=connection.client_name,
            client_version=connection.client_version,
            recorded_at=self._clock().isoformat().replace("+00:00", "Z"),
        )

    def _publish_session_events(self, session_id: str) -> None:
        try:
            outbox = self._engine.events_for_session(session_id)
        except LucidaError as exc:
            if exc.code == "LUCIDA_NOT_FOUND":
                return
            raise
        offset = self._session_event_offsets.get(session_id, 0)
        if offset > len(outbox):
            offset = 0
        new_events = outbox[offset:]
        self._session_event_offsets[session_id] = len(outbox)
        if new_events:
            self._events.publish(session_id=session_id, events=new_events)

    def _register_subscription(self, *, connection_id: str, result: dict[str, Any]) -> None:
        session_id = result.get("session_id")
        subscription_id = result.get("subscription_id")
        topics = result.get("topics")
        if not isinstance(session_id, str):
            raise invalid_params("events.subscribe response missing session_id", {"result": result})
        if not isinstance(subscription_id, str):
            raise invalid_params(
                "events.subscribe response missing subscription_id",
                {"result": result},
            )
        if not isinstance(topics, list) or not all(isinstance(item, str) for item in topics):
            raise invalid_params("events.subscribe response missing topics", {"result": result})
        self._events.add_subscription(
            session_id=session_id,
            subscription_id=subscription_id,
            connection_id=connection_id,
            topics=topics,
        )
