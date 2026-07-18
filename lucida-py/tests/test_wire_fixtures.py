from __future__ import annotations

import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest

PYTHON_PROJECT = Path(__file__).resolve().parents[1]
REPO_ROOT = PYTHON_PROJECT.parent
SESSION_FIXTURES = REPO_ROOT / "wire-fixtures" / "session"
COLLECTION_FIXTURE = (
    REPO_ROOT / "wire-fixtures" / "dataset-open" / "dataset_opened_collection.json"
)
COMPACT_MULTISCALE_CASES = (
    REPO_ROOT / "wire-fixtures" / "manifest" / "compact_multiscale_cases.json"
)
sys.path.insert(0, str(PYTHON_PROJECT / "python"))

from lucida.client import (  # noqa: E402
    Deadline,
    LucidaError,
    dataset_info_from_document,
    dataset_open_error_kind,
    dataset_open_summary,
    dataset_summaries_from_document,
    effective_multiscale,
    recv_json,
    send_json,
)


# Rust's `wire_goldens` integration test authors and byte-locks these maximal
# fixtures. Keeping the complete inventory here makes a new Rust wire variant
# an explicit Python compatibility decision instead of an unobserved file.
SESSION_CONTRACT: dict[str, tuple[str, frozenset[str]]] = {
    "chunk_request.json": (
        "chunk_request",
        frozenset({"type", "dataset_id", "image_id", "key"}),
    ),
    "client_command_add_annotation.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_add_comment.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_edit_comment.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_move_annotation.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_register_layout.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_remove_annotation.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_remove_comment.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_remove_dataset.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_rename_dataset.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_command_set_active_layout.json": (
        "command",
        frozenset({"type", "request_id", "command"}),
    ),
    "client_cursor.json": (
        "cursor",
        frozenset({"type", "position", "dataset_id"}),
    ),
    "client_dataset_health.json": (
        "dataset_health",
        frozenset({"type", "request_id", "dataset_id"}),
    ),
    "client_dataset_presence.json": (
        "dataset_presence",
        frozenset({"type", "dataset_order", "dataset_settings"}),
    ),
    "client_dataset_retry.json": (
        "dataset_retry",
        frozenset({"type", "request_id", "dataset_id"}),
    ),
    "client_follow.json": ("follow", frozenset({"type", "target"})),
    "client_inverse_command.json": (
        "inverse_command",
        frozenset({"type", "request_id", "target_operation_id", "expected_revision"}),
    ),
    "client_open_remote_dataset.json": (
        "open_remote_dataset",
        frozenset({"type", "request_id", "url"}),
    ),
    "client_presence.json": (
        "presence",
        frozenset({"type", "camera", "view", "display"}),
    ),
    "client_request_snapshot.json": ("request_snapshot", frozenset({"type"})),
    "client_steer.json": ("steer", frozenset({"type", "client"})),
    "client_viewer_interest.json": (
        "viewer_interest",
        frozenset({"type", "interest"}),
    ),
    "server_ack.json": (
        "ack",
        frozenset({"type", "request_id", "seq"}),
    ),
    "server_command_broadcast_dataset_opened.json": (
        "command_broadcast",
        frozenset({"type", "seq", "command"}),
    ),
    "server_cursor_update.json": (
        "cursor_update",
        frozenset({"type", "client_id", "position", "dataset_id"}),
    ),
    "server_dataset_health.json": (
        "dataset_health",
        frozenset({"type", "request_id", "datasets"}),
    ),
    "server_dataset_open_progress.json": (
        "dataset_open_progress",
        frozenset({"type", "request_id", "url", "diagnostic"}),
    ),
    "server_dataset_open_progress_warning.json": (
        "dataset_open_progress",
        frozenset({"type", "request_id", "url", "diagnostic"}),
    ),
    "server_dataset_presence_update.json": (
        "dataset_presence_update",
        frozenset({"type", "client_id", "dataset_order", "dataset_settings"}),
    ),
    "server_follow_changed.json": (
        "follow_changed",
        frozenset({"type", "client_id", "target"}),
    ),
    "server_generated_availability_update.json": (
        "generated_availability_update",
        frozenset({"type", "dataset_id", "delta"}),
    ),
    "server_generated_chunk_status.json": (
        "generated_chunk_status",
        frozenset(
            {"type", "dataset_id", "image_id", "key", "status", "failure", "message"}
        ),
    ),
    "server_nack.json": (
        "nack",
        frozenset({"type", "request_id", "code", "message", "retryable"}),
    ),
    "server_open_dataset_failed.json": (
        "open_dataset_failed",
        frozenset({"type", "request_id", "url", "error", "diagnostic"}),
    ),
    "server_open_dataset_succeeded.json": (
        "open_dataset_succeeded",
        frozenset(
            {"type", "request_id", "url", "seq", "summary", "opened", "diagnostic"}
        ),
    ),
    "server_peer_joined.json": (
        "peer_joined",
        frozenset({"type", "client_id", "presence"}),
    ),
    "server_peer_left.json": (
        "peer_left",
        frozenset({"type", "client_id"}),
    ),
    "server_presence_update.json": (
        "presence_update",
        frozenset({"type", "client_id", "camera", "view", "display"}),
    ),
    "server_snapshot.json": (
        "snapshot",
        frozenset(
            {
                "type",
                "seq",
                "document",
                "peers",
                "your_id",
                "generated_availability",
                "dataset_fetch",
            }
        ),
    ),
    "server_source_chunk_status.json": (
        "source_chunk_status",
        frozenset(
            {
                "type",
                "dataset_id",
                "image_id",
                "key",
                "status",
                "category",
                "code",
                "retryable",
                "message",
            }
        ),
    ),
    "server_workspace_archived.json": (
        "workspace_archived",
        frozenset({"type", "workspace_id"}),
    ),
}

COMMAND_VARIANTS = {
    "client_command_add_annotation.json": "add_annotation",
    "client_command_add_comment.json": "add_comment",
    "client_command_edit_comment.json": "edit_comment",
    "client_command_move_annotation.json": "move_annotation",
    "client_command_register_layout.json": "register_layout",
    "client_command_remove_annotation.json": "remove_annotation",
    "client_command_remove_comment.json": "remove_comment",
    "client_command_remove_dataset.json": "remove_dataset",
    "client_command_rename_dataset.json": "rename_dataset",
    "client_command_set_active_layout.json": "set_active_layout",
}


def load_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict), f"{path.name} must contain one JSON object"
    return value


def json_pointer(value: object, pointer: str) -> object:
    current = value
    for raw in pointer.removeprefix("/").split("/") if pointer else []:
        part = raw.replace("~1", "/").replace("~0", "~")
        current = current[int(part)] if isinstance(current, list) else current[part]
    return current


def apply_compact_case(manifest: dict[str, object], operations: list[object]) -> None:
    for raw_operation in operations:
        assert isinstance(raw_operation, dict)
        operation = str(raw_operation["op"])
        path = str(raw_operation["path"])
        parts = path.removeprefix("/").split("/")
        parent = json_pointer(manifest, "/" + "/".join(parts[:-1])) if len(parts) > 1 else manifest
        key = parts[-1].replace("~1", "/").replace("~0", "~")
        if operation == "remove":
            if isinstance(parent, list):
                parent.pop(int(key))
            else:
                assert isinstance(parent, dict)
                parent.pop(key)
        elif operation in {"set", "copy"}:
            replacement = (
                copy.deepcopy(json_pointer(manifest, str(raw_operation["from"])))
                if operation == "copy"
                else copy.deepcopy(raw_operation.get("value"))
            )
            if isinstance(parent, list):
                parent[int(key)] = replacement
            else:
                assert isinstance(parent, dict)
                parent[key] = replacement
        else:  # pragma: no cover - the shared corpus has a closed operation vocabulary
            raise AssertionError(f"unsupported compact-corpus operation: {operation}")


class FixtureSocket:
    def __init__(self, inbound: object | None = None) -> None:
        self.inbound = inbound
        self.sent: list[str] = []

    async def recv(self) -> str:
        return json.dumps(self.inbound)

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


def receive_through_client(payload: object) -> dict[str, object]:
    async def receive() -> dict[str, object]:
        return await recv_json(
            FixtureSocket(payload),
            Deadline(1.0, operation="wire fixture"),
        )

    return asyncio.run(receive())


def send_through_client(payload: dict[str, object]) -> dict[str, object]:
    socket = FixtureSocket()

    async def send() -> None:
        await send_json(socket, payload)

    asyncio.run(send())
    assert len(socket.sent) == 1
    sent = json.loads(socket.sent[0])
    assert isinstance(sent, dict)
    return sent


def test_session_fixture_inventory_is_exhaustive() -> None:
    on_disk = {path.name for path in SESSION_FIXTURES.glob("*.json")}
    assert on_disk == set(SESSION_CONTRACT), (
        "Rust session fixture inventory changed; add or remove the corresponding "
        "Python contract entry intentionally"
    )


@pytest.mark.parametrize("filename", sorted(SESSION_CONTRACT))
def test_rust_session_fixture_round_trips_through_python(filename: str) -> None:
    payload = load_json(SESSION_FIXTURES / filename)
    expected_type, expected_keys = SESSION_CONTRACT[filename]

    assert payload["type"] == expected_type
    assert frozenset(payload) == expected_keys

    if filename == "server_workspace_archived.json":
        with pytest.raises(LucidaError) as error:
            receive_through_client(payload)
        assert error.value.kind == "archived_workspace"
    elif filename.startswith("server_"):
        assert receive_through_client(payload) == payload
    else:
        assert send_through_client(payload) == payload


@pytest.mark.parametrize("filename,command_type", sorted(COMMAND_VARIANTS.items()))
def test_rust_document_command_variants_are_exhaustive(
    filename: str, command_type: str
) -> None:
    payload = load_json(SESSION_FIXTURES / filename)
    command = payload["command"]
    assert isinstance(command, dict)
    assert command["type"] == command_type


def test_rust_snapshot_and_open_terminals_feed_python_domain_helpers() -> None:
    snapshot = load_json(SESSION_FIXTURES / "server_snapshot.json")
    document = snapshot["document"]
    assert isinstance(document, dict)
    summaries = dataset_summaries_from_document(document)
    assert summaries == [
        {
            "workspace_dataset_id": "wds-0f3a",
            "name": "kidney-multiplex.zarr",
            "kind": "single",
            "image_count": 1,
            "entity_count": 1,
            "channel_count": 2,
            "dimensions": [3, 2, 50, 4096, 4096],
            "active_layout_id": "layout-grid",
        }
    ]

    succeeded = load_json(SESSION_FIXTURES / "server_open_dataset_succeeded.json")
    result = dataset_open_summary(
        succeeded["summary"],
        source=str(succeeded["url"]),
        seq=int(succeeded["seq"]),
        workspace_id="workspace-fixture",
        diagnostic=succeeded["diagnostic"],
    )
    assert result["workspace_dataset_id"] == "wds-0f3a"
    assert result["seq"] == 43
    assert result["diagnostic"]["stage"] == "complete"

    failed = load_json(SESSION_FIXTURES / "server_open_dataset_failed.json")
    assert dataset_open_error_kind(failed["diagnostic"]) == "missing_resource"


def test_python_preserves_typed_source_and_generated_chunk_failures() -> None:
    generated = load_json(SESSION_FIXTURES / "server_generated_chunk_status.json")
    assert generated["failure"] == {
        "category": "source",
        "code": "storage_backend",
        "retryable": True,
    }
    assert receive_through_client(generated) == generated

    source = load_json(SESSION_FIXTURES / "server_source_chunk_status.json")
    assert {
        "category": source["category"],
        "code": source["code"],
        "retryable": source["retryable"],
    } == {
        "category": "authorization",
        "code": "permission",
        "retryable": False,
    }
    assert receive_through_client(source) == source


@pytest.mark.parametrize(
    "payload,match",
    [
        ([], "JSON object"),
        ("snapshot", "JSON object"),
        ({}, "non-empty string field 'type'"),
        ({"type": None}, "non-empty string field 'type'"),
        ({"type": ""}, "non-empty string field 'type'"),
    ],
)
def test_python_rejects_malformed_server_envelope_boundaries(
    payload: object, match: str
) -> None:
    with pytest.raises(LucidaError, match=match) as error:
        receive_through_client(payload)
    assert error.value.kind == "protocol"


def test_python_preserves_unknown_typed_server_envelopes_for_forward_compatibility() -> None:
    payload = {"type": "future_server_advisory", "payload": {"version": 2}}
    assert receive_through_client(payload) == payload


def compact_collection_manifest() -> dict[str, object]:
    opened = load_json(COLLECTION_FIXTURE)
    manifest = opened["manifest"]
    assert isinstance(manifest, dict)
    return manifest


def test_python_consumes_rust_compact_collection_fixture() -> None:
    manifest = compact_collection_manifest()
    images = manifest["images"]
    multiscales = manifest["multiscales"]
    assert isinstance(images, list)
    assert isinstance(multiscales, list)
    assert len(images) == 2
    assert len(multiscales) == 1
    assert effective_multiscale(manifest, images[0]) == multiscales[0]
    assert effective_multiscale(manifest, images[1]) == multiscales[0]

    document = {"manifests": {manifest["dataset_id"]: manifest}}
    info = dataset_info_from_document(document, str(manifest["dataset_id"]))
    assert info["image_count"] == 2
    assert [image["data_type"] for image in info["images"]] == ["Uint8", "Uint8"]


def test_python_matches_shared_compact_multiscale_accept_reject_corpus() -> None:
    corpus = load_json(COMPACT_MULTISCALE_CASES)
    base_path = REPO_ROOT / "wire-fixtures" / str(corpus["base_fixture"])
    cases = corpus["cases"]
    assert isinstance(cases, list)

    for raw_case in cases:
        assert isinstance(raw_case, dict)
        opened = load_json(base_path)
        manifest = opened[str(corpus["target"])]
        assert isinstance(manifest, dict)
        operations = raw_case["operations"]
        assert isinstance(operations, list)
        apply_compact_case(manifest, operations)
        images = manifest.get("images")
        assert isinstance(images, list) and isinstance(images[0], dict)

        if raw_case["accepted"]:
            assert effective_multiscale(manifest, images[0])
            continue

        with pytest.raises(LucidaError) as error:
            effective_multiscale(manifest, images[0])
        assert error.value.kind == "protocol", raw_case["name"]
        assert error.value.diagnostic["field"] == raw_case["field"], raw_case["name"]


@pytest.mark.parametrize(
    "case,match,field",
    [
        ("both", "both.*multiscale.*multiscale_ref", "images[].multiscale"),
        ("neither", "neither.*multiscale.*multiscale_ref", "images[].multiscale"),
        ("inline_non_object", "multiscale.*object", "images[].multiscale"),
        ("bool", "multiscale_ref.*integer", "images[].multiscale_ref"),
        ("string", "multiscale_ref.*integer", "images[].multiscale_ref"),
        ("negative", "multiscale_ref.*non-negative", "images[].multiscale_ref"),
        ("out_of_range", "references shared multiscale", "images[].multiscale_ref"),
        ("missing_table", "multiscales.*array", "multiscales"),
        ("non_array_table", "multiscales.*array", "multiscales"),
        ("non_object_entry", r"multiscales\[0\].*object", "multiscales[0]"),
    ],
)
def test_python_rejects_malformed_compact_multiscale_references(
    case: str, match: str, field: str
) -> None:
    manifest = compact_collection_manifest()
    image = manifest["images"][0]
    assert isinstance(image, dict)

    if case == "both":
        image["multiscale"] = copy.deepcopy(manifest["multiscales"][0])
    elif case == "neither":
        image.pop("multiscale_ref")
    elif case == "inline_non_object":
        image.pop("multiscale_ref")
        image["multiscale"] = []
    elif case == "bool":
        image["multiscale_ref"] = True
    elif case == "string":
        image["multiscale_ref"] = "0"
    elif case == "negative":
        image["multiscale_ref"] = -1
    elif case == "out_of_range":
        image["multiscale_ref"] = len(manifest["multiscales"])
    elif case == "missing_table":
        manifest.pop("multiscales")
    elif case == "non_array_table":
        manifest["multiscales"] = {}
    elif case == "non_object_entry":
        manifest["multiscales"][0] = []
    else:  # pragma: no cover - parameter table is closed above
        raise AssertionError(f"unknown malformed case: {case}")

    with pytest.raises(LucidaError, match=match) as error:
        effective_multiscale(manifest, image)
    assert error.value.kind == "protocol"
    assert error.value.diagnostic["field"] == field
