"""Command log storage, parsing, and replay helpers for Step 09."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path
import uuid
from urllib.parse import unquote, urlparse
from typing import Any


COMMAND_LOG_METHODS = frozenset(
    {
        "command_log.export",
        "command_log.import",
        "command_log.replay",
    }
)
REQUEST_META_FIELDS = frozenset(
    {
        "protocol_version",
        "request_id",
        "idempotency_key",
    }
)

_COMMAND_KEYS = frozenset({"kind", "seq", "recorded_at", "correlation_id", "method", "request"})
_REQUEST_KEYS = frozenset({"protocol_version", "request_id", "idempotency_key", "params"})
_EVENT_RECORD_KEYS = frozenset({"kind", "seq", "recorded_at", "correlation_id", "event"})
_EVENT_KEYS = frozenset({"protocol_version", "session_id", "event_id", "event_type", "session_seq", "emitted_at", "payload"})


class CommandLogValidationError(ValueError):
    """Command log content failed shape or deterministic integrity checks."""


class CommandLogStorageError(RuntimeError):
    """Command log URI resolution or filesystem/memory IO failed."""


@dataclass(frozen=True)
class ReplayStep:
    command: dict[str, Any]
    expected_events: list[dict[str, Any]]


def method_params_from_request(params: dict[str, Any]) -> dict[str, Any]:
    return {key: deepcopy(value) for key, value in params.items() if key not in REQUEST_META_FIELDS}


def build_command_record(
    *,
    seq: int,
    recorded_at: str,
    correlation_id: str,
    method: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(seq, int) or seq <= 0:
        raise ValueError("seq must be a positive integer")
    return {
        "kind": "command",
        "seq": seq,
        "recorded_at": recorded_at,
        "correlation_id": correlation_id,
        "method": method,
        "request": deepcopy(request),
    }


def build_event_record(
    *,
    seq: int,
    recorded_at: str,
    correlation_id: str,
    event: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(seq, int) or seq <= 0:
        raise ValueError("seq must be a positive integer")
    return {
        "kind": "event",
        "seq": seq,
        "recorded_at": recorded_at,
        "correlation_id": correlation_id,
        "event": deepcopy(event),
    }


def canonical_json_line(record: dict[str, Any]) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def parse_jsonl_lines(raw: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise CommandLogValidationError(f"Line {line_number} is not valid JSON: {exc.msg}") from exc
        if not isinstance(parsed, dict):
            raise CommandLogValidationError(f"Line {line_number} must be a JSON object")
        records.append(parsed)
    return records


def validate_records(records: list[dict[str, Any]], *, protocol_version: str) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    expected_seq = 1
    seen_correlations: set[str] = set()

    for index, record in enumerate(records, start=1):
        normalized_record = _validate_record(record, index=index)
        seq = normalized_record["seq"]
        if seq != expected_seq:
            raise CommandLogValidationError(
                f"Record sequence must be contiguous starting at 1 (expected {expected_seq}, got {seq})"
            )
        expected_seq += 1

        correlation_id = normalized_record["correlation_id"]
        kind = normalized_record["kind"]
        if kind == "command":
            request = normalized_record["request"]
            if request["protocol_version"] != protocol_version:
                raise CommandLogValidationError(
                    f"Unsupported command protocol_version '{request['protocol_version']}' at seq {seq}"
                )
            if correlation_id in seen_correlations:
                raise CommandLogValidationError(f"Duplicate command correlation_id '{correlation_id}' at seq {seq}")
            seen_correlations.add(correlation_id)
        else:
            event = normalized_record["event"]
            if event["protocol_version"] != protocol_version:
                raise CommandLogValidationError(
                    f"Unsupported event protocol_version '{event['protocol_version']}' at seq {seq}"
                )
            if correlation_id not in seen_correlations:
                raise CommandLogValidationError(
                    f"Event record at seq {seq} references unknown correlation_id '{correlation_id}'"
                )

        normalized.append(normalized_record)

    return normalized


def group_replay_steps(records: list[dict[str, Any]]) -> list[ReplayStep]:
    steps: list[ReplayStep] = []
    current_command: dict[str, Any] | None = None
    current_events: list[dict[str, Any]] = []
    current_correlation: str | None = None

    for record in records:
        kind = record["kind"]
        if kind == "command":
            if current_command is not None:
                steps.append(ReplayStep(command=deepcopy(current_command), expected_events=deepcopy(current_events)))
            current_command = record
            current_events = []
            current_correlation = record["correlation_id"]
            continue

        if current_command is None or current_correlation is None:
            raise CommandLogValidationError("Event record appears before any command record")
        if record["correlation_id"] != current_correlation:
            raise CommandLogValidationError(
                "Event record correlation_id must match the most recent command record correlation_id"
            )
        current_events.append(record)

    if current_command is not None:
        steps.append(ReplayStep(command=deepcopy(current_command), expected_events=deepcopy(current_events)))
    return steps


def canonicalize_logged_event(record: dict[str, Any]) -> dict[str, Any]:
    event = record.get("event", {})
    if not isinstance(event, dict):
        return {"event_type": None, "payload": None}
    return {
        "event_type": event.get("event_type"),
        "payload": deepcopy(event.get("payload")),
    }


def canonicalize_runtime_event(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "event_type": event.get("event_type"),
        "payload": deepcopy(event.get("payload")),
    }


class CommandLogStore:
    """Persistent command log storage over local filesystem and memory URIs."""

    def __init__(self) -> None:
        self._memory_jsonl: dict[str, str] = {}

    def write_records(self, *, uri: str, records: list[dict[str, Any]]) -> int:
        target = _resolve_uri(uri)
        payload = self._serialize_jsonl(records)

        if target.kind == "memory":
            self._memory_jsonl[target.value] = payload
            return len(records)

        path = Path(target.value)
        parent = path.parent
        if not parent.exists():
            raise CommandLogStorageError(f"Parent directory does not exist for destination_uri '{uri}'")
        temp_name = f".{path.name}.tmp-{uuid.uuid4().hex}"
        temp_path = parent / temp_name
        try:
            temp_path.write_text(payload, encoding="utf-8")
            temp_path.replace(path)
        except OSError as exc:
            raise CommandLogStorageError(f"Failed to write command log to '{uri}': {exc}") from exc
        return len(records)

    def read_records(self, *, uri: str) -> list[dict[str, Any]]:
        target = _resolve_uri(uri)
        if target.kind == "memory":
            raw = self._memory_jsonl.get(target.value)
            if raw is None:
                raise CommandLogStorageError(f"Command log memory URI does not exist: '{uri}'")
            return parse_jsonl_lines(raw)

        path = Path(target.value)
        if not path.exists():
            raise CommandLogStorageError(f"Command log file does not exist: '{uri}'")
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise CommandLogStorageError(f"Failed to read command log from '{uri}': {exc}") from exc
        return parse_jsonl_lines(raw)

    def _serialize_jsonl(self, records: list[dict[str, Any]]) -> str:
        if not records:
            return ""
        return "".join(f"{canonical_json_line(record)}\n" for record in records)


@dataclass(frozen=True)
class _ResolvedUri:
    kind: str
    value: str


def _resolve_uri(uri: str) -> _ResolvedUri:
    if not isinstance(uri, str) or not uri.strip():
        raise CommandLogStorageError("Command log URI must be a non-empty string")
    if uri.startswith("memory://"):
        return _ResolvedUri(kind="memory", value=uri)
    if uri.startswith("file://"):
        parsed = urlparse(uri)
        path = _path_from_file_uri(parsed)
        return _ResolvedUri(kind="file", value=str(path))
    if "://" in uri:
        raise CommandLogStorageError(f"Unsupported command log URI scheme in '{uri}'")
    return _ResolvedUri(kind="file", value=str(Path(uri)))


def _path_from_file_uri(parsed: Any) -> Path:
    netloc = parsed.netloc or ""
    decoded_path = unquote(parsed.path or "")
    if netloc and netloc not in {"localhost"}:
        if decoded_path:
            return Path(f"//{netloc}{decoded_path}")
        return Path(f"//{netloc}")
    return Path(decoded_path)


def _validate_record(record: dict[str, Any], *, index: int) -> dict[str, Any]:
    kind = record.get("kind")
    if kind == "command":
        return _validate_command_record(record, index=index)
    if kind == "event":
        return _validate_event_record(record, index=index)
    raise CommandLogValidationError(f"Record {index} has invalid kind '{kind}'")


def _validate_command_record(record: dict[str, Any], *, index: int) -> dict[str, Any]:
    _validate_object_keys(record, allowed=_COMMAND_KEYS, required=_COMMAND_KEYS, index=index, label="command record")
    _validate_common_fields(record, index=index)
    method = record["method"]
    if not isinstance(method, str) or not method:
        raise CommandLogValidationError(f"Record {index} has invalid command method")
    request = record["request"]
    if not isinstance(request, dict):
        raise CommandLogValidationError(f"Record {index} command.request must be an object")
    _validate_object_keys(
        request,
        allowed=_REQUEST_KEYS,
        required=frozenset({"protocol_version", "request_id", "params"}),
        index=index,
        label="command.request",
    )
    if not isinstance(request["protocol_version"], str) or not request["protocol_version"]:
        raise CommandLogValidationError(f"Record {index} command.request.protocol_version must be a non-empty string")
    if not isinstance(request["request_id"], str) or not request["request_id"]:
        raise CommandLogValidationError(f"Record {index} command.request.request_id must be a non-empty string")
    if "idempotency_key" in request and (not isinstance(request["idempotency_key"], str) or not request["idempotency_key"]):
        raise CommandLogValidationError(f"Record {index} command.request.idempotency_key must be a non-empty string")
    if not isinstance(request["params"], dict):
        raise CommandLogValidationError(f"Record {index} command.request.params must be an object")
    return deepcopy(record)


def _validate_event_record(record: dict[str, Any], *, index: int) -> dict[str, Any]:
    _validate_object_keys(record, allowed=_EVENT_RECORD_KEYS, required=_EVENT_RECORD_KEYS, index=index, label="event record")
    _validate_common_fields(record, index=index)
    event = record["event"]
    if not isinstance(event, dict):
        raise CommandLogValidationError(f"Record {index} event must be an object")
    _validate_object_keys(event, allowed=_EVENT_KEYS, required=_EVENT_KEYS, index=index, label="event")
    if not isinstance(event["protocol_version"], str) or not event["protocol_version"]:
        raise CommandLogValidationError(f"Record {index} event.protocol_version must be a non-empty string")
    if not isinstance(event["session_id"], str) or not event["session_id"]:
        raise CommandLogValidationError(f"Record {index} event.session_id must be a non-empty string")
    if not isinstance(event["event_id"], str) or not event["event_id"]:
        raise CommandLogValidationError(f"Record {index} event.event_id must be a non-empty string")
    if not isinstance(event["event_type"], str) or not event["event_type"]:
        raise CommandLogValidationError(f"Record {index} event.event_type must be a non-empty string")
    session_seq = event["session_seq"]
    if not isinstance(session_seq, int) or session_seq < 0:
        raise CommandLogValidationError(f"Record {index} event.session_seq must be a non-negative integer")
    if not isinstance(event["emitted_at"], str) or not event["emitted_at"]:
        raise CommandLogValidationError(f"Record {index} event.emitted_at must be a non-empty string")
    if not isinstance(event["payload"], dict):
        raise CommandLogValidationError(f"Record {index} event.payload must be an object")
    return deepcopy(record)


def _validate_common_fields(record: dict[str, Any], *, index: int) -> None:
    seq = record["seq"]
    if not isinstance(seq, int) or seq < 0:
        raise CommandLogValidationError(f"Record {index} seq must be a non-negative integer")
    recorded_at = record["recorded_at"]
    if not isinstance(recorded_at, str) or not recorded_at:
        raise CommandLogValidationError(f"Record {index} recorded_at must be a non-empty string")
    correlation_id = record["correlation_id"]
    if not isinstance(correlation_id, str) or not correlation_id:
        raise CommandLogValidationError(f"Record {index} correlation_id must be a non-empty string")


def _validate_object_keys(
    value: dict[str, Any],
    *,
    allowed: frozenset[str],
    required: frozenset[str],
    index: int,
    label: str,
) -> None:
    value_keys = set(value.keys())
    missing = sorted(required - value_keys)
    if missing:
        raise CommandLogValidationError(f"Record {index} {label} is missing keys: {', '.join(missing)}")
    extra = sorted(value_keys - allowed)
    if extra:
        raise CommandLogValidationError(f"Record {index} {label} contains unsupported keys: {', '.join(extra)}")
