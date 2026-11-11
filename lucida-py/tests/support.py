"""Fakes shared by the client tests: a workspace socket that always opens with
a given snapshot, and an HTTP transport that keeps viewer profiles and saved
views in memory the way the server does."""

from __future__ import annotations

import contextlib
import copy
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import unquote, urlparse
from urllib.request import urlopen

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

WIRE_FIXTURES = ROOT.parent / "wire-fixtures"

from lucida.client import HttpResponse  # noqa: E402


def wire_fixture(family: str, name: str) -> dict:
    return json.loads((WIRE_FIXTURES / family / f"{name}.json").read_text(encoding="utf-8"))


class FakeWebSocket:
    def __init__(self, messages: list[dict]):
        self.messages = [json.dumps(message) for message in messages]
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def recv(self):
        if not self.messages:
            raise AssertionError("no websocket message queued")
        return self.messages.pop(0)

    async def send(self, data):
        self.sent.append(json.loads(data))


class SnapshotConnector:
    """Each connection opens with ``snapshot``, then ``then``."""

    def __init__(self, snapshot: dict, then: list[dict] | None = None):
        self.snapshot = snapshot
        self.then = then or []
        self.sockets: list[FakeWebSocket] = []

    def __call__(self, url, headers):
        socket = FakeWebSocket([copy.deepcopy(self.snapshot), *copy.deepcopy(self.then)])
        self.sockets.append(socket)
        return socket


class ProfileServer:
    """The viewer-profile and saved-view routes, kept in memory."""

    def __init__(self, saved_views: dict[str, dict] | None = None):
        self.profiles: dict[tuple[str, str], dict] = {}
        self.saved_views = saved_views or {}
        self.requests: list[dict] = []

    def request(self, method, url, *, headers=None, body=None, timeout=None):
        parts = [unquote(part) for part in urlparse(url).path.strip("/").split("/")]
        payload = json.loads(body) if body else None
        self.requests.append({"method": method, "path": parts, "body": payload})
        match parts:
            case ["api", "workspaces", workspace_id, "viewer-profiles", profile]:
                key = (workspace_id, profile)
                if method == "GET":
                    record = self.profiles.get(key)
                    if record is None:
                        return HttpResponse(status=204, body=b"", headers={})
                    return self._json(record)
                if method == "PUT":
                    existing = self.profiles.get(key, {})
                    view = dict(payload["view"])
                    view["datasets"] = []
                    record = {
                        "workspace_id": workspace_id,
                        "user_email": "dev@local",
                        "profile": profile,
                        "created_at": existing.get("created_at", "2026-11-07T00:00:00Z"),
                        "updated_at": "2026-11-07T00:00:01Z",
                        "seed_source": payload.get("seed_source") or existing.get("seed_source"),
                        "view": view,
                    }
                    self.profiles[key] = record
                    return self._json(record)
            case ["api", "workspaces", _, "saved-views", saved_view_id] if method == "GET":
                return self._json(self.saved_views[saved_view_id])
        raise AssertionError(f"unexpected request {method} {url}")

    def puts(self) -> list[dict]:
        return [request for request in self.requests if request["method"] == "PUT"]

    @staticmethod
    def _json(value) -> HttpResponse:
        return HttpResponse(status=200, body=json.dumps(value).encode("utf-8"), headers={})


def workspace_record(workspace_id="w1", name="Demo", default_saved_view_id=None):
    return {
        "id": workspace_id,
        "name": name,
        "role": "owner",
        "created_by": "dev@local",
        "created_at": "2026-06-07T00:00:00Z",
        "updated_at": "2026-06-07T00:00:00Z",
        "archived_at": None,
        "seq": 1,
        "default_saved_view_id": default_saved_view_id,
        "last_opened_at": None,
        "pinned_at": None,
    }


def server_binary() -> Path | None:
    """``LUCIDA_SERVER_BIN``, else a cargo build in the repository's ``target/``."""
    configured = os.environ.get("LUCIDA_SERVER_BIN")
    if configured:
        return Path(configured)
    name = "lucida-server.exe" if os.name == "nt" else "lucida-server"
    for profile in ("debug", "release"):
        candidate = ROOT.parent / "target" / profile / name
        if candidate.exists():
            return candidate
    return None


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextlib.contextmanager
def running_server(tmp_path: Path, env: dict[str, str] | None = None):
    """A lucida-server of its own on a free port, yielding its URL. Without a
    server build the test skips, unless ``LUCIDA_REQUIRE_SERVER_TESTS`` is
    set, as CI sets it."""
    binary = server_binary()
    if binary is None:
        message = "no lucida-server build; set LUCIDA_SERVER_BIN or `cargo build -p lucida-server`"
        if os.environ.get("LUCIDA_REQUIRE_SERVER_TESTS"):
            pytest.fail(message)
        pytest.skip(message)

    port = free_port()
    # A loopback bind runs with auth disabled, and the database defaults to a
    # file in the working directory. The caller's own LUCIDA_* settings must
    # not reach this server.
    server_env = {key: value for key, value in os.environ.items() if not key.startswith("LUCIDA_")}
    server_env.update(
        {
            "LUCIDA_BIND": f"127.0.0.1:{port}",
            "LUCIDA_GENERATED_COARSE_CACHE_DIR": str(tmp_path / "coarse-cache"),
            **(env or {}),
        }
    )
    log_path = tmp_path / "server.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [str(binary)], cwd=tmp_path, env=server_env, stdout=log, stderr=subprocess.STDOUT
        )
        url = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    pytest.fail(f"lucida-server exited early:\n{log_path.read_text()}")
                try:
                    with urlopen(f"{url}/healthz", timeout=2):
                        break
                except (URLError, ConnectionError):
                    if time.monotonic() > deadline:
                        pytest.fail(f"lucida-server never became healthy:\n{log_path.read_text()}")
                    time.sleep(0.1)
            yield url
        finally:
            process.terminate()
            process.wait(timeout=10)
