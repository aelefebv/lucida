from __future__ import annotations

import base64
import json
from io import BytesIO

from PIL import Image
from typer.testing import CliRunner

import lucida.cli as cli_module
from lucida.service.dataset_service import DatasetService


def _decode_size(payload_b64: str) -> tuple[int, int]:
    image = Image.open(BytesIO(base64.b64decode(payload_b64))).convert("RGBA")
    return image.size


def test_cli_render_and_navigation(render_omezarr_uri: str) -> None:
    cli_module._LOCAL_SERVICE = DatasetService()
    runner = CliRunner()

    open_result = runner.invoke(
        cli_module.app,
        ["dataset", "open", "--uri", render_omezarr_uri, "--json"],
    )
    assert open_result.exit_code == 0
    dataset_id = json.loads(open_result.stdout)["dataset_summary"]["dataset_id"]

    create_result = runner.invoke(
        cli_module.app,
        ["view", "create", "--dataset-id", dataset_id, "--json"],
    )
    assert create_result.exit_code == 0
    view_id = json.loads(create_result.stdout)["view_state"]["view_id"]

    set_plane_result = runner.invoke(
        cli_module.app,
        ["view", "set-plane", "--view-id", view_id, "--plane", "xz", "--json"],
    )
    assert set_plane_result.exit_code == 0
    assert json.loads(set_plane_result.stdout)["view_state"]["view_2d"]["plane"] == "xz"

    pan_result = runner.invoke(
        cli_module.app,
        ["view", "pan", "--view-id", view_id, "--dx-px", "10", "--dy-px", "-4", "--json"],
    )
    assert pan_result.exit_code == 0

    zoom_result = runner.invoke(
        cli_module.app,
        ["view", "zoom", "--view-id", view_id, "--factor", "0.75", "--json"],
    )
    assert zoom_result.exit_code == 0

    render_result = runner.invoke(
        cli_module.app,
        [
            "render",
            "image",
            "--view-id",
            view_id,
            "--width-px",
            "72",
            "--height-px",
            "56",
            "--json",
        ],
    )
    assert render_result.exit_code == 0
    payload = json.loads(render_result.stdout)
    assert payload["status"] == "ok"
    assert payload["images"][0]["mime"] == "image/png"
    assert _decode_size(payload["images"][0]["bytes_base64"]) == (72, 56)
