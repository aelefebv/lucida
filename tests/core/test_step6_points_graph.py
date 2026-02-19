from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import sys
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


def _data_ref(
    *,
    uri: str,
    dtype: str,
    shape: list[int],
) -> dict[str, object]:
    return {
        "kind": "uri",
        "uri": uri,
        "dtype": dtype,
        "shape": shape,
        "endianness": "little",
        "compression": "none",
        "ttl_ms": 60000,
        "checksum_sha256": "a" * 64,
    }


class Step6PointsGraphTests(unittest.TestCase):
    def _new_engine(self, seed: int = 1) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=seed),
        )

    def _create_session(self, engine: NDStateEngine, key: str = "idem-step6-session") -> str:
        return str(
            engine.dispatch(
                "session.create",
                _request(1, idempotency_key=key, label="step6"),
            )["session_id"]
        )

    def _default_view_id(self, engine: NDStateEngine, session_id: str) -> str:
        snapshot = engine.snapshot()
        for session in snapshot["sessions"]:
            if session["session_id"] == session_id:
                return sorted(session["views"])[0]
        raise AssertionError("session not found")

    def _run_flow(self, seed: int) -> dict[str, object]:
        engine = self._new_engine(seed=seed)
        session_id = self._create_session(engine, key=f"idem-step6-session-{seed}")
        view_id = self._default_view_id(engine, session_id)

        layer_id = str(
            engine.dispatch(
                "layer.add_points",
                _request(
                    2,
                    idempotency_key=f"idem-step6-layer-{seed}",
                    session_id=session_id,
                    data_ref=_data_ref(
                        uri=f"memory://points/{seed}",
                        dtype="float32",
                        shape=[100_000, 3],
                    ),
                    point_id_ref=_data_ref(
                        uri=f"memory://points_ids/{seed}",
                        dtype="uint64",
                        shape=[100_000],
                    ),
                    edges_ref=_data_ref(
                        uri=f"memory://edges/{seed}",
                        dtype="uint32",
                        shape=[20_000, 2],
                    ),
                    attribute_table_ref=_data_ref(
                        uri=f"memory://attrs/{seed}",
                        dtype="float32",
                        shape=[100_000, 2],
                    ),
                    attribute_columns=["intensity", "track_id"],
                    coordinate_axes=["x", "y", "z"],
                    name="cells",
                ),
            )["layer_id"]
        )

        engine.dispatch(
            "view.bind_layer",
            _request(
                3,
                idempotency_key=f"idem-step6-bind-{seed}",
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
            ),
        )

        engine.dispatch(
            "layer.update",
            _request(
                4,
                idempotency_key=f"idem-step6-style-{seed}",
                session_id=session_id,
                layer_id=layer_id,
                patch={
                    "points_filter": {
                        "op": "and",
                        "predicates": [
                            {"op": "range", "field": "intensity", "min": 0.25, "max": 0.9},
                            {"op": "exists", "field": "track_id"},
                        ],
                    },
                    "lod_cell_px": 3,
                    "lod_max_points": 120_000,
                    "point_size": 1.25,
                    "color_by": "track_id",
                },
            ),
        )

        engine.dispatch(
            "selection.set",
            _request(
                5,
                idempotency_key=f"idem-step6-select-{seed}",
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
                selection={"indices": [5, 3, 3, 1]},
            ),
        )

        return {
            "snapshot": engine.snapshot(),
            "events": engine.events_for_session(session_id),
            "points_plan": engine.frame_plan_points_for_view(session_id, view_id),
        }

    def test_frame_plans_and_events_are_deterministic(self) -> None:
        first = self._run_flow(seed=10)
        second = self._run_flow(seed=10)
        self.assertEqual(first, second)

    def test_layer_add_points_rejects_invalid_shapes_and_dtypes(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)

        with self.assertRaises(LucidaError) as bad_shape:
            engine.dispatch(
                "layer.add_points",
                _request(
                    2,
                    idempotency_key="idem-step6-invalid-shape",
                    session_id=session_id,
                    data_ref=_data_ref(uri="memory://bad-shape", dtype="float32", shape=[100]),
                ),
            )
        self.assertEqual(bad_shape.exception.code, "LUCIDA_INVALID_PARAMS")

        with self.assertRaises(LucidaError) as bad_dtype:
            engine.dispatch(
                "layer.add_points",
                _request(
                    3,
                    idempotency_key="idem-step6-invalid-dtype",
                    session_id=session_id,
                    data_ref=_data_ref(uri="memory://bad-dtype", dtype="str", shape=[100, 3]),
                ),
            )
        self.assertEqual(bad_dtype.exception.code, "LUCIDA_INVALID_PARAMS")

        with self.assertRaises(LucidaError) as bad_edges:
            engine.dispatch(
                "layer.add_points",
                _request(
                    4,
                    idempotency_key="idem-step6-invalid-edges",
                    session_id=session_id,
                    data_ref=_data_ref(uri="memory://ok", dtype="float32", shape=[100, 3]),
                    edges_ref=_data_ref(uri="memory://bad-edges", dtype="uint32", shape=[10, 3]),
                ),
            )
        self.assertEqual(bad_edges.exception.code, "LUCIDA_INVALID_PARAMS")

    def test_layer_get_returns_points_state_summary(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        layer_id = str(
            engine.dispatch(
                "layer.add_points",
                _request(
                    2,
                    idempotency_key="idem-step6-summary-layer",
                    session_id=session_id,
                    data_ref=_data_ref(uri="memory://summary-points", dtype="float32", shape=[42, 3]),
                    edges_ref=_data_ref(uri="memory://summary-edges", dtype="uint32", shape=[7, 2]),
                    attribute_columns=["signal", "class_id"],
                ),
            )["layer_id"]
        )
        engine.dispatch(
            "layer.update",
            _request(
                3,
                idempotency_key="idem-step6-summary-style",
                session_id=session_id,
                layer_id=layer_id,
                patch={"lod_cell_px": 4, "lod_max_points": 11111, "points_filter": {"op": "exists", "field": "signal"}},
            ),
        )

        layer = engine.dispatch(
            "layer.get",
            _request(4, session_id=session_id, layer_id=layer_id),
        )
        points_state = layer["points_state"]
        self.assertEqual(points_state["point_count"], 42)
        self.assertEqual(points_state["edge_count"], 7)
        self.assertEqual(points_state["attribute_columns"], ["signal", "class_id"])
        self.assertEqual(points_state["active_lod"]["lod_cell_px"], 4)
        self.assertEqual(points_state["active_lod"]["lod_max_points"], 11111)

    def test_selection_changed_large_payload_uses_dataref_fallback(self) -> None:
        engine = self._new_engine(seed=33)
        session_id = self._create_session(engine, key="idem-step6-large")
        view_id = self._default_view_id(engine, session_id)

        layer_id = str(
            engine.dispatch(
                "layer.add_points",
                _request(
                    2,
                    idempotency_key="idem-step6-large-layer",
                    session_id=session_id,
                    data_ref=_data_ref(uri="memory://large-points", dtype="float32", shape=[10000, 3]),
                ),
            )["layer_id"]
        )
        engine.dispatch(
            "view.bind_layer",
            _request(
                3,
                idempotency_key="idem-step6-large-bind",
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
            ),
        )

        engine.dispatch(
            "selection.set",
            _request(
                4,
                idempotency_key="idem-step6-large-selection",
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
                selection={"indices": list(range(5000))},
            ),
        )

        events = engine.events_for_session(session_id)
        selection_event = [event for event in events if event["event_type"] == "selection.changed"][-1]
        payload = selection_event["payload"]

        self.assertEqual(payload["view_id"], view_id)
        self.assertEqual(payload["resolved_count"], 5000)
        self.assertIn("selected_point_ids_ref", payload)
        self.assertNotIn("selected_point_ids", payload)
        self.assertIn("linked_image_context", payload)
        self.assertEqual(payload["linked_image_context"]["slice_hint"], {"c": 0, "t": 0, "x": 0, "y": 0, "z": 0})

    def test_points_style_patch_maps_to_style_invalidation(self) -> None:
        engine = self._new_engine(seed=99)
        session_id = self._create_session(engine, key="idem-step6-style")
        view_id = self._default_view_id(engine, session_id)

        layer_id = str(
            engine.dispatch(
                "layer.add_points",
                _request(
                    2,
                    idempotency_key="idem-step6-style-layer",
                    session_id=session_id,
                    data_ref=_data_ref(uri="memory://style-points", dtype="float32", shape=[2500, 3]),
                ),
            )["layer_id"]
        )
        engine.dispatch(
            "view.bind_layer",
            _request(
                3,
                idempotency_key="idem-step6-style-bind",
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
            ),
        )

        engine.dispatch(
            "layer.update",
            _request(
                4,
                idempotency_key="idem-step6-style-update",
                session_id=session_id,
                layer_id=layer_id,
                patch={"lod_max_points": 999, "points_filter": {"op": "eq", "field": "class", "value": "A"}},
            ),
        )
        plan = engine.frame_plan_points_for_view(session_id, view_id)
        self.assertEqual(plan["invalidation_kind"], "style")
        self.assertIn("layer.update.lod_max_points", plan["invalidation_reasons"])
        self.assertIn("layer.update.points_filter", plan["invalidation_reasons"])

    def test_points_filter_validation_rejects_unknown_operator(self) -> None:
        engine = self._new_engine(seed=123)
        session_id = self._create_session(engine, key="idem-step6-filter")
        layer_id = str(
            engine.dispatch(
                "layer.add_points",
                _request(
                    2,
                    idempotency_key="idem-step6-filter-layer",
                    session_id=session_id,
                    data_ref=_data_ref(uri="memory://filter-points", dtype="float32", shape=[100, 3]),
                ),
            )["layer_id"]
        )

        with self.assertRaises(LucidaError) as invalid_filter:
            engine.dispatch(
                "layer.update",
                _request(
                    3,
                    idempotency_key="idem-step6-filter-update",
                    session_id=session_id,
                    layer_id=layer_id,
                    patch={"points_filter": {"op": "foo", "field": "signal"}},
                ),
            )
        self.assertEqual(invalid_filter.exception.code, "LUCIDA_INVALID_PARAMS")


if __name__ == "__main__":
    unittest.main()
