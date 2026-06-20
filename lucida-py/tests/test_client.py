from __future__ import annotations

import json
import builtins
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from lucida.client import (  # noqa: E402
    HttpResponse,
    LucidaClient,
    LucidaError,
    WorkspaceResource,
    default_ws_connect,
    normalize_server_base_url,
    resolve_token,
)


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
            "asset_catalogs": {},
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


def test_token_sourcing_prefers_env_then_config(monkeypatch):
    monkeypatch.setenv("LUCIDA_TOKEN", "env-token")
    assert resolve_token("http://server", config={"token": "config-token"}).token == "env-token"

    monkeypatch.delenv("LUCIDA_TOKEN")
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


def test_normalize_server_accepts_bare_host():
    assert normalize_server_base_url("127.0.0.1:9988/") == "http://127.0.0.1:9988"


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
        "opened": {"manifest": manifest("wds-new", "new.zarr")},
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
            "kind": "missing_object",
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
    assert err.value.diagnostic["kind"] == "missing_object"
    assert err.value.to_dict()["error"]["diagnostic"]["stage"] == "backend_open"


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
        "opened": {"manifest": manifest("wds-test", "demo.zarr")},
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


def test_view_pan_sends_presence_update(tmp_path):
    connector = FakeConnector([snapshot()])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    workspace = WorkspaceResource(client, workspace_record())

    result = workspace.view.pan(4.0, -2.0)

    sent = connector.websocket.sent[0]
    assert sent["type"] == "presence"
    assert sent["camera"]["center"] == [12.0, 19.0]
    assert result["snapshot_seq"] == 12


def test_layer_and_channel_commands_send_dataset_presence(tmp_path):
    connector = FakeConnector([snapshot()])
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    workspace = WorkspaceResource(client, workspace_record())

    workspace.channel.colormap("demo.zarr", 1, "green")

    sent = connector.websocket.sent[0]
    assert sent["type"] == "dataset_presence"
    settings = sent["dataset_settings"]["wds-test"]
    assert settings["channel_settings"][1]["colormap"] == "green"


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
