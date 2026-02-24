from __future__ import annotations

import json
import os
from pathlib import Path

from typer.testing import CliRunner

from lucida.cli import app


def _rust_backend_env(base_url: str) -> dict[str, str]:
    env = dict(os.environ)
    env["LUCIDA_BASE_URL"] = base_url
    return env


def test_cli_view_flow(
    local_omezarr_uri: str,
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
            local_omezarr_uri,
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert open_result.exit_code == 0
    dataset_payload = json.loads(open_result.stdout)
    dataset_id = dataset_payload["dataset_summary"]["dataset_id"]

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
    create_payload = json.loads(create_result.stdout)
    view_id = create_payload["view_state"]["view_id"]

    set_dim_result = runner.invoke(
        app,
        [
            "view",
            "set-dim",
            "--view-id",
            view_id,
            "--axis",
            "z",
            "--index",
            "3",
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert set_dim_result.exit_code == 0
    set_dim_payload = json.loads(set_dim_result.stdout)
    z_selector = next(item for item in set_dim_payload["selectors_applied"] if item["axis"] == "z")
    assert z_selector["index"] == 3

    set_range_result = runner.invoke(
        app,
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
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert set_range_result.exit_code == 0
    set_range_payload = json.loads(set_range_result.stdout)
    z_range_selector = next(item for item in set_range_payload["selectors_applied"] if item["axis"] == "z")
    assert z_range_selector["start"] == 1

    set_set_result = runner.invoke(
        app,
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
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
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
        ),
        encoding="utf-8",
    )
    update_result = runner.invoke(
        app,
        [
            "view",
            "update",
            "--view-id",
            view_id,
            "--patch-file",
            str(patch_path),
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert update_result.exit_code == 0
    update_payload = json.loads(update_result.stdout)
    assert update_payload["view_state"]["state_version"] >= 1

    get_result = runner.invoke(
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
    assert get_result.exit_code == 0
    get_payload = json.loads(get_result.stdout)
    assert get_payload["view_state"]["view_id"] == view_id
