#!/usr/bin/env python3
"""Validate Lucida skill structure and contract artifacts."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_ALLOWED_FRONTMATTER_KEYS = {"name", "description"}
_RESERVED_NAME_TERMS = ("anthropic", "claude")


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: list[str]


def _read_frontmatter(skill_md: Path) -> dict[str, str]:
    content = skill_md.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
    if match is None:
        raise ValueError("SKILL.md must start with YAML frontmatter.")

    frontmatter: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if not line.strip():
            continue
        if ":" not in line:
            raise ValueError(f"Invalid frontmatter line: {line}")
        key, raw_value = line.split(":", 1)
        key = key.strip()
        value = raw_value.strip()
        if value.startswith("\"") and value.endswith("\""):
            value = value[1:-1]
        frontmatter[key] = value
    return frontmatter


def _validate_frontmatter(skill_root: Path, errors: list[str]) -> None:
    skill_md = skill_root / "SKILL.md"
    if not skill_md.exists():
        errors.append("Missing SKILL.md")
        return

    skill_lines = skill_md.read_text(encoding="utf-8").splitlines()
    if len(skill_lines) > 500:
        errors.append("SKILL.md should remain under 500 lines for context efficiency.")

    try:
        frontmatter = _read_frontmatter(skill_md)
    except ValueError as exc:
        errors.append(str(exc))
        return

    keys = set(frontmatter)
    if keys != _ALLOWED_FRONTMATTER_KEYS:
        errors.append(
            "SKILL.md frontmatter must contain exactly name and description; "
            f"found: {sorted(keys)}"
        )

    name = frontmatter.get("name", "")
    if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
        errors.append("Frontmatter name must be hyphen-case and <=64 characters.")
    if any(term in name for term in _RESERVED_NAME_TERMS):
        errors.append("Frontmatter name should not include reserved provider terms like 'claude' or 'anthropic'.")

    description = frontmatter.get("description", "")
    if len(description) < 40:
        errors.append("Frontmatter description must be informative (>=40 chars).")
    if "use when" not in description.lower():
        errors.append("Frontmatter description should include explicit trigger context using 'Use when ...'.")
    if re.search(r"\b(i|me|my|mine|you|your|yours)\b", description, flags=re.IGNORECASE):
        errors.append("Frontmatter description should be written in third person.")


def _validate_openai_adapter(skill_root: Path, errors: list[str]) -> None:
    openai_yaml = skill_root / "agents" / "openai.yaml"
    if not openai_yaml.exists():
        errors.append("Missing OpenAI adapter metadata: agents/openai.yaml")
        return

    content = openai_yaml.read_text(encoding="utf-8")
    if "interface:" not in content:
        errors.append("OpenAI adapter must include interface: block.")
        return

    match = re.search(r"short_description:\s*\"(.*?)\"", content)
    if match is None:
        errors.append("OpenAI adapter missing interface.short_description.")
    else:
        short_description = match.group(1)
        if not (25 <= len(short_description) <= 64):
            errors.append(
                "OpenAI interface.short_description must be between 25 and 64 characters."
            )

    default_prompt_match = re.search(r"default_prompt:\s*\"(.*?)\"", content)
    if default_prompt_match is None:
        errors.append("OpenAI adapter missing interface.default_prompt.")
    else:
        default_prompt = default_prompt_match.group(1)
        if "$lucida-orchestrator" not in default_prompt:
            errors.append("OpenAI default_prompt must mention $lucida-orchestrator.")


def _validate_anthropic_adapter(skill_root: Path, errors: list[str]) -> None:
    path = skill_root / "adapters" / "anthropic" / "skill-container.json"
    if not path.exists():
        errors.append("Missing Anthropic adapter metadata: adapters/anthropic/skill-container.json")
        return

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"Invalid anthropic adapter JSON: {exc}")
        return

    container_skill = payload.get("container_skill")
    if payload.get("provider") != "anthropic":
        errors.append("Anthropic adapter provider must be 'anthropic'.")
    if not isinstance(container_skill, dict):
        errors.append("Anthropic adapter must include container_skill object.")
        return

    if container_skill.get("type") != "custom":
        errors.append("Anthropic adapter container_skill.type must be 'custom'.")
    if container_skill.get("entrypoint") != "SKILL.md":
        errors.append("Anthropic adapter entrypoint must be SKILL.md.")


def _validate_operation_matrix(skill_root: Path, errors: list[str]) -> None:
    matrix_path = skill_root / "references" / "operation-matrix.json"
    if not matrix_path.exists():
        errors.append("Missing references/operation-matrix.json")
        return

    try:
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"Invalid operation matrix JSON: {exc}")
        return

    if matrix.get("schema_version") != 1:
        errors.append("operation-matrix schema_version must be 1.")
    if matrix.get("surface") != "current":
        errors.append("operation-matrix surface must be current.")

    operations = matrix.get("operations")
    if not isinstance(operations, list) or not operations:
        errors.append("operation-matrix operations must be a non-empty list.")
        return

    seen_ids: set[str] = set()
    required_op_keys = {
        "id",
        "cli_command",
        "http_method",
        "http_path",
        "cli_template",
        "http_template",
        "required_inputs",
        "expected_outputs",
        "failure_hints",
    }

    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            errors.append(f"operation[{index}] must be an object.")
            continue

        missing = sorted(required_op_keys - set(operation))
        if missing:
            errors.append(f"operation[{index}] missing keys: {missing}")
            continue

        op_id = str(operation["id"])
        if op_id in seen_ids:
            errors.append(f"Duplicate operation id: {op_id}")
        seen_ids.add(op_id)

        cli_template_path = skill_root / str(operation["cli_template"])
        http_template_path = skill_root / str(operation["http_template"])

        if not cli_template_path.exists():
            errors.append(f"Missing CLI template for {op_id}: {cli_template_path}")
        else:
            cli_content = cli_template_path.read_text(encoding="utf-8")
            if f"# {op_id}" not in cli_content:
                errors.append(f"CLI template header mismatch for {op_id}: {cli_template_path}")

        if not http_template_path.exists():
            errors.append(f"Missing HTTP template for {op_id}: {http_template_path}")
        else:
            try:
                http_template = json.loads(http_template_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                errors.append(f"Invalid HTTP template JSON for {op_id}: {exc}")
                http_template = None

            if isinstance(http_template, dict):
                if http_template.get("operation_id") != op_id:
                    errors.append(f"HTTP template operation_id mismatch for {op_id}.")
                if str(http_template.get("method", "")).upper() != str(operation["http_method"]):
                    errors.append(f"HTTP template method mismatch for {op_id}.")
                if http_template.get("path") != operation["http_path"].replace("{view_id}", "<view_id>"):
                    errors.append(f"HTTP template path mismatch for {op_id}.")

        for list_key in ("required_inputs", "expected_outputs", "failure_hints"):
            value = operation[list_key]
            if not isinstance(value, list):
                errors.append(f"Operation {op_id} field {list_key} must be a list.")


def validate_skill(skill_root: Path) -> ValidationResult:
    errors: list[str] = []

    if not skill_root.exists():
        errors.append(f"Skill path does not exist: {skill_root}")
        return ValidationResult(ok=False, errors=errors)

    _validate_frontmatter(skill_root, errors)
    _validate_openai_adapter(skill_root, errors)
    _validate_anthropic_adapter(skill_root, errors)
    _validate_operation_matrix(skill_root, errors)

    for rel_path in (
        "references/operation-matrix.md",
        "references/current-cli.md",
        "references/current-http.md",
        "references/troubleshooting.md",
    ):
        if not (skill_root / rel_path).exists():
            errors.append(f"Missing reference file: {rel_path}")

    reference_root = skill_root / "references"
    if reference_root.exists():
        for path in sorted(reference_root.glob("*.md")):
            lines = path.read_text(encoding="utf-8").splitlines()
            if len(lines) <= 100:
                continue
            header_window = "\n".join(lines[:30]).lower()
            if "table of contents" not in header_window:
                errors.append(
                    f"Reference file {path.name} is longer than 100 lines and should include a table of contents near the top."
                )

    return ValidationResult(ok=not errors, errors=errors)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Lucida skill artifacts.")
    parser.add_argument("--skill", type=Path, required=True, help="Path to skill root.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    result = validate_skill(args.skill.resolve())
    if result.ok:
        print("skill validation passed")
        return 0

    print("skill validation failed")
    for error in result.errors:
        print(f"- {error}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
