from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[2]
VERIFY_SCRIPT = ROOT / "scripts" / "release" / "verify_version_sync.py"


def _release_tag_for_rust_version(version: str) -> str:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?", version)
    if match is None:
        raise AssertionError(f"Unexpected Rust workspace version format: {version}")
    major, minor, patch, rc = match.groups()
    if rc is None:
        return f"v{major}.{minor}.{patch}"
    return f"v{major}.{minor}.{patch}-rc.{rc}"


def _run_verify(tag: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VERIFY_SCRIPT), "--tag", tag],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


class Step10VersionSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        cargo = tomllib.loads((ROOT / "rust" / "Cargo.toml").read_text(encoding="utf-8"))
        self.python_version = pyproject["project"]["version"]
        self.rust_version = cargo["workspace"]["package"]["version"]

    def test_sync_check_passes_for_repo_version_tag(self) -> None:
        tag = _release_tag_for_rust_version(self.rust_version)
        result = _run_verify(tag)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_sync_check_fails_for_mismatched_patch_version(self) -> None:
        match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?", self.rust_version)
        assert match is not None
        major, minor, patch, _rc = match.groups()
        bad_tag = f"v{major}.{minor}.{int(patch) + 1}"

        result = _run_verify(bad_tag)
        self.assertNotEqual(result.returncode, 0)
        output = result.stdout + result.stderr
        self.assertIn("version mismatch", output)

    def test_invalid_tag_format_fails_fast(self) -> None:
        result = _run_verify("not-a-tag")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid release tag", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
