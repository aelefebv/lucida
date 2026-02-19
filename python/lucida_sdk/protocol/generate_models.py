#!/usr/bin/env python3
"""Generate typed protocol models from JSON Schema definitions."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATHS = [
    Path("protocol/schemas/common/primitives.schema.json"),
    Path("protocol/schemas/common/types.schema.json"),
    Path("protocol/schemas/errors/error.schema.json"),
    Path("protocol/schemas/requests/methods.request.schema.json"),
    Path("protocol/schemas/responses/methods.response.schema.json"),
    Path("protocol/schemas/events/events.schema.json"),
    Path("protocol/command-log/lucida.commandlog.v1.schema.json"),
]
OUTPUT_PATH = Path("python/lucida_sdk/protocol/generated/models.py")


def schema_digest() -> str:
    digest = hashlib.sha256()
    for rel_path in SCHEMA_PATHS:
        blob = (REPO_ROOT / rel_path).read_bytes()
        digest.update(rel_path.as_posix().encode("utf-8"))
        digest.update(b"\n")
        digest.update(blob)
        digest.update(b"\n")
    return digest.hexdigest()


def title_to_name(ref: str) -> str:
    if "#/$defs/" in ref:
        return ref.split("#/$defs/")[-1]
    if "/" in ref:
        return ref.split("/")[-1]
    return ref


def to_literal(value: Any) -> str:
    return repr(value)


def schema_to_annotation(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return title_to_name(schema["$ref"])
    if "const" in schema:
        return f"Literal[{to_literal(schema['const'])}]"
    if "enum" in schema:
        parts = ", ".join(to_literal(item) for item in schema["enum"])
        return f"Literal[{parts}]"
    if "oneOf" in schema:
        parts = sorted({schema_to_annotation(item) for item in schema["oneOf"]})
        return " | ".join(parts) if parts else "Any"
    if "anyOf" in schema:
        parts = sorted({schema_to_annotation(item) for item in schema["anyOf"]})
        return " | ".join(parts) if parts else "Any"
    if "allOf" in schema:
        parts = sorted({schema_to_annotation(item) for item in schema["allOf"]})
        return " | ".join(parts) if parts else "Any"

    schema_type = schema.get("type")
    if schema_type == "string":
        return "str"
    if schema_type == "integer":
        return "int"
    if schema_type == "number":
        return "float"
    if schema_type == "boolean":
        return "bool"
    if schema_type == "array":
        item_schema = schema.get("items", {})
        return f"list[{schema_to_annotation(item_schema)}]"
    if schema_type == "object":
        return "dict[str, Any]"
    return "Any"


def load_defs() -> dict[str, dict[str, Any]]:
    defs: dict[str, dict[str, Any]] = {}
    for rel_path in SCHEMA_PATHS:
        schema = json.loads((REPO_ROOT / rel_path).read_text(encoding="utf-8"))
        for def_name, def_schema in schema.get("$defs", {}).items():
            if def_name in defs:
                raise RuntimeError(f"duplicate definition name: {def_name}")
            defs[def_name] = def_schema
    return defs


def render_models(defs: dict[str, dict[str, Any]], digest: str) -> str:
    lines: list[str] = []
    lines.append('"""Generated protocol models. Do not edit by hand."""')
    lines.append("")
    lines.append("from __future__ import annotations")
    lines.append("")
    lines.append("from typing import Any, Literal, NotRequired, TypedDict")
    lines.append("")
    lines.append(f'SCHEMA_DIGEST = "{digest}"')
    lines.append("")

    object_defs: list[tuple[str, dict[str, Any]]] = []
    alias_defs: list[tuple[str, dict[str, Any]]] = []
    for def_name in sorted(defs):
        schema = defs[def_name]
        if schema.get("type") == "object" and isinstance(schema.get("properties"), dict):
            object_defs.append((def_name, schema))
        else:
            alias_defs.append((def_name, schema))

    for def_name, schema in object_defs:
        properties = schema.get("properties")
        required = set(schema.get("required", []))
        lines.append(f"class {def_name}(TypedDict):")
        if not properties:
            lines.append("    pass")
        else:
            for prop_name in sorted(properties):
                annotation = schema_to_annotation(properties[prop_name])
                if prop_name in required:
                    lines.append(f"    {prop_name}: {annotation}")
                else:
                    lines.append(f"    {prop_name}: NotRequired[{annotation}]")
        lines.append("")

    for def_name, schema in alias_defs:
        annotation = schema_to_annotation(schema)
        lines.append(f"{def_name} = {annotation}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def generate() -> str:
    defs = load_defs()
    digest = schema_digest()
    return render_models(defs, digest)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate that generated models are up to date.",
    )
    args = parser.parse_args()

    generated = generate()
    target = REPO_ROOT / OUTPUT_PATH

    if args.check:
        if not target.exists():
            print(f"missing generated file: {target}")
            return 1
        existing = target.read_text(encoding="utf-8")
        if existing != generated:
            print("generated models are stale; run generate_models.py")
            return 1
        return 0

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(generated, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
