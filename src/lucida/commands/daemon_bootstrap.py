"""Local daemon bootstrap and lifecycle helpers for the CLI."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx

_REPO_ROOT = Path(__file__).resolve().parents[3]
_HEALTH_TIMEOUT_S = 1.0
_HEALTH_POLL_INTERVAL_S = 0.2
_START_TIMEOUT_S = 60.0
_STOP_TIMEOUT_S = 10.0
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_DAEMON_STATE_ENV = "LUCIDA_DAEMON_STATE_PATH"

StopStatus = Literal["stopped", "not_managed", "not_running"]


class DaemonBootstrapError(RuntimeError):
    """Raised when the CLI cannot bootstrap or stop a local daemon."""


@dataclass(frozen=True, slots=True)
class StopManagedDaemonResult:
    """Outcome payload for daemon stop operations."""

    base_url: str
    status: StopStatus
    pid: int | None

    def to_payload(self) -> dict[str, str | int | bool | None]:
        """Serialize result to a JSON-compatible payload."""
        return {
            "base_url": self.base_url,
            "status": self.status,
            "pid": self.pid,
            "stopped": self.status == "stopped",
        }


@dataclass(frozen=True, slots=True)
class _DaemonBindTarget:
    host: str
    port: int


@dataclass(frozen=True, slots=True)
class _ManagedDaemonRecord:
    pid: int


@dataclass(slots=True)
class _DaemonState:
    schema_version: int = 1
    daemons: dict[str, _ManagedDaemonRecord] | None = None

    def __post_init__(self) -> None:
        if self.daemons is None:
            self.daemons = {}


def ensure_local_daemon_running(base_url: str) -> None:
    """Ensure the daemon is reachable at ``base_url``.

    If ``base_url`` points to localhost over HTTP and the daemon is not yet healthy,
    this function starts a detached local daemon process and waits for ``/healthz``.
    """
    normalized_base_url = _normalize_base_url(base_url)
    if _healthz_ok(normalized_base_url):
        return

    bind_target = _resolve_local_bind_target(normalized_base_url)
    if bind_target is None:
        return

    state = _load_daemon_state()
    _prune_stale_daemons(state)
    existing = state.daemons.get(normalized_base_url) if state.daemons is not None else None
    if existing is not None:
        _terminate_pid(existing.pid)
        state.daemons.pop(normalized_base_url, None)
        _save_daemon_state(state)

    command, cwd = _resolve_start_command()
    daemon_env = dict(os.environ)
    daemon_env["LUCIDA_DAEMON_ADDR"] = f"{bind_target.host}:{bind_target.port}"
    try:
        process = subprocess.Popen(
            command,
            cwd=str(cwd) if cwd is not None else None,
            env=daemon_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            text=False,
        )
    except OSError as exc:
        formatted = " ".join(command)
        raise DaemonBootstrapError(
            f"failed to start local lucida-daemon via '{formatted}': {exc}"
        ) from exc

    try:
        _wait_for_healthz(base_url=normalized_base_url, process=process)
    except Exception:
        _terminate_pid(process.pid)
        raise

    state = _load_daemon_state()
    _prune_stale_daemons(state)
    state.daemons[normalized_base_url] = _ManagedDaemonRecord(pid=process.pid)
    _save_daemon_state(state)


def stop_managed_daemon(base_url: str) -> StopManagedDaemonResult:
    """Stop the managed daemon for ``base_url`` if one is recorded."""
    normalized_base_url = _normalize_base_url(base_url)
    state = _load_daemon_state()
    _prune_stale_daemons(state)
    record = state.daemons.get(normalized_base_url) if state.daemons is not None else None
    if record is not None:
        pid = record.pid
        if not _pid_exists(pid):
            state.daemons.pop(normalized_base_url, None)
            _save_daemon_state(state)
            return StopManagedDaemonResult(
                base_url=normalized_base_url,
                status="not_running",
                pid=pid,
            )

        _terminate_pid(pid)
        state.daemons.pop(normalized_base_url, None)
        _save_daemon_state(state)
        return StopManagedDaemonResult(
            base_url=normalized_base_url,
            status="stopped",
            pid=pid,
        )

    bind_target = _resolve_local_bind_target(normalized_base_url)
    if bind_target is not None and _healthz_ok(normalized_base_url):
        stopped_pid = _stop_local_listener_by_port(bind_target.port)
        if stopped_pid is not None and not _healthz_ok(normalized_base_url):
            return StopManagedDaemonResult(
                base_url=normalized_base_url,
                status="stopped",
                pid=stopped_pid,
            )

    return StopManagedDaemonResult(
        base_url=normalized_base_url,
        status="not_managed",
        pid=None,
    )


def is_managed_daemon_running(base_url: str) -> bool:
    """Return ``True`` if a managed daemon process exists and is alive."""
    normalized_base_url = _normalize_base_url(base_url)
    state = _load_daemon_state()
    _prune_stale_daemons(state)
    record = state.daemons.get(normalized_base_url) if state.daemons is not None else None
    if record is None:
        return False
    return _pid_exists(record.pid)


def resolve_daemon_state_path() -> Path:
    """Resolve the on-disk daemon state path."""
    env_path = os.environ.get(_DAEMON_STATE_ENV, "").strip()
    if env_path:
        return Path(env_path).expanduser()
    return Path.home() / ".config" / "lucida" / "daemon-state.json"


def _normalize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def _load_daemon_state() -> _DaemonState:
    path = resolve_daemon_state_path()
    if not path.exists():
        return _DaemonState()

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DaemonBootstrapError(
            f"failed to read daemon state at {path}. Remove the file and retry."
        ) from exc

    if not isinstance(payload, dict):
        raise DaemonBootstrapError(f"invalid daemon state at {path}. Remove the file and retry.")
    schema_version = payload.get("schema_version", 1)
    if schema_version != 1:
        raise DaemonBootstrapError(
            f"unsupported daemon state schema_version={schema_version} at {path}."
        )

    raw_daemons = payload.get("daemons", {})
    if not isinstance(raw_daemons, dict):
        raise DaemonBootstrapError(f"invalid daemon state at {path}. Remove the file and retry.")

    daemons: dict[str, _ManagedDaemonRecord] = {}
    for raw_base_url, raw_record in raw_daemons.items():
        if not isinstance(raw_base_url, str) or not raw_base_url.strip():
            raise DaemonBootstrapError(
                f"invalid daemon state entry in {path}. Remove the file and retry."
            )
        if not isinstance(raw_record, dict):
            raise DaemonBootstrapError(
                f"invalid daemon state entry in {path}. Remove the file and retry."
            )
        raw_pid = raw_record.get("pid")
        if not isinstance(raw_pid, int) or raw_pid <= 0:
            raise DaemonBootstrapError(
                f"invalid daemon pid entry in {path}. Remove the file and retry."
            )
        daemons[_normalize_base_url(raw_base_url)] = _ManagedDaemonRecord(pid=raw_pid)

    return _DaemonState(schema_version=1, daemons=daemons)


def _save_daemon_state(state: _DaemonState) -> None:
    if state.daemons is None:
        state.daemons = {}
    path = resolve_daemon_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "daemons": {
            base_url: {"pid": record.pid}
            for base_url, record in sorted(state.daemons.items())
        },
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _prune_stale_daemons(state: _DaemonState) -> None:
    if state.daemons is None:
        state.daemons = {}
        return
    stale = [base_url for base_url, record in state.daemons.items() if not _pid_exists(record.pid)]
    if not stale:
        return
    for base_url in stale:
        state.daemons.pop(base_url, None)
    _save_daemon_state(state)


def _resolve_local_bind_target(base_url: str) -> _DaemonBindTarget | None:
    parsed = urlparse(base_url)
    if parsed.scheme != "http":
        return None
    hostname = parsed.hostname
    if hostname is None or hostname.lower() not in _LOCAL_HOSTS:
        return None
    port = parsed.port if parsed.port is not None else 80
    return _DaemonBindTarget(host="127.0.0.1", port=port)


def _resolve_start_command() -> tuple[list[str], Path | None]:
    raw_override = os.environ.get("LUCIDA_DAEMON_CMD")
    if raw_override and raw_override.strip():
        return shlex.split(raw_override.strip()), None

    daemon_binary = shutil.which("lucida-daemon")
    if daemon_binary is not None:
        return [daemon_binary], None

    daemon_crate = _REPO_ROOT / "crates" / "lucida-daemon" / "Cargo.toml"
    if daemon_crate.exists():
        if shutil.which("cargo") is None:
            raise DaemonBootstrapError(
                "cargo is not available in PATH; install cargo or set LUCIDA_DAEMON_CMD."
            )

        debug_binary = _REPO_ROOT / "target" / "debug" / "lucida-daemon"
        if not debug_binary.exists():
            try:
                subprocess.run(
                    ["cargo", "build", "-p", "lucida-daemon", "--quiet"],
                    cwd=_REPO_ROOT,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=True,
                    text=False,
                )
            except subprocess.CalledProcessError as exc:
                raise DaemonBootstrapError(
                    "failed to build lucida-daemon binary with cargo."
                ) from exc
        if not debug_binary.exists():
            raise DaemonBootstrapError(
                f"expected daemon binary at {debug_binary}, but it was not found."
            )
        return [str(debug_binary)], None

    raise DaemonBootstrapError(
        "unable to locate lucida-daemon binary; install it or set LUCIDA_DAEMON_CMD."
    )


def _stop_local_listener_by_port(port: int) -> int | None:
    pids = _listener_pids_for_port(port)
    if not pids:
        return None

    stopped_any = False
    first_pid: int | None = None
    for pid in pids:
        if first_pid is None:
            first_pid = pid
        try:
            _terminate_pid(pid)
            stopped_any = True
        except DaemonBootstrapError:
            continue
    if not stopped_any:
        return None
    return first_pid


def _listener_pids_for_port(port: int) -> list[int]:
    lsof_binary = shutil.which("lsof")
    if lsof_binary is None:
        return []

    try:
        result = subprocess.run(
            [lsof_binary, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
        )
    except OSError:
        return []

    if result.returncode not in {0, 1}:
        return []

    pids: list[int] = []
    for raw_line in result.stdout.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        try:
            pid = int(stripped)
        except ValueError:
            continue
        if pid > 0:
            pids.append(pid)

    unique: list[int] = []
    seen: set[int] = set()
    for pid in pids:
        if pid in seen:
            continue
        seen.add(pid)
        unique.append(pid)
    return unique


def _wait_for_healthz(
    *,
    base_url: str,
    process: subprocess.Popen[bytes],
) -> None:
    deadline = time.monotonic() + _START_TIMEOUT_S
    while time.monotonic() < deadline:
        if _healthz_ok(base_url):
            return
        if process.poll() is not None:
            raise DaemonBootstrapError("lucida-daemon exited before becoming healthy.")
        time.sleep(_HEALTH_POLL_INTERVAL_S)
    raise DaemonBootstrapError(
        f"timed out after {_START_TIMEOUT_S:.0f}s waiting for {base_url}/healthz."
    )


def _healthz_ok(base_url: str) -> bool:
    health_url = f"{base_url.rstrip('/')}/healthz"
    try:
        response = httpx.get(health_url, timeout=_HEALTH_TIMEOUT_S)
    except httpx.HTTPError:
        return False
    if response.status_code != 200:
        return False
    try:
        payload = response.json()
    except ValueError:
        return True
    if not isinstance(payload, dict):
        return True
    return payload.get("status") == "ok"


def _terminate_pid(pid: int) -> None:
    if not _pid_exists(pid):
        return

    _signal_pid(pid, signal.SIGTERM)
    deadline = time.monotonic() + _STOP_TIMEOUT_S
    while time.monotonic() < deadline:
        if not _pid_exists(pid):
            return
        time.sleep(_HEALTH_POLL_INTERVAL_S)

    _signal_pid(pid, signal.SIGKILL)
    deadline = time.monotonic() + _STOP_TIMEOUT_S
    while time.monotonic() < deadline:
        if not _pid_exists(pid):
            return
        time.sleep(_HEALTH_POLL_INTERVAL_S)
    raise DaemonBootstrapError(f"failed to terminate daemon process pid={pid}.")


def _signal_pid(pid: int, sig: signal.Signals) -> None:
    if os.name == "nt":
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return
        return

    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        return
    except OSError:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return


def _pid_exists(pid: int) -> bool:
    try:
        reaped_pid, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    except OSError:
        pass
    else:
        if reaped_pid == pid:
            return False

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
