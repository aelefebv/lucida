from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
RELEASE_GATES_WORKFLOW = ROOT / ".github" / "workflows" / "step10-release-gates.yml"
TAG_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "step10-tag-release.yml"


class Step10WorkflowContractTests(unittest.TestCase):
    def test_release_gate_workflow_exists_with_required_smoke_jobs(self) -> None:
        self.assertTrue(RELEASE_GATES_WORKFLOW.exists())
        content = RELEASE_GATES_WORKFLOW.read_text(encoding="utf-8")

        required_snippets = [
            "name: Step 10 Release Gates",
            "release-gates-linux",
            "release-gates-macos",
            "release-gates-windows",
            "tests/release/test_step10_version_mapping.py",
            "tests/release/test_step10_version_sync.py",
            "tests/release/test_step10_workflow_contracts.py",
            "scripts/release/build_linux_appimage.sh",
            "scripts/release/build_macos_dmg.sh",
            "scripts/release/build_windows_msi.ps1",
            "DRY_RUN: \"1\"",
            "UNSIGNED: \"1\"",
        ]

        for snippet in required_snippets:
            with self.subTest(snippet=snippet):
                self.assertIn(snippet, content)

    def test_tag_release_workflow_has_preflight_signing_publish_contracts(self) -> None:
        self.assertTrue(TAG_RELEASE_WORKFLOW.exists())
        content = TAG_RELEASE_WORKFLOW.read_text(encoding="utf-8")

        required_snippets = [
            "name: Step 10 Tag Release",
            "Ensure tag commit is reachable from main",
            "scripts/release/parse_tag_version.py",
            "scripts/release/verify_version_sync.py",
            "scripts/release/build_macos_dmg.sh",
            "scripts/release/build_windows_msi.ps1",
            "scripts/release/build_linux_appimage.sh",
            "scripts/release/generate_checksums.sh",
            "scripts/release/publish_pypi.sh",
            "scripts/release/create_github_release.sh",
            "actions/attest-build-provenance@v2",
            "APPLE_SIGNING_CERT_P12_BASE64",
            "APPLE_SIGNING_CERT_PASSWORD",
            "APPLE_SIGNING_IDENTITY",
            "APPLE_NOTARY_KEY_ID",
            "APPLE_NOTARY_ISSUER_ID",
            "APPLE_NOTARY_KEY_P8_BASE64",
            "WINDOWS_SIGNING_CERT_PFX_BASE64",
            "WINDOWS_SIGNING_CERT_PASSWORD",
            "WINDOWS_SIGNING_TIMESTAMP_URL",
            "APPIMAGE_GPG_PRIVATE_KEY_ASC",
            "APPIMAGE_GPG_PASSPHRASE",
            "PYPI_API_TOKEN",
            "TEST_PYPI_API_TOKEN",
        ]

        for snippet in required_snippets:
            with self.subTest(snippet=snippet):
                self.assertIn(snippet, content)

    def test_new_workflows_pin_python_version(self) -> None:
        for path in [RELEASE_GATES_WORKFLOW, TAG_RELEASE_WORKFLOW]:
            with self.subTest(workflow=path.name):
                content = path.read_text(encoding="utf-8")
                self.assertIn('python-version: "3.12"', content)


if __name__ == "__main__":
    unittest.main()
