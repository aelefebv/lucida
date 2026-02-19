from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import NDStateEngine, SequenceClock, SequenceUUIDFactory
from lucida_core.render2d.controls import PanZoomState, apply_cursor_anchored_zoom, apply_pan_drag


def _request(base_id: int, **kwargs: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocol_version": "1.0.0",
        "request_id": f"0194c8f0-c7fa-7a2d-8abc-{base_id:012x}",
    }
    payload.update(kwargs)
    return payload


def _panzoom_pose(*, center_x: float = 0.0, center_y: float = 0.0, zoom: float = 1.0) -> dict[str, object]:
    depth = 1.0 / zoom
    return {
        "position": [center_x, center_y, depth],
        "target": [center_x, center_y, 0.0],
        "up": [0.0, 1.0, 0.0],
        "fov_degrees": 45.0,
    }


class Step4Render2DTests(unittest.TestCase):
    def _new_engine(self, seed: int = 1) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=seed),
        )

    def _create_session(self, engine: NDStateEngine, key: str = "idem-session-step4-1") -> str:
        result = engine.dispatch(
            "session.create",
            _request(1, idempotency_key=key, label="step4"),
        )
        return str(result["session_id"])

    def _default_view_id(self, engine: NDStateEngine, session_id: str) -> str:
        snapshot = engine.snapshot()
        for session in snapshot["sessions"]:
            if session["session_id"] == session_id:
                return sorted(session["views"])[0]
        raise AssertionError("session not found in snapshot")

    def _dataset_ids(self, engine: NDStateEngine, session_id: str) -> list[str]:
        events = engine.events_for_session(session_id)
        return [event["payload"]["dataset_id"] for event in events if event["event_type"] == "dataset.opened"]

    def _open_and_bind_single_layer(
        self,
        engine: NDStateEngine,
        session_id: str,
        *,
        uri: str = "synthetic://image",
        axis_map: dict[str, str] | None = None,
        view_id: str | None = None,
        request_base: int = 10,
    ) -> tuple[str, str]:
        engine.dispatch(
            "dataset.open",
            _request(
                request_base,
                idempotency_key=f"idem-open-{request_base}",
                session_id=session_id,
                uri=uri,
                read_only=True,
                axis_map=axis_map,
            ),
        )
        dataset_id = self._dataset_ids(engine, session_id)[-1]
        layer_id = str(
            engine.dispatch(
                "layer.add_image",
                _request(
                    request_base + 1,
                    idempotency_key=f"idem-layer-{request_base}",
                    session_id=session_id,
                    dataset_id=dataset_id,
                    name="image",
                ),
            )["layer_id"]
        )
        selected_view_id = view_id or self._default_view_id(engine, session_id)
        engine.dispatch(
            "view.bind_layer",
            _request(
                request_base + 2,
                idempotency_key=f"idem-bind-{request_base}",
                session_id=session_id,
                view_id=selected_view_id,
                layer_id=layer_id,
            ),
        )
        return dataset_id, layer_id

    def _write_multiscale_fixture(self, root: Path) -> str:
        import zarr

        path = root / "step4-multiscale.zarr"
        group = zarr.open_group(str(path), mode="w")
        create_array = getattr(group, "create_array", None)

        def create(path_name: str, shape: tuple[int, ...], chunks: tuple[int, ...]) -> None:
            if callable(create_array):
                try:
                    create_array(name=path_name, shape=shape, chunks=chunks, dtype="uint16", fill_value=0)
                except TypeError:
                    create_array(path_name, shape=shape, chunks=chunks, dtype="uint16", fill_value=0)
            else:
                group.create_dataset(path_name, shape=shape, chunks=chunks, dtype="uint16", fill_value=0)

        create("0", (1, 1, 4, 128, 128), (1, 1, 2, 64, 64))
        create("1", (1, 1, 4, 64, 64), (1, 1, 2, 32, 32))

        group.attrs["multiscales"] = [
            {
                "name": "main",
                "version": "0.5",
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "c", "type": "channel"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"},
                ],
                "datasets": [
                    {"path": "0"},
                    {"path": "1"},
                ],
            }
        ]
        return f"file://{path}"

    def _run_step4_flow(self, seed: int) -> dict[str, object]:
        engine = self._new_engine(seed=seed)
        session_id = self._create_session(engine, key=f"idem-session-{seed}")
        view_id = self._default_view_id(engine, session_id)
        _dataset_id, layer_id = self._open_and_bind_single_layer(engine, session_id, view_id=view_id, request_base=10)

        engine.dispatch(
            "view.set_axis_index",
            _request(
                20,
                idempotency_key=f"idem-axis-{seed}",
                session_id=session_id,
                view_id=view_id,
                axis_index={"axis": "z", "index": 2},
            ),
        )
        engine.dispatch(
            "camera.set_pose",
            _request(
                21,
                idempotency_key=f"idem-pose-{seed}",
                session_id=session_id,
                view_id=view_id,
                pose=_panzoom_pose(zoom=2.0),
            ),
        )
        engine.dispatch(
            "layer.update",
            _request(
                22,
                idempotency_key=f"idem-style-{seed}",
                session_id=session_id,
                layer_id=layer_id,
                patch={"visible": False, "opacity": 0.25},
            ),
        )
        return {
            "snapshot": engine.snapshot(),
            "frame_plan": engine.frame_plan_for_view(session_id, view_id),
        }

    def test_controls_cursor_anchored_zoom_preserves_anchor(self) -> None:
        initial = PanZoomState(center_x=10.0, center_y=5.0, zoom=2.0)
        anchor_x = 12.0
        anchor_y = 7.0
        before = ((anchor_x - initial.center_x) * initial.zoom, (anchor_y - initial.center_y) * initial.zoom)

        updated = apply_cursor_anchored_zoom(
            initial,
            cursor_world_x=anchor_x,
            cursor_world_y=anchor_y,
            zoom_factor=1.5,
        )
        after = ((anchor_x - updated.center_x) * updated.zoom, (anchor_y - updated.center_y) * updated.zoom)
        self.assertAlmostEqual(before[0], after[0], places=9)
        self.assertAlmostEqual(before[1], after[1], places=9)

    def test_controls_pan_drag_scales_by_zoom(self) -> None:
        initial = PanZoomState(center_x=0.0, center_y=0.0, zoom=2.0)
        updated = apply_pan_drag(initial, delta_screen_x=4.0, delta_screen_y=-2.0)
        self.assertAlmostEqual(updated.center_x, -2.0)
        self.assertAlmostEqual(updated.center_y, 1.0)
        self.assertAlmostEqual(updated.zoom, 2.0)

    def test_frame_plans_are_deterministic_for_same_command_stream(self) -> None:
        first = self._run_step4_flow(seed=40)
        second = self._run_step4_flow(seed=40)
        self.assertEqual(first, second)

    def test_axis_map_and_reorder_allow_display_plane_selection(self) -> None:
        engine = self._new_engine(seed=50)
        session_id = self._create_session(engine, key="idem-axis-flex")
        engine.dispatch(
            "dataset.open",
            _request(
                30,
                idempotency_key="idem-axis-open",
                session_id=session_id,
                uri="synthetic://image",
                read_only=True,
                axis_map={"y": "x", "x": "y"},
            ),
        )
        dataset_id = self._dataset_ids(engine, session_id)[0]
        view_id = str(
            engine.dispatch(
                "view.create",
                _request(31, idempotency_key="idem-axis-view", session_id=session_id, label="axes"),
            )["view_id"]
        )
        layer_id = str(
            engine.dispatch(
                "layer.add_image",
                _request(
                    32,
                    idempotency_key="idem-axis-layer",
                    session_id=session_id,
                    dataset_id=dataset_id,
                ),
            )["layer_id"]
        )
        engine.dispatch(
            "view.bind_layer",
            _request(
                33,
                idempotency_key="idem-axis-bind",
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
            ),
        )
        default_plan = engine.frame_plan_for_view(session_id, view_id)
        self.assertEqual(default_plan["display_axes"], ["x", "y"])

        engine.dispatch(
            "view.reorder_axes",
            _request(
                34,
                idempotency_key="idem-axis-reorder",
                session_id=session_id,
                view_id=view_id,
                order=["t", "c", "z", "y", "x"],
            ),
        )
        reordered = engine.frame_plan_for_view(session_id, view_id)
        self.assertEqual(reordered["display_axes"], ["y", "x"])

    def test_multiscale_level_selection_uses_screen_match_with_hysteresis(self) -> None:
        engine = self._new_engine(seed=60)
        session_id = self._create_session(engine, key="idem-multiscale")
        view_id = self._default_view_id(engine, session_id)

        with tempfile.TemporaryDirectory() as tmpdir:
            uri = self._write_multiscale_fixture(Path(tmpdir))
            _dataset_id, _layer_id = self._open_and_bind_single_layer(
                engine,
                session_id,
                uri=uri,
                view_id=view_id,
                request_base=40,
            )

            initial = engine.frame_plan_for_view(session_id, view_id)
            self.assertEqual(initial["selected_level"], 0)

            engine.dispatch(
                "camera.set_pose",
                _request(
                    43,
                    idempotency_key="idem-ms-zoom-low",
                    session_id=session_id,
                    view_id=view_id,
                    pose=_panzoom_pose(zoom=0.4),
                ),
            )
            zoomed_out = engine.frame_plan_for_view(session_id, view_id)
            self.assertEqual(zoomed_out["selected_level"], 1)

            engine.dispatch(
                "camera.set_pose",
                _request(
                    44,
                    idempotency_key="idem-ms-zoom-hys",
                    session_id=session_id,
                    view_id=view_id,
                    pose=_panzoom_pose(zoom=0.55),
                ),
            )
            hysteresis_hold = engine.frame_plan_for_view(session_id, view_id)
            self.assertEqual(hysteresis_hold["selected_level"], 1)

            engine.dispatch(
                "camera.set_pose",
                _request(
                    45,
                    idempotency_key="idem-ms-zoom-in",
                    session_id=session_id,
                    view_id=view_id,
                    pose=_panzoom_pose(zoom=1.4),
                ),
            )
            zoomed_in = engine.frame_plan_for_view(session_id, view_id)
            self.assertEqual(zoomed_in["selected_level"], 0)

    def test_style_invalidation_coalesces_multiple_patch_reasons(self) -> None:
        engine = self._new_engine(seed=70)
        session_id = self._create_session(engine, key="idem-coalesce")
        view_id = self._default_view_id(engine, session_id)
        _dataset_id, layer_id = self._open_and_bind_single_layer(engine, session_id, view_id=view_id, request_base=50)

        before = engine.frame_plan_for_view(session_id, view_id)
        engine.dispatch(
            "layer.update",
            _request(
                53,
                idempotency_key="idem-coalesce-style",
                session_id=session_id,
                layer_id=layer_id,
                patch={"visible": False, "opacity": 0.2},
            ),
        )
        after = engine.frame_plan_for_view(session_id, view_id)
        self.assertEqual(after["plan_seq"], before["plan_seq"] + 1)
        self.assertEqual(after["invalidation_kind"], "style")
        self.assertEqual(after["invalidation_reasons"], ["layer.update.opacity", "layer.update.visible"])

    def test_compositing_plan_reflects_visibility_opacity_and_channel_order(self) -> None:
        engine = self._new_engine(seed=80)
        session_id = self._create_session(engine, key="idem-composite")
        view_id = self._default_view_id(engine, session_id)
        engine.dispatch(
            "dataset.open",
            _request(
                60,
                idempotency_key="idem-composite-open",
                session_id=session_id,
                uri="synthetic://image",
                read_only=True,
            ),
        )
        dataset_id = self._dataset_ids(engine, session_id)[0]
        layer_a = str(
            engine.dispatch(
                "layer.add_image",
                _request(61, idempotency_key="idem-composite-layer-a", session_id=session_id, dataset_id=dataset_id),
            )["layer_id"]
        )
        layer_b = str(
            engine.dispatch(
                "layer.add_image",
                _request(62, idempotency_key="idem-composite-layer-b", session_id=session_id, dataset_id=dataset_id),
            )["layer_id"]
        )
        engine.dispatch(
            "view.bind_layer",
            _request(63, idempotency_key="idem-composite-bind-a", session_id=session_id, view_id=view_id, layer_id=layer_a),
        )
        engine.dispatch(
            "view.bind_layer",
            _request(64, idempotency_key="idem-composite-bind-b", session_id=session_id, view_id=view_id, layer_id=layer_b),
        )
        engine.dispatch(
            "view.set_channel_order",
            _request(
                65,
                idempotency_key="idem-composite-order",
                session_id=session_id,
                view_id=view_id,
                channel_order=[0],
            ),
        )
        engine.dispatch(
            "layer.update",
            _request(
                66,
                idempotency_key="idem-composite-style",
                session_id=session_id,
                layer_id=layer_b,
                patch={"visible": False, "opacity": 0.35},
            ),
        )
        plan = engine.frame_plan_for_view(session_id, view_id)
        self.assertEqual(plan["layer_order"], [layer_a, layer_b])
        layer_by_id = {entry["layer_id"]: entry for entry in plan["layers"]}
        self.assertEqual(layer_by_id[layer_a]["visible"], True)
        self.assertEqual(layer_by_id[layer_a]["opacity"], 1.0)
        self.assertEqual(layer_by_id[layer_b]["visible"], False)
        self.assertEqual(layer_by_id[layer_b]["opacity"], 0.35)


if __name__ == "__main__":
    unittest.main()
