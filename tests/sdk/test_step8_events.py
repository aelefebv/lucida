from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import sys
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import NDStateEngine, SequenceClock, SequenceUUIDFactory
from lucida_daemon import DaemonConfig, LucidaDaemon, default_local_ipc_uri
from lucida_sdk import Busy, EventGapError, connect, launch_or_connect
from lucida_sdk.events import EventSubscription
from lucida_sdk.registry import clear_local_daemon_registry


class Step8EventTests(unittest.TestCase):
    def tearDown(self) -> None:
        clear_local_daemon_registry()

    def _unique_ipc_uri(self) -> str:
        app_name = f"lucida-step8-events-{uuid.uuid4().hex[:8]}"
        return default_local_ipc_uri(app_name=app_name)

    def test_subscribe_and_iter_events_is_monotonic(self) -> None:
        client = launch_or_connect(local_ipc_uri=self._unique_ipc_uri())
        with client.session_scope(label="step8-events") as session_id:
            subscription = client.subscribe_events(session_id=session_id, topics=["*"])
            client.dataset_open(session_id=session_id, uri="synthetic://image", read_only=True)
            events = list(
                subscription.iter_events(
                    limit=16,
                    poll_interval_s=0.0,
                    max_idle_polls=3,
                )
            )
            self.assertGreaterEqual(len(events), 3)
            seq = [int(event["session_seq"]) for event in events]
            self.assertEqual(seq, sorted(seq))
            self.assertEqual(seq, list(range(seq[0], seq[0] + len(seq))))
        client.close()

    def test_event_gap_detection_raises_typed_error(self) -> None:
        batches = [
            [{"session_seq": 10, "event_type": "job.lifecycle"}],
            [{"session_seq": 12, "event_type": "job.lifecycle"}],
        ]

        def _poll(_session_id: str, _subscription_id: str, _limit: int) -> list[dict[str, object]]:
            if batches:
                return list(batches.pop(0))
            return []

        subscription = EventSubscription(
            session_id="0194c8f0-c7fa-7a2d-8abc-000000000101",
            subscription_id="0194c8f0-c7fa-7a2d-8abc-000000000102",
            topics=["job.lifecycle"],
            transport_uri="memory://events/test",
            _poll_events_fn=_poll,
        )

        first = subscription.poll(limit=4)
        self.assertEqual(len(first), 1)
        with self.assertRaises(EventGapError):
            subscription.poll(limit=4)

    def test_backpressure_maps_to_busy_sdk_error(self) -> None:
        daemon = LucidaDaemon(
            engine=NDStateEngine(
                clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
                uuid_factory=SequenceUUIDFactory(seed=1),
            ),
            config=DaemonConfig(local_ipc_uri=self._unique_ipc_uri(), event_queue_capacity=1),
            uuid_factory=SequenceUUIDFactory(seed=1001),
        )
        client = connect(daemon=daemon)
        with client.session_scope(label="step8-pressure") as session_id:
            subscription = client.subscribe_events(session_id=session_id, topics=["job.lifecycle"])
            client.dataset_open(session_id=session_id, uri="synthetic://image", read_only=True)
            with self.assertRaises(Busy):
                subscription.poll(limit=8)
        client.close()
        daemon.stop()


if __name__ == "__main__":
    unittest.main()
