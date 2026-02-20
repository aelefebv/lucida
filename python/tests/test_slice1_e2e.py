from __future__ import annotations

import time
from pathlib import Path

from lucida_py import LucidaClient


ROOT = Path(__file__).resolve().parents[2]
RUST_DIR = ROOT / "rust"
FIXTURE_PATH = ROOT / "fixtures" / "ome_zarr_v05_min"


def test_slice1_notebook_flow_end_to_end() -> None:
    socket_path = f"/tmp/lucida-test-{time.time_ns()}.sock"

    client = LucidaClient.launch_or_connect(
        socket_path=socket_path,
        daemon_cmd=["cargo", "run", "-p", "lucida-daemon", "--", "--socket", socket_path],
        daemon_cwd=str(RUST_DIR),
    )

    captured_events: list[dict] = []
    subscription = client.events.subscribe(captured_events.append)

    try:
        health = client.health()
        assert health["status"] == "ok"

        capabilities = client.capabilities()
        assert "state.changed" in capabilities["events"]
        assert "2d_stub" in capabilities["render_modes"]
        assert "3d" in capabilities["render_modes"]
        assert "3d_stub" not in capabilities["render_modes"]
        assert "nearest" in capabilities["sampling_modes"]
        assert "linear" in capabilities["sampling_modes"]

        session_id = client.session.create()
        dataset = client.dataset.open(session_id=session_id, uri=str(FIXTURE_PATH))
        assert dataset["dataset"]["ome_version"] == "0.5"

        image_layer = client.layer.add_image(session_id=session_id, layer_id="image-1", channel=0)
        assert image_layer["layer_id"] == "image-1"
        sampling = client.layer.set_sampling(
            session_id=session_id,
            layer_id="image-1",
            sampling_mode="linear",
        )
        assert sampling["sampling_mode"] == "linear"
        contrast = client.layer.set_contrast_limits(
            session_id=session_id,
            layer_id="image-1",
            min_value=2048,
            max_value=40000,
        )
        assert contrast["contrast_limits"] == [2048, 40000]

        inspection = client.session.inspect(session_id=session_id)
        assert inspection["exists"] is True
        assert inspection["dataset"]["uri"] == str(FIXTURE_PATH)
        assert inspection["render_mode"] == "2d"
        image_layers = [
            layer for layer in inspection["layers"] if layer["id"] == "image-1" and layer["kind"]["type"] == "image"
        ]
        assert len(image_layers) == 1
        assert image_layers[0]["kind"]["render_state"]["sampling_mode"] == "linear"
        assert image_layers[0]["kind"]["render_state"]["contrast_limits"] == [2048, 40000]

        auto = client.layer.auto_contrast(session_id=session_id, layer_id="image-1")
        assert auto["layer_id"] == "image-1"
        assert auto["method"] == "robust_percentile_1_99"
        assert auto["contrast_limits"][0] < auto["contrast_limits"][1]
        inspection_after_auto = client.session.inspect(session_id=session_id)
        image_layers_after_auto = [
            layer
            for layer in inspection_after_auto["layers"]
            if layer["id"] == "image-1" and layer["kind"]["type"] == "image"
        ]
        assert len(image_layers_after_auto) == 1
        assert image_layers_after_auto[0]["kind"]["render_state"]["contrast_limits"] == auto["contrast_limits"]

        frame_channel = client.frame_channel.open(session_id=session_id)
        assert frame_channel["frame_protocol_version"] == "0.1.0"
        assert frame_channel["channel_token"]
        assert frame_channel["frame_socket_path"]

        client.view.set_axis(session_id=session_id, axis="t", index=0)
        client.view.set_axis(session_id=session_id, axis="c", index=0)
        client.view.set_axis(session_id=session_id, axis="z", index=2)
        client.view.reorder_axes(session_id=session_id, order=["t", "c", "z", "y", "x"])
        client.view.set_render_mode(session_id=session_id, mode="3d")
        client.view.set_render_mode(session_id=session_id, mode="graph_stub")
        inspection_after = client.session.inspect(session_id=session_id)
        assert inspection_after["render_mode"] == "graph_stub"

        client.camera.set_mode(session_id=session_id, mode="panzoom")
        client.camera.set_pose(session_id=session_id, pose={"center": [10.0, 8.0], "zoom": 1.5})

        exported = client.command_log.export()
        assert exported["log_schema_version"] == 1
        assert len(exported["audit_log"]) >= 8
        assert len(exported["replay_log"]) >= 6

        replay = client.command_log.replay(exported["replay_log"])
        assert replay["replayed_entries"] == len(exported["replay_log"])
        assert isinstance(replay["state_hash"], str)
        assert len(replay["state_hash"]) == 64

        time.sleep(0.2)
        event_types = {entry.get("event") for entry in captured_events}
        assert "state.changed" in event_types
        assert "perf.frame" in event_types
        mode_events = [
            entry
            for entry in captured_events
            if entry.get("event") == "state.changed"
            and entry.get("payload", {}).get("method") == "view.set_render_mode"
        ]
        assert mode_events
        assert mode_events[-1]["payload"]["render_mode"] == "graph_stub"

        close_result = client.session.close(session_id)
        assert close_result["closed"] == session_id
    finally:
        subscription.stop()
        client.close()
