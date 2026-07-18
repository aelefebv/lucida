from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "create_browser_smoke_fixture.py"
SPEC = importlib.util.spec_from_file_location("browser_smoke_fixture", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class BrowserSmokeFixtureTests(unittest.TestCase):
    def test_generator_writes_wide_collection_with_real_uint8_channel_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "browser-smoke.ome.zarr"
            fixture.create_fixture(output)
            fixture.validate_fixture(output)

            self.assertEqual(
                (
                    output / fixture.COLLECTION_ROW / fixture.COLLECTION_COLUMNS[0]
                    / "0" / "0" / "c" / "0" / "0" / "0" / "0" / "0"
                ).stat().st_size,
                fixture.WIDTH * fixture.HEIGHT,
            )
            root_metadata = json.loads((output / "zarr.json").read_text(encoding="utf-8"))
            plate = root_metadata["attributes"]["ome"]["plate"]
            self.assertEqual(len(plate["columns"]), 12)
            self.assertEqual(len(plate["wells"]), 12)
            first_member = output / fixture.COLLECTION_ROW / fixture.COLLECTION_COLUMNS[0] / "0"
            member_metadata = json.loads((first_member / "zarr.json").read_text(encoding="utf-8"))
            channels = member_metadata["attributes"]["ome"]["omero"]["channels"]
            expected_window = {"min": 0, "max": 255, "start": 0, "end": 255}
            self.assertEqual(
                [channel["window"] for channel in channels],
                [expected_window] * fixture.CHANNELS,
            )
            for channel in (0, 1):
                payload = (
                    first_member / "0" / "c" / "0" / str(channel) / "0" / "0" / "0"
                ).read_bytes()
                self.assertEqual((min(payload), max(payload)), (0, 255))
            with self.assertRaises(FileExistsError):
                fixture.create_fixture(output)
            fixture.create_fixture(output, force=True)
            fixture.validate_fixture(output)


if __name__ == "__main__":
    unittest.main()
