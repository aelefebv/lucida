#!/usr/bin/env python3
"""Build deterministic OpenAI and Anthropic adapter bundles for Lucida skill."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tarfile
from pathlib import Path
from typing import Iterable

import check_drift
import validate_skill


def _resolve_sha(explicit_sha: str | None) -> str:
    if explicit_sha:
        return explicit_sha[:12]

    github_sha = os.environ.get("GITHUB_SHA", "").strip()
    if github_sha:
        return github_sha[:12]

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            check=True,
            text=True,
            capture_output=True,
        )
        value = result.stdout.strip()
        if value:
            return value
    except subprocess.CalledProcessError:
        pass

    return "dev"


def _read_skill_name(skill_root: Path) -> str:
    for line in (skill_root / "SKILL.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip().strip('"')
    raise ValueError("Unable to resolve skill name from SKILL.md")


def _deterministic_filter(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo:
    tarinfo.uid = 0
    tarinfo.gid = 0
    tarinfo.uname = "root"
    tarinfo.gname = "root"
    tarinfo.mtime = 0
    return tarinfo


def _collect_common_files(skill_root: Path) -> list[Path]:
    files: list[Path] = [skill_root / "SKILL.md"]
    files.extend(sorted((skill_root / "references").rglob("*")))
    files.extend(sorted((skill_root / "templates").rglob("*")))
    return [path for path in files if path.is_file()]


def _provider_files(skill_root: Path, provider: str) -> list[Path]:
    if provider == "openai":
        return [skill_root / "agents" / "openai.yaml"]
    if provider == "anthropic":
        return [skill_root / "adapters" / "anthropic" / "skill-container.json"]
    raise ValueError(f"Unsupported provider: {provider}")


def _bundle_provider(
    *,
    provider: str,
    skill_root: Path,
    output_dir: Path,
    skill_name: str,
    revision: str,
) -> Path:
    archive_name = f"{skill_name}-{provider}-{revision}.tar.gz"
    archive_path = output_dir / archive_name

    common_files = _collect_common_files(skill_root)
    provider_files = _provider_files(skill_root, provider)

    missing = [path for path in provider_files if not path.exists()]
    if missing:
        joined = ", ".join(str(path) for path in missing)
        raise FileNotFoundError(f"Missing provider metadata for {provider}: {joined}")

    included_files = sorted(set(common_files + provider_files))

    with tarfile.open(archive_path, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for path in included_files:
            rel = path.relative_to(skill_root)
            arcname = f"{skill_name}/{rel.as_posix()}"
            tar.add(path, arcname=arcname, filter=_deterministic_filter)

    return archive_path


def build_adapters(skill_root: Path, output_dir: Path, repo_root: Path, sha: str | None) -> dict[str, str]:
    validation = validate_skill.validate_skill(skill_root)
    if not validation.ok:
        joined = "\n".join(f"- {item}" for item in validation.errors)
        raise ValueError(f"Skill validation failed before bundling:\n{joined}")

    drift = check_drift.check_drift(repo_root=repo_root, skill_root=skill_root)
    if not drift.ok:
        joined = "\n".join(f"- {item}" for item in drift.errors)
        raise ValueError(f"Skill drift check failed before bundling:\n{joined}")

    output_dir.mkdir(parents=True, exist_ok=True)

    skill_name = _read_skill_name(skill_root)
    revision = _resolve_sha(sha)

    openai_bundle = _bundle_provider(
        provider="openai",
        skill_root=skill_root,
        output_dir=output_dir,
        skill_name=skill_name,
        revision=revision,
    )
    anthropic_bundle = _bundle_provider(
        provider="anthropic",
        skill_root=skill_root,
        output_dir=output_dir,
        skill_name=skill_name,
        revision=revision,
    )

    manifest = {
        "skill_name": skill_name,
        "revision": revision,
        "bundles": {
            "openai": str(openai_bundle),
            "anthropic": str(anthropic_bundle),
        },
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    return manifest["bundles"]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Lucida skill provider adapter bundles.")
    parser.add_argument("--skill", type=Path, required=True, help="Path to skill root.")
    parser.add_argument("--out", type=Path, required=True, help="Output directory for bundles.")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="Repository root for drift checks.",
    )
    parser.add_argument("--sha", type=str, default=None, help="Override revision suffix.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    bundles = build_adapters(
        skill_root=args.skill.resolve(),
        output_dir=args.out.resolve(),
        repo_root=args.repo_root.resolve(),
        sha=args.sha,
    )
    print("adapter bundles built")
    for provider, path in bundles.items():
        print(f"- {provider}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
