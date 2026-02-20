"""Gateway bridge between browser WS frames and daemon RPC/event channels."""

from __future__ import annotations

from dataclasses import dataclass
import threading
from typing import Any
from typing import Callable

from lucida_core.errors import LucidaError, conflict, invalid_params
from lucida_daemon import LucidaDaemon
from lucida_sdk.ids import uuid7_str


_PROTOCOL_VERSION = "1.0.0"
_SUPPORTED_VERSIONS = {"min_version": "1.0.0", "max_version": "1.0.0"}


@dataclass(frozen=True)
class AttachmentState:
    session_id: str
    view_id: str
    subscription_id: str


class GatewayBridge:
    """Owns daemon connection lifecycle, attach policy, and RPC relay safety checks."""

    def __init__(
        self,
        *,
        daemon: LucidaDaemon,
        uuid_factory: Callable[[], str] = uuid7_str,
    ) -> None:
        self._daemon = daemon
        self._uuid = uuid_factory
        self._controllers: dict[str, str] = {}
        self._attachments: dict[str, AttachmentState] = {}
        self._guard = threading.Lock()

    def connect(self) -> str:
        return self._daemon.connect()

    def disconnect(self, connection_id: str) -> None:
        with self._guard:
            attachment = self._attachments.pop(connection_id, None)
            if attachment is not None:
                holder = self._controllers.get(attachment.session_id)
                if holder == connection_id:
                    self._controllers.pop(attachment.session_id, None)
        try:
            self._daemon.disconnect(connection_id)
        except LucidaError as exc:
            if exc.code != "LUCIDA_NOT_FOUND":
                raise

    def attach(
        self,
        *,
        connection_id: str,
        session_id: str,
        view_id: str,
        client_name: str,
        client_version: str,
    ) -> AttachmentState:
        reserved_controller = False
        with self._guard:
            current = self._attachments.get(connection_id)
            if current is not None:
                raise conflict(
                    "Connection is already attached",
                    {
                        "session_id": current.session_id,
                        "view_id": current.view_id,
                    },
                )

            owner = self._controllers.get(session_id)
            if owner is not None and owner != connection_id:
                raise conflict(
                    "Session already has an active controller",
                    {"session_id": session_id},
                )
            self._controllers[session_id] = connection_id
            reserved_controller = True

        try:
            self._hello(
                connection_id=connection_id,
                client_name=client_name,
                client_version=client_version,
            )

            self._daemon.dispatch(
                connection_id,
                "session.get",
                {
                    "protocol_version": _PROTOCOL_VERSION,
                    "request_id": self._uuid(),
                    "session_id": session_id,
                },
            )
            self._daemon.dispatch(
                connection_id,
                "view.get",
                {
                    "protocol_version": _PROTOCOL_VERSION,
                    "request_id": self._uuid(),
                    "session_id": session_id,
                    "view_id": view_id,
                },
            )

            subscription = self._daemon.dispatch(
                connection_id,
                "events.subscribe",
                {
                    "protocol_version": _PROTOCOL_VERSION,
                    "request_id": self._uuid(),
                    "session_id": session_id,
                    "topics": ["*"],
                },
            )
            subscription_id = str(subscription["subscription_id"])

            attached = AttachmentState(
                session_id=session_id,
                view_id=view_id,
                subscription_id=subscription_id,
            )
            with self._guard:
                self._attachments[connection_id] = attached
            return attached
        except Exception:
            if reserved_controller:
                with self._guard:
                    if self._controllers.get(session_id) == connection_id:
                        self._controllers.pop(session_id, None)
            raise

    def attachment_for(self, connection_id: str) -> AttachmentState:
        with self._guard:
            attached = self._attachments.get(connection_id)
        if attached is None:
            raise invalid_params("Connection is not attached to a session", {"connection_id": connection_id})
        return attached

    def poll_events(
        self,
        *,
        connection_id: str,
        limit: int = 256,
    ) -> list[dict[str, Any]]:
        attached = self.attachment_for(connection_id)
        return self._daemon.poll_events(
            connection_id=connection_id,
            session_id=attached.session_id,
            subscription_id=attached.subscription_id,
            limit=limit,
        )

    def dispatch_rpc(
        self,
        *,
        connection_id: str,
        method: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        attached = self.attachment_for(connection_id)
        if method == "events.subscribe":
            raise conflict(
                "events.subscribe is managed by gateway attach flow",
                {"method": method},
            )
        if "session_id" in params:
            value = params.get("session_id")
            if not isinstance(value, str) or value != attached.session_id:
                raise conflict(
                    "RPC request session_id must match attached session",
                    {
                        "attached_session_id": attached.session_id,
                        "request_session_id": value,
                    },
                )
        return self._daemon.dispatch(connection_id, method, params)

    def _hello(
        self,
        *,
        connection_id: str,
        client_name: str,
        client_version: str,
    ) -> dict[str, Any]:
        return self._daemon.dispatch(
            connection_id,
            "system.hello",
            {
                "protocol_version": _PROTOCOL_VERSION,
                "request_id": self._uuid(),
                "client_name": client_name,
                "client_version": client_version,
                "supported_versions": dict(_SUPPORTED_VERSIONS),
                "transport": "ws",
            },
        )


__all__ = ["AttachmentState", "GatewayBridge"]
