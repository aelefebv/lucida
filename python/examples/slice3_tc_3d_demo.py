from __future__ import annotations

import time
from pathlib import Path

from lucida_py import LucidaClient


ROOT = Path(__file__).resolve().parents[2]
RUST_DIR = ROOT / "rust"
FIXTURE = ROOT / "fixtures" / "ome_zarr_v05_tc_3d"
SOCKET = f"/tmp/lucida-tc-3d-demo-{time.time_ns()}.sock"


def main() -> None:
    if not FIXTURE.exists():
        raise SystemExit(
            "missing fixture, run `python3 fixtures/generate_slice3a_fixtures.py` first"
        )

    client = LucidaClient.launch_or_connect(
        socket_path=SOCKET,
        daemon_cmd=["cargo", "run", "--release", "-p", "lucida-daemon", "--", "--socket", SOCKET],
        daemon_cwd=str(RUST_DIR),
    )

    session_id = client.session.create()
    print("session_id", session_id)
    print("dataset.open", client.dataset.open(session_id=session_id, uri=str(FIXTURE), read_only=True))
    print(
        "layer.add_image",
        client.layer.add_image(
            session_id=session_id,
            layer_id="image-1",
            # Deliberately no channel pinning so c-axis stepping works in app.
        ),
    )
    print("view.set_axis(t)", client.view.set_axis(session_id=session_id, axis="t", index=0))
    print("view.set_axis(c)", client.view.set_axis(session_id=session_id, axis="c", index=0))
    print("view.set_axis(z)", client.view.set_axis(session_id=session_id, axis="z", index=12))
    print("view.set_render_mode", client.view.set_render_mode(session_id=session_id, mode="3d"))
    print("camera.set_mode", client.camera.set_mode(session_id=session_id, mode="freefly"))
    print(
        "camera.set_pose",
        client.camera.set_pose(
            session_id=session_id,
            pose={
                "position": [0.0, 0.0, 3.2],
                "yaw_pitch_roll": [0.0, 0.0, 0.0],
                "speed": 1.5,
            },
        ),
    )
    print("session.inspect", client.session.inspect(session_id))
    print("attach app with:")
    print(
        "cargo run --manifest-path "
        f"{RUST_DIR / 'Cargo.toml'} "
        f"--release -p lucida-app -- --socket {SOCKET} --session-id {session_id}"
    )
    print("in app 3d mode: left/right steps c, comma/period steps t, up/down or [/]/PgUp/PgDn steps z")
    print("note: this script leaves the daemon/session running for app attach and SDK poking")


if __name__ == "__main__":
    main()
