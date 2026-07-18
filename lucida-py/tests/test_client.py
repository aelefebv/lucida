from __future__ import annotations

import json
import builtins
import copy
import io
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from lucida.client import (  # noqa: E402
    DATASET_OPEN_CODE_TO_ERROR_KIND,
    HttpResponse,
    LucidaClient,
    LucidaError,
    UrllibTransport,
    WorkspaceResource,
    build_url,
    default_ws_connect,
    dataset_open_error_kind,
    normalize_server_base_url,
    resolve_token,
)


@pytest.fixture(autouse=True)
def do_not_read_real_user_keychain(monkeypatch):
    monkeypatch.setattr("lucida.client._native_read_keychain_token", None)


class RecordingTransport:
    def __init__(self, responses: list[HttpResponse]):
        self.responses = list(responses)
        self.requests = []

    def request(self, method, url, *, headers=None, body=None, timeout=None):
        self.requests.append(
            {
                "method": method,
                "url": url,
                "headers": headers or {},
                "body": body,
                "timeout": timeout,
            }
        )
        if not self.responses:
            raise AssertionError("no response queued")
        return self.responses.pop(0)


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


class FakeConnector:
    def __init__(self, messages: list[dict]):
        self.websocket = FakeWebSocket(messages)
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append({"url": url, "headers": headers})
        return self.websocket


def response(status: int, value) -> HttpResponse:
    body = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
    return HttpResponse(status=status, body=body, headers={})


def workspace_record(workspace_id="w1", name="Demo"):
    return {
        "id": workspace_id,
        "name": name,
        "role": "owner",
        "created_by": "dev@local",
        "created_at": "2026-06-07T00:00:00Z",
        "updated_at": "2026-06-07T00:00:00Z",
        "archived_at": None,
        "seq": 1,
        "default_saved_view_id": None,
        "last_opened_at": None,
        "pinned_at": None,
    }


def manifest(dataset_id="wds-test", name="demo.zarr"):
    return {
        "dataset_id": dataset_id,
        "name": name,
        "kind": "Single",
        "entities": [{"id": "entity-1", "kind": "Image", "parent": None, "labels": {}}],
        "transforms": [],
        "images": [
            {
                "image_id": "image-1",
                "owner": "entity-1",
                "multiscale": {
                    "axes": [],
                    "levels": [
                        {
                            "level_index": 0,
                            "shape": [1, 3, 5, 64, 32],
                            "chunk_shape": [1, 1, 1, 32, 32],
                            "grid_shape": [1, 3, 5, 2, 1],
                            "scale": [1.0, 1.0, 1.0, 1.0, 1.0],
                        }
                    ],
                    "coarse_level_index": None,
                    "generated_levels": [],
                    "data_type": "Uint16",
                    "pinned_axes": [],
                },
            }
        ],
        "source_layouts": [
            {"id": "layout-source", "name": "Source layout", "placements": []}
        ],
        "default_layout_id": "layout-source",
    }


def snapshot():
    return {
        "type": "snapshot",
        "seq": 12,
        "document": {
            "manifests": {"wds-test": manifest()},
            "registered_layouts": {},
            "active_layout_ids": {},
        },
        "peers": [
            {
                "client_id": 7,
                "camera": {
                    "mode": "slice",
                    "center": [10.0, 20.0],
                    "zoom": 2.0,
                    "viewport": [800, 600],
                },
                "view": {"z_range": {"start": 0, "end": 1}, "t": 0, "c": 0},
                "display": {
                    "contrast_min": 0.0,
                    "contrast_max": 65535.0,
                    "gamma": 1.0,
                },
                "following": None,
                "cursor": None,
                "dataset_order": [],
                "dataset_settings": {},
            }
        ],
        "your_id": 7,
        "generated_availability": {},
    }


def viewer_view(*, center=None, dataset_settings=None):
    state = snapshot()["peers"][0]
    camera = copy.deepcopy(state["camera"])
    if center is not None:
        camera["center"] = center
    return {
        "v": 1,
        "datasets": [],
        "active_layouts": {"wds-test": "layout-source"},
        "camera": camera,
        "view": copy.deepcopy(state["view"]),
        "display": copy.deepcopy(state["display"]),
        "dataset_order": ["wds-test"],
        "dataset_settings": dataset_settings or {},
        "auto_contrast": {},
    }


def viewer_profile_record(*, revision=1, view=None):
    return {
        "workspace_id": "w1",
        "user_email": "dev@local",
        "profile": "default",
        "revision": revision,
        "created_at": "2026-06-07T00:00:00Z",
        "updated_at": "2026-06-07T00:00:00Z",
        "seed_source": "workspace_snapshot",
        "view": view or viewer_view(),
    }


def test_token_sourcing_prefers_env_then_config(monkeypatch):
    native_calls = []
    monkeypatch.setattr(
        "lucida.client._native_read_keychain_token",
        lambda server: native_calls.append(server) or "native-token",
    )
    monkeypatch.setenv("LUCIDA_TOKEN", "env-token")
    assert resolve_token("http://server", config={"token": "config-token"}).token == "env-token"
    assert native_calls == []

    monkeypatch.delenv("LUCIDA_TOKEN")
    token = resolve_token(
        "http://server",
        config={"servers": {"http://server": {"token": "config-token"}}},
    )
    assert token.token == "native-token"
    assert token.source == "keychain"


def test_token_sourcing_falls_through_for_absent_native_token(monkeypatch):
    monkeypatch.delenv("LUCIDA_TOKEN", raising=False)
    monkeypatch.setattr("lucida.client._native_read_keychain_token", lambda _server: None)
    token = resolve_token(
        "http://server",
        config={"servers": {"http://server": {"token": "config-token"}}},
    )
    assert token.token == "config-token"
    assert token.source == "config"
    assert (
        resolve_token(
            "http://elsewhere",
            config={"servers": {"http://server": {"token": "config-token"}}},
        )
        is None
    )


def test_token_sourcing_falls_through_for_native_error(monkeypatch):
    monkeypatch.delenv("LUCIDA_TOKEN", raising=False)

    def denied(_server):
        raise RuntimeError("keychain locked")

    monkeypatch.setattr("lucida.client._native_read_keychain_token", denied)
    token = resolve_token(
        "http://server",
        config={"servers": {"http://server": {"token": "config-token"}}},
    )
    assert token.token == "config-token"
    assert token.source == "config"


def test_token_sourcing_falls_through_when_native_extension_is_missing(monkeypatch):
    monkeypatch.delenv("LUCIDA_TOKEN", raising=False)
    monkeypatch.setattr("lucida.client._native_read_keychain_token", None)
    token = resolve_token(
        "http://server",
        config={"servers": {"http://server": {"token": "config-token"}}},
    )
    assert token.token == "config-token"
    assert token.source == "config"


def test_normalize_server_accepts_bare_host():
    assert normalize_server_base_url("127.0.0.1:9988/") == "http://127.0.0.1:9988"


def test_build_url_preserves_reverse_proxy_prefix():
    assert (
        build_url(
            "https://example.test/lucida/",
            ["api", "workspaces", "workspace one"],
            {"archived": "true"},
        )
        == "https://example.test/lucida/api/workspaces/workspace%20one?archived=true"
    )


def test_urllib_transport_rejects_declared_and_streamed_oversized_bodies():
    class Response(io.BytesIO):
        def __init__(self, body: bytes, content_length: str | None = None):
            super().__init__(body)
            self.headers = {}
            if content_length is not None:
                self.headers["Content-Length"] = content_length

    transport = UrllibTransport(max_response_bytes=4)

    with pytest.raises(LucidaError, match="exceeds 4 bytes") as declared:
        transport._read_bounded(Response(b"tiny", "5"))
    assert declared.value.kind == "resource_limit"

    with pytest.raises(LucidaError, match="exceeds 4 bytes") as streamed:
        transport._read_bounded(Response(b"large", None))
    assert streamed.value.kind == "resource_limit"


def test_urllib_transport_exposes_redirect_without_forwarding_bearer_token():
    captured_authorization: list[str | None] = []

    class CaptureHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            captured_authorization.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"unexpected redirect follow")

        def log_message(self, format, *args):
            del format, args

    target = ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
    target_thread = threading.Thread(target=target.serve_forever, daemon=True)
    target_thread.start()

    target_url = f"http://127.0.0.1:{target.server_port}/capture"

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", target_url)
            self.send_header("Content-Length", "16")
            self.end_headers()
            self.wfile.write(b"redirect blocked")

        def log_message(self, format, *args):
            del format, args

    redirector = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    redirect_thread = threading.Thread(target=redirector.serve_forever, daemon=True)
    redirect_thread.start()

    try:
        response = UrllibTransport().request(
            "GET",
            f"http://127.0.0.1:{redirector.server_port}/start",
            headers={"Authorization": "Bearer lucida_pat_redirect_secret"},
            timeout=2.0,
        )

        assert response.status == 302
        assert response.headers["Location"] == target_url
        assert response.body == b"redirect blocked"
        assert captured_authorization == []
    finally:
        redirector.shutdown()
        redirector.server_close()
        redirect_thread.join(timeout=2.0)
        target.shutdown()
        target.server_close()
        target_thread.join(timeout=2.0)


def test_workspace_connector_receives_configured_message_and_open_limits(monkeypatch):
    captured = {}

    def connector(url, headers, *, open_timeout, max_size):
        captured.update(
            url=url,
            headers=headers,
            open_timeout=open_timeout,
            max_size=max_size,
        )
        return object()

    monkeypatch.setattr("lucida.client.default_ws_connect", connector)
    client = LucidaClient(
        server="http://localhost:9876/base",
        transport=RecordingTransport([]),
        max_ws_message_bytes=1234,
    )
    workspace = WorkspaceResource(client, workspace_record())

    workspace._connect_ws(2.5)

    assert captured == {
        "url": "ws://localhost:9876/base/ws/workspaces/w1",
        "headers": {},
        "open_timeout": 2.5,
        "max_size": 1234,
    }


def test_remote_plaintext_server_rejects_bearer_token(tmp_path, monkeypatch):
    monkeypatch.delenv("LUCIDA_ALLOW_INSECURE_TOKEN", raising=False)
    with pytest.raises(LucidaError) as error:
        LucidaClient(
            "http://example.test/lucida",
            token="secret",
            config_path=tmp_path / "config.json",
        )
    assert error.value.kind == "insecure_transport"
    assert "HTTPS" in error.value.message


def test_server_base_path_is_preserved_for_http_and_websocket(tmp_path):
    transport = RecordingTransport([response(200, [workspace_record()])])
    client = LucidaClient(
        "https://example.test/lucida",
        config_path=tmp_path / "config.json",
        transport=transport,
    )
    client.workspaces.list()
    workspace = WorkspaceResource(client, workspace_record())
    assert transport.requests[0]["url"] == "https://example.test/lucida/api/workspaces"
    assert workspace.ws_url == "wss://example.test/lucida/ws/workspaces/w1"


def test_package_root_import_exposes_server_client():
    import lucida  # noqa: PLC0415

    assert lucida.LucidaClient is LucidaClient
    assert not hasattr(lucida, "Viewer")


def test_missing_websockets_error_points_to_project_environment(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "websockets":
            raise ImportError("missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(LucidaError) as exc_info:
        default_ws_connect("ws://127.0.0.1:9876/ws/workspaces/w1", {})

    assert exc_info.value.kind == "config"
    assert "uv run python" in exc_info.value.message


def test_workspace_list_builds_bearer_request(tmp_path):
    transport = RecordingTransport([response(200, [workspace_record()])])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        token="tok",
        config_path=tmp_path / "config.json",
        transport=transport,
    )

    workspaces = client.workspaces.list()

    assert workspaces[0]["id"] == "w1"
    request = transport.requests[0]
    assert request["method"] == "GET"
    assert request["url"] == "http://127.0.0.1:9988/api/workspaces"
    assert request["headers"]["Authorization"] == "Bearer tok"


def test_workspace_use_persists_default_workspace(tmp_path):
    config_path = tmp_path / "config.json"
    transport = RecordingTransport(
        [
            response(200, [workspace_record()]),
            response(200, workspace_record()),
        ]
    )
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=config_path,
        transport=transport,
    )

    workspace = client.workspaces.use("Demo")

    assert workspace.id == "w1"
    assert json.loads(config_path.read_text())["servers"]["http://127.0.0.1:9988"][
        "workspace"
    ] == "w1"
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600


def test_http_error_normalizes_forbidden(tmp_path):
    transport = RecordingTransport([response(403, {"error": "forbidden"})])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        transport=transport,
    )

    with pytest.raises(LucidaError) as err:
        client.workspaces.list()

    assert err.value.kind == "unauthorized"
    assert err.value.to_dict()["error"]["kind"] == "unauthorized"


def test_snapshot_and_dataset_listing_use_workspace_websocket(tmp_path):
    connector = FakeConnector([snapshot()])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        token="tok",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    workspace = WorkspaceResource(client, workspace_record())

    datasets = workspace.datasets.list()

    assert datasets[0]["workspace_dataset_id"] == "wds-test"
    assert datasets[0]["channel_count"] == 3
    assert connector.calls[0]["url"] == "ws://127.0.0.1:9988/ws/workspaces/w1"
    assert connector.calls[0]["headers"]["Authorization"] == "Bearer tok"


def test_dataset_open_sends_protocol_message_and_reads_broadcast(tmp_path, monkeypatch):
    class FakeUuid:
        hex = "abc123"

    monkeypatch.setattr("lucida.client.uuid.uuid4", lambda: FakeUuid())
    opened = {
        "type": "open_dataset_succeeded",
        "request_id": "py-abc123",
        "seq": 13,
        "summary": {
            "workspace_dataset_id": "wds-new",
            "name": "new.zarr",
            "image_count": 1,
            "entity_count": 1,
        },
    }
    progress = {
        "type": "dataset_open_progress",
        "request_id": "py-abc123",
        "url": "/data/new.zarr",
        "diagnostic": {
            "stage": "metadata_import",
            "message": "importing OME-Zarr metadata",
            "workspace_dataset_id": "wds-new",
            "dataset_source_id": "source-new",
        },
    }
    connector = FakeConnector([snapshot(), progress, opened])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    workspace = WorkspaceResource(client, workspace_record())

    result = workspace.datasets.open("/data/new.zarr")

    sent = connector.websocket.sent[0]
    assert sent["type"] == "open_remote_dataset"
    assert sent["url"] == "/data/new.zarr"
    assert sent["request_id"] == "py-abc123"
    assert result["workspace_dataset_id"] == "wds-new"
    assert result["seq"] == 13
    assert result["progress"][0]["stage"] == "metadata_import"


def test_dataset_open_failure_preserves_diagnostic(tmp_path, monkeypatch):
    class FakeUuid:
        hex = "abc123"

    monkeypatch.setattr("lucida.client.uuid.uuid4", lambda: FakeUuid())
    failed = {
        "type": "open_dataset_failed",
        "request_id": "py-abc123",
        "url": "/data/missing.zarr",
        "error": "object was not found",
        "diagnostic": {
            "stage": "backend_open",
            "category": "source",
            "code": "missing_object",
            "retryable": False,
            "message": "object was not found",
            "detail": "zarr.json missing",
        },
    }
    connector = FakeConnector([snapshot(), failed])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    workspace = WorkspaceResource(client, workspace_record())

    with pytest.raises(LucidaError) as err:
        workspace.datasets.open("/data/missing.zarr")

    assert err.value.kind == "missing_resource"
    assert err.value.failure_category == "source"
    assert err.value.failure_code == "missing_object"
    assert err.value.retryable is False
    assert err.value.diagnostic["code"] == "missing_object"
    assert err.value.to_dict()["error"]["diagnostic"]["stage"] == "backend_open"


def test_shared_failure_matrix_preserves_every_category_code_and_retry_flag():
    rows = json.loads((ROOT.parent / "test-fixtures" / "failure_contract.json").read_text())
    assert set(DATASET_OPEN_CODE_TO_ERROR_KIND) == {row["code"] for row in rows}

    for row in rows:
        diagnostic = {
            "stage": "metadata_import",
            "category": row["category"],
            "code": row["code"],
            "retryable": row["retryable"],
            "message": "typed failure",
        }
        assert dataset_open_error_kind(diagnostic) == row["client_kind"]
        error = LucidaError(
            dataset_open_error_kind(diagnostic),
            "typed failure",
            diagnostic=diagnostic,
        )
        assert error.failure_category == row["category"]
        assert error.failure_code == row["code"]
        assert error.retryable is row["retryable"]
        assert error.to_dict()["error"]["diagnostic"] == diagnostic


def test_dataset_health_sends_protocol_message_and_returns_health(tmp_path, monkeypatch):
    class FakeUuid:
        hex = "abc123"

    monkeypatch.setattr("lucida.client.uuid.uuid4", lambda: FakeUuid())
    health = {
        "type": "dataset_health",
        "request_id": "py-health-abc123",
        "datasets": [
            {
                "workspace_dataset_id": "wds-test",
                "name": "demo.zarr",
                "status": "healthy",
                "source_url": "/data/demo.zarr",
                "backend": "local",
                "binding": {"status": "healthy", "message": "server binding is ready"},
                "source_cache": {
                    "max_bytes": 1024,
                    "current_bytes": 128,
                    "entry_count": 2,
                    "hits": 3,
                    "misses": 4,
                    "evictions": 1,
                    "backend_errors": 0,
                },
                "generated_coarse": {
                    "status": "healthy",
                    "level_count": 0,
                    "ready_chunks": 0,
                    "pending_chunks": 0,
                    "failed_chunks": 0,
                    "unavailable_chunks": 0,
                    "message": "no generated coarse levels advertised",
                },
                "messages": [],
            }
        ],
    }
    connector = FakeConnector([snapshot(), health])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    workspace = WorkspaceResource(client, workspace_record())

    result = workspace.datasets.health("demo.zarr")

    sent = connector.websocket.sent[0]
    assert sent["type"] == "dataset_health"
    assert sent["request_id"] == "py-health-abc123"
    assert sent["dataset_id"] == "wds-test"
    assert result[0]["source_cache"]["hits"] == 3


def test_dataset_retry_sends_protocol_message_and_reads_result(tmp_path, monkeypatch):
    class FakeUuid:
        hex = "abc123"

    monkeypatch.setattr("lucida.client.uuid.uuid4", lambda: FakeUuid())
    retried = {
        "type": "open_dataset_succeeded",
        "request_id": "py-retry-abc123",
        "url": "/data/demo.zarr",
        "seq": 14,
        "summary": {
            "workspace_dataset_id": "wds-test",
            "name": "demo.zarr",
            "image_count": 1,
            "entity_count": 1,
        },
    }
    progress = {
        "type": "dataset_open_progress",
        "request_id": "py-retry-abc123",
        "url": "/data/demo.zarr",
        "diagnostic": {
            "stage": "binding_build",
            "message": "building server chunk binding",
            "workspace_dataset_id": "wds-test",
            "dataset_source_id": "source-test",
        },
    }
    connector = FakeConnector([snapshot(), progress, retried])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    workspace = WorkspaceResource(client, workspace_record())

    result = workspace.datasets.retry("demo.zarr")

    sent = connector.websocket.sent[0]
    assert sent["type"] == "dataset_retry"
    assert sent["request_id"] == "py-retry-abc123"
    assert sent["dataset_id"] == "wds-test"
    assert result["workspace_dataset_id"] == "wds-test"
    assert result["source"] == "/data/demo.zarr"
    assert result["seq"] == 14
    assert result["progress"][0]["stage"] == "binding_build"


def test_view_pan_persists_revisioned_viewer_profile(tmp_path):
    connector = FakeConnector([snapshot()])
    transport = RecordingTransport(
        [
            response(204, b""),
            response(200, viewer_profile_record(view=viewer_view(center=[12.0, 19.0]))),
        ]
    )
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
        transport=transport,
    )
    workspace = WorkspaceResource(client, workspace_record())

    result = workspace.view.pan(4.0, -2.0)

    put = transport.requests[1]
    payload = json.loads(put["body"])
    assert put["method"] == "PUT"
    assert payload["expected_revision"] is None
    assert payload["view"]["camera"]["center"] == [12.0, 19.0]
    assert result["durable"] is True
    assert connector.websocket.sent == []


def test_layer_and_channel_commands_persist_dataset_settings(tmp_path):
    connector = FakeConnector([snapshot()])
    updated_settings = {
        "wds-test": {
            "visible": True,
            "opacity": 1.0,
            "contrast_min": 0.0,
            "contrast_max": 65535.0,
            "gamma": 1.0,
            "blend_mode": "alpha",
            "render_mode": "translucent",
            "channel_settings": [
                {
                    "visible": True,
                    "colormap": "magenta",
                    "contrast_min": 0.0,
                    "contrast_max": 65535.0,
                    "gamma": 1.0,
                },
                {
                    "visible": True,
                    "colormap": "green",
                    "contrast_min": 0.0,
                    "contrast_max": 65535.0,
                    "gamma": 1.0,
                },
            ],
            "channel_blend_mode": "additive",
            "detail_level_override": None,
        }
    }
    transport = RecordingTransport(
        [
            response(204, b""),
            response(
                200,
                viewer_profile_record(
                    view=viewer_view(dataset_settings=updated_settings)
                ),
            ),
        ]
    )
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
        transport=transport,
    )
    workspace = WorkspaceResource(client, workspace_record())

    workspace.channel.colormap("demo.zarr", 1, "green")

    payload = json.loads(transport.requests[1]["body"])
    settings = payload["view"]["dataset_settings"]["wds-test"]
    assert settings["channel_settings"][1]["colormap"] == "green"
    assert connector.websocket.sent == []


def test_manual_channel_contrast_persists_auto_contrast_disabled(tmp_path):
    connector = FakeConnector([snapshot()])
    updated = viewer_view()
    updated["auto_contrast"] = {"wds-test": False}
    transport = RecordingTransport(
        [
            response(204, b""),
            response(200, viewer_profile_record(view=updated)),
        ]
    )
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
        transport=transport,
    )
    workspace = WorkspaceResource(client, workspace_record())

    result = workspace.channel.contrast("demo.zarr", 0, 0, 255)

    payload = json.loads(transport.requests[1]["body"])
    view = payload["view"]
    assert view["dataset_settings"]["wds-test"]["channel_settings"][0][
        "contrast_max"
    ] == 255
    assert view["auto_contrast"] == {"wds-test": False}
    assert result["auto_contrast"] == {"wds-test": False}


def test_layer_contrast_targets_current_channel_and_disables_auto(tmp_path):
    current = snapshot()
    current["peers"][0]["view"]["c"] = 1
    connector = FakeConnector([current])
    updated = viewer_view()
    updated["view"]["c"] = 1
    updated["auto_contrast"] = {"wds-test": False}
    transport = RecordingTransport(
        [
            response(204, b""),
            response(200, viewer_profile_record(view=updated)),
        ]
    )
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
        transport=transport,
    )
    workspace = WorkspaceResource(client, workspace_record())

    # The CLI and UI both define layer-level contrast as shorthand for the
    # selected channel. Keep Python on the same effective-rendering contract.
    workspace.layer.contrast("demo.zarr", 10, 200)

    payload = json.loads(transport.requests[-1]["body"])
    view = payload["view"]
    channel = view["dataset_settings"]["wds-test"]["channel_settings"][1]
    assert (channel["contrast_min"], channel["contrast_max"]) == (10, 200)
    assert view["auto_contrast"] == {"wds-test": False}


def test_display_mutations_reject_unknown_colormaps_and_non_finite_values(tmp_path):
    client = LucidaClient(
        "http://127.0.0.1:9988",
        token="test-token",
        config_path=tmp_path / "config.json",
        transport=RecordingTransport([]),
    )
    workspace = WorkspaceResource(client, workspace_record())

    with pytest.raises(LucidaError, match="unknown channel colormap"):
        workspace.channel.colormap("demo.zarr", 0, "rainbow")
    with pytest.raises(LucidaError, match="must be finite"):
        workspace.layer.opacity("demo.zarr", float("nan"))
    with pytest.raises(LucidaError, match="must be finite"):
        workspace.view.pan(float("inf"), 0.0)


def test_http_json_boundary_rejects_nan_before_transport(tmp_path):
    transport = RecordingTransport([])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        token="test-token",
        config_path=tmp_path / "config.json",
        transport=transport,
    )

    with pytest.raises(LucidaError, match="finite JSON"):
        client._request_json("POST", ["api", "test"], body={"value": float("nan")})
    assert transport.requests == []


def test_profile_conflict_rereads_and_reapplies_disjoint_edit(tmp_path):
    original = viewer_view(center=[10.0, 20.0])
    concurrent = viewer_view(center=[10.0, 20.0])
    concurrent["display"]["gamma"] = 2.0
    final = copy.deepcopy(concurrent)
    final["camera"]["center"] = [12.0, 20.0]
    transport = RecordingTransport(
        [
            response(200, viewer_profile_record(revision=1, view=original)),
            response(
                409,
                {
                    "error": "viewer_profile_conflict",
                    "detail": "viewer profile changed",
                    "expected_revision": 1,
                    "actual_revision": 2,
                    "retryable": True,
                },
            ),
            response(200, viewer_profile_record(revision=2, view=concurrent)),
            response(200, viewer_profile_record(revision=3, view=final)),
        ]
    )
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        transport=transport,
    )
    workspace = WorkspaceResource(client, workspace_record())

    result = workspace.view.pan(4.0, 0.0)

    retry_payload = json.loads(transport.requests[3]["body"])
    assert retry_payload["expected_revision"] == 2
    assert retry_payload["view"]["camera"]["center"] == [12.0, 20.0]
    assert retry_payload["view"]["display"]["gamma"] == 2.0
    assert result["revision"] == 3


def saved_view_record(saved_view_id="sv-1", visibility="shared"):
    return {
        "id": saved_view_id,
        "workspace_id": "w1",
        "name": "Captured",
        "created_by": "dev@local",
        "created_by_name": "Local Dev",
        "created_at": "2026-06-07T00:00:00Z",
        "updated_at": "2026-06-07T00:00:00Z",
        "visibility": visibility,
        "view": {"v": 2},
    }


def saved_views_workspace(tmp_path, responses):
    transport = RecordingTransport(responses)
    client = LucidaClient(
        "http://127.0.0.1:9988",
        token="t",
        config_path=tmp_path / "config.json",
        transport=transport,
    )
    return WorkspaceResource(client, workspace_record()), transport


def test_saved_views_create_sends_visibility(tmp_path):
    workspace, transport = saved_views_workspace(
        tmp_path, [response(201, saved_view_record(visibility="personal"))]
    )

    record = workspace.saved_views.create(
        "Captured", {"v": 2}, visibility="personal"
    )

    request = transport.requests[0]
    assert request["method"] == "POST"
    assert request["url"].endswith("/api/workspaces/w1/saved-views")
    assert json.loads(request["body"]) == {
        "name": "Captured",
        "view": {"v": 2},
        "visibility": "personal",
    }
    assert record["visibility"] == "personal"


def test_saved_views_create_defaults_to_shared(tmp_path):
    workspace, transport = saved_views_workspace(
        tmp_path, [response(201, saved_view_record())]
    )

    workspace.saved_views.create("Captured", {"v": 2})

    assert json.loads(transport.requests[0]["body"])["visibility"] == "shared"


def test_saved_views_set_visibility_patches_visibility(tmp_path):
    workspace, transport = saved_views_workspace(
        tmp_path, [response(200, saved_view_record(visibility="shared"))]
    )

    record = workspace.saved_views.set_visibility("sv-1", "shared")

    request = transport.requests[0]
    assert request["method"] == "PATCH"
    assert request["url"].endswith("/api/workspaces/w1/saved-views/sv-1/visibility")
    assert json.loads(request["body"]) == {"visibility": "shared"}
    assert record["visibility"] == "shared"


def test_saved_views_approve_and_reject_post_without_body(tmp_path):
    workspace, transport = saved_views_workspace(
        tmp_path,
        [
            response(200, saved_view_record(visibility="shared")),
            response(200, saved_view_record(visibility="personal")),
        ],
    )

    approved = workspace.saved_views.approve("sv-1")
    rejected = workspace.saved_views.reject("sv-1")

    approve_request = transport.requests[0]
    assert approve_request["method"] == "POST"
    assert approve_request["url"].endswith("/api/workspaces/w1/saved-views/sv-1/approve")
    assert approve_request["body"] is None
    assert approved["visibility"] == "shared"

    reject_request = transport.requests[1]
    assert reject_request["method"] == "POST"
    assert reject_request["url"].endswith("/api/workspaces/w1/saved-views/sv-1/reject")
    assert reject_request["body"] is None
    assert rejected["visibility"] == "personal"


def collection_manifest_with_shared_multiscale():
    shared = manifest()["images"][0]["multiscale"]
    return {
        # Compact-format marker: emitted alongside any compact construct.
        # The client must tolerate and ignore it (summaries read fields, not
        # the marker).
        "format_version": 2,
        "dataset_id": "wds-coll",
        "name": "collection.zarr",
        "kind": {
            "Collection": {
                "rows": ["A"],
                "columns": ["1"],
                "positioning_mode": "Derived",
                "has_explicit_positions": False,
            }
        },
        "entities": [
            {"id": "group-1", "kind": "Group", "parent": None, "labels": {}},
            {"id": "tile-1", "kind": "Tile", "parent": "group-1", "labels": {}},
            {"id": "tile-2", "kind": "Tile", "parent": "group-1", "labels": {}},
        ],
        "transforms": [
            {"from": "tile-1", "to": "group-1", "translation": [0.0, 0.0]},
            {"from": "tile-2", "to": "group-1", "translation": [64.0, 0.0]},
        ],
        "multiscales": [shared],
        "images": [
            {"image_id": "image-1", "owner": "tile-1", "multiscale_ref": 0},
            {"image_id": "image-2", "owner": "tile-2", "multiscale_ref": 0},
        ],
        "source_layouts": [],
        "default_layout_id": None,
    }


def test_dataset_summary_resolves_shared_multiscale_table():
    from lucida.client import dataset_info_from_document, dataset_summary

    compact = collection_manifest_with_shared_multiscale()
    document = {"manifests": {"wds-coll": compact}}

    summary = dataset_summary(document, compact)
    assert summary["image_count"] == 2
    assert summary["dimensions"] == [1, 3, 5, 64, 32]
    assert summary["channel_count"] == 3

    info = dataset_info_from_document(document, "wds-coll")
    assert [image["data_type"] for image in info["images"]] == ["Uint16", "Uint16"]
    assert all(image["level_count"] == 1 for image in info["images"])


def test_dataset_summary_keeps_reading_inline_multiscales():
    from lucida.client import dataset_summary

    inline = manifest()
    summary = dataset_summary({"manifests": {"wds-test": inline}}, inline)
    assert summary["dimensions"] == [1, 3, 5, 64, 32]


def test_dataset_info_exposes_channel_and_segmentation_label_contracts():
    from lucida.client import dataset_info_from_document

    labeled = manifest()
    labeled["images"][0]["multiscale"]["channel_infos"] = [
        {"label": "channel-a", "color": "0000FF"},
        {"label": "Actin"},
    ]
    label_multiscale = copy.deepcopy(labeled["images"][0]["multiscale"])
    label_multiscale["data_type"] = "Uint32"
    label_multiscale["axes"] = [
        {"name": "t", "kind": "Time"},
        {"name": "z", "kind": "Space"},
        {"name": "y", "kind": "Space"},
        {"name": "x", "kind": "Space"},
    ]
    label_multiscale["levels"][0]["scale"] = [1.0, 1.0, 2.0, 0.5, 0.5]
    labeled["labels"] = [
        {
            "name": "regions",
            "source_image_id": "image-1",
            "image": {
                "image_id": "label-image-1",
                "owner": "entity-1",
                "multiscale": label_multiscale,
            },
            "colors": [{"value": 1, "rgba": [255, 0, 0, 255]}],
            "source_declared": True,
        }
    ]

    document = {"manifests": {"wds-test": labeled}}
    info = dataset_info_from_document(document, "wds-test")

    assert info["label_count"] == 1
    assert info["images"][0]["channel_infos"][0]["label"] == "channel-a"
    assert info["labels"][0] == {
        "name": "regions",
        "source_image_id": "image-1",
        "source_entity_id": "entity-1",
        "label_image_id": "label-image-1",
        "data_type": "Uint32",
        "axis_names": ["t", "z", "y", "x"],
        "level0_scale": [1.0, 1.0, 2.0, 0.5, 0.5],
        "colors": [{"value": 1, "rgba": [255, 0, 0, 255]}],
        "source_declared": True,
    }
