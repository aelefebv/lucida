from __future__ import annotations

import tempfile
import time
from pathlib import Path

from lucida_py import LucidaClient


ROOT = Path(__file__).resolve().parents[2]
RUST_DIR = ROOT / "rust"
FIXTURE_PATH = ROOT / "fixtures" / "ome_zarr_v05_min"


def test_slice1_notebook_flow_end_to_end() -> None:
    socket_path = str(Path(tempfile.gettempdir()) / f"lucida-test-{time.time_ns()}.sock")

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

        session_id = client.session.create()
        dataset = client.dataset.open(session_id=session_id, uri=str(FIXTURE_PATH))
        assert dataset["dataset"]["ome_version"] == "0.5"

        image_layer = client.layer.add_image(session_id=session_id, layer_id="image-1", channel=0)
        assert image_layer["layer_id"] == "image-1"

        inspection = client.session.inspect(session_id=session_id)
        assert inspection["exists"] is True
        assert inspection["dataset"]["uri"] == str(FIXTURE_PATH)

        frame_channel = client.frame_channel.open(session_id=session_id)
        assert frame_channel["frame_protocol_version"] == "0.1.0"
        assert frame_channel["channel_token"]
        assert frame_channel["frame_socket_path"]

        client.view.set_axis(session_id=session_id, axis="t", index=0)
        client.view.set_axis(session_id=session_id, axis="c", index=0)
        client.view.set_axis(session_id=session_id, axis="z", index=2)
        client.view.reorder_axes(session_id=session_id, order=["t", "c", "z", "y", "x"])

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

        close_result = client.session.close(session_id)
        assert close_result["closed"] == session_id
    finally:
        subscription.stop()
        client.close()
