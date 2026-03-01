from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class PermissionScope(str, Enum):
    CLIENT_VIEW = "client_view"
    SCENE_SHARED = "scene_shared"
    ADMIN = "admin"


class AttachMode(str, Enum):
    OPEN_VIEW = "open_view"
    TOKEN_VIEW = "token_view"
    CONTROL = "control"


@dataclass(frozen=True)
class CommandEnvelope:
    message_type: str
    schema_version: str
    session_id: str
    client_id: str
    client_seq: int
    op: str
    scope: PermissionScope
    requires_lease: bool
    args: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "message_type": self.message_type,
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "client_id": self.client_id,
            "client_seq": self.client_seq,
            "op": self.op,
            "scope": self.scope.value,
            "requires_lease": self.requires_lease,
            "args": self.args,
        }


class CommandQueue:
    def __init__(self) -> None:
        self._pending: list[CommandEnvelope] = []

    def push(self, command: CommandEnvelope) -> None:
        self._pending.append(command)

    def drain(self) -> list[CommandEnvelope]:
        drained = list(self._pending)
        self._pending.clear()
        return drained


class LucidaClient:
    def __init__(self, session_id: str, client_id: str) -> None:
        if not session_id:
            raise ValueError("session_id is required")
        if not client_id:
            raise ValueError("client_id is required")
        self._session_id = session_id
        self._client_id = client_id
        self._client_seq = 1
        self._queue = CommandQueue()

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def client_id(self) -> str:
        return self._client_id

    def queue(self) -> CommandQueue:
        return self._queue

    def attach_session(
        self,
        client_label: str,
        mode: AttachMode = AttachMode.OPEN_VIEW,
        token: str | None = None,
    ) -> dict[str, Any]:
        if not client_label:
            raise ValueError("client_label is required")
        if mode in (AttachMode.TOKEN_VIEW, AttachMode.CONTROL) and not token:
            raise ValueError("token is required for token_view/control modes")

        requested_permission = "control" if mode == AttachMode.CONTROL else "view"
        return {
            "session_id": self._session_id,
            "client_label": client_label,
            "requested_permission": requested_permission,
            "auth": {
                "mode": mode.value,
                "token": token,
            },
        }

    def add_image(self, name: str, source_uri: str) -> CommandEnvelope:
        if not name:
            raise ValueError("name is required")
        if not source_uri:
            raise ValueError("source_uri is required")
        return self._emit(
            op="scene.add_source",
            scope=PermissionScope.SCENE_SHARED,
            requires_lease=True,
            args={"name": name, "uri": source_uri},
        )

    def set_point(self, x: float, y: float, z: int, t: int) -> CommandEnvelope:
        return self._emit(
            op="view.set_point",
            scope=PermissionScope.CLIENT_VIEW,
            requires_lease=False,
            args={"x": x, "y": y, "z": z, "t": t},
        )

    def set_camera(self, center_x: float, center_y: float, zoom: float) -> CommandEnvelope:
        return self._emit(
            op="view.set_camera",
            scope=PermissionScope.CLIENT_VIEW,
            requires_lease=False,
            args={"center_x": center_x, "center_y": center_y, "zoom": zoom},
        )

    def _emit(
        self,
        op: str,
        scope: PermissionScope,
        requires_lease: bool,
        args: dict[str, Any],
    ) -> CommandEnvelope:
        envelope = CommandEnvelope(
            message_type="command",
            schema_version="lucida-proto-0.1",
            session_id=self._session_id,
            client_id=self._client_id,
            client_seq=self._client_seq,
            op=op,
            scope=scope,
            requires_lease=requires_lease,
            args=args,
        )
        self._client_seq += 1
        self._queue.push(envelope)
        return envelope
