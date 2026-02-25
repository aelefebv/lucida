from __future__ import annotations

import base64
import json
from io import BytesIO
from pathlib import Path
import uuid

from PIL import Image
from typer.testing import CliRunner

from cli_helpers import build_cli_env, create_view_context, run_cli_json


def _decode_size(payload_b64: str) -> tuple[int, int]:
    image = Image.open(BytesIO(base64.b64decode(payload_b64))).convert("RGBA")
    return image.size


def test_cli_render_and_navigation(
    render_omezarr_uri: str,
    rust_daemon_base_url: str,
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    cli_env = build_cli_env(base_url=rust_daemon_base_url)
    view_context = create_view_context(runner, env=cli_env, dataset_uri=render_omezarr_uri)

    set_plane_payload = run_cli_json(
        runner,
        [
            "view",
            "plane",
            "--view-id",
            view_context.view_id,
            "--plane",
            "xz",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert set_plane_payload["view_state"]["view_2d"]["plane"] == "xz"

    run_cli_json(
        runner,
        [
            "view",
            "pan",
            "--view-id",
            view_context.view_id,
            "--dx-px",
            "10",
            "--dy-px",
            "-4",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )

    run_cli_json(
        runner,
        [
            "view",
            "zoom",
            "--view-id",
            view_context.view_id,
            "--factor",
            "0.75",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )

    set_rotation_payload = run_cli_json(
        runner,
        [
            "view",
            "rotation",
            "--view-id",
            view_context.view_id,
            "--rotation-deg",
            "15",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert set_rotation_payload["view_state"]["view_2d"]["camera"]["rotation_deg"] == 15.0

    move_rotate_payload = run_cli_json(
        runner,
        [
            "view",
            "rotate",
            "--view-id",
            view_context.view_id,
            "--delta-deg",
            "-5",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert move_rotate_payload["view_state"]["view_2d"]["camera"]["rotation_deg"] == 10.0

    bounds_payload = run_cli_json(
        runner,
        [
            "view",
            "bounds",
            "--view-id",
            view_context.view_id,
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert bounds_payload["axes"] == {"u": "x", "v": "z"}
    assert bounds_payload["visible_bounds_world"]["u_min"] < bounds_payload["visible_bounds_world"]["u_max"]
    assert bounds_payload["visible_bounds_world"]["v_min"] < bounds_payload["visible_bounds_world"]["v_max"]

    screenshot_payload = run_cli_json(
        runner,
        [
            "view",
            "screenshot",
            "--view-id",
            view_context.view_id,
            "--width-px",
            "40",
            "--height-px",
            "30",
            "--session-id",
            view_context.session_id,
            "--delivery",
            "inline_base64",
            "--json",
        ],
        env=cli_env,
    )
    assert screenshot_payload["status"] == "ok"
    assert _decode_size(screenshot_payload["images"][0]["bytes_base64"]) == (40, 30)

    payload = run_cli_json(
        runner,
        [
            "render",
            "image",
            "--view-id",
            view_context.view_id,
            "--width-px",
            "72",
            "--height-px",
            "56",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert payload["status"] == "ok"
    assert payload["images"][0]["mime"] == "image/png"
    assert _decode_size(payload["images"][0]["bytes_base64"]) == (72, 56)

    view_state_payload = run_cli_json(
        runner,
        [
            "view",
            "state",
            "--view-id",
            view_context.view_id,
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    state_payload = view_state_payload["view_state"]
    view_state_file = tmp_path / "view_state.json"
    view_state_file.write_text(json.dumps(state_payload), encoding="utf-8")

    stateless_payload = run_cli_json(
        runner,
        [
            "render",
            "image",
            "--view-state-file",
            str(view_state_file),
            "--width-px",
            "64",
            "--height-px",
            "48",
            "--json",
        ],
        env=cli_env,
    )
    assert stateless_payload["status"] == "ok"
    assert stateless_payload["view_id"] is None
    assert stateless_payload["state_version"] is None
    assert _decode_size(stateless_payload["images"][0]["bytes_base64"]) == (64, 48)

    stateless_inline_payload = run_cli_json(
        runner,
        [
            "render",
            "image",
            "--view-state-json",
            json.dumps(state_payload),
            "--width-px",
            "32",
            "--height-px",
            "24",
            "--json",
        ],
        env=cli_env,
    )
    assert stateless_inline_payload["status"] == "ok"
    assert _decode_size(stateless_inline_payload["images"][0]["bytes_base64"]) == (32, 24)

    output_root = Path(__file__).resolve().parents[3] / "output"
    output_relative = f"snapshots/test-cli-{uuid.uuid4().hex}.png"
    file_payload = run_cli_json(
        runner,
        [
            "render",
            "image",
            "--view-id",
            view_context.view_id,
            "--width-px",
            "64",
            "--height-px",
            "48",
            "--delivery",
            "file_path",
            "--file-path",
            output_relative,
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    file_output_path = Path(file_payload["images"][0]["file_path"])
    try:
        assert file_output_path.exists()
        assert file_output_path.is_relative_to(output_root)

        invalid_payload = run_cli_json(
            runner,
            [
                "render",
                "image",
                "--view-id",
                view_context.view_id,
                "--view-state-file",
                str(view_state_file),
                "--width-px",
                "64",
                "--height-px",
                "48",
                "--json",
            ],
            env=cli_env,
            expected_exit=1,
        )
        assert invalid_payload["code"] == "invalid_request"
    finally:
        if file_output_path.exists():
            file_output_path.unlink()
