import json
from pathlib import Path

from lucida_py import cli


def run_cli(args: list[str], state_root: Path, capsys: object) -> dict:
    cli.STATE_ROOT = state_root
    exit_code = cli.main(args)
    assert exit_code == 0
    captured = capsys.readouterr()  # type: ignore[attr-defined]
    return json.loads(captured.out)


def test_open_pan_set_overview_and_snapshot_flow(tmp_path: Path, capsys: object) -> None:
    common = ["--session-id", "sess_00000001", "--client-id", "cli_00000001"]
    open_output = run_cli(
        [
            "open",
            *common,
            "--name",
            "cells",
            "--uri",
            "/tmp/cells.ome.zarr",
        ],
        tmp_path,
        capsys,
    )
    assert open_output["command"] == "open"
    assert open_output["envelope"]["op"] == "scene.add_source"

    pan_output = run_cli(["pan", *common, "--dx", "5", "--dy", "-3"], tmp_path, capsys)
    assert pan_output["envelope"]["op"] == "view.pan"

    set_output = run_cli(
        ["set", *common, "--point", "1.0", "2.0", "3", "4"],
        tmp_path,
        capsys,
    )
    assert set_output["envelope"]["op"] == "view.set_point"

    overview_output = run_cli(
        ["overview", *common, "--active-layer-id", "lay_00000001"],
        tmp_path,
        capsys,
    )
    assert overview_output["envelope"]["op"] == "view.set_active_layer"

    snapshot = run_cli(["snapshot", *common], tmp_path, capsys)
    assert snapshot["command"] == "snapshot"
    assert len(snapshot["history"]) == 4


def test_attach_output_modes(tmp_path: Path, capsys: object) -> None:
    cli.STATE_ROOT = tmp_path
    exit_code = cli.main(
        [
            "--output",
            "text",
            "attach",
            "--session-id",
            "sess_00000002",
            "--client-id",
            "cli_00000002",
            "--client-label",
            "notebook",
            "--mode",
            "control",
            "--token",
            "control-token",
        ]
    )
    assert exit_code == 0
    captured = capsys.readouterr()  # type: ignore[attr-defined]
    assert "attach: mode=control" in captured.out
