from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
PARSE_SCRIPT = ROOT / "scripts" / "release" / "parse_tag_version.py"


def _parse(tag: str) -> tuple[int, dict[str, str], str]:
    result = subprocess.run(
        [sys.executable, str(PARSE_SCRIPT), "--tag", tag, "--format", "json"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(result.stdout) if result.returncode == 0 else {}
    return result.returncode, payload, result.stdout + result.stderr


class Step10VersionMappingTests(unittest.TestCase):
    def test_stable_tag_maps_to_stable_python_version(self) -> None:
        code, payload, output = _parse("v2.4.6")
        self.assertEqual(code, 0, msg=output)
        self.assertEqual(payload["semver"], "2.4.6")
        self.assertEqual(payload["python_version"], "2.4.6")
        self.assertEqual(payload["is_prerelease"], "false")
        self.assertEqual(payload["channel"], "pypi")

    def test_rc_tag_maps_to_pep440_prerelease(self) -> None:
        code, payload, output = _parse("v2.4.6-rc.7")
        self.assertEqual(code, 0, msg=output)
        self.assertEqual(payload["semver"], "2.4.6-rc.7")
        self.assertEqual(payload["python_version"], "2.4.6rc7")
        self.assertEqual(payload["is_prerelease"], "true")
        self.assertEqual(payload["channel"], "testpypi")

    def test_refs_tags_prefix_is_accepted(self) -> None:
        code, payload, output = _parse("refs/tags/v1.0.0-rc.1")
        self.assertEqual(code, 0, msg=output)
        self.assertEqual(payload["tag"], "v1.0.0-rc.1")

    def test_invalid_tags_fail(self) -> None:
        for bad_tag in ["1.2.3", "v1", "v1.2", "v1.2.3-rc", "v1.2.3-beta.1", "vx.y.z"]:
            with self.subTest(tag=bad_tag):
                code, _payload, output = _parse(bad_tag)
                self.assertNotEqual(code, 0)
                self.assertIn("Invalid release tag", output)


if __name__ == "__main__":
    unittest.main()
