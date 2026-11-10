"""View, camera, layer and channel changes land in the durable viewer profile,
applied by the compiled core over the workspace snapshot fixture."""

from __future__ import annotations

import pytest

from support import ProfileServer, SnapshotConnector, wire_fixture, workspace_record

pytest.importorskip("lucida.lucida")

from lucida.client import LucidaClient, LucidaError, WorkspaceResource  # noqa: E402

DATASET = "wds-0f3a"


def workspace(tmp_path, server=None, record=None, **kwargs):
    server = server or ProfileServer()
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        transport=server,
        ws_connect=SnapshotConnector(wire_fixture("session", "server_snapshot")),
    )
    return WorkspaceResource(client, record or workspace_record(), **kwargs), server


def stored_view(server, profile="default"):
    return server.profiles[("w1", profile)]["view"]


def test_a_new_profile_starts_framed_and_records_its_seed(tmp_path):
    ws, server = workspace(tmp_path)

    state = ws.viewer.state()

    camera = state["camera"]
    assert camera["mode"] == "slice"
    assert camera["viewport"] == [1440, 900]
    # The 4096-sample-tall dataset fills the 900-pixel canvas height less the
    # core's 2D fit margin of 1.15.
    assert camera["zoom"] == pytest.approx(900 / 4096 / 1.15)
    assert state["seed_source"] == "workspace_snapshot"
    assert stored_view(server)["camera"] == camera
    assert state["web_url"] == "http://127.0.0.1:9988/w/w1?viewer_profile=default"


def test_a_pan_persists_and_the_next_call_starts_from_it(tmp_path):
    ws, server = workspace(tmp_path)
    start = ws.viewer.state()["camera"]

    ws.view.pan(100.0, 0.0)
    second = ws.view.pan(100.0, -50.0)

    zoom = start["zoom"]
    assert second["camera"]["center"] == pytest.approx(
        [start["center"][0] + 200.0 / zoom, start["center"][1] - 50.0 / zoom]
    )
    assert stored_view(server)["camera"] == second["camera"]
    assert second["command"] == {"type": "pan", "dx": 100.0, "dy": -50.0}


def test_zoom_uses_the_core_clamps(tmp_path):
    ws, _ = workspace(tmp_path)

    result = ws.view.set_zoom(1e12)

    assert result["camera"]["zoom"] < 1e12

    with pytest.raises(LucidaError) as error:
        ws.view.zoom(0.0)
    assert error.value.kind == "config"


def test_a_new_profile_seeds_from_the_workspace_default_saved_view(tmp_path):
    seeded = wire_fixture("session", "server_snapshot")["peers"][0]
    saved = {
        "id": "sv-1",
        "view": {
            "v": 1,
            "camera": seeded["camera"],
            "view": seeded["view"],
            "display": seeded["display"],
        },
    }
    ws, server = workspace(
        tmp_path,
        server=ProfileServer(saved_views={"sv-1": saved}),
        record=workspace_record(default_saved_view_id="sv-1"),
    )

    result = ws.view.pan(0.0, 0.0)

    assert result["seed_source"] == "default_saved_view:sv-1"
    assert result["camera"]["center"] == seeded["camera"]["center"]
    assert server.puts()[0]["body"]["seed_source"] == "default_saved_view:sv-1"


def test_view_indices_are_checked_against_the_dataset(tmp_path):
    ws, server = workspace(tmp_path)

    assert ws.view.slice("z", 49)["view"]["z_range"] == {"start": 49, "end": 50}
    with pytest.raises(LucidaError) as error:
        ws.view.slice("z", 50)
    assert error.value.kind == "config"
    assert "50 Z value(s)" in error.value.message
    assert stored_view(server)["view"]["z_range"] == {"start": 49, "end": 50}


def test_3d_cameras_rotate_and_a_2d_pan_is_refused_on_them(tmp_path):
    ws, server = workspace(tmp_path)

    rotated = ws.camera.rotate(0.5, 0.25)
    assert rotated["camera"]["mode"] == "arcball"
    assert stored_view(server)["camera"]["mode"] == "arcball"

    zoomed = ws.camera.zoom(-0.5)
    assert zoomed["camera"]["distance"] < rotated["camera"]["distance"]

    with pytest.raises(LucidaError) as error:
        ws.view.pan(10.0, 0.0)
    assert error.value.kind == "config"
    assert "arcball" in error.value.message

    assert ws.camera.mode("slice")["camera"]["mode"] == "slice"


def test_layer_changes_persist_with_the_core_defaults(tmp_path):
    ws, server = workspace(tmp_path)

    ws.layer.opacity("multichannel-volume.zarr", 0.25)
    ws.layer.visible(DATASET, False)

    settings = stored_view(server)["dataset_settings"][DATASET]
    assert settings["opacity"] == 0.25
    assert settings["visible"] is False
    # Seeded by the core: one entry per channel, in the colormap nearest the
    # color it declares or else the first one free, and the label list with
    # its names.
    assert [channel["colormap"] for channel in settings["channel_settings"]] == [
        "blue",
        "magenta",
    ]
    assert settings["label_names"] == ["region-a"]
    assert settings["label_settings"] == [{"visible": False, "opacity": 0.5}]

    layers = ws.layer.list()
    assert layers[0]["workspace_dataset_id"] == DATASET
    assert layers[0]["settings"]["opacity"] == 0.25
    assert layers[0]["level_pin"] == "follows the screen"


def test_layer_contrast_sets_the_soloed_channel_and_stops_auto_contrast(tmp_path):
    ws, server = workspace(tmp_path)
    ws.channel.solo(DATASET, 1)

    ws.layer.contrast(DATASET, 10.0, 500.0)

    view = stored_view(server)
    channel = view["dataset_settings"][DATASET]["channel_settings"][1]
    assert (channel["contrast_min"], channel["contrast_max"]) == (10.0, 500.0)
    assert view["auto_contrast"] == {DATASET: False}

    # A later change keeps both.
    ws.view.pan(1.0, 1.0)
    assert stored_view(server)["auto_contrast"] == {DATASET: False}
    assert stored_view(server)["dataset_settings"][DATASET]["channel_settings"][1][
        "contrast_max"
    ] == 500.0


def test_channel_changes_persist_and_unknown_channels_are_missing(tmp_path):
    ws, server = workspace(tmp_path)

    ws.channel.colormap(DATASET, 1, "viridis")
    ws.channel.solo(DATASET, 1)

    view = stored_view(server)
    assert view["dataset_settings"][DATASET]["channel_settings"][1]["colormap"] == "viridis"
    assert view["dataset_settings"][DATASET]["solo"] == 1
    assert "c" not in view["view"]

    ws.channel.solo(DATASET)
    assert "solo" not in stored_view(server)["dataset_settings"][DATASET]

    with pytest.raises(LucidaError) as error:
        ws.channel.visible(DATASET, 2, False)
    assert error.value.kind == "missing_resource"

    with pytest.raises(LucidaError) as error:
        ws.channel.solo(DATASET, 2)
    assert error.value.kind == "missing_resource"

    with pytest.raises(LucidaError) as error:
        ws.view.slice("c", 1)
    assert error.value.kind == "config"

    with pytest.raises(LucidaError) as error:
        ws.channel.colormap(DATASET, 0, "not-a-colormap")
    assert error.value.kind == "config"


def test_layer_order_keeps_unnamed_layers(tmp_path):
    ws, server = workspace(tmp_path)

    ws.layer.order([DATASET])

    assert stored_view(server)["dataset_order"] == [DATASET]


def test_profiles_are_independent(tmp_path):
    server = ProfileServer()
    analysis, _ = workspace(tmp_path, server=server, viewer_profile="analysis")
    default, _ = workspace(tmp_path, server=server)

    analysis.view.pan(500.0, 0.0)

    assert ("w1", "analysis") in server.profiles
    assert ("w1", "default") not in server.profiles
    assert default.viewer.state()["camera"] != analysis.viewer.state()["camera"]
