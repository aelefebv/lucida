from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from schema_tools import assert_invalid, assert_valid, SchemaResolver


ROOT = Path(__file__).resolve().parents[2]


def _sample_string(schema: dict) -> str:
    pattern = schema.get("pattern", "")
    if pattern.startswith("^[0-9a-f]{8}-") and "-7" in pattern:
        return "0194c8f0-c7fa-7a2d-8abc-1234567890ab"
    if "0|[1-9]" in pattern and "\\." in pattern:
        return "1.2.3"
    if "[0-9a-f]{64}" in pattern:
        return "a" * 64
    if "A-Za-z0-9._:-" in pattern:
        return "idem-key-1234"
    if "[a-z][a-z0-9_]" in pattern:
        return "x"
    min_length = schema.get("minLength", 1)
    return "x" * max(min_length, 1)


def _sample_from_schema(
    schema: dict,
    resolver: SchemaResolver,
    current_file: Path,
) -> object:
    if "$ref" in schema:
        target, target_file = resolver.resolve_ref(current_file, schema["$ref"])
        return _sample_from_schema(target, resolver, target_file)

    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    if "oneOf" in schema:
        return _sample_from_schema(schema["oneOf"][0], resolver, current_file)
    if "anyOf" in schema:
        return _sample_from_schema(schema["anyOf"][0], resolver, current_file)
    if "allOf" in schema:
        merged: dict[str, object] = {}
        for sub in schema["allOf"]:
            value = _sample_from_schema(sub, resolver, current_file)
            if isinstance(value, dict):
                merged.update(value)
        return merged

    schema_type = schema.get("type")
    if schema_type == "string":
        if schema.get("format") == "date-time":
            return "2026-01-01T00:00:00Z"
        return _sample_string(schema)
    if schema_type == "integer":
        minimum = schema.get("minimum", 0)
        return max(int(minimum), 0)
    if schema_type == "number":
        minimum = schema.get("minimum", 0.0)
        exclusive = schema.get("exclusiveMinimum")
        if exclusive is not None:
            return float(exclusive) + 1.0
        return float(minimum)
    if schema_type == "boolean":
        return True
    if schema_type == "array":
        count = schema.get("minItems", 1)
        item = schema.get("items", {})
        return [_sample_from_schema(item, resolver, current_file) for _ in range(max(count, 1))]
    if schema_type == "object":
        out: dict[str, object] = {}
        properties = schema.get("properties", {})
        required = schema.get("required", [])
        for key in required:
            out[key] = _sample_from_schema(properties[key], resolver, current_file)
        return out
    return {}


class SchemaConformanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.resolver = SchemaResolver(ROOT)
        self.requests_file = ROOT / "protocol/schemas/requests/methods.request.schema.json"
        self.responses_file = ROOT / "protocol/schemas/responses/methods.response.schema.json"
        self.events_file = ROOT / "protocol/schemas/events/events.schema.json"
        self.common_types_file = ROOT / "protocol/schemas/common/types.schema.json"
        self.errors_file = ROOT / "protocol/schemas/errors/error.schema.json"
        self.log_file = ROOT / "protocol/command-log/lucida.commandlog.v1.schema.json"

    def test_request_defs_have_valid_samples(self) -> None:
        data = self.resolver.load(self.requests_file)
        for name, schema in data["$defs"].items():
            with self.subTest(definition=name):
                sample = _sample_from_schema(schema, self.resolver, self.requests_file)
                assert_valid(sample, schema, self.resolver, self.requests_file)

    def test_response_defs_have_valid_samples(self) -> None:
        data = self.resolver.load(self.responses_file)
        for name, schema in data["$defs"].items():
            with self.subTest(definition=name):
                sample = _sample_from_schema(schema, self.resolver, self.responses_file)
                assert_valid(sample, schema, self.resolver, self.responses_file)

    def test_event_defs_have_valid_samples(self) -> None:
        data = self.resolver.load(self.events_file)
        for name, schema in data["$defs"].items():
            with self.subTest(definition=name):
                sample = _sample_from_schema(schema, self.resolver, self.events_file)
                assert_valid(sample, schema, self.resolver, self.events_file)

    def test_error_envelope_valid_and_invalid(self) -> None:
        error_schema = self.resolver.load(self.errors_file)["$defs"]["ErrorEnvelope"]
        valid = {
            "code": "LUCIDA_INTERNAL",
            "message": "boom",
            "details": {},
            "retryable": False,
        }
        assert_valid(valid, error_schema, self.resolver, self.errors_file)
        invalid = copy.deepcopy(valid)
        invalid["code"] = "BAD_CODE"
        assert_invalid(invalid, error_schema, self.resolver, self.errors_file)

    def test_dataref_union_rejects_unknown_kind(self) -> None:
        dataref_schema = self.resolver.load(self.common_types_file)["$defs"]["DataRef"]
        invalid = {
            "kind": "stream",
            "dtype": "float32",
            "shape": [100],
            "endianness": "little",
            "compression": "none",
            "ttl_ms": 10,
            "checksum_sha256": "a" * 64,
        }
        assert_invalid(invalid, dataref_schema, self.resolver, self.common_types_file)

    def test_negative_session_seq_is_invalid(self) -> None:
        event_schema = self.resolver.load(self.events_file)["$defs"]["JobProgressEvent"]
        sample = _sample_from_schema(event_schema, self.resolver, self.events_file)
        assert isinstance(sample, dict)
        sample["session_seq"] = -1
        assert_invalid(sample, event_schema, self.resolver, self.events_file)

    def test_command_log_schema_sample(self) -> None:
        log_schema = self.resolver.load(self.log_file)
        sample = _sample_from_schema(log_schema, self.resolver, self.log_file)
        assert_valid(sample, log_schema, self.resolver, self.log_file)

    def test_command_log_sample_is_json_serializable(self) -> None:
        log_schema = self.resolver.load(self.log_file)
        sample = _sample_from_schema(log_schema, self.resolver, self.log_file)
        serialized = json.dumps(sample, sort_keys=True)
        self.assertTrue(serialized.startswith("{"))


if __name__ == "__main__":
    unittest.main()
