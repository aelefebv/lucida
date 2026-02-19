"""Small JSON Schema helper for protocol conformance tests.

This validates the subset of Draft 2020-12 keywords used by Lucida schemas.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
import re
from typing import Any


@dataclass
class SchemaResolver:
    """Resolve local JSON schema files and fragments."""

    root: Path

    def __post_init__(self) -> None:
        self._cache: dict[Path, dict[str, Any]] = {}

    def load(self, path: Path) -> dict[str, Any]:
        resolved = path.resolve()
        if resolved not in self._cache:
            self._cache[resolved] = json.loads(resolved.read_text(encoding="utf-8"))
        return self._cache[resolved]

    def resolve_ref(self, current_file: Path, ref: str) -> tuple[dict[str, Any], Path]:
        if "#" in ref:
            file_part, frag = ref.split("#", 1)
        else:
            file_part, frag = ref, ""

        if file_part:
            target_file = (current_file.parent / file_part).resolve()
        else:
            target_file = current_file.resolve()

        doc = self.load(target_file)
        if not frag:
            return doc, target_file
        if not frag.startswith("/"):
            raise AssertionError(f"unsupported fragment format: {ref}")

        cursor: Any = doc
        for raw in frag.split("/")[1:]:
            key = raw.replace("~1", "/").replace("~0", "~")
            if isinstance(cursor, dict):
                cursor = cursor[key]
            elif isinstance(cursor, list):
                cursor = cursor[int(key)]
            else:
                raise AssertionError(f"invalid ref path segment: {raw}")
        if not isinstance(cursor, dict):
            raise AssertionError(f"resolved ref is not schema object: {ref}")
        return cursor, target_file


def _validate_type(instance: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(instance, dict)
    if expected == "array":
        return isinstance(instance, list)
    if expected == "string":
        return isinstance(instance, str)
    if expected == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if expected == "number":
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
    if expected == "boolean":
        return isinstance(instance, bool)
    return True


def validate(
    instance: Any,
    schema: dict[str, Any],
    resolver: SchemaResolver,
    *,
    current_file: Path,
    path: str = "$",
) -> list[str]:
    errors: list[str] = []

    if "$ref" in schema:
        target_schema, target_file = resolver.resolve_ref(current_file, schema["$ref"])
        return validate(instance, target_schema, resolver, current_file=target_file, path=path)

    if "allOf" in schema:
        for sub in schema["allOf"]:
            errors.extend(validate(instance, sub, resolver, current_file=current_file, path=path))
    if "anyOf" in schema:
        sub_errors = [
            validate(instance, sub, resolver, current_file=current_file, path=path)
            for sub in schema["anyOf"]
        ]
        if not any(len(e) == 0 for e in sub_errors):
            errors.append(f"{path}: does not satisfy anyOf")
    if "oneOf" in schema:
        sub_errors = [
            validate(instance, sub, resolver, current_file=current_file, path=path)
            for sub in schema["oneOf"]
        ]
        matched = sum(1 for e in sub_errors if len(e) == 0)
        if matched != 1:
            errors.append(f"{path}: expected exactly one schema match in oneOf, got {matched}")

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: value {instance!r} not in enum")

    expected_type = schema.get("type")
    if expected_type and not _validate_type(instance, expected_type):
        errors.append(f"{path}: expected type {expected_type}")
        return errors

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength")
        if "pattern" in schema:
            if not re.match(schema["pattern"], instance):
                errors.append(f"{path}: does not match pattern")
        if schema.get("format") == "date-time":
            text = instance.replace("Z", "+00:00")
            try:
                datetime.fromisoformat(text)
            except ValueError:
                errors.append(f"{path}: invalid date-time")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: above maximum")
        if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
            errors.append(f"{path}: not above exclusiveMinimum")
        if "exclusiveMaximum" in schema and instance >= schema["exclusiveMaximum"]:
            errors.append(f"{path}: not below exclusiveMaximum")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: fewer than minItems")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: more than maxItems")
        if schema.get("uniqueItems"):
            seen = set()
            for idx, value in enumerate(instance):
                marker = json.dumps(value, sort_keys=True)
                if marker in seen:
                    errors.append(f"{path}[{idx}]: duplicate item not allowed")
                    break
                seen.add(marker)
        if "items" in schema:
            for idx, item in enumerate(instance):
                errors.extend(
                    validate(
                        item,
                        schema["items"],
                        resolver,
                        current_file=current_file,
                        path=f"{path}[{idx}]",
                    )
                )

    if isinstance(instance, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in instance:
                errors.append(f"{path}: missing required field '{key}'")

        properties = schema.get("properties", {})
        for key, value in instance.items():
            if key in properties:
                errors.extend(
                    validate(
                        value,
                        properties[key],
                        resolver,
                        current_file=current_file,
                        path=f"{path}.{key}",
                    )
                )
            else:
                additional = schema.get("additionalProperties", True)
                if additional is False:
                    errors.append(f"{path}: additional property '{key}' is not allowed")
                elif isinstance(additional, dict):
                    errors.extend(
                        validate(
                            value,
                            additional,
                            resolver,
                            current_file=current_file,
                            path=f"{path}.{key}",
                        )
                    )

    return errors


def assert_valid(
    instance: Any,
    schema: dict[str, Any],
    resolver: SchemaResolver,
    current_file: Path,
) -> None:
    errors = validate(instance, schema, resolver, current_file=current_file)
    if errors:
        joined = "\n".join(errors)
        raise AssertionError(f"schema validation failed:\n{joined}")


def assert_invalid(
    instance: Any,
    schema: dict[str, Any],
    resolver: SchemaResolver,
    current_file: Path,
) -> None:
    errors = validate(instance, schema, resolver, current_file=current_file)
    if not errors:
        raise AssertionError("expected invalid instance, but validation passed")

