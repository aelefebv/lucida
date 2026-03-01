from __future__ import annotations

import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"


def require_port_inspection_tool() -> None:
    if shutil.which("lsof") is None and shutil.which("ss") is None:
        pytest.skip("requires `lsof` or `ss`")


def allocate_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def wait_until_listening(port: int, timeout_seconds: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((HOST, port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f"port {port} did not start listening in time")


def port_is_open(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.2):
            return True
    except OSError:
        return False


def start_http_server(port: int) -> subprocess.Popen[bytes]:
    process: subprocess.Popen[bytes] = subprocess.Popen(
        ["python3", "-m", "http.server", str(port), "--bind", HOST],
        cwd=REPO_ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    wait_until_listening(port)
    return process


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def test_close_open_sessions_stops_active_listeners() -> None:
    require_port_inspection_tool()
    first_port = allocate_free_port()
    second_port = allocate_free_port()
    while second_port == first_port:
        second_port = allocate_free_port()

    first_server = start_http_server(first_port)
    second_server = start_http_server(second_port)

    try:
        subprocess.run(
            [
                "python3",
                "scripts/close_open_sessions.py",
                "--ports",
                f"{first_port},{second_port}",
            ],
            cwd=REPO_ROOT,
            check=True,
        )
        first_server.wait(timeout=5)
        second_server.wait(timeout=5)
        assert not port_is_open(first_port)
        assert not port_is_open(second_port)
    finally:
        stop_process(first_server)
        stop_process(second_server)


def test_close_open_sessions_succeeds_when_nothing_is_listening() -> None:
    require_port_inspection_tool()
    free_port = allocate_free_port()
    completed = subprocess.run(
        [
            "python3",
            "scripts/close_open_sessions.py",
            "--ports",
            str(free_port),
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "No listening processes found" in completed.stdout
