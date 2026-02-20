"""Transport abstractions for SDK command and event channels."""

from __future__ import annotations

from typing import Any, Protocol

from lucida_core.errors import LucidaError
from lucida_daemon import LucidaDaemon

from .errors import UnsupportedCapability


class LucidaTransport(Protocol):
    def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Dispatch one protocol command and return method result payload."""

    def poll_events(
        self,
        *,
        session_id: str,
        subscription_id: str,
        limit: int = 256,
    ) -> list[dict[str, Any]]:
        """Poll dedicated event stream payloads for one subscription."""

    def close(self) -> None:
        """Close transport resources for the current SDK connection."""


class InProcessDaemonTransport:
    """Transport adapter backed by an in-process LucidaDaemon instance."""

    def __init__(
        self,
        *,
        daemon: LucidaDaemon,
        connection_id: str | None = None,
    ) -> None:
        self._daemon = daemon
        self._daemon.start()
        self._connection_id = self._daemon.connect(connection_id=connection_id)
        self._closed = False

    @property
    def connection_id(self) -> str:
        return self._connection_id

    @property
    def closed(self) -> bool:
        return self._closed

    def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._ensure_open()
        return self._daemon.dispatch(self._connection_id, method, params)

    def poll_events(
        self,
        *,
        session_id: str,
        subscription_id: str,
        limit: int = 256,
    ) -> list[dict[str, Any]]:
        self._ensure_open()
        return self._daemon.poll_events(
            connection_id=self._connection_id,
            session_id=session_id,
            subscription_id=subscription_id,
            limit=limit,
        )

    def close(self) -> None:
        if self._closed:
            return
        try:
            self._daemon.disconnect(self._connection_id)
        except LucidaError as exc:
            if exc.code not in {"LUCIDA_NOT_FOUND", "LUCIDA_INVALID_PARAMS"}:
                raise
        self._closed = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise UnsupportedCapability(
                "In-process transport connection is closed",
                {"transport": "in_process"},
            )


class IpcTransport:
    """Scaffold-only external IPC transport for Step 08."""

    def __init__(self, *, local_ipc_uri: str | None = None) -> None:
        self._local_ipc_uri = local_ipc_uri

    def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise UnsupportedCapability(
            "External IPC transport is deferred to a later roadmap step",
            {
                "step": "step-08",
                "transport": "ipc",
                "local_ipc_uri": self._local_ipc_uri,
                "method": method,
                "params": params,
            },
        )

    def poll_events(
        self,
        *,
        session_id: str,
        subscription_id: str,
        limit: int = 256,
    ) -> list[dict[str, Any]]:
        raise UnsupportedCapability(
            "External IPC event transport is deferred to a later roadmap step",
            {
                "step": "step-08",
                "transport": "ipc",
                "local_ipc_uri": self._local_ipc_uri,
                "session_id": session_id,
                "subscription_id": subscription_id,
                "limit": limit,
            },
        )

    def close(self) -> None:
        return None

