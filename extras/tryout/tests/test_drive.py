from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


TRYOUT_ROOT = Path(__file__).resolve().parents[1]
if str(TRYOUT_ROOT) not in sys.path:
    sys.path.insert(0, str(TRYOUT_ROOT))

from tryout import drive as drive_module  # noqa: E402
from tryout.surfaces import Surface, SurfaceResult, WorkspaceResult  # noqa: E402


class _FakeServer:
    def __init__(self, *, out_dir: Path, **_kwargs):
        self.out_dir = out_dir
        self.server_log_path = out_dir / "server.log"
        self.db_path = out_dir / "lucida.db"
        self.pid = 42

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.stop()
        return False

    def start(self):
        return SimpleNamespace(
            base_url="http://127.0.0.1:12345",
            ws_url="ws://127.0.0.1:12345",
            server_log=self.server_log_path,
            db_path=self.db_path,
            pid=self.pid,
        )

    def stop(self) -> str:
        return "clean"


class DriveVerdictTests(unittest.TestCase):
    def test_fixture_grants_only_its_local_source_root(self) -> None:
        from tryout.bringup import fixture_data_root

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset = root / "fixture.ome.zarr"
            dataset.mkdir()
            file_fixture = root / "fixture.tif"
            file_fixture.write_bytes(b"fixture")

            self.assertEqual(fixture_data_root(dataset), dataset.resolve())
            self.assertEqual(fixture_data_root(file_fixture), root.resolve())
            self.assertIsNone(fixture_data_root(None))

    def test_required_surface_failure_finishes_tour_but_fails_run(self) -> None:
        seen: list[str] = []

        def failing(_ctx):
            seen.append("failing")
            return SurfaceResult(name="failing", ran=True, ok=False)

        def passing(_ctx):
            seen.append("passing")
            return SurfaceResult(name="passing", ran=True, ok=True)

        opened = WorkspaceResult(
            workspace_id="ws-test",
            workspace_name="test",
            web_url="http://127.0.0.1:12345/w/ws-test",
            ws_url="ws://127.0.0.1:12345/ws/workspaces/ws-test",
            dataset_id="dataset-test",
            dataset={"name": "fixture"},
        )
        registry = {
            "failing": Surface(name="failing", run=failing),
            "passing": Surface(name="passing", run=passing),
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.object(drive_module, "ServerProcess", _FakeServer),
                patch.object(drive_module, "validate_fixture", return_value="fixture"),
                patch.object(drive_module, "create_workspace_and_open", return_value=opened),
                patch.dict(drive_module.REGISTRY, registry, clear=True),
            ):
                outcome = drive_module.drive(
                    out_dir=Path(temp_dir),
                    fixture="fixture",
                    workspace_name="test",
                    surfaces=["failing", "passing"],
                    health_timeout_s=1.0,
                    open_timeout_s=1.0,
                    log=lambda _message: None,
                )

        self.assertEqual(seen, ["failing", "passing"])
        self.assertFalse(outcome.record["ok"])
        self.assertEqual(outcome.exit_code, 1)
        self.assertFalse(outcome.record["surfaces"]["failing"]["ok"])
        self.assertTrue(outcome.record["surfaces"]["passing"]["ok"])


if __name__ == "__main__":
    unittest.main()
