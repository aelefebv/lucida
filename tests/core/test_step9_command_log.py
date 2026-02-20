from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import LucidaError, NDStateEngine, SequenceClock, SequenceUUIDFactory


def _request(base_id: int, **kwargs: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocol_version": "1.0.0",
        "request_id": f"0194c8f0-c7fa-7a2d-8abc-{base_id:012x}",
    }
    payload.update(kwargs)
    return payload


class Step9CommandLogTests(unittest.TestCase):
    def _new_engine(self, seed: int) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=seed),
        )

    def _create_session(self, engine: NDStateEngine, *, key: str) -> tuple[str, str]:
        created = engine.dispatch("session.create", _request(1, idempotency_key=key, label="step9"))
        session_id = str(created["session_id"])
        view_id = str(next(iter(engine.snapshot()["sessions"][0]["views"])))
        return session_id, view_id

    def _job_terminal_state(self, engine: NDStateEngine, session_id: str, job_id: str, *, request_id: int) -> dict[str, object]:
        return engine.dispatch("job.get", _request(request_id, session_id=session_id, job_id=job_id))

    def test_export_import_replay_roundtrip_matches_view_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "roundtrip.jsonl"

            source = self._new_engine(seed=11)
            source_session, source_view = self._create_session(source, key="idem-source-session")
            source.dispatch(
                "view.set_axis_index",
                _request(
                    2,
                    idempotency_key="idem-source-axis",
                    session_id=source_session,
                    view_id=source_view,
                    axis_index={"axis": "t", "index": 1},
                ),
            )
            exported = source.dispatch(
                "command_log.export",
                _request(3, session_id=source_session, destination_uri=str(log_path)),
            )
            self.assertGreater(int(exported["record_count"]), 0)

            target = self._new_engine(seed=11)
            target_session, target_view = self._create_session(target, key="idem-target-session")
            self.assertEqual(target_session, source_session)
            self.assertEqual(target_view, source_view)

            imported = target.dispatch(
                "command_log.import",
                _request(
                    4,
                    idempotency_key="idem-target-import",
                    session_id=target_session,
                    source_uri=str(log_path),
                ),
            )
            import_job = self._job_terminal_state(target, target_session, str(imported["job"]["job_id"]), request_id=5)
            self.assertEqual(import_job["state"], "completed")

            replayed = target.dispatch(
                "command_log.replay",
                _request(
                    6,
                    idempotency_key="idem-target-replay",
                    session_id=target_session,
                    source_uri=str(log_path),
                    dry_run=False,
                ),
            )
            replay_job = self._job_terminal_state(target, target_session, str(replayed["job"]["job_id"]), request_id=7)
            self.assertEqual(replay_job["state"], "completed")

            source_view_state = source.dispatch(
                "view.get",
                _request(8, session_id=source_session, view_id=source_view),
            )
            target_view_state = target.dispatch(
                "view.get",
                _request(9, session_id=target_session, view_id=target_view),
            )
            self.assertEqual(source_view_state["axis_indices"], target_view_state["axis_indices"])

    def test_capabilities_expose_command_log_replay_support(self) -> None:
        engine = self._new_engine(seed=13)
        capabilities = engine.dispatch("system.capabilities.get", _request(1))
        self.assertTrue(capabilities["capabilities"]["command_log_replay"])

    def test_replay_dry_run_does_not_mutate_target_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "dryrun.jsonl"
            source = self._new_engine(seed=17)
            source_session, source_view = self._create_session(source, key="idem-dryrun-source-session")
            source.dispatch(
                "view.set_axis_index",
                _request(
                    2,
                    idempotency_key="idem-dryrun-source-axis",
                    session_id=source_session,
                    view_id=source_view,
                    axis_index={"axis": "t", "index": 3},
                ),
            )
            source.dispatch(
                "command_log.export",
                _request(3, session_id=source_session, destination_uri=str(log_path)),
            )

            target = self._new_engine(seed=17)
            target_session, target_view = self._create_session(target, key="idem-dryrun-target-session")
            before = target.dispatch(
                "view.get",
                _request(4, session_id=target_session, view_id=target_view),
            )
            replayed = target.dispatch(
                "command_log.replay",
                _request(
                    5,
                    idempotency_key="idem-dryrun-target-replay",
                    session_id=target_session,
                    source_uri=str(log_path),
                    dry_run=True,
                ),
            )
            replay_job = self._job_terminal_state(target, target_session, str(replayed["job"]["job_id"]), request_id=6)
            self.assertEqual(replay_job["state"], "completed")
            after = target.dispatch(
                "view.get",
                _request(7, session_id=target_session, view_id=target_view),
            )
            self.assertEqual(before["axis_indices"], after["axis_indices"])

    def test_import_fails_fast_on_invalid_json_and_version_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            invalid_log = Path(tmpdir) / "invalid.jsonl"
            invalid_log.write_text("{not json}\n", encoding="utf-8")

            version_log = Path(tmpdir) / "version.jsonl"
            version_log.write_text(
                json.dumps(
                    {
                        "kind": "command",
                        "seq": 1,
                        "recorded_at": "2026-01-01T00:00:00Z",
                        "correlation_id": "0194c8f0-c7fa-7a2d-8abc-0000000000aa",
                        "method": "view.set_axis_index",
                        "request": {
                            "protocol_version": "2.0.0",
                            "request_id": "0194c8f0-c7fa-7a2d-8abc-0000000000ab",
                            "idempotency_key": "idem-version-record",
                            "params": {
                                "session_id": "0194c8f0-c7fa-7a2d-8abc-0000000000ac",
                                "view_id": "0194c8f0-c7fa-7a2d-8abc-0000000000ad",
                                "axis_index": {"axis": "t", "index": 1},
                            },
                        },
                    },
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )

            engine = self._new_engine(seed=23)
            session_id, _view_id = self._create_session(engine, key="idem-import-failure-session")

            invalid_import = engine.dispatch(
                "command_log.import",
                _request(
                    2,
                    idempotency_key="idem-import-invalid",
                    session_id=session_id,
                    source_uri=str(invalid_log),
                ),
            )
            invalid_job = self._job_terminal_state(engine, session_id, str(invalid_import["job"]["job_id"]), request_id=3)
            self.assertEqual(invalid_job["state"], "failed")
            self.assertEqual(invalid_job["error"]["code"], "LUCIDA_INVALID_PARAMS")

            version_import = engine.dispatch(
                "command_log.import",
                _request(
                    4,
                    idempotency_key="idem-import-version",
                    session_id=session_id,
                    source_uri=str(version_log),
                ),
            )
            version_job = self._job_terminal_state(engine, session_id, str(version_import["job"]["job_id"]), request_id=5)
            self.assertEqual(version_job["state"], "failed")
            self.assertEqual(version_job["error"]["code"], "LUCIDA_VERSION_MISMATCH")

    def test_replay_emits_failed_state_on_event_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "mismatch.jsonl"

            source = self._new_engine(seed=31)
            source_session, source_view = self._create_session(source, key="idem-mismatch-source-session")
            source.dispatch(
                "view.set_axis_index",
                _request(
                    2,
                    idempotency_key="idem-mismatch-source-axis",
                    session_id=source_session,
                    view_id=source_view,
                    axis_index={"axis": "t", "index": 2},
                ),
            )
            source.dispatch(
                "command_log.export",
                _request(3, session_id=source_session, destination_uri=str(log_path)),
            )

            lines = [line for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            tampered: list[str] = []
            for line in lines:
                record = json.loads(line)
                if record.get("kind") == "event" and record.get("event", {}).get("event_type") == "state.changed":
                    payload = record["event"]["payload"]
                    if isinstance(payload, dict):
                        payload["change_summary"] = "tampered"
                    record["event"]["payload"] = payload
                tampered.append(json.dumps(record, sort_keys=True))
            log_path.write_text("".join(f"{line}\n" for line in tampered), encoding="utf-8")

            target = self._new_engine(seed=31)
            target_session, _target_view = self._create_session(target, key="idem-mismatch-target-session")
            replayed = target.dispatch(
                "command_log.replay",
                _request(
                    4,
                    idempotency_key="idem-mismatch-target-replay",
                    session_id=target_session,
                    source_uri=str(log_path),
                    dry_run=False,
                ),
            )
            replay_job = self._job_terminal_state(target, target_session, str(replayed["job"]["job_id"]), request_id=5)
            self.assertEqual(replay_job["state"], "failed")
            self.assertEqual(replay_job["error"]["code"], "LUCIDA_CONFLICT")

            replay_states = [
                event["payload"]["state"]
                for event in target.events_for_session(target_session)
                if event["event_type"] == "command_log.replay" and event["payload"]["replay_id"] == replayed["replay_id"]
            ]
            self.assertEqual(replay_states[0], "started")
            self.assertEqual(replay_states[-1], "failed")
            self.assertNotIn("completed", replay_states)

    def test_command_log_uri_policy_rejects_unsupported_scheme(self) -> None:
        engine = self._new_engine(seed=41)
        session_id, _view_id = self._create_session(engine, key="idem-uri-session")
        with self.assertRaises(LucidaError) as ctx:
            engine.dispatch(
                "command_log.export",
                _request(2, session_id=session_id, destination_uri="https://example.com/commands.jsonl"),
            )
        self.assertEqual(ctx.exception.code, "LUCIDA_UNSUPPORTED_CAPABILITY")


if __name__ == "__main__":
    unittest.main()
