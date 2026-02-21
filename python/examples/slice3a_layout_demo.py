from __future__ import annotations

import time
from pathlib import Path

from lucida_py import LucidaClient


ROOT = Path(__file__).resolve().parents[2]
RUST_DIR = ROOT / "rust"
FIXTURE_AXIS_REMAP = ROOT / "fixtures" / "ome_zarr_v05_axis_remap"
FIXTURE_ANISO_3D = ROOT / "fixtures" / "ome_zarr_v05_anisotropic_3d"
FIXTURE_V04 = ROOT / "fixtures" / "ome_zarr_v04_smoke"
SOCKET = f"/tmp/lucida-slice3a-{time.time_ns()}.sock"


def ensure_fixtures() -> None:
    missing = [
        path
        for path in [FIXTURE_AXIS_REMAP, FIXTURE_ANISO_3D, FIXTURE_V04]
        if not path.exists()
    ]
    if missing:
        missing_str = "\n".join(str(path) for path in missing)
        raise SystemExit(
            "missing Slice 3A fixtures:\n"
            f"{missing_str}\n"
            "run `python3 fixtures/generate_slice3a_fixtures.py` first"
        )


def main() -> None:
    ensure_fixtures()

    client = LucidaClient.launch_or_connect(
        socket_path=SOCKET,
        daemon_cmd=["cargo", "run", "--release", "-p", "lucida-daemon", "--", "--socket", SOCKET],
        daemon_cwd=str(RUST_DIR),
    )

    remap_session = client.session.create()
    print("remap_session", remap_session)
    print(
        "dataset.open(remap)",
        client.dataset.open(
            session_id=remap_session,
            uri=str(FIXTURE_AXIS_REMAP),
            axis_map={"channel": "c"},
            read_only=True,
        ),
    )
    print(
        "layer.add_image(remap)",
        client.layer.add_image(session_id=remap_session, layer_id="image-remap", channel=1),
    )
    print("session.inspect(remap)", client.session.inspect(remap_session))

    v04_session = client.session.create()
    print("v04_session", v04_session)
    print(
        "dataset.open(v0.4)",
        client.dataset.open(session_id=v04_session, uri=str(FIXTURE_V04), read_only=True),
    )
    print(
        "layer.add_image(v0.4)",
        client.layer.add_image(session_id=v04_session, layer_id="image-v04", channel=0),
    )
    print("view.set_axis(v0.4)", client.view.set_axis(session_id=v04_session, axis="z", index=2))

    aniso_session = client.session.create()
    print("aniso_session", aniso_session)
    print(
        "dataset.open(aniso)",
        client.dataset.open(session_id=aniso_session, uri=str(FIXTURE_ANISO_3D), read_only=True),
    )
    print(
        "layer.add_image(aniso)",
        client.layer.add_image(session_id=aniso_session, layer_id="image-aniso", channel=0),
    )
    print("view.set_render_mode(aniso)", client.view.set_render_mode(session_id=aniso_session, mode="3d"))
    print("camera.set_mode(aniso)", client.camera.set_mode(session_id=aniso_session, mode="freefly"))
    print(
        "camera.set_pose(aniso)",
        client.camera.set_pose(
            session_id=aniso_session,
            pose={
                "position": [0.0, 0.0, 3.2],
                "yaw_pitch_roll": [0.0, 0.0, 0.0],
                "speed": 1.5,
            },
        ),
    )
    print("session.inspect(aniso)", client.session.inspect(aniso_session))

    print("attach app with:")
    print(
        "cargo run --manifest-path "
        f"{RUST_DIR / 'Cargo.toml'} "
        f"--release -p lucida-app -- --socket {SOCKET} --session-id {aniso_session}"
    )
    print("note: daemon stays alive for manual app attach and SDK poking")


if __name__ == "__main__":
    main()
