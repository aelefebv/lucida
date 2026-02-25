from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from lucida.cli import app
from cli_helpers import build_cli_env, create_view_context, run_cli, run_cli_json


def test_cli_view_flow(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    cli_env = build_cli_env(base_url=rust_daemon_base_url)
    view_context = create_view_context(runner, env=cli_env, dataset_uri=local_omezarr_uri)

    set_dim_payload = run_cli_json(
        runner,
        [
            "view",
            "set",
            "dim",
            "--view-id",
            view_context.view_id,
            "--axis",
            "z",
            "--index",
            "3",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    z_selector = next(item for item in set_dim_payload["selectors_applied"] if item["axis"] == "z")
    assert z_selector["index"] == 3

    set_range_payload = run_cli_json(
        runner,
        [
            "view",
            "set",
            "range",
            "--view-id",
            view_context.view_id,
            "--axis",
            "z",
            "--start",
            "1",
            "--end-exclusive",
            "4",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    z_range_selector = next(item for item in set_range_payload["selectors_applied"] if item["axis"] == "z")
    assert z_range_selector["start"] == 1

    set_set_payload = run_cli_json(
        runner,
        [
            "view",
            "set",
            "set",
            "--view-id",
            view_context.view_id,
            "--axis",
            "z",
            "--index",
            "0",
            "--index",
            "2",
            "--index",
            "2",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
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
    update_payload = run_cli_json(
        runner,
        [
            "view",
            "update",
            "--view-id",
            view_context.view_id,
            "--patch-file",
            str(patch_path),
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert update_payload["view_state"]["state_version"] >= 1

    inline_patch_payload = run_cli_json(
        runner,
        [
            "view",
            "update",
            "--view-id",
            view_context.view_id,
            "--patch-json",
            json.dumps(
                [
                    {
                        "op": "replace",
                        "path": "/selectors",
                        "value": [{"axis": "z", "kind": "index", "index": 2, "clamp": True}],
                    }
                ]
            ),
            "--expected-state-version",
            str(update_payload["view_state"]["state_version"]),
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert inline_patch_payload["view_state"]["state_version"] == update_payload["view_state"]["state_version"] + 1

    conflict_payload = run_cli_json(
        runner,
        [
            "view",
            "update",
            "--view-id",
            view_context.view_id,
            "--patch-json",
            json.dumps(
                [
                    {
                        "op": "replace",
                        "path": "/selectors",
                        "value": [{"axis": "z", "kind": "index", "index": 0, "clamp": True}],
                    }
                ]
            ),
            "--expected-state-version",
            "0",
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
        expected_exit=1,
    )
    assert "state_conflict" in conflict_payload["message"]

    get_payload = run_cli_json(
        runner,
        [
            "view",
            "get",
            "state",
            "--view-id",
            view_context.view_id,
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert get_payload["view_state"]["view_id"] == view_context.view_id


def test_cli_view_legacy_aliases_removed() -> None:
    runner = CliRunner()

    set_dim_result = run_cli(runner, ["view", "set-dim", "--help"], env={})
    assert set_dim_result.exit_code != 0
    assert "No such command" in set_dim_result.output

    pan_result = run_cli(runner, ["view", "pan", "--help"], env={})
    assert pan_result.exit_code != 0
    assert "No such command" in pan_result.output

    bare_get_result = run_cli(
        runner,
        ["view", "get", "--view-id", "view_123", "--json"],
        env={},
    )
    assert bare_get_result.exit_code != 0
    assert "No such option" in bare_get_result.output
