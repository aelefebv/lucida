"""Per-session routing primitives for Step 07 daemon command serialization."""

from __future__ import annotations

import threading


class _LockScope:
    def __init__(self, lock: threading.Lock) -> None:
        self._lock = lock

    def __enter__(self) -> None:
        self._lock.acquire()
        return None

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> bool:
        self._lock.release()
        return False


class SessionRouter:
    """Serialize command execution per session while allowing cross-session concurrency."""

    def __init__(self) -> None:
        self._session_locks: dict[str, threading.Lock] = {}
        self._session_locks_guard = threading.Lock()
        self._global_lock = threading.Lock()

    def _lock_for_session(self, session_id: str) -> threading.Lock:
        with self._session_locks_guard:
            lock = self._session_locks.get(session_id)
            if lock is None:
                lock = threading.Lock()
                self._session_locks[session_id] = lock
            return lock

    def route(self, *, method: str, session_id: str | None) -> _LockScope:
        if method == "session.create":
            return _LockScope(self._global_lock)
        if session_id is None:
            return _LockScope(self._global_lock)
        lock = self._lock_for_session(session_id)
        return _LockScope(lock)
