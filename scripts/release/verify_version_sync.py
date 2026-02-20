#!/usr/bin/env python3
"""Verify release tag version aligns with Python and Rust metadata."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import tomllib

from parse_tag_version import TagParseError, parse_tag


def _load_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _read_python_version(pyproject_path: Path) -> str:
    data = _load_toml(pyproject_path)
    project = data.get("project")
    if not isinstance(project, dict):
        raise RuntimeError("pyproject.toml missing [project] table")
    version = project.get("version")
    if not isinstance(version, str) or not version:
        raise RuntimeError("pyproject.toml project.version must be a non-empty string")
    return version


def _read_rust_workspace_version(cargo_path: Path) -> str:
    data = _load_toml(cargo_path)
    workspace = data.get("workspace")
    if not isinstance(workspace, dict):
        raise RuntimeError("rust/Cargo.toml missing [workspace] table")
    workspace_package = workspace.get("package")
    if not isinstance(workspace_package, dict):
        raise RuntimeError("rust/Cargo.toml missing [workspace.package] table")
    version = workspace_package.get("version")
    if not isinstance(version, str) or not version:
        raise RuntimeError("rust/Cargo.toml workspace.package.version must be a non-empty string")
    return version


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tag",
        default=os.environ.get("RELEASE_TAG") or os.environ.get("GITHUB_REF_NAME") or "",
        help="Release tag, e.g. v1.2.3 or v1.2.3-rc.1",
    )
    parser.add_argument(
        "--repo-root",
        default=Path(__file__).resolve().parents[2],
        help="Path to repository root",
    )
    args = parser.parse_args()

    if not args.tag:
        print("Missing release tag. Pass --tag or set GITHUB_REF_NAME/RELEASE_TAG.")
        return 1

    try:
        parsed = parse_tag(args.tag)
    except TagParseError as exc:
        print(str(exc))
        return 1

    repo_root = Path(args.repo_root).resolve()
    pyproject_path = repo_root / "pyproject.toml"
    cargo_path = repo_root / "rust" / "Cargo.toml"

    try:
        python_version = _read_python_version(pyproject_path)
        rust_version = _read_rust_workspace_version(cargo_path)
    except RuntimeError as exc:
        print(str(exc))
        return 1

    expected_python = parsed.python_version
    expected_rust = parsed.semver

    failures: list[str] = []
    if python_version != expected_python:
        failures.append(
            "pyproject.toml project.version mismatch: "
            f"expected '{expected_python}', found '{python_version}'"
        )
    if rust_version != expected_rust:
        failures.append(
            "rust/Cargo.toml workspace.package.version mismatch: "
            f"expected '{expected_rust}', found '{rust_version}'"
        )

    if failures:
        for item in failures:
            print(item)
        return 1

    print(
        "Version metadata is synchronized for "
        f"tag {parsed.tag}: python={python_version}, rust={rust_version}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
