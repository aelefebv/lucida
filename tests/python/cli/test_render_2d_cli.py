from __future__ import annotations

import base64
import json
from io import BytesIO
import os
from pathlib import Path
import uuid

from PIL import Image
from typer.testing import CliRunner

from lucida.cli import app


def _rust_backend_env(base_url: str) -> dict[str, str]:
    env = dict(os.environ)
    env["LUCIDA_BASE_URL"] = base_url
    return env


def _decode_size(payload_b64: str) -> tuple[int, int]:
    image = Image.open(BytesIO(base64.b64decode(payload_b64))).convert("RGBA")
    return image.size


def test_cli_render_and_navigation(
    render_omezarr_uri: str,
    rust_daemon_base_url: str,
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    cli_env = _rust_backend_env(rust_daemon_base_url)

    session_result = runner.invoke(
        app,
        ["session", "create", "--json"],
        env=cli_env,
    )
    assert session_result.exit_code == 0
    session_id = json.loads(session_result.stdout)["session_id"]

    open_result = runner.invoke(
        app,
        [
            "dataset",
            "open",
            "--uri",
            render_omezarr_uri,
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert open_result.exit_code == 0
    dataset_id = json.loads(open_result.stdout)["dataset_summary"]["dataset_id"]

    create_result = runner.invoke(
        app,
        [
            "view",
            "create",
            "--dataset-id",
            dataset_id,
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert create_result.exit_code == 0
    view_id = json.loads(create_result.stdout)["view_state"]["view_id"]

    set_plane_result = runner.invoke(
        app,
        [
            "view",
            "set-plane",
            "--view-id",
            view_id,
            "--plane",
            "xz",
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert set_plane_result.exit_code == 0
    assert json.loads(set_plane_result.stdout)["view_state"]["view_2d"]["plane"] == "xz"

    pan_result = runner.invoke(
        app,
        [
            "view",
            "pan",
            "--view-id",
            view_id,
            "--dx-px",
            "10",
            "--dy-px",
            "-4",
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert pan_result.exit_code == 0

    zoom_result = runner.invoke(
        app,
        [
            "view",
            "zoom",
            "--view-id",
            view_id,
            "--factor",
            "0.75",
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert zoom_result.exit_code == 0

    render_result = runner.invoke(
        app,
        [
            "render",
            "image",
            "--view-id",
            view_id,
            "--width-px",
            "72",
            "--height-px",
            "56",
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert render_result.exit_code == 0
    payload = json.loads(render_result.stdout)
    assert payload["status"] == "ok"
    assert payload["images"][0]["mime"] == "image/png"
    assert _decode_size(payload["images"][0]["bytes_base64"]) == (72, 56)

    view_get_result = runner.invoke(
        app,
        [
            "view",
            "get",
            "--view-id",
            view_id,
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert view_get_result.exit_code == 0
    view_state_payload = json.loads(view_get_result.stdout)["view_state"]
    view_state_file = tmp_path / "view_state.json"
    view_state_file.write_text(json.dumps(view_state_payload), encoding="utf-8")

    stateless_result = runner.invoke(
        app,
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
    assert stateless_result.exit_code == 0
    stateless_payload = json.loads(stateless_result.stdout)
    assert stateless_payload["status"] == "ok"
    assert stateless_payload["view_id"] is None
    assert stateless_payload["state_version"] is None
    assert _decode_size(stateless_payload["images"][0]["bytes_base64"]) == (64, 48)

    stateless_inline_result = runner.invoke(
        app,
        [
            "render",
            "image",
            "--view-state-json",
            json.dumps(view_state_payload),
            "--width-px",
            "32",
            "--height-px",
            "24",
            "--json",
        ],
        env=cli_env,
    )
    assert stateless_inline_result.exit_code == 0
    stateless_inline_payload = json.loads(stateless_inline_result.stdout)
    assert stateless_inline_payload["status"] == "ok"
    assert _decode_size(stateless_inline_payload["images"][0]["bytes_base64"]) == (32, 24)

    output_root = Path(__file__).resolve().parents[3] / "output"
    output_relative = f"snapshots/test-cli-{uuid.uuid4().hex}.png"
    file_result = runner.invoke(
        app,
        [
            "render",
            "image",
            "--view-id",
            view_id,
            "--width-px",
            "64",
            "--height-px",
            "48",
            "--delivery",
            "file_path",
            "--file-path",
            output_relative,
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert file_result.exit_code == 0
    file_payload = json.loads(file_result.stdout)
    file_output_path = Path(file_payload["images"][0]["file_path"])
    try:
        assert file_output_path.exists()
        assert file_output_path.is_relative_to(output_root)

        invalid_one_of = runner.invoke(
            app,
            [
                "render",
                "image",
                "--view-id",
                view_id,
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
        assert invalid_one_of.exit_code == 1
        invalid_payload = json.loads(invalid_one_of.stdout)
        assert invalid_payload["code"] == "invalid_request"
    finally:
        if file_output_path.exists():
            file_output_path.unlink()
