"""Local IPC endpoint abstraction for Step 07 daemon transport setup."""

from __future__ import annotations

from dataclasses import dataclass

from lucida_core.errors import invalid_params

from .config import NAMED_PIPE_PREFIX, UNIX_SOCKET_PREFIX


@dataclass(frozen=True)
class LocalIpcBinding:
    transport: str
    uri: str


def parse_local_ipc_uri(uri: str) -> LocalIpcBinding:
    if uri.startswith(UNIX_SOCKET_PREFIX):
        return LocalIpcBinding(transport="unix_socket", uri=uri)
    if uri.startswith(NAMED_PIPE_PREFIX):
        return LocalIpcBinding(transport="named_pipe", uri=uri)
    raise invalid_params(
        "local_ipc_uri must begin with unix_socket:// or named_pipe://",
        {"local_ipc_uri": uri},
    )


class LocalIpcAdapter:
    """Lifecycle holder for local IPC endpoint metadata."""

    def __init__(self, *, local_ipc_uri: str) -> None:
        self._binding = parse_local_ipc_uri(local_ipc_uri)
        self._started = False

    def start(self) -> dict[str, str]:
        self._started = True
        return {"transport": self._binding.transport, "uri": self._binding.uri}

    def stop(self) -> None:
        self._started = False

    def ensure_started(self) -> None:
        if not self._started:
            raise invalid_params("Daemon local IPC endpoint is not started", {})
