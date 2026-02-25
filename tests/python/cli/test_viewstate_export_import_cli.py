from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from cli_helpers import build_cli_env, create_view_context, run_cli_json


def test_cli_viewstate_export_import(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    cli_env = build_cli_env(base_url=rust_daemon_base_url)
    view_context = create_view_context(runner, env=cli_env, dataset_uri=local_omezarr_uri)

    export_path = tmp_path / "exported_view_state.json"
    export_payload = run_cli_json(
        runner,
        [
            "view",
            "export",
            "--view-id",
            view_context.view_id,
            "--session-id",
            view_context.session_id,
            "--out",
            str(export_path),
            "--json",
        ],
        env=cli_env,
    )
    assert export_payload["export_id"].startswith("exp_")
    assert export_payload["source_view_id"] == view_context.view_id
    assert export_path.exists()

    stored_view_state = json.loads(export_path.read_text(encoding="utf-8"))
    assert stored_view_state["view_id"] == view_context.view_id

    import_payload = run_cli_json(
        runner,
        [
            "view",
            "import",
            "--view-state-file",
            str(export_path),
            "--session-id",
            view_context.session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert import_payload["import_id"].startswith("imp_")
    assert import_payload["imported_from_view_id"] == view_context.view_id
    assert import_payload["view_state"]["view_id"] != view_context.view_id
    assert import_payload["view_state"]["state_version"] == 0
    assert import_payload["selectors_applied"]
