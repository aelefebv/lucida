from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import LucidaError, NDStateEngine, SequenceClock, SequenceUUIDFactory
from lucida_daemon import DaemonConfig, LucidaDaemon, RemoteBindPolicy, default_local_ipc_uri


class ManualClock:
    def __init__(self, start: datetime) -> None:
        self._now = start

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: int) -> None:
        self._now = self._now + timedelta(seconds=seconds)


class RequestFactory:
    def __init__(self) -> None:
        self._counter = 1

    def build(self, **kwargs: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "protocol_version": "1.0.0",
            "request_id": f"0194c8f0-c7fa-7a2d-8abc-{self._counter:012x}",
        }
        self._counter += 1
        payload.update(kwargs)
        return payload


class Step7DaemonRuntimeTests(unittest.TestCase):
    def _new_daemon(
        self,
        *,
        queue_capacity: int = 1024,
        retention_seconds: int = 60,
        seed: int = 1,
        config: DaemonConfig | None = None,
    ) -> tuple[LucidaDaemon, ManualClock]:
        engine = NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=seed),
        )
        manual_clock = ManualClock(datetime(2026, 1, 1, tzinfo=UTC))
        runtime_config = config or DaemonConfig(
            event_queue_capacity=queue_capacity,
            closed_session_retention_seconds=retention_seconds,
        )
        daemon = LucidaDaemon(
            engine=engine,
            config=runtime_config,
            clock=manual_clock.now,
            uuid_factory=SequenceUUIDFactory(seed=seed + 10_000),
        )
        daemon.start()
        return daemon, manual_clock

    def _hello(self, daemon: LucidaDaemon, conn: str, req: RequestFactory) -> dict[str, object]:
        return daemon.dispatch(
            conn,
            "system.hello",
            req.build(
                client_name="step7-tests",
                client_version="1.0.0",
                supported_versions={"min_version": "1.0.0", "max_version": "1.0.0"},
                transport="ipc",
            ),
        )

    def test_handshake_required_before_non_hello_commands(self) -> None:
        daemon, _ = self._new_daemon()
        req = RequestFactory()
        conn = daemon.connect()
        with self.assertRaises(LucidaError) as ctx:
            daemon.dispatch(conn, "session.create", req.build(idempotency_key="idem-session-a"))
        self.assertEqual(ctx.exception.code, "LUCIDA_INVALID_PARAMS")

        hello = self._hello(daemon, conn, req)
        self.assertEqual(hello["selected_version"], "1.0.0")

        created = daemon.dispatch(conn, "session.create", req.build(idempotency_key="idem-session-a"))
        self.assertIn("session_id", created)

    def test_session_owner_is_tracked_without_write_lock(self) -> None:
        daemon, _ = self._new_daemon()
        req = RequestFactory()
        owner_conn = daemon.connect()
        other_conn = daemon.connect()
        self._hello(daemon, owner_conn, req)
        self._hello(daemon, other_conn, req)

        session_id = str(daemon.dispatch(owner_conn, "session.create", req.build(idempotency_key="idem-owner-a"))["session_id"])
        owner = daemon.session_owner(session_id)
        self.assertIsNotNone(owner)
        assert owner is not None
        self.assertEqual(owner["connection_id"], owner_conn)

        opened = daemon.dispatch(
            other_conn,
            "dataset.open",
            req.build(
                idempotency_key="idem-open-other",
                session_id=session_id,
                uri="synthetic://image",
                read_only=True,
            ),
        )
        self.assertIn("job", opened)
        owner_after = daemon.session_owner(session_id)
        self.assertEqual(owner_after, owner)

    def test_events_are_topic_filtered_and_monotonic(self) -> None:
        daemon, _ = self._new_daemon()
        req = RequestFactory()
        conn = daemon.connect()
        self._hello(daemon, conn, req)
        session_id = str(daemon.dispatch(conn, "session.create", req.build(idempotency_key="idem-event-a"))["session_id"])
        sub = daemon.dispatch(
            conn,
            "events.subscribe",
            req.build(session_id=session_id, topics=["job.lifecycle"]),
        )
        sub_id = str(sub["subscription_id"])

        daemon.dispatch(
            conn,
            "dataset.open",
            req.build(
                idempotency_key="idem-open-events",
                session_id=session_id,
                uri="synthetic://image",
                read_only=True,
            ),
        )

        events = daemon.poll_events(
            connection_id=conn,
            session_id=session_id,
            subscription_id=sub_id,
            limit=20,
        )
        self.assertGreaterEqual(len(events), 3)
        self.assertTrue(all(event["event_type"] == "job.lifecycle" for event in events))
        seq_values = [int(event["session_seq"]) for event in events]
        self.assertEqual(seq_values, sorted(seq_values))
        self.assertEqual(len(seq_values), len(set(seq_values)))

    def test_backpressure_disconnects_slow_subscriber(self) -> None:
        daemon, _ = self._new_daemon(queue_capacity=1)
        req = RequestFactory()
        conn = daemon.connect()
        self._hello(daemon, conn, req)
        session_id = str(daemon.dispatch(conn, "session.create", req.build(idempotency_key="idem-pressure-a"))["session_id"])
        sub = daemon.dispatch(
            conn,
            "events.subscribe",
            req.build(session_id=session_id, topics=["job.lifecycle"]),
        )
        sub_id = str(sub["subscription_id"])

        daemon.dispatch(
            conn,
            "dataset.open",
            req.build(
                idempotency_key="idem-open-pressure",
                session_id=session_id,
                uri="synthetic://image",
                read_only=True,
            ),
        )

        with self.assertRaises(LucidaError) as ctx:
            daemon.poll_events(
                connection_id=conn,
                session_id=session_id,
                subscription_id=sub_id,
                limit=20,
            )
        self.assertEqual(ctx.exception.code, "LUCIDA_BUSY")

        session = daemon.dispatch(conn, "session.get", req.build(session_id=session_id))
        self.assertEqual(session["state"], "active")

    def test_multi_session_isolation_under_concurrency(self) -> None:
        daemon, _ = self._new_daemon()
        req = RequestFactory()
        conn_a = daemon.connect()
        conn_b = daemon.connect()
        self._hello(daemon, conn_a, req)
        self._hello(daemon, conn_b, req)

        session_a = str(daemon.dispatch(conn_a, "session.create", req.build(idempotency_key="idem-multi-a"))["session_id"])
        session_b = str(daemon.dispatch(conn_b, "session.create", req.build(idempotency_key="idem-multi-b"))["session_id"])
        sub_a = daemon.dispatch(conn_a, "events.subscribe", req.build(session_id=session_a, topics=["dataset.opened"]))
        sub_b = daemon.dispatch(conn_b, "events.subscribe", req.build(session_id=session_b, topics=["dataset.opened"]))

        def open_for(conn: str, session_id: str, idem: str) -> None:
            daemon.dispatch(
                conn,
                "dataset.open",
                req.build(
                    idempotency_key=idem,
                    session_id=session_id,
                    uri="synthetic://image",
                    read_only=True,
                ),
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            future_a = pool.submit(open_for, conn_a, session_a, "idem-open-a")
            future_b = pool.submit(open_for, conn_b, session_b, "idem-open-b")
            future_a.result()
            future_b.result()

        events_a = daemon.poll_events(
            connection_id=conn_a,
            session_id=session_a,
            subscription_id=str(sub_a["subscription_id"]),
            limit=10,
        )
        events_b = daemon.poll_events(
            connection_id=conn_b,
            session_id=session_b,
            subscription_id=str(sub_b["subscription_id"]),
            limit=10,
        )

        self.assertTrue(events_a and events_b)
        self.assertTrue(all(event["session_id"] == session_a for event in events_a))
        self.assertTrue(all(event["session_id"] == session_b for event in events_b))

    def test_reconnect_client_can_recover_via_query_methods(self) -> None:
        daemon, _ = self._new_daemon()
        req = RequestFactory()
        conn_a = daemon.connect()
        self._hello(daemon, conn_a, req)
        session_id = str(daemon.dispatch(conn_a, "session.create", req.build(idempotency_key="idem-reconnect-a"))["session_id"])

        opened = daemon.dispatch(
            conn_a,
            "dataset.open",
            req.build(
                idempotency_key="idem-reconnect-open",
                session_id=session_id,
                uri="synthetic://image",
                read_only=True,
            ),
        )
        job_id = str(opened["job"]["job_id"])
        daemon.disconnect(conn_a)

        conn_b = daemon.connect()
        self._hello(daemon, conn_b, req)
        session = daemon.dispatch(conn_b, "session.get", req.build(session_id=session_id))
        jobs = daemon.dispatch(conn_b, "job.list", req.build(session_id=session_id))
        self.assertEqual(session["state"], "active")
        self.assertTrue(any(str(job["job_id"]) == job_id for job in jobs["jobs"]))

    def test_closed_sessions_reject_mutations_and_expire_after_ttl(self) -> None:
        daemon, manual_clock = self._new_daemon(retention_seconds=60)
        req = RequestFactory()
        conn = daemon.connect()
        self._hello(daemon, conn, req)
        session_id = str(daemon.dispatch(conn, "session.create", req.build(idempotency_key="idem-close-a"))["session_id"])

        daemon.dispatch(
            conn,
            "session.close",
            req.build(idempotency_key="idem-close-b", session_id=session_id),
        )
        with self.assertRaises(LucidaError) as ctx:
            daemon.dispatch(
                conn,
                "dataset.open",
                req.build(
                    idempotency_key="idem-close-c",
                    session_id=session_id,
                    uri="synthetic://image",
                    read_only=True,
                ),
            )
        self.assertEqual(ctx.exception.code, "LUCIDA_CONFLICT")

        session = daemon.dispatch(conn, "session.get", req.build(session_id=session_id))
        self.assertEqual(session["state"], "closed")

        manual_clock.advance(61)
        removed = daemon.run_retention_gc()
        self.assertIn(session_id, removed)
        with self.assertRaises(LucidaError) as not_found_err:
            daemon.dispatch(conn, "session.get", req.build(session_id=session_id))
        self.assertEqual(not_found_err.exception.code, "LUCIDA_NOT_FOUND")

    def test_remote_bind_is_deferred_to_step11(self) -> None:
        config = DaemonConfig(
            remote_bind=RemoteBindPolicy(
                enabled=True,
                transport="tcp",
                host="127.0.0.1",
                port=7000,
                token="step7token",
            )
        )
        daemon = LucidaDaemon(config=config)
        with self.assertRaises(LucidaError) as ctx:
            daemon.start()
        self.assertEqual(ctx.exception.code, "LUCIDA_UNSUPPORTED_CAPABILITY")

    def test_local_ipc_defaults_and_roundtrip_startup(self) -> None:
        self.assertTrue(default_local_ipc_uri(platform_name="darwin").startswith("unix_socket://"))
        self.assertTrue(default_local_ipc_uri(platform_name="linux").startswith("unix_socket://"))
        self.assertTrue(default_local_ipc_uri(platform_name="win32").startswith("named_pipe://"))

        daemon, _ = self._new_daemon()
        req = RequestFactory()
        conn = daemon.connect()
        self._hello(daemon, conn, req)
        result = daemon.dispatch(conn, "session.create", req.build(idempotency_key="idem-ipc-roundtrip"))
        self.assertIn("session_id", result)


if __name__ == "__main__":
    unittest.main()
