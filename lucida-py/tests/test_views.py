"""Several views in the viewer profile: a layout, what each view shows, how
two link, and commands that act in one view, applied by the compiled core."""

from __future__ import annotations

import copy
import json
import subprocess

import pytest

from support import ProfileServer, SnapshotConnector, wire_fixture, workspace_record

pytest.importorskip("lucida.lucida")

from lucida.client import LucidaClient, LucidaError, WorkspaceResource  # noqa: E402

A, B = "wds-0f3a", "wds-0f3b"


def two_datasets(physical: bool = False) -> dict:
    """The snapshot fixture with a second dataset of the same shape and
    placement, both in micrometers when ``physical``, so the pair lines up."""
    snapshot = wire_fixture("session", "server_snapshot")
    manifests = snapshot["document"]["manifests"]
    twin = copy.deepcopy(manifests[A])
    twin["dataset_id"] = B
    twin["name"] = "twin-volume.zarr"
    manifests[B] = twin
    document = snapshot["document"]
    document["registered_layouts"][B] = copy.deepcopy(document["registered_layouts"][A])
    document["active_layout_ids"][B] = document["active_layout_ids"][A]
    if physical:
        for manifest in manifests.values():
            manifest["space"] = {"units": ["micrometer"] * 3, "origin": [0.0, 0.0, 0.0]}
    return snapshot


def workspace(tmp_path, physical: bool = False):
    server = ProfileServer()
    client = LucidaClient(
        "http://127.0.0.1:9988",
        config_path=tmp_path / "config.json",
        transport=server,
        ws_connect=SnapshotConnector(two_datasets(physical)),
    )
    return WorkspaceResource(client, workspace_record()), server


def shown(result: dict) -> list:
    return [view["datasets"] for view in result["views"]["views"]]


def link_mode(result: dict, prop: str) -> str:
    return next(link["mode"] for link in result["links"]["properties"] if link["property"] == prop)


def test_one_view_reports_its_layout_and_no_links(tmp_path):
    ws, _ = workspace(tmp_path)

    state = ws.viewer.state()

    assert state["views"]["layout"] == "single"
    assert shown(state) == ["all"]
    assert state["links"] is None


def test_a_layout_shows_each_dataset_in_its_view_and_links_them(tmp_path):
    ws, server = workspace(tmp_path)

    laid_out = ws.view.layout("columns", [A, "twin-volume.zarr"])
    assert laid_out["views"]["layout"] == "columns"
    assert shown(laid_out) == [{"only": [A]}, {"only": [B]}]
    assert laid_out["views"]["links"]["datasets"] == [A, B]

    linked = ws.view.link("zoom", "linked")
    assert link_mode(linked, "zoom") == "linked"
    assert linked["views"]["links"]["modes"]["zoom"] == "linked"
    stored = server.profiles[("w1", "default")]["view"]
    assert stored["views"] == linked["views"]


def test_a_command_in_a_named_view_steers_it_alone(tmp_path):
    ws, _ = workspace(tmp_path)
    ws.view.layout("columns", [A, B])
    ws.view.link("pan", "off")

    result = ws.camera.mode("arcball", view=1)

    assert result["views"]["active"] == 1
    cameras = [view["camera"]["mode"] for view in result["views"]["views"]]
    assert cameras == ["slice", "arcball"]
    assert result["command"] == {"type": "set_mode_arcball"}


def test_showing_moving_and_maximizing_views(tmp_path):
    ws, _ = workspace(tmp_path)
    ws.view.layout("grid", [A, B])

    kept = ws.view.show(A, view=2, keep=True)
    assert shown(kept)[:3] == [{"only": [A]}, {"only": [B]}, {"only": [A]}]
    moved = ws.view.show([B], view=3)
    assert shown(moved)[1] == {"only": []}
    assert moved["views"]["active"] == 3

    maximized = ws.view.maximize(2)
    assert maximized["views"]["maximized"] == 2
    assert "maximized" not in ws.view.maximize(None)["views"]
    assert ws.view.activate(0)["views"]["active"] == 0


def test_four_up_shows_the_named_dataset_in_every_view(tmp_path):
    ws, _ = workspace(tmp_path)

    result = ws.view.layout("four-up", [B])

    assert shown(result) == [{"only": [B]}] * 4
    planes = [view["camera"].get("plane", "xy") for view in result["views"]["views"][:3]]
    assert planes == ["xy", "yz", "xz"]
    assert result["views"]["views"][3]["camera"]["mode"] == "arcball"


def comparison(result: dict, view: int = 0) -> dict | None:
    return result["views"]["views"][view].get("comparison")


def test_a_swipe_and_a_blink_set_through_the_client(tmp_path):
    ws, server = workspace(tmp_path, physical=True)

    swiped = ws.view.compare(A, "twin-volume.zarr", swipe=0.4)
    assert comparison(swiped) == {"a": A, "b": B, "mode": "swipe", "divider": 0.4, "showing": "a"}
    stored = server.profiles[("w1", "default")]["view"]["views"]["views"][0]
    assert stored["comparison"] == comparison(swiped)

    blinking = ws.view.compare(B, A, blink=2)
    assert comparison(blinking)["mode"] == "blink"
    assert (comparison(blinking)["a"], comparison(blinking)["rate"]) == (B, 2.0)
    assert "rate" not in comparison(ws.view.compare(A, B, blink=True))

    assert comparison(ws.view.end_comparison()) is None


def test_a_comparison_the_pair_cannot_take_is_refused(tmp_path):
    ws, _ = workspace(tmp_path)
    with pytest.raises(LucidaError) as error:
        ws.view.compare(A, B)
    assert error.value.kind == "config"
    assert "physical scale" in error.value.message

    physical, _ = workspace(tmp_path / "physical", physical=True)
    with pytest.raises(LucidaError) as error:
        physical.view.compare(A, B, blink=3)
    assert error.value.kind == "config"
    with pytest.raises(LucidaError):
        physical.view.end_comparison()


def test_refusals_change_nothing(tmp_path):
    ws, server = workspace(tmp_path)
    ws.viewer.state()
    before = copy.deepcopy(server.profiles[("w1", "default")])

    with pytest.raises(LucidaError) as error:
        ws.view.link("zoom", "linked")
    assert error.value.kind == "config"
    with pytest.raises(LucidaError) as error:
        ws.view.pan(10.0, 0.0, view=1)
    assert error.value.kind == "missing_resource"
    with pytest.raises(LucidaError) as error:
        ws.view.layout("columns", [A, B, A])
    assert error.value.kind == "missing_resource"

    assert server.profiles[("w1", "default")] == before


def test_a_screenshot_runs_the_cli_as_this_client(tmp_path, monkeypatch):
    ws, _ = workspace(tmp_path)
    ran = {}

    def run(argv, *, env, capture_output, text, timeout):
        ran.update(argv=argv, env=env)
        report = {"captured": [{"output": "pair.png", "pixels": [1200, 800]}]}
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(report), stderr="")

    monkeypatch.setenv("LUCIDA_CLI", "lucida-test")
    monkeypatch.setattr(subprocess, "run", run)
    report = ws.viewer.screenshot("pair.png", each_view=True, device_pixel_ratio=2)

    assert report["captured"][0]["pixels"] == [1200, 800]
    argv = ran["argv"]
    assert argv[:6] == ["lucida-test", "--server", "http://127.0.0.1:9988", "--workspace", "w1", "--json"]
    assert argv[6:10] == ["viewer", "--profile", "default", "screenshot"]
    assert "--each-view" in argv
    assert argv[argv.index("--device-pixel-ratio") + 1] == "2"
    assert "--plane-lines" not in argv
    ws.viewer.screenshot("quad.png", each_view=True, plane_lines=True)
    assert "--plane-lines" in ran["argv"]
    assert ran["env"]["LUCIDA_CONFIG_PATH"] == str(tmp_path / "config.json")


def test_a_cli_refusal_keeps_its_kind(tmp_path, monkeypatch):
    ws, _ = workspace(tmp_path)

    def run(argv, **_):
        error = {"error": {"kind": "missing_resource", "message": "view 3 was requested"}}
        return subprocess.CompletedProcess(argv, 4, stdout="", stderr=json.dumps(error))

    monkeypatch.setenv("LUCIDA_CLI", "lucida-test")
    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(LucidaError) as error:
        ws.viewer.screenshot("view.png", view=3)
    assert (error.value.kind, error.value.message) == ("missing_resource", "view 3 was requested")
