"""Process-local daemon registry for Step 08 launch/connect behavior."""

from __future__ import annotations

from dataclasses import dataclass
import threading

from lucida_core import NDStateEngine
from lucida_daemon import DaemonConfig, LucidaDaemon, default_local_ipc_uri

from .errors import NotFound
from .ids import uuid7_str


@dataclass(frozen=True)
class _RegistryEntry:
    daemon: LucidaDaemon


_REGISTRY: dict[str, _RegistryEntry] = {}
_REGISTRY_LOCK = threading.Lock()


def resolve_local_ipc_uri(local_ipc_uri: str | None = None) -> str:
    if local_ipc_uri is not None:
        return local_ipc_uri
    return default_local_ipc_uri()


def launch_or_get_local_daemon(*, local_ipc_uri: str | None = None) -> tuple[LucidaDaemon, bool]:
    resolved_uri = resolve_local_ipc_uri(local_ipc_uri)
    with _REGISTRY_LOCK:
        existing = _REGISTRY.get(resolved_uri)
        if existing is not None:
            return existing.daemon, False

        engine = NDStateEngine(uuid_factory=uuid7_str)
        daemon = LucidaDaemon(
            engine=engine,
            config=DaemonConfig(local_ipc_uri=resolved_uri),
            uuid_factory=uuid7_str,
        )
        daemon.start()
        _REGISTRY[resolved_uri] = _RegistryEntry(daemon=daemon)
        return daemon, True


def get_local_daemon(*, local_ipc_uri: str | None = None) -> LucidaDaemon:
    resolved_uri = resolve_local_ipc_uri(local_ipc_uri)
    with _REGISTRY_LOCK:
        entry = _REGISTRY.get(resolved_uri)
        if entry is None:
            raise NotFound(
                "No local daemon is registered for the requested URI",
                {"local_ipc_uri": resolved_uri},
            )
        return entry.daemon


def register_local_daemon(
    daemon: LucidaDaemon,
    *,
    local_ipc_uri: str | None = None,
) -> str:
    resolved_uri = resolve_local_ipc_uri(local_ipc_uri)
    daemon.start()
    with _REGISTRY_LOCK:
        _REGISTRY[resolved_uri] = _RegistryEntry(daemon=daemon)
    return resolved_uri


def shutdown_local_daemon(*, local_ipc_uri: str | None = None) -> bool:
    resolved_uri = resolve_local_ipc_uri(local_ipc_uri)
    with _REGISTRY_LOCK:
        entry = _REGISTRY.pop(resolved_uri, None)
    if entry is None:
        return False
    entry.daemon.stop()
    return True


def clear_local_daemon_registry() -> None:
    with _REGISTRY_LOCK:
        uris = list(_REGISTRY.keys())
    for uri in uris:
        shutdown_local_daemon(local_ipc_uri=uri)


def local_daemon_count() -> int:
    with _REGISTRY_LOCK:
        return len(_REGISTRY)

