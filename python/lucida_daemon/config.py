"""Step 07 daemon configuration and policy validation."""

from __future__ import annotations

from dataclasses import dataclass, field
import sys

from lucida_core.errors import invalid_params


UNIX_SOCKET_PREFIX = "unix_socket://"
NAMED_PIPE_PREFIX = "named_pipe://"


def default_local_ipc_uri(*, platform_name: str | None = None, app_name: str = "lucida") -> str:
    platform_key = (platform_name or sys.platform).lower()
    if platform_key.startswith("win"):
        return f"{NAMED_PIPE_PREFIX}\\\\.\\pipe\\{app_name}"
    return f"{UNIX_SOCKET_PREFIX}/tmp/{app_name}.sock"


def validate_local_ipc_uri(uri: str) -> None:
    if not isinstance(uri, str) or not uri:
        raise invalid_params("local_ipc_uri must be a non-empty string", {})
    if not (uri.startswith(UNIX_SOCKET_PREFIX) or uri.startswith(NAMED_PIPE_PREFIX)):
        raise invalid_params(
            "local_ipc_uri must use unix_socket:// or named_pipe://",
            {"local_ipc_uri": uri},
        )
    location = uri.split("://", 1)[1]
    if not location:
        raise invalid_params("local_ipc_uri requires a non-empty endpoint path", {"local_ipc_uri": uri})


@dataclass(frozen=True)
class RemoteBindPolicy:
    enabled: bool = False
    transport: str = "tcp"
    host: str = "127.0.0.1"
    port: int = 8765
    token: str | None = None

    def validate(self) -> None:
        if self.transport not in {"tcp", "ws"}:
            raise invalid_params(
                "remote_bind.transport must be tcp or ws",
                {"transport": self.transport},
            )
        if not isinstance(self.host, str) or not self.host:
            raise invalid_params("remote_bind.host must be a non-empty string", {"host": self.host})
        if not isinstance(self.port, int) or not (1 <= self.port <= 65535):
            raise invalid_params("remote_bind.port must be between 1 and 65535", {"port": self.port})
        if self.enabled:
            if not isinstance(self.token, str) or len(self.token) < 8:
                raise invalid_params(
                    "remote_bind.token must be set with at least 8 characters when enabled",
                    {"token_set": isinstance(self.token, str)},
                )


@dataclass(frozen=True)
class DaemonConfig:
    local_ipc_uri: str = field(default_factory=default_local_ipc_uri)
    event_queue_capacity: int = 1024
    closed_session_retention_seconds: int = 60
    remote_bind: RemoteBindPolicy = field(default_factory=RemoteBindPolicy)

    def validate(self) -> None:
        validate_local_ipc_uri(self.local_ipc_uri)
        if not isinstance(self.event_queue_capacity, int) or self.event_queue_capacity <= 0:
            raise invalid_params(
                "event_queue_capacity must be a positive integer",
                {"event_queue_capacity": self.event_queue_capacity},
            )
        if (
            not isinstance(self.closed_session_retention_seconds, int)
            or self.closed_session_retention_seconds <= 0
        ):
            raise invalid_params(
                "closed_session_retention_seconds must be a positive integer",
                {"closed_session_retention_seconds": self.closed_session_retention_seconds},
            )
        self.remote_bind.validate()
