from __future__ import annotations

from datetime import UTC, datetime
import os
from pathlib import Path
import statistics
import sys
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import NDStateEngine, SequenceClock, SequenceUUIDFactory
from lucida_daemon import DaemonConfig, LucidaDaemon
from lucida_sdk.ids import make_idempotency_key, uuid7_str

from lucida_gateway.render import FrameRenderer2D, RemoteRenderState


class Step11GatewayPerfTests(unittest.TestCase):
    def setUp(self) -> None:
        engine = NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=1),
        )
        daemon = LucidaDaemon(
            engine=engine,
            config=DaemonConfig(),
            uuid_factory=SequenceUUIDFactory(seed=10_000),
        )
        daemon.start()
        self.daemon = daemon

        self.connection_id = self.daemon.connect()
        self._hello(self.connection_id)
        self.session_id, self.view_id = self._seed_session(self.connection_id)

        self.renderer = FrameRenderer2D(
            daemon=self.daemon,
            tile_size_px=256,
            jpeg_quality=75,
        )

    def tearDown(self) -> None:
        try:
            self.daemon.disconnect(self.connection_id)
        except Exception:
            pass
        self.daemon.stop()

    def _req(self, **kwargs: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "protocol_version": "1.0.0",
            "request_id": uuid7_str(),
        }
        payload.update(kwargs)
        return payload

    def _hello(self, connection_id: str) -> None:
        self.daemon.dispatch(
            connection_id,
            "system.hello",
            self._req(
                client_name="step11-perf",
                client_version="1.0.0",
                supported_versions={"min_version": "1.0.0", "max_version": "1.0.0"},
                transport="ws",
            ),
        )

    def _seed_session(self, connection_id: str) -> tuple[str, str]:
        created = self.daemon.dispatch(
            connection_id,
            "session.create",
            self._req(idempotency_key=make_idempotency_key(prefix="idem-step11-perf-create")),
        )
        session_id = str(created["session_id"])

        self.daemon.dispatch(
            connection_id,
            "dataset.open",
            self._req(
                idempotency_key=make_idempotency_key(prefix="idem-step11-perf-open"),
                session_id=session_id,
                uri="synthetic://image-large",
                read_only=True,
            ),
        )

        snapshot = self.daemon.snapshot()
        session = next(item for item in snapshot["sessions"] if item["session_id"] == session_id)
        dataset_id = sorted(session["datasets"])[0]
        view_id = sorted(session["views"])[0]

        layer = self.daemon.dispatch(
            connection_id,
            "layer.add_image",
            self._req(
                idempotency_key=make_idempotency_key(prefix="idem-step11-perf-layer"),
                session_id=session_id,
                dataset_id=dataset_id,
                channel=0,
            ),
        )
        layer_id = str(layer["layer_id"])

        self.daemon.dispatch(
            connection_id,
            "view.bind_layer",
            self._req(
                idempotency_key=make_idempotency_key(prefix="idem-step11-perf-bind"),
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
            ),
        )

        return session_id, view_id

    def test_step11_gateway_input_to_visible_perf_smoke(self) -> None:
        p95_limit_ms = float(os.getenv("LUCIDA_STEP11_GATEWAY_P95_MS", "150"))
        min_fps = float(os.getenv("LUCIDA_STEP11_GATEWAY_MIN_FPS", "10"))
        iterations = int(os.getenv("LUCIDA_STEP11_GATEWAY_PERF_ITERS", "30"))

        state = RemoteRenderState()
        durations_ms: list[float] = []
        total_changed_tiles = 0

        start_total = time.perf_counter()
        for idx in range(iterations):
            self.daemon.dispatch(
                self.connection_id,
                "camera.set_pose",
                self._req(
                    idempotency_key=make_idempotency_key(prefix=f"idem-step11-perf-pose-{idx}"),
                    session_id=self.session_id,
                    view_id=self.view_id,
                    pose={
                        "position": [float(idx), 0.0, 1.0],
                        "target": [float(idx), 0.0, 0.0],
                        "up": [0.0, 1.0, 0.0],
                        "fov_degrees": 45.0,
                    },
                ),
            )

            start = time.perf_counter()
            _plan_seq, tiles = self.renderer.render_tiles(
                session_id=self.session_id,
                view_id=self.view_id,
                state=state,
            )
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            durations_ms.append(elapsed_ms)
            total_changed_tiles += len(tiles)

        total_seconds = time.perf_counter() - start_total
        fps = float(iterations) / max(total_seconds, 1e-6)
        p95_ms = statistics.quantiles(durations_ms, n=100)[94]
        self.assertGreater(total_changed_tiles, 0, msg="Expected at least one changed tile during perf loop")

        self.assertLessEqual(
            p95_ms,
            p95_limit_ms,
            msg=f"Step11 gateway p95 {p95_ms:.2f}ms exceeded threshold {p95_limit_ms:.2f}ms",
        )
        self.assertGreaterEqual(
            fps,
            min_fps,
            msg=f"Step11 gateway fps {fps:.2f} below threshold {min_fps:.2f}",
        )


if __name__ == "__main__":
    unittest.main()
