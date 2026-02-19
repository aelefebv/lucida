from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


MUTATING_METHOD_REQUEST_DEFS = {
    "SessionCreateRequest",
    "SessionCloseRequest",
    "DatasetOpenRequest",
    "DatasetCloseRequest",
    "LayerAddImageRequest",
    "LayerAddPointsRequest",
    "LayerUpdateRequest",
    "LayerRemoveRequest",
    "ViewSetAxisIndexRequest",
    "ViewReorderAxesRequest",
    "ViewSetChannelOrderRequest",
    "CameraSetModeRequest",
    "CameraSetPoseRequest",
    "SelectionSetRequest",
    "JobCancelRequest",
    "CommandLogImportRequest",
    "CommandLogReplayRequest",
}


def parse_semver(version: str) -> tuple[int, int, int]:
    major, minor, patch = version.split(".")
    return int(major), int(minor), int(patch)


def negotiate_version(
    client_min: str,
    client_max: str,
    server_min: str,
    server_max: str,
) -> str | None:
    cmin = parse_semver(client_min)
    cmax = parse_semver(client_max)
    smin = parse_semver(server_min)
    smax = parse_semver(server_max)
    lower = max(cmin, smin)
    upper = min(cmax, smax)
    if lower > upper:
        return None
    return ".".join(str(part) for part in upper)


class ProtocolPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.requests_path = ROOT / "protocol/schemas/requests/methods.request.schema.json"
        self.events_path = ROOT / "protocol/schemas/events/events.schema.json"
        self.requests = json.loads(self.requests_path.read_text(encoding="utf-8"))
        self.events = json.loads(self.events_path.read_text(encoding="utf-8"))

    def test_handshake_compatible_range_selects_highest_shared(self) -> None:
        selected = negotiate_version("1.0.0", "1.3.0", "1.0.0", "1.1.4")
        self.assertEqual(selected, "1.1.4")

    def test_handshake_incompatible_range_returns_none(self) -> None:
        selected = negotiate_version("2.0.0", "2.1.0", "1.0.0", "1.9.9")
        self.assertIsNone(selected)

    def test_mutating_requests_require_idempotency_key(self) -> None:
        req_defs = self.requests["$defs"]
        for def_name, schema in req_defs.items():
            required = set(schema.get("required", []))
            with self.subTest(definition=def_name):
                if def_name in MUTATING_METHOD_REQUEST_DEFS:
                    self.assertIn("idempotency_key", required)
                else:
                    self.assertNotIn("idempotency_key", required)

    def test_event_definitions_require_session_sequence(self) -> None:
        event_defs = self.events["$defs"]
        event_names = [name for name in event_defs if name.endswith("Event") and name != "AnyEvent"]
        for name in event_names:
            with self.subTest(event=name):
                required = set(event_defs[name].get("required", []))
                self.assertIn("session_seq", required)
                self.assertIn("event_id", required)
                self.assertIn("session_id", required)

    def test_job_state_enum_is_stable(self) -> None:
        primitives_path = ROOT / "protocol/schemas/common/primitives.schema.json"
        primitives = json.loads(primitives_path.read_text(encoding="utf-8"))
        states = primitives["$defs"]["JobState"]["enum"]
        self.assertEqual(states, ["queued", "running", "completed", "failed", "cancelled"])


if __name__ == "__main__":
    unittest.main()

