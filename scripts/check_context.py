#!/usr/bin/env python3
"""Validate Lucida context artifacts and step traceability contracts."""

from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
from typing import Any


ALLOWED_STATUSES = {"planned", "in_progress", "blocked", "done"}


def _parse_date(value: str, field: str, errors: list[str]) -> None:
    try:
        date.fromisoformat(value)
    except ValueError:
        errors.append(f"{field}: invalid date format (expected YYYY-MM-DD)")


def _load_yaml_like_json(path: Path, errors: list[str]) -> dict[str, Any]:
    if not path.exists():
        errors.append(f"missing file: {path}")
        return {}

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"failed reading {path}: {exc}")
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        errors.append(
            f"{path}: parse error. Context .yaml files must be valid JSON-compatible YAML. {exc}"
        )
        return {}

    if not isinstance(data, dict):
        errors.append(f"{path}: top-level object must be a mapping")
        return {}

    return data


def _collect_step_specs(repo_root: Path) -> set[str]:
    return {
        str(path.relative_to(repo_root))
        for path in sorted((repo_root / "specs" / "roadmap").glob("step-*.md"))
    }


def _validate_required_keys(
    obj: dict[str, Any],
    required: list[str],
    location: str,
    errors: list[str],
) -> None:
    for key in required:
        if key not in obj:
            errors.append(f"{location}: missing required key '{key}'")


def _validate_path_exists(repo_root: Path, rel_path: str, location: str, errors: list[str]) -> None:
    if not rel_path:
        errors.append(f"{location}: empty path")
        return

    target = repo_root / rel_path
    if not target.exists():
        errors.append(f"{location}: path does not exist: {rel_path}")


def validate_index(repo_root: Path, index: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    _validate_required_keys(index, ["version", "last_updated", "artifacts"], "index.yaml", errors)

    if "last_updated" in index and isinstance(index["last_updated"], str):
        _parse_date(index["last_updated"], "index.yaml:last_updated", errors)

    artifacts = index.get("artifacts")
    if not isinstance(artifacts, list):
        errors.append("index.yaml: 'artifacts' must be a list")
        return errors

    seen_ids: set[str] = set()
    for idx, artifact in enumerate(artifacts):
        location = f"index.yaml:artifacts[{idx}]"
        if not isinstance(artifact, dict):
            errors.append(f"{location}: entry must be an object")
            continue
        _validate_required_keys(
            artifact,
            ["id", "path", "role", "owner", "update_trigger"],
            location,
            errors,
        )

        artifact_id = artifact.get("id")
        if isinstance(artifact_id, str):
            if artifact_id in seen_ids:
                errors.append(f"{location}: duplicate artifact id '{artifact_id}'")
            seen_ids.add(artifact_id)

        path_val = artifact.get("path")
        if isinstance(path_val, str):
            _validate_path_exists(repo_root, path_val, f"{location}:path", errors)

    return errors


def validate_traceability(
    repo_root: Path,
    traceability: dict[str, Any],
    step_specs: set[str],
) -> list[str]:
    errors: list[str] = []
    _validate_required_keys(
        traceability,
        ["version", "last_updated", "steps"],
        "traceability.yaml",
        errors,
    )

    if "last_updated" in traceability and isinstance(traceability["last_updated"], str):
        _parse_date(traceability["last_updated"], "traceability.yaml:last_updated", errors)

    steps = traceability.get("steps")
    if not isinstance(steps, list):
        errors.append("traceability.yaml: 'steps' must be a list")
        return errors

    required_step_keys = [
        "step_id",
        "step_spec_path",
        "status",
        "implementation_paths",
        "test_paths",
        "protocol_artifacts",
        "last_validated",
    ]

    traceability_steps: set[str] = set()

    for idx, step in enumerate(steps):
        location = f"traceability.yaml:steps[{idx}]"
        if not isinstance(step, dict):
            errors.append(f"{location}: entry must be an object")
            continue

        _validate_required_keys(step, required_step_keys, location, errors)

        step_id = step.get("step_id")
        if isinstance(step_id, str):
            if step_id in traceability_steps:
                errors.append(f"{location}: duplicate step_id '{step_id}'")
            traceability_steps.add(step_id)

        step_spec_path = step.get("step_spec_path")
        if isinstance(step_spec_path, str):
            _validate_path_exists(repo_root, step_spec_path, f"{location}:step_spec_path", errors)
            if step_spec_path not in step_specs:
                errors.append(f"{location}: step_spec_path not found in specs/roadmap: {step_spec_path}")

        status = step.get("status")
        if isinstance(status, str):
            if status not in ALLOWED_STATUSES:
                errors.append(
                    f"{location}: invalid status '{status}', expected one of {sorted(ALLOWED_STATUSES)}"
                )

        for list_key in ["implementation_paths", "test_paths", "protocol_artifacts"]:
            value = step.get(list_key)
            if not isinstance(value, list):
                errors.append(f"{location}:{list_key}: must be a list")
                continue
            for i, path_value in enumerate(value):
                if not isinstance(path_value, str):
                    errors.append(f"{location}:{list_key}[{i}]: must be a string path")
                    continue
                _validate_path_exists(repo_root, path_value, f"{location}:{list_key}[{i}]", errors)

        if status == "done":
            impl = step.get("implementation_paths")
            tests = step.get("test_paths")
            if not isinstance(impl, list) or len(impl) == 0:
                errors.append(f"{location}: status 'done' requires non-empty implementation_paths")
            if not isinstance(tests, list) or len(tests) == 0:
                errors.append(f"{location}: status 'done' requires non-empty test_paths")

            last_validated = step.get("last_validated")
            if not isinstance(last_validated, str) or not last_validated:
                errors.append(f"{location}: status 'done' requires non-empty last_validated")
            else:
                _parse_date(last_validated, f"{location}:last_validated", errors)

        if status in {"planned", "in_progress", "blocked"}:
            last_validated = step.get("last_validated")
            if isinstance(last_validated, str) and last_validated:
                _parse_date(last_validated, f"{location}:last_validated", errors)

    traceability_paths = {
        step.get("step_spec_path")
        for step in steps
        if isinstance(step, dict) and isinstance(step.get("step_spec_path"), str)
    }

    missing_paths = sorted(step_specs - traceability_paths)
    extra_paths = sorted(traceability_paths - step_specs)

    if missing_paths:
        errors.append(
            "traceability.yaml: missing step rows for: " + ", ".join(missing_paths)
        )
    if extra_paths:
        errors.append(
            "traceability.yaml: includes unknown step_spec_path entries: " + ", ".join(extra_paths)
        )

    return errors


def run_checks(repo_root: Path) -> list[str]:
    errors: list[str] = []

    index_path = repo_root / "docs" / "context" / "index.yaml"
    traceability_path = repo_root / "docs" / "context" / "traceability.yaml"

    index = _load_yaml_like_json(index_path, errors)
    traceability = _load_yaml_like_json(traceability_path, errors)
    step_specs = _collect_step_specs(repo_root)

    if not step_specs:
        errors.append("no roadmap step specs found under specs/roadmap")

    if index:
        errors.extend(validate_index(repo_root, index))
    if traceability:
        errors.extend(validate_traceability(repo_root, traceability, step_specs))

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Path to repository root (default: current directory)",
    )
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    errors = run_checks(repo_root)

    if errors:
        print("Context checks failed:")
        for err in errors:
            print(f"- {err}")
        return 1

    print("Context checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
