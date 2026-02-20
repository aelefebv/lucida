from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import tempfile
import tomllib
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
CHECK_CONTEXT_PATH = REPO_ROOT / "scripts" / "check_context.py"


def _load_check_context_module():
    spec = importlib.util.spec_from_file_location("check_context", CHECK_CONTEXT_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write_json_yaml(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def _make_base_repo(tmp: Path) -> tuple[dict, dict]:
    (tmp / "SPEC.md").write_text("# spec\n", encoding="utf-8")

    step_01 = "specs/roadmap/step-01-core-interfaces-and-command-protocol.md"
    step_02 = "specs/roadmap/step-02-nd-state-model-and-transforms.md"
    (tmp / step_01).parent.mkdir(parents=True, exist_ok=True)
    (tmp / step_01).write_text("# step 01\n", encoding="utf-8")
    (tmp / step_02).write_text("# step 02\n", encoding="utf-8")

    impl_path = "runtime/impl.txt"
    test_path = "tests/runtime/test_impl.py"
    (tmp / impl_path).parent.mkdir(parents=True, exist_ok=True)
    (tmp / impl_path).write_text("ok\n", encoding="utf-8")
    (tmp / test_path).parent.mkdir(parents=True, exist_ok=True)
    (tmp / test_path).write_text("ok\n", encoding="utf-8")

    index = {
        "version": "1",
        "last_updated": "2026-02-19",
        "artifacts": [
            {
                "id": "spec",
                "path": "SPEC.md",
                "role": "product-intent",
                "owner": "team",
                "update_trigger": "scope-change",
            }
        ],
    }

    traceability = {
        "version": "1",
        "last_updated": "2026-02-19",
        "steps": [
            {
                "step_id": "step-01",
                "step_spec_path": step_01,
                "status": "done",
                "implementation_paths": [impl_path],
                "test_paths": [test_path],
                "protocol_artifacts": [],
                "last_validated": "2026-02-19",
            },
            {
                "step_id": "step-02",
                "step_spec_path": step_02,
                "status": "planned",
                "implementation_paths": [],
                "test_paths": [],
                "protocol_artifacts": [],
                "last_validated": "",
            },
        ],
    }

    _write_json_yaml(tmp / "docs/context/index.yaml", index)
    _write_json_yaml(tmp / "docs/context/traceability.yaml", traceability)

    return index, traceability


class ContextContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.check_context = _load_check_context_module()

    def test_base_contract_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            _make_base_repo(root)
            errors = self.check_context.run_checks(root)
            self.assertEqual(errors, [])

    def test_missing_step_row_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            _, traceability = _make_base_repo(root)
            traceability["steps"] = traceability["steps"][:-1]
            _write_json_yaml(root / "docs/context/traceability.yaml", traceability)

            errors = self.check_context.run_checks(root)
            self.assertTrue(any("missing step rows" in err for err in errors))

    def test_broken_index_path_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            index, _ = _make_base_repo(root)
            index["artifacts"][0]["path"] = "DOES_NOT_EXIST.md"
            _write_json_yaml(root / "docs/context/index.yaml", index)

            errors = self.check_context.run_checks(root)
            self.assertTrue(any("index.yaml:artifacts[0]:path" in err for err in errors))

    def test_done_step_without_test_paths_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            _, traceability = _make_base_repo(root)
            traceability["steps"][0]["test_paths"] = []
            _write_json_yaml(root / "docs/context/traceability.yaml", traceability)

            errors = self.check_context.run_checks(root)
            self.assertTrue(any("requires non-empty test_paths" in err for err in errors))

    def test_invalid_status_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            _, traceability = _make_base_repo(root)
            traceability["steps"][1]["status"] = "unknown"
            _write_json_yaml(root / "docs/context/traceability.yaml", traceability)

            errors = self.check_context.run_checks(root)
            self.assertTrue(any("invalid status" in err for err in errors))

    def test_pr_template_contains_required_traceability_sections(self) -> None:
        template_path = REPO_ROOT / ".github/pull_request_template.md"
        self.assertTrue(template_path.exists())
        content = template_path.read_text(encoding="utf-8")

        for section in [
            "## spec_refs",
            "## step_refs",
            "## traceability_updated",
            "## tests_run",
            "## adr_required",
        ]:
            self.assertIn(section, content)

    def test_agents_playbook_has_required_workflow_sections(self) -> None:
        agents_path = REPO_ROOT / "AGENTS.md"
        self.assertTrue(agents_path.exists())
        content = agents_path.read_text(encoding="utf-8")

        required_snippets = [
            "## Purpose",
            "## Context Retrieval Order",
            "## A. Planning Workflow",
            "## B. Implementation Workflow",
            "## Validation and Handoff",
            "## Guidance Policy",
            "## Stop/Ask Triggers",
            "SPEC.md",
            "specs/roadmap/step-*.md",
            "docs/protocol/README.md",
            "docs/context/traceability.yaml",
            "docs/context/status.md",
        ]

        for snippet in required_snippets:
            self.assertIn(snippet, content)

    def test_workflow_python_pins_are_compatible_with_project_requirement(self) -> None:
        pyproject_path = REPO_ROOT / "pyproject.toml"
        self.assertTrue(pyproject_path.exists())
        pyproject = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))

        project = pyproject.get("project")
        self.assertIsInstance(project, dict)
        requires_python = project.get("requires-python")
        self.assertIsInstance(requires_python, str)

        min_match = re.search(r">=\s*(\d+)\.(\d+)", requires_python)
        self.assertIsNotNone(
            min_match,
            f"Unable to parse minimum Python version from requires-python: {requires_python}",
        )
        assert min_match is not None
        min_version = (int(min_match.group(1)), int(min_match.group(2)))

        workflow_dir = REPO_ROOT / ".github" / "workflows"
        workflow_paths = sorted(workflow_dir.glob("*.yml"))
        self.assertGreater(len(workflow_paths), 0)

        mismatches: list[str] = []
        unpinned: list[str] = []

        for workflow_path in workflow_paths:
            content = workflow_path.read_text(encoding="utf-8")
            pinned_versions = set(re.findall(r"python-version:\s*[\"']?(\d+\.\d+)", content))
            pinned_versions.update(re.findall(r"--python\s+(\d+\.\d+)", content))

            rel_path = str(workflow_path.relative_to(REPO_ROOT))
            if not pinned_versions:
                unpinned.append(rel_path)
                continue

            for version_str in sorted(pinned_versions):
                major, minor = (int(part) for part in version_str.split(".", maxsplit=1))
                if (major, minor) < min_version:
                    mismatches.append(
                        f"{rel_path} pins Python {version_str} below requires-python {requires_python}"
                    )

        if unpinned:
            self.fail("Missing explicit Python pin(s): " + ", ".join(unpinned))
        if mismatches:
            self.fail("\n".join(mismatches))


if __name__ == "__main__":
    unittest.main()
