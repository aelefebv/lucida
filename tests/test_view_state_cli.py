from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

import lucida.cli as cli_module
from lucida.service.dataset_service import DatasetService


def test_cli_view_flow(local_omezarr_uri: str, tmp_path: Path) -> None:
    cli_module._LOCAL_SERVICE = DatasetService()
    runner = CliRunner()

    open_result = runner.invoke(
        cli_module.app,
        ["dataset", "open", "--uri", local_omezarr_uri, "--json"],
    )
    assert open_result.exit_code == 0
    dataset_payload = json.loads(open_result.stdout)
    dataset_id = dataset_payload["dataset_summary"]["dataset_id"]

    create_result = runner.invoke(
        cli_module.app,
        ["view", "create", "--dataset-id", dataset_id, "--json"],
    )
    assert create_result.exit_code == 0
    create_payload = json.loads(create_result.stdout)
    view_id = create_payload["view_state"]["view_id"]

    set_dim_result = runner.invoke(
        cli_module.app,
        ["view", "set-dim", "--view-id", view_id, "--axis", "z", "--index", "3", "--json"],
    )
    assert set_dim_result.exit_code == 0
    set_dim_payload = json.loads(set_dim_result.stdout)
    z_selector = next(item for item in set_dim_payload["selectors_applied"] if item["axis"] == "z")
    assert z_selector["index"] == 3

    set_range_result = runner.invoke(
        cli_module.app,
        [
            "view",
            "set-range",
            "--view-id",
            view_id,
            "--axis",
            "z",
            "--start",
            "1",
            "--end-exclusive",
            "4",
            "--json",
        ],
    )
    assert set_range_result.exit_code == 0
    set_range_payload = json.loads(set_range_result.stdout)
    z_range_selector = next(item for item in set_range_payload["selectors_applied"] if item["axis"] == "z")
    assert z_range_selector["start"] == 1

    set_set_result = runner.invoke(
        cli_module.app,
        [
            "view",
            "set-set",
            "--view-id",
            view_id,
            "--axis",
            "z",
            "--index",
            "0",
            "--index",
            "2",
            "--index",
            "2",
            "--json",
        ],
    )
    assert set_set_result.exit_code == 0
    set_set_payload = json.loads(set_set_result.stdout)
    z_set_selector = next(item for item in set_set_payload["selectors_applied"] if item["axis"] == "z")
    assert z_set_selector["indices"] == [0, 2]

    patch_path = tmp_path / "patch.json"
    patch_path.write_text(
        json.dumps(
            [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 1, "clamp": True}],
                }
            ]
        )
    )
    update_result = runner.invoke(
        cli_module.app,
        ["view", "update", "--view-id", view_id, "--patch-file", str(patch_path), "--json"],
    )
    assert update_result.exit_code == 0
    update_payload = json.loads(update_result.stdout)
    assert update_payload["view_state"]["state_version"] >= 1

    get_result = runner.invoke(
        cli_module.app,
        ["view", "get", "--view-id", view_id, "--json"],
    )
    assert get_result.exit_code == 0
    get_payload = json.loads(get_result.stdout)
    assert get_payload["view_state"]["view_id"] == view_id
