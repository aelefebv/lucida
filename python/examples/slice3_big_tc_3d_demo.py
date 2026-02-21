from __future__ import annotations

import argparse
import time
from pathlib import Path

from lucida_py import LucidaClient


ROOT = Path(__file__).resolve().parents[2]
RUST_DIR = ROOT / "rust"
DEFAULT_FIXTURE = Path("/tmp/lucida_ome_zarr_v05_big_tc_3d")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Launch session for large multi-chunk t/c/z 3D fixture")
    parser.add_argument(
        "--fixture",
        type=Path,
        default=DEFAULT_FIXTURE,
        help="Path to generated large fixture",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    fixture = args.fixture
    if not fixture.exists():
        raise SystemExit(
            "missing fixture, generate one first, e.g.\n"
            "python3 /Users/austin/GitHub/lucida/fixtures/generate_big_tc_3d_fixture.py "
            "--output /tmp/lucida_ome_zarr_v05_big_tc_3d --force"
        )

    socket = f"/tmp/lucida-big-tc-3d-demo-{time.time_ns()}.sock"

    client = LucidaClient.launch_or_connect(
        socket_path=socket,
        daemon_cmd=["cargo", "run", "--release", "-p", "lucida-daemon", "--", "--socket", socket],
        daemon_cwd=str(RUST_DIR),
    )

    session_id = client.session.create()
    print("session_id", session_id)
    print("dataset", fixture)
    print("dataset.open", client.dataset.open(session_id=session_id, uri=str(fixture), read_only=True))
    print(
        "layer.add_image",
        client.layer.add_image(
            session_id=session_id,
            layer_id="image-1",
            # no channel pin, c stepping should mutate active channel
        ),
    )

    inspect = client.session.inspect(session_id)
    axes = inspect.get("dataset", {}).get("multiscale_metadata", {}).get("canonical_axes", [])
    axis_sizes = {
        axis.get("label"): axis.get("size") for axis in axes if isinstance(axis, dict)
    }
    z_mid = max((int(axis_sizes.get("z", 1)) - 1) // 2, 0)
    print("axis_sizes", axis_sizes)

    print("view.set_axis(t)", client.view.set_axis(session_id=session_id, axis="t", index=0))
    print("view.set_axis(c)", client.view.set_axis(session_id=session_id, axis="c", index=0))
    print("view.set_axis(z)", client.view.set_axis(session_id=session_id, axis="z", index=z_mid))
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

    print("attach app with:")
    print(
        "cargo run --manifest-path "
        f"{RUST_DIR / 'Cargo.toml'} "
        f"--release -p lucida-app -- --socket {socket} --session-id {session_id}"
    )
    print("in app: left/right = c, comma/period = t, up/down or [/]/PgUp/PgDn = z")
    print("note: daemon/session remain alive for app attach and SDK poking")


if __name__ == "__main__":
    main()
