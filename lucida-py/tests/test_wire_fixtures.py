"""The client against the wire fixtures the server's golden test generates
from the real serde types (`lucida-server/tests/wire_goldens.rs`), so a
protocol change the client has not followed fails here."""

from __future__ import annotations

import json

import pytest

from support import SnapshotConnector, wire_fixture, workspace_record

from lucida.client import LucidaClient, LucidaError, WorkspaceResource  # noqa: E402

REQUEST_ID = "py-fixture"


@pytest.fixture
def fixed_request_ids(monkeypatch):
    class FixedUuid:
        hex = "fixture"

    monkeypatch.setattr("lucida.client.uuid.uuid4", lambda: FixedUuid())


def workspace(tmp_path, then=None):
    connector = SnapshotConnector(wire_fixture("session", "server_snapshot"), then)
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    return WorkspaceResource(client, workspace_record()), connector


def with_request_id(message: dict, request_id: str) -> dict:
    return {**message, "request_id": request_id}


def test_the_snapshot_fixture_summarizes_its_datasets(tmp_path):
    ws, _ = workspace(tmp_path)
    document = wire_fixture("session", "server_snapshot")["document"]
    manifest = document["manifests"]["wds-0f3a"]

    (summary,) = ws.datasets.list()
    info = ws.datasets.info("wds-0f3a")

    assert summary["workspace_dataset_id"] == "wds-0f3a"
    assert summary["name"] == manifest["name"]
    assert summary["dimensions"] == [3, 2, 50, 4096, 4096]
    assert summary["channel_count"] == 2
    assert summary["active_layout_id"] == document["active_layout_ids"]["wds-0f3a"]
    assert info["images"][0]["level_count"] == 3


def test_dataset_open_sends_the_fixture_shape_and_reads_the_replies(tmp_path, fixed_request_ids):
    progress = with_request_id(wire_fixture("session", "server_dataset_open_progress"), REQUEST_ID)
    succeeded = with_request_id(wire_fixture("session", "server_open_dataset_succeeded"), REQUEST_ID)
    ws, connector = workspace(tmp_path, [progress, succeeded])

    result = ws.datasets.open(succeeded["url"])

    (sent,) = connector.sockets[0].sent
    expected = wire_fixture("session", "client_open_remote_dataset")
    assert sent.keys() == expected.keys()
    assert sent["type"] == expected["type"]
    assert result["workspace_dataset_id"] == "wds-0f3a"
    assert result["seq"] == succeeded["seq"]
    assert result["diagnostic"] == succeeded["diagnostic"]
    assert result["progress"] == [progress["diagnostic"]]


def test_a_failed_open_keeps_the_fixture_diagnostic(tmp_path, fixed_request_ids):
    failed = with_request_id(wire_fixture("session", "server_open_dataset_failed"), REQUEST_ID)
    ws, _ = workspace(tmp_path, [failed])

    with pytest.raises(LucidaError) as error:
        ws.datasets.open(failed["url"])

    assert error.value.diagnostic == failed["diagnostic"]


def test_dataset_health_and_retry_send_the_fixture_shapes(tmp_path, fixed_request_ids):
    health = with_request_id(wire_fixture("session", "server_dataset_health"), "py-health-fixture")
    ws, connector = workspace(tmp_path, [health])

    datasets = ws.datasets.health("wds-0f3a")

    (sent,) = connector.sockets[0].sent
    expected = wire_fixture("session", "client_dataset_health")
    assert sent.keys() == expected.keys()
    assert sent["dataset_id"] == expected["dataset_id"]
    assert datasets == health["datasets"]

    retried = with_request_id(
        wire_fixture("session", "server_open_dataset_succeeded"), "py-retry-fixture"
    )
    ws, connector = workspace(tmp_path, [retried])
    ws.datasets.retry("wds-0f3a")
    (sent,) = connector.sockets[0].sent
    expected = wire_fixture("session", "client_dataset_retry")
    assert sent.keys() == expected.keys()
    assert sent["dataset_id"] == expected["dataset_id"]


def test_an_archived_workspace_reads_as_archived(tmp_path):
    connector = SnapshotConnector(wire_fixture("session", "server_workspace_archived"))
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        ws_connect=connector,
    )
    ws = WorkspaceResource(client, workspace_record())

    with pytest.raises(LucidaError) as error:
        ws.snapshot(timeout=1.0)

    assert error.value.kind == "archived_workspace"


def test_the_core_opens_every_camera_the_fixtures_carry():
    extension = pytest.importorskip("lucida.lucida")
    snapshot = wire_fixture("session", "server_snapshot")
    document = json.dumps(snapshot["document"])
    reported = [
        wire_fixture("session", "client_presence"),
        wire_fixture("session", "server_presence_update"),
        *snapshot["peers"],
    ]
    views = [
        {
            "v": 1,
            "camera": item["camera"],
            "view": item["view"],
            "display": item["display"],
            "dataset_order": item.get("dataset_order", []),
            "dataset_settings": item.get("dataset_settings", {}),
        }
        for item in reported
    ]
    # A pin carries a whole saved view.
    views.append(wire_fixture("session", "client_command_add_annotation")["command"]["view"])
    assert {view["camera"]["mode"] for view in views} == {"slice", "arcball", "fly"}

    for view in views:
        scene = extension.ProfileScene(document, json.dumps(view))
        stored = json.loads(scene.saved_view_json())
        assert stored["camera"]["mode"] == view["camera"]["mode"]
        assert stored["dataset_order"] == ["wds-0f3a"]
        assert len(stored["dataset_settings"]["wds-0f3a"]["channel_settings"]) >= 2
