"""Event subscription queues with topic filtering and bounded backpressure behavior."""

from __future__ import annotations

from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from lucida_core.errors import busy, conflict, invalid_params, not_found


@dataclass
class BufferedSubscription:
    session_id: str
    subscription_id: str
    connection_id: str
    topics: set[str]
    queue: deque[dict[str, Any]] = field(default_factory=deque)
    active: bool = True
    disconnect_reason: str | None = None


class EventPublisher:
    """Publishes session events into per-subscription bounded queues."""

    def __init__(self, *, queue_capacity: int) -> None:
        if queue_capacity <= 0:
            raise invalid_params("queue_capacity must be a positive integer", {"queue_capacity": queue_capacity})
        self._queue_capacity = queue_capacity
        self._subscriptions: dict[tuple[str, str], BufferedSubscription] = {}
        self._session_index: dict[str, set[tuple[str, str]]] = {}
        self._connection_index: dict[str, set[tuple[str, str]]] = {}

    def add_subscription(
        self,
        *,
        session_id: str,
        subscription_id: str,
        connection_id: str,
        topics: list[str],
    ) -> None:
        key = (session_id, subscription_id)
        if key in self._subscriptions:
            raise conflict(
                "Event subscription already exists",
                {"session_id": session_id, "subscription_id": subscription_id},
            )
        sub = BufferedSubscription(
            session_id=session_id,
            subscription_id=subscription_id,
            connection_id=connection_id,
            topics=set(topics),
        )
        self._subscriptions[key] = sub
        self._session_index.setdefault(session_id, set()).add(key)
        self._connection_index.setdefault(connection_id, set()).add(key)

    def drop_connection(self, connection_id: str) -> None:
        keys = list(self._connection_index.pop(connection_id, set()))
        for key in keys:
            self._drop_key(key)

    def drop_session(self, session_id: str) -> None:
        keys = list(self._session_index.pop(session_id, set()))
        for key in keys:
            self._drop_key(key)

    def _drop_key(self, key: tuple[str, str]) -> None:
        sub = self._subscriptions.pop(key, None)
        if sub is None:
            return
        session_keys = self._session_index.get(sub.session_id)
        if session_keys is not None:
            session_keys.discard(key)
            if not session_keys:
                self._session_index.pop(sub.session_id, None)
        conn_keys = self._connection_index.get(sub.connection_id)
        if conn_keys is not None:
            conn_keys.discard(key)
            if not conn_keys:
                self._connection_index.pop(sub.connection_id, None)

    def publish(self, *, session_id: str, events: list[dict[str, Any]]) -> None:
        keys = list(self._session_index.get(session_id, set()))
        if not keys or not events:
            return
        for event in events:
            event_type = event.get("event_type")
            if not isinstance(event_type, str):
                continue
            for key in keys:
                sub = self._subscriptions.get(key)
                if sub is None or not sub.active:
                    continue
                if event_type not in sub.topics and "*" not in sub.topics:
                    continue
                if len(sub.queue) >= self._queue_capacity:
                    sub.active = False
                    sub.disconnect_reason = "queue_overflow"
                    sub.queue.clear()
                    continue
                sub.queue.append(deepcopy(event))

    def poll(
        self,
        *,
        connection_id: str,
        session_id: str,
        subscription_id: str,
        limit: int = 256,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            raise invalid_params("limit must be a positive integer", {"limit": limit})
        key = (session_id, subscription_id)
        sub = self._subscriptions.get(key)
        if sub is None or sub.connection_id != connection_id:
            raise not_found(
                "Event subscription does not exist",
                {"session_id": session_id, "subscription_id": subscription_id},
            )
        if not sub.active:
            raise busy(
                "Event subscription disconnected due to backpressure",
                {
                    "session_id": session_id,
                    "subscription_id": subscription_id,
                    "reason": sub.disconnect_reason or "disconnected",
                },
            )
        out: list[dict[str, Any]] = []
        while sub.queue and len(out) < limit:
            out.append(sub.queue.popleft())
        return out

    def is_active(self, *, session_id: str, subscription_id: str) -> bool:
        sub = self._subscriptions.get((session_id, subscription_id))
        return bool(sub and sub.active)
