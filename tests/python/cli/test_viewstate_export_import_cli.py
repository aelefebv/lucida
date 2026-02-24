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


def test_cli_viewstate_export_import(
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
    source_view_id = json.loads(create_result.stdout)["view_state"]["view_id"]

    export_path = tmp_path / "exported_view_state.json"
    export_result = runner.invoke(
        app,
        [
            "view",
            "export",
            "--view-id",
            source_view_id,
            "--session-id",
            session_id,
            "--out",
            str(export_path),
            "--json",
        ],
        env=cli_env,
    )
    assert export_result.exit_code == 0
    export_payload = json.loads(export_result.stdout)
    assert export_payload["export_id"].startswith("exp_")
    assert export_payload["source_view_id"] == source_view_id
    assert export_path.exists()

    stored_view_state = json.loads(export_path.read_text(encoding="utf-8"))
    assert stored_view_state["view_id"] == source_view_id

    import_result = runner.invoke(
        app,
        [
            "view",
            "import",
            "--view-state-file",
            str(export_path),
            "--session-id",
            session_id,
            "--json",
        ],
        env=cli_env,
    )
    assert import_result.exit_code == 0
    import_payload = json.loads(import_result.stdout)
    assert import_payload["import_id"].startswith("imp_")
    assert import_payload["imported_from_view_id"] == source_view_id
    assert import_payload["view_state"]["view_id"] != source_view_id
    assert import_payload["view_state"]["state_version"] == 0
    assert import_payload["selectors_applied"]
