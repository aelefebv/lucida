from __future__ import annotations

import json
from pathlib import Path
import unittest

from schema_tools import assert_valid, SchemaResolver


ROOT = Path(__file__).resolve().parents[2]


class CommandLogRoundtripTests(unittest.TestCase):
    def setUp(self) -> None:
        self.log_schema_path = ROOT / "protocol/command-log/lucida.commandlog.v1.schema.json"
        self.resolver = SchemaResolver(ROOT)
        self.log_schema = self.resolver.load(self.log_schema_path)

    def test_roundtrip_records_keep_deterministic_order(self) -> None:
        records = [
            {
                "kind": "command",
                "seq": 1,
                "recorded_at": "2026-01-01T00:00:00Z",
                "correlation_id": "0194c8f0-c7fa-7a2d-8abc-1234567890ab",
                "method": "session.create",
                "request": {
                    "protocol_version": "1.0.0",
                    "request_id": "0194c8f0-c7fb-7a2d-8abc-1234567890ab",
                    "idempotency_key": "idem-00000001",
                    "params": {"label": "main"},
                },
            },
            {
                "kind": "event",
                "seq": 2,
                "recorded_at": "2026-01-01T00:00:00Z",
                "correlation_id": "0194c8f0-c7fc-7a2d-8abc-1234567890ab",
                "event": {
                    "protocol_version": "1.0.0",
                    "session_id": "0194c8f0-c7fd-7a2d-8abc-1234567890ab",
                    "event_id": "0194c8f0-c7fe-7a2d-8abc-1234567890ab",
                    "event_type": "job.lifecycle",
                    "session_seq": 10,
                    "emitted_at": "2026-01-01T00:00:01Z",
                    "payload": {
                        "job_id": "0194c8f0-c7ff-7a2d-8abc-1234567890ab",
                        "state": "running",
                    },
                },
            },
        ]

        for record in records:
            assert_valid(record, self.log_schema, self.resolver, self.log_schema_path)

        serialized_lines = "\n".join(json.dumps(r, sort_keys=True) for r in records)
        parsed = [json.loads(line) for line in serialized_lines.splitlines()]
        self.assertEqual([r["seq"] for r in parsed], [1, 2])


if __name__ == "__main__":
    unittest.main()
