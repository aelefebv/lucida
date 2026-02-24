from __future__ import annotations

import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

import httpx


@dataclass(slots=True)
class RustDaemonProcess:
    process: subprocess.Popen[str]
    base_url: str

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)


def start_rust_daemon(repo_root: Path, env: Mapping[str, str]) -> RustDaemonProcess:
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    daemon_env = dict(env)
    daemon_env["LUCIDA_DAEMON_ADDR"] = f"127.0.0.1:{port}"

    process = subprocess.Popen(
        ["cargo", "run", "-p", "lucida-daemon", "--quiet"],
        cwd=str(repo_root),
        env=daemon_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    daemon = RustDaemonProcess(process=process, base_url=base_url)
    try:
        _wait_for_healthz(daemon)
    except Exception:
        daemon.stop()
        raise
    return daemon


def _wait_for_healthz(daemon: RustDaemonProcess, timeout_s: float = 45.0) -> None:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if daemon.process.poll() is not None:
            raise RuntimeError("Rust daemon exited before becoming healthy.")
        try:
            response = httpx.get(f"{daemon.base_url}/healthz", timeout=1.0)
            if response.status_code == 200:
                payload = response.json()
                if isinstance(payload, dict) and payload.get("status") == "ok":
                    return
        except Exception as exc:  # pragma: no cover - exercised in retries
            last_error = exc
        time.sleep(0.2)
    if last_error is None:
        raise TimeoutError("Timed out waiting for rust daemon /healthz.")
    raise TimeoutError(f"Timed out waiting for rust daemon /healthz: {last_error}")


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
