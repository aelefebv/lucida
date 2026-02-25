from __future__ import annotations

import json
import subprocess
import tarfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SKILL_ROOT = REPO_ROOT / "skills" / "lucida-orchestrator"


def _run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=True)


def test_validate_skill_script_passes() -> None:
    result = _run(
        [
            "uv",
            "run",
            "python",
            "scripts/skills/validate_skill.py",
            "--skill",
            str(SKILL_ROOT),
        ],
        cwd=REPO_ROOT,
    )
    assert "skill validation passed" in result.stdout


def test_check_drift_script_passes() -> None:
    result = _run(
        [
            "uv",
            "run",
            "python",
            "scripts/skills/check_drift.py",
            "--skill",
            str(SKILL_ROOT),
        ],
        cwd=REPO_ROOT,
    )
    assert "skill drift check passed" in result.stdout


def test_build_adapters_creates_provider_archives(tmp_path: Path) -> None:
    out_dir = tmp_path / "bundles"
    result = _run(
        [
            "uv",
            "run",
            "python",
            "scripts/skills/build_adapters.py",
            "--skill",
            str(SKILL_ROOT),
            "--out",
            str(out_dir),
            "--sha",
            "testsha123456",
        ],
        cwd=REPO_ROOT,
    )

    assert "adapter bundles built" in result.stdout

    openai_bundle = out_dir / "lucida-orchestrator-openai-testsha12345.tar.gz"
    anthropic_bundle = out_dir / "lucida-orchestrator-anthropic-testsha12345.tar.gz"
    manifest_path = out_dir / "manifest.json"

    assert openai_bundle.exists()
    assert anthropic_bundle.exists()
    assert manifest_path.exists()

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["revision"] == "testsha12345"

    with tarfile.open(openai_bundle, "r:gz") as archive:
        names = set(archive.getnames())
    assert "lucida-orchestrator/SKILL.md" in names
    assert "lucida-orchestrator/agents/openai.yaml" in names

    with tarfile.open(anthropic_bundle, "r:gz") as archive:
        names = set(archive.getnames())
    assert "lucida-orchestrator/SKILL.md" in names
    assert "lucida-orchestrator/adapters/anthropic/skill-container.json" in names
