from __future__ import annotations

from datetime import UTC, datetime
import json
import os
from pathlib import Path
import statistics
import sys
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import NDStateEngine, SequenceClock, SequenceUUIDFactory


BASELINE_PATH = ROOT / "tests" / "perf" / "baselines" / "step4_render2d_perf.json"


def _request(base_id: int, **kwargs: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocol_version": "1.0.0",
        "request_id": f"0194c8f0-c7fa-7a2d-8abc-{base_id:012x}",
    }
    payload.update(kwargs)
    return payload


def _panzoom_pose(zoom: float) -> dict[str, object]:
    depth = 1.0 / zoom
    return {
        "position": [0.0, 0.0, depth],
        "target": [0.0, 0.0, 0.0],
        "up": [0.0, 1.0, 0.0],
        "fov_degrees": 45.0,
    }


def _p95(samples: list[float]) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    index = int(0.95 * (len(ordered) - 1))
    return float(ordered[index])


class Step4Render2DPerfTests(unittest.TestCase):
    def _new_engine(self) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=500),
        )

    def _create_bound_view(self, engine: NDStateEngine) -> tuple[str, str]:
        session_id = str(
            engine.dispatch(
                "session.create",
                _request(1, idempotency_key="idem-perf-session", label="perf"),
            )["session_id"]
        )
        snapshot = engine.snapshot()
        view_id = sorted(snapshot["sessions"][0]["views"])[0]
        engine.dispatch(
            "dataset.open",
            _request(
                2,
                idempotency_key="idem-perf-open",
                session_id=session_id,
                uri="synthetic://large",
                read_only=True,
            ),
        )
        dataset_id = [
            event["payload"]["dataset_id"]
            for event in engine.events_for_session(session_id)
            if event["event_type"] == "dataset.opened"
        ][0]
        layer_id = str(
            engine.dispatch(
                "layer.add_image",
                _request(3, idempotency_key="idem-perf-layer", session_id=session_id, dataset_id=dataset_id),
            )["layer_id"]
        )
        engine.dispatch(
            "view.bind_layer",
            _request(4, idempotency_key="idem-perf-bind", session_id=session_id, view_id=view_id, layer_id=layer_id),
        )
        return session_id, view_id

    def _measure_dispatch_ms(self, engine: NDStateEngine, session_id: str, view_id: str, count: int = 120) -> list[float]:
        timings_ms: list[float] = []
        for idx in range(count):
            axis = "z"
            axis_index = idx % 16
            start = time.perf_counter()
            engine.dispatch(
                "view.set_axis_index",
                _request(
                    1000 + idx * 2,
                    idempotency_key=f"idem-perf-axis-{idx}",
                    session_id=session_id,
                    view_id=view_id,
                    axis_index={"axis": axis, "index": axis_index},
                ),
            )
            engine.dispatch(
                "camera.set_pose",
                _request(
                    1001 + idx * 2,
                    idempotency_key=f"idem-perf-pose-{idx}",
                    session_id=session_id,
                    view_id=view_id,
                    pose=_panzoom_pose(zoom=1.0 + (idx % 5) * 0.15),
                ),
            )
            elapsed = (time.perf_counter() - start) * 1000.0
            timings_ms.append(elapsed)
        return timings_ms

    def test_perf_smoke_planner_dispatch_p95_under_target(self) -> None:
        engine = self._new_engine()
        session_id, view_id = self._create_bound_view(engine)
        samples = self._measure_dispatch_ms(engine, session_id, view_id, count=80)
        p95_ms = _p95(samples)

        target_ms = float(os.environ.get("LUCIDA_STEP4_PERF_SMOKE_P95_MS", "50"))
        self.assertLessEqual(
            p95_ms,
            target_ms,
            msg=f"Step4 perf smoke p95 exceeded target: p95={p95_ms:.3f}ms target={target_ms:.3f}ms",
        )

    def test_perf_regression_against_baseline(self) -> None:
        if os.environ.get("LUCIDA_STEP4_PERF_FULL", "0") != "1":
            self.skipTest("Full perf regression gate is enabled only in scheduled/nightly mode")

        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
        baseline_p95 = float(baseline["planner_dispatch_p95_ms"])
        baseline_avg = float(baseline["planner_dispatch_avg_ms"])

        engine = self._new_engine()
        session_id, view_id = self._create_bound_view(engine)
        samples = self._measure_dispatch_ms(engine, session_id, view_id, count=160)
        p95_ms = _p95(samples)
        avg_ms = float(statistics.fmean(samples))

        regression_factor = float(os.environ.get("LUCIDA_STEP4_PERF_REGRESSION_FACTOR", "1.25"))
        self.assertLessEqual(
            p95_ms,
            baseline_p95 * regression_factor,
            msg=(
                "Step4 perf regression gate failed for p95: "
                f"p95={p95_ms:.3f}ms baseline={baseline_p95:.3f}ms factor={regression_factor:.2f}"
            ),
        )
        self.assertLessEqual(
            avg_ms,
            baseline_avg * regression_factor,
            msg=(
                "Step4 perf regression gate failed for average: "
                f"avg={avg_ms:.3f}ms baseline={baseline_avg:.3f}ms factor={regression_factor:.2f}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
