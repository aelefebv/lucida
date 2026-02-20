from __future__ import annotations

from pathlib import Path

from lucida_py import LucidaClient


ROOT = Path(__file__).resolve().parents[2]
RUST_DIR = ROOT / "rust"
FIXTURE = ROOT / "fixtures" / "ome_zarr_v05_min"
SOCKET = "/tmp/lucida-demo.sock"


def main() -> None:
    client = LucidaClient.launch_or_connect(
        socket_path=SOCKET,
        daemon_cmd=["cargo", "run", "-p", "lucida-daemon", "--", "--socket", SOCKET],
        daemon_cwd=str(RUST_DIR),
    )

    events: list[dict] = []
    subscription = client.events.subscribe(events.append)

    try:
        print("health", client.health())
        print("capabilities", client.capabilities())

        session_id = client.session.create()
        print("session", session_id)

        dataset = client.dataset.open(session_id=session_id, uri=str(FIXTURE), read_only=True)
        print("dataset", dataset)
        print("inspect", client.session.inspect(session_id))

        print("add_image", client.layer.add_image(session_id=session_id, layer_id="image-1", channel=0))
        print("frame_channel", client.frame_channel.open(session_id))
        print("set_axis", client.view.set_axis(session_id=session_id, axis="z", index=1))
        print("set_mode", client.camera.set_mode(session_id=session_id, mode="panzoom"))
        print(
            "set_pose",
            client.camera.set_pose(
                session_id=session_id,
                pose={"center": [25.0, 10.0], "zoom": 1.8},
            ),
        )

        exported = client.command_log.export()
        replay = client.command_log.replay(exported["replay_log"])

        print("audit entries", len(exported["audit_log"]))
        print("replay entries", len(exported["replay_log"]))
        print("replay result", replay)
        print("event sample", events[:3])
    finally:
        subscription.stop()
        client.close()


if __name__ == "__main__":
    main()
