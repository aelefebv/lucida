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


BASELINE_PATH = ROOT / "tests" / "perf" / "baselines" / "step6_points_perf.json"


def _request(base_id: int, **kwargs: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocol_version": "1.0.0",
        "request_id": f"0194c8f0-c7fa-7a2d-8abc-{base_id:012x}",
    }
    payload.update(kwargs)
    return payload


def _points_data_ref(uri: str, point_count: int = 1_000_000, dims: int = 3) -> dict[str, object]:
    return {
        "kind": "uri",
        "uri": uri,
        "dtype": "float32",
        "shape": [point_count, dims],
        "endianness": "little",
        "compression": "none",
        "ttl_ms": 60000,
        "checksum_sha256": "a" * 64,
    }


def _p95(samples: list[float]) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    idx = int(0.95 * (len(ordered) - 1))
    return float(ordered[idx])


class Step6PointsPerfTests(unittest.TestCase):
    def _new_engine(self) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=950),
        )

    def _create_bound_points_view(self, engine: NDStateEngine) -> tuple[str, str, str]:
        session_id = str(
            engine.dispatch(
                "session.create",
                _request(1, idempotency_key="idem-step6-perf-session", label="perf-step6"),
            )["session_id"]
        )

        snapshot = engine.snapshot()
        view_id = sorted(snapshot["sessions"][0]["views"])[0]

        layer_id = str(
            engine.dispatch(
                "layer.add_points",
                _request(
                    2,
                    idempotency_key="idem-step6-perf-layer",
                    session_id=session_id,
                    data_ref=_points_data_ref("memory://perf-step6-points", point_count=1_000_000),
                    point_id_ref={
                        "kind": "uri",
                        "uri": "memory://perf-step6-ids",
                        "dtype": "uint64",
                        "shape": [1_000_000],
                        "endianness": "little",
                        "compression": "none",
                        "ttl_ms": 60000,
                        "checksum_sha256": "b" * 64,
                    },
                    attribute_columns=["signal", "track_id"],
                ),
            )["layer_id"]
        )

        engine.dispatch(
            "view.bind_layer",
            _request(
                3,
                idempotency_key="idem-step6-perf-bind",
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
            ),
        )
        return session_id, view_id, layer_id

    def _measure_dispatch_ms(
        self,
        engine: NDStateEngine,
        session_id: str,
        view_id: str,
        layer_id: str,
        count: int = 120,
    ) -> list[float]:
        timings_ms: list[float] = []
        for idx in range(count):
            start = time.perf_counter()
            engine.dispatch(
                "layer.update",
                _request(
                    1000 + idx * 2,
                    idempotency_key=f"idem-step6-perf-style-{idx}",
                    session_id=session_id,
                    layer_id=layer_id,
                    patch={
                        "lod_cell_px": 2 + (idx % 3),
                        "lod_max_points": 180000 + (idx % 7) * 1000,
                        "points_filter": {
                            "op": "and",
                            "predicates": [
                                {"op": "range", "field": "signal", "min": 0.1, "max": 0.95},
                                {"op": "eq", "field": "track_id", "value": idx % 17},
                            ],
                        },
                    },
                ),
            )
            engine.dispatch(
                "selection.set",
                _request(
                    1001 + idx * 2,
                    idempotency_key=f"idem-step6-perf-select-{idx}",
                    session_id=session_id,
                    view_id=view_id,
                    layer_id=layer_id,
                    selection={"indices": [idx % 1000, (idx + 1) % 1000, (idx + 2) % 1000]},
                ),
            )
            timings_ms.append((time.perf_counter() - start) * 1000.0)
        return timings_ms

    def test_perf_smoke_planner_dispatch_p95_under_target(self) -> None:
        engine = self._new_engine()
        session_id, view_id, layer_id = self._create_bound_points_view(engine)
        samples = self._measure_dispatch_ms(engine, session_id, view_id, layer_id, count=80)
        p95_ms = _p95(samples)

        target_ms = float(os.environ.get("LUCIDA_STEP6_PERF_SMOKE_P95_MS", "80"))
        self.assertLessEqual(
            p95_ms,
            target_ms,
            msg=f"Step6 perf smoke p95 exceeded target: p95={p95_ms:.3f}ms target={target_ms:.3f}ms",
        )

    def test_perf_regression_against_baseline(self) -> None:
        if os.environ.get("LUCIDA_STEP6_PERF_FULL", "0") != "1":
            self.skipTest("Full perf regression gate is enabled only in scheduled/nightly mode")

        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
        baseline_p95 = float(baseline["planner_dispatch_p95_ms"])
        baseline_avg = float(baseline["planner_dispatch_avg_ms"])

        engine = self._new_engine()
        session_id, view_id, layer_id = self._create_bound_points_view(engine)
        samples = self._measure_dispatch_ms(engine, session_id, view_id, layer_id, count=160)
        p95_ms = _p95(samples)
        avg_ms = float(statistics.fmean(samples))

        factor = float(os.environ.get("LUCIDA_STEP6_PERF_REGRESSION_FACTOR", "1.25"))
        self.assertLessEqual(
            p95_ms,
            baseline_p95 * factor,
            msg=(
                "Step6 perf regression gate failed for p95: "
                f"p95={p95_ms:.3f}ms baseline={baseline_p95:.3f}ms factor={factor:.2f}"
            ),
        )
        self.assertLessEqual(
            avg_ms,
            baseline_avg * factor,
            msg=(
                "Step6 perf regression gate failed for average: "
                f"avg={avg_ms:.3f}ms baseline={baseline_avg:.3f}ms factor={factor:.2f}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
