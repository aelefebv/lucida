from __future__ import annotations

from datetime import UTC, datetime
import math
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import LucidaError, NDStateEngine, SequenceClock, SequenceUUIDFactory
from lucida_core.render3d.controls import apply_arcball_orbit, apply_freefly_motion


def _request(base_id: int, **kwargs: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocol_version": "1.0.0",
        "request_id": f"0194c8f0-c7fa-7a2d-8abc-{base_id:012x}",
    }
    payload.update(kwargs)
    return payload


def _pose(*, position: tuple[float, float, float], target: tuple[float, float, float], up: tuple[float, float, float], fov: float | None = 45.0) -> dict[str, object]:
    out: dict[str, object] = {
        "position": [float(position[0]), float(position[1]), float(position[2])],
        "target": [float(target[0]), float(target[1]), float(target[2])],
        "up": [float(up[0]), float(up[1]), float(up[2])],
    }
    if fov is not None:
        out["fov_degrees"] = float(fov)
    return out


def _vec_sub(left: list[float], right: list[float]) -> list[float]:
    return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]


def _vec_norm(vec: list[float]) -> float:
    return math.sqrt(vec[0] ** 2 + vec[1] ** 2 + vec[2] ** 2)


def _vec_dot(left: list[float], right: list[float]) -> float:
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]


def _vec_cross(left: list[float], right: list[float]) -> list[float]:
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]


def _vec_normalize(vec: list[float]) -> list[float]:
    norm = _vec_norm(vec)
    if norm <= 1e-12:
        return [0.0, 0.0, 0.0]
    return [vec[0] / norm, vec[1] / norm, vec[2] / norm]


class Step5Render3DTests(unittest.TestCase):
    def _new_engine(self, seed: int = 1) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=seed),
        )

    def _create_session(self, engine: NDStateEngine, key: str = "idem-session-step5") -> str:
        result = engine.dispatch(
            "session.create",
            _request(1, idempotency_key=key, label="step5"),
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
    ) -> tuple[str, str, str]:
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
        return dataset_id, layer_id, selected_view_id

    def _write_multiscale_fixture(self, root: Path) -> str:
        import zarr

        path = root / "step5-multiscale.zarr"
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

        create("0", (1, 1, 16, 128, 128), (1, 1, 8, 64, 64))
        create("1", (1, 1, 8, 64, 64), (1, 1, 4, 32, 32))

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

    def _write_2d_fixture(self, root: Path) -> str:
        import zarr

        path = root / "step5-2d.zarr"
        group = zarr.open_group(str(path), mode="w")
        create_array = getattr(group, "create_array", None)

        if callable(create_array):
            try:
                create_array(name="0", shape=(128, 128), chunks=(64, 64), dtype="uint16", fill_value=0)
            except TypeError:
                create_array("0", shape=(128, 128), chunks=(64, 64), dtype="uint16", fill_value=0)
        else:
            group.create_dataset("0", shape=(128, 128), chunks=(64, 64), dtype="uint16", fill_value=0)

        group.attrs["multiscales"] = [
            {
                "name": "main",
                "version": "0.5",
                "axes": [
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"},
                ],
                "datasets": [{"path": "0"}],
            }
        ]
        return f"file://{path}"

    def _run_step5_flow(self, seed: int) -> dict[str, object]:
        engine = self._new_engine(seed=seed)
        session_id = self._create_session(engine, key=f"idem-session-step5-{seed}")
        _dataset_id, layer_id, view_id = self._open_and_bind_single_layer(
            engine,
            session_id,
            uri="synthetic://anisotropic-large",
            request_base=20,
        )

        engine.dispatch(
            "camera.set_mode",
            _request(
                30,
                idempotency_key=f"idem-mode-{seed}",
                session_id=session_id,
                view_id=view_id,
                mode="freefly",
            ),
        )
        engine.dispatch(
            "camera.set_pose",
            _request(
                31,
                idempotency_key=f"idem-pose-{seed}",
                session_id=session_id,
                view_id=view_id,
                pose=_pose(position=(1.0, 2.0, 3.0), target=(0.0, 2.0, 2.0), up=(0.0, 1.0, 1.0), fov=55.0),
            ),
        )
        engine.dispatch(
            "view.reorder_axes",
            _request(
                32,
                idempotency_key=f"idem-reorder-{seed}",
                session_id=session_id,
                view_id=view_id,
                order=["t", "c", "z", "x", "y"],
            ),
        )
        engine.dispatch(
            "view.set_axis_index",
            _request(
                33,
                idempotency_key=f"idem-slice-{seed}",
                session_id=session_id,
                view_id=view_id,
                axis_index={"axis": "t", "index": 0},
            ),
        )
        engine.dispatch(
            "layer.update",
            _request(
                34,
                idempotency_key=f"idem-style-{seed}",
                session_id=session_id,
                layer_id=layer_id,
                patch={"render_mode": "alpha", "density_scale": 1.5, "sample_step": 0.75, "opacity": 0.6},
            ),
        )

        return {
            "snapshot": engine.snapshot(),
            "frame_plan_3d": engine.frame_plan_3d_for_view(session_id, view_id),
        }

    def test_controls_arcball_orbit_preserves_target_and_radius(self) -> None:
        initial = _pose(position=(4.0, 2.0, 8.0), target=(1.0, 2.0, 3.0), up=(0.0, 1.0, 0.0))
        before_offset = _vec_sub(initial["position"], initial["target"])  # type: ignore[arg-type]
        before_radius = _vec_norm(before_offset)

        updated = apply_arcball_orbit(initial, delta_yaw=0.4, delta_pitch=-0.2, delta_roll=0.5)
        after_offset = _vec_sub(updated["position"], updated["target"])  # type: ignore[arg-type]
        after_radius = _vec_norm(after_offset)

        self.assertEqual(updated["target"], initial["target"])
        self.assertAlmostEqual(before_radius, after_radius, places=9)

    def test_controls_freefly_motion_uses_local_basis_after_roll(self) -> None:
        initial = _pose(position=(0.0, 0.0, 5.0), target=(0.0, 0.0, 4.0), up=(0.0, 1.0, 0.0))
        rolled = apply_freefly_motion(initial, delta_roll=math.pi / 2)
        moved = apply_freefly_motion(rolled, move_right=1.0)

        delta = _vec_sub(moved["position"], rolled["position"])  # type: ignore[arg-type]
        delta_unit = _vec_normalize(delta)

        forward = _vec_normalize(_vec_sub(rolled["target"], rolled["position"]))  # type: ignore[arg-type]
        up = _vec_normalize(rolled["up"])  # type: ignore[arg-type]
        right = _vec_normalize(_vec_cross(forward, up))

        self.assertGreater(_vec_dot(delta_unit, right), 0.999)

    def test_frame_plans_are_deterministic_for_same_command_stream(self) -> None:
        first = self._run_step5_flow(seed=300)
        second = self._run_step5_flow(seed=300)
        self.assertEqual(first, second)

    def test_axis_map_and_reorder_determine_volume_axes(self) -> None:
        engine = self._new_engine(seed=320)
        session_id = self._create_session(engine, key="idem-axis-step5")
        _dataset_id, _layer_id, view_id = self._open_and_bind_single_layer(
            engine,
            session_id,
            axis_map={"x": "y", "y": "x"},
            request_base=50,
        )

        default_plan = engine.frame_plan_3d_for_view(session_id, view_id)
        self.assertEqual(default_plan["volume_axes"], ["z", "y", "x"])

        engine.dispatch(
            "view.reorder_axes",
            _request(
                53,
                idempotency_key="idem-axis-step5-reorder",
                session_id=session_id,
                view_id=view_id,
                order=["t", "c", "z", "x", "y"],
            ),
        )
        reordered = engine.frame_plan_3d_for_view(session_id, view_id)
        self.assertEqual(reordered["volume_axes"], ["z", "x", "y"])

    def test_camera_set_get_canonicalizes_arcball_and_freefly(self) -> None:
        engine = self._new_engine(seed=330)
        session_id = self._create_session(engine, key="idem-camera-step5")
        _dataset_id, _layer_id, view_id = self._open_and_bind_single_layer(engine, session_id, request_base=60)

        engine.dispatch(
            "camera.set_mode",
            _request(63, idempotency_key="idem-cam-mode-arcball", session_id=session_id, view_id=view_id, mode="arcball"),
        )
        engine.dispatch(
            "camera.set_pose",
            _request(
                64,
                idempotency_key="idem-cam-pose-arcball",
                session_id=session_id,
                view_id=view_id,
                pose=_pose(position=(0.0, 0.0, 4.0), target=(0.0, 0.0, 0.0), up=(0.0, 1.0, 1.0)),
            ),
        )
        arcball = engine.dispatch("camera.get", _request(65, session_id=session_id, view_id=view_id))
        up = arcball["pose"]["up"]
        self.assertAlmostEqual(_vec_norm(up), 1.0, places=9)
        self.assertGreater(abs(up[2]), 0.5)

        engine.dispatch(
            "camera.set_mode",
            _request(66, idempotency_key="idem-cam-mode-freefly", session_id=session_id, view_id=view_id, mode="freefly"),
        )
        freefly = engine.dispatch("camera.get", _request(67, session_id=session_id, view_id=view_id))
        up_freefly = freefly["pose"]["up"]
        self.assertAlmostEqual(_vec_norm(up_freefly), 1.0, places=9)
        self.assertGreater(abs(up_freefly[2]), 0.5)

    def test_render_modes_defaults_updates_and_invalid_values(self) -> None:
        engine = self._new_engine(seed=340)
        session_id = self._create_session(engine, key="idem-style-step5")
        _dataset_id, layer_id, view_id = self._open_and_bind_single_layer(engine, session_id, request_base=70)

        default_plan = engine.frame_plan_3d_for_view(session_id, view_id)
        layer = default_plan["layers"][0]
        self.assertEqual(layer["render_mode"], "mip")
        self.assertEqual(layer["iso_threshold"], 0.5)
        self.assertEqual(layer["density_scale"], 1.0)
        self.assertEqual(layer["sample_step"], 1.0)

        engine.dispatch(
            "layer.update",
            _request(
                73,
                idempotency_key="idem-style-step5-iso",
                session_id=session_id,
                layer_id=layer_id,
                patch={"render_mode": "iso", "iso_threshold": 0.25, "sample_step": 0.5},
            ),
        )
        iso_plan = engine.frame_plan_3d_for_view(session_id, view_id)
        iso_layer = iso_plan["layers"][0]
        self.assertEqual(iso_layer["render_mode"], "iso")
        self.assertEqual(iso_layer["iso_threshold"], 0.25)
        self.assertEqual(iso_layer["sample_step"], 0.5)

        engine.dispatch(
            "layer.update",
            _request(
                74,
                idempotency_key="idem-style-step5-alpha",
                session_id=session_id,
                layer_id=layer_id,
                patch={"render_mode": "alpha", "density_scale": 2.5},
            ),
        )
        alpha_plan = engine.frame_plan_3d_for_view(session_id, view_id)
        alpha_layer = alpha_plan["layers"][0]
        self.assertEqual(alpha_layer["render_mode"], "alpha")
        self.assertEqual(alpha_layer["density_scale"], 2.5)

        with self.assertRaises(LucidaError):
            engine.dispatch(
                "layer.update",
                _request(
                    75,
                    idempotency_key="idem-style-step5-invalid",
                    session_id=session_id,
                    layer_id=layer_id,
                    patch={"render_mode": "blend"},
                ),
            )

    def test_multiscale_selection_with_hysteresis_uses_volume_axes(self) -> None:
        engine = self._new_engine(seed=350)
        session_id = self._create_session(engine, key="idem-multiscale-step5")
        view_id = self._default_view_id(engine, session_id)

        with tempfile.TemporaryDirectory() as tmpdir:
            uri = self._write_multiscale_fixture(Path(tmpdir))
            _dataset_id, _layer_id, _ = self._open_and_bind_single_layer(
                engine,
                session_id,
                uri=uri,
                view_id=view_id,
                request_base=80,
            )

            engine.dispatch(
                "camera.set_mode",
                _request(83, idempotency_key="idem-ms-step5-mode", session_id=session_id, view_id=view_id, mode="arcball"),
            )
            initial = engine.frame_plan_3d_for_view(session_id, view_id)
            self.assertEqual(initial["selected_level"], 0)

            engine.dispatch(
                "camera.set_pose",
                _request(
                    84,
                    idempotency_key="idem-ms-step5-out",
                    session_id=session_id,
                    view_id=view_id,
                    pose=_pose(position=(0.0, 0.0, 2.5), target=(0.0, 0.0, 0.0), up=(0.0, 1.0, 0.0)),
                ),
            )
            zoomed_out = engine.frame_plan_3d_for_view(session_id, view_id)
            self.assertEqual(zoomed_out["selected_level"], 1)

            engine.dispatch(
                "camera.set_pose",
                _request(
                    85,
                    idempotency_key="idem-ms-step5-hold",
                    session_id=session_id,
                    view_id=view_id,
                    pose=_pose(position=(0.0, 0.0, 1.8181818182), target=(0.0, 0.0, 0.0), up=(0.0, 1.0, 0.0)),
                ),
            )
            hysteresis_hold = engine.frame_plan_3d_for_view(session_id, view_id)
            self.assertEqual(hysteresis_hold["selected_level"], 1)

            engine.dispatch(
                "camera.set_pose",
                _request(
                    86,
                    idempotency_key="idem-ms-step5-in",
                    session_id=session_id,
                    view_id=view_id,
                    pose=_pose(position=(0.0, 0.0, 0.7142857143), target=(0.0, 0.0, 0.0), up=(0.0, 1.0, 0.0)),
                ),
            )
            zoomed_in = engine.frame_plan_3d_for_view(session_id, view_id)
            self.assertEqual(zoomed_in["selected_level"], 0)

    def test_style_invalidation_coalesces_step5_style_reasons(self) -> None:
        engine = self._new_engine(seed=360)
        session_id = self._create_session(engine, key="idem-coalesce-step5")
        _dataset_id, layer_id, view_id = self._open_and_bind_single_layer(engine, session_id, request_base=90)

        before = engine.frame_plan_3d_for_view(session_id, view_id)
        engine.dispatch(
            "layer.update",
            _request(
                93,
                idempotency_key="idem-coalesce-step5-style",
                session_id=session_id,
                layer_id=layer_id,
                patch={"opacity": 0.4, "render_mode": "iso", "sample_step": 0.75},
            ),
        )
        after = engine.frame_plan_3d_for_view(session_id, view_id)
        self.assertEqual(after["plan_seq"], before["plan_seq"] + 1)
        self.assertEqual(after["invalidation_kind"], "style")
        self.assertEqual(
            after["invalidation_reasons"],
            ["layer.update.opacity", "layer.update.render_mode", "layer.update.sample_step"],
        )

    def test_compositing_reflects_visible_opacity_channel_order(self) -> None:
        engine = self._new_engine(seed=370)
        session_id = self._create_session(engine, key="idem-composite-step5")
        view_id = self._default_view_id(engine, session_id)
        engine.dispatch(
            "dataset.open",
            _request(
                100,
                idempotency_key="idem-composite-step5-open",
                session_id=session_id,
                uri="synthetic://image",
                read_only=True,
            ),
        )
        dataset_id = self._dataset_ids(engine, session_id)[0]
        layer_a = str(
            engine.dispatch(
                "layer.add_image",
                _request(101, idempotency_key="idem-composite-step5-layer-a", session_id=session_id, dataset_id=dataset_id),
            )["layer_id"]
        )
        layer_b = str(
            engine.dispatch(
                "layer.add_image",
                _request(102, idempotency_key="idem-composite-step5-layer-b", session_id=session_id, dataset_id=dataset_id),
            )["layer_id"]
        )
        engine.dispatch(
            "view.bind_layer",
            _request(103, idempotency_key="idem-composite-step5-bind-a", session_id=session_id, view_id=view_id, layer_id=layer_a),
        )
        engine.dispatch(
            "view.bind_layer",
            _request(104, idempotency_key="idem-composite-step5-bind-b", session_id=session_id, view_id=view_id, layer_id=layer_b),
        )
        engine.dispatch(
            "view.set_channel_order",
            _request(105, idempotency_key="idem-composite-step5-channel", session_id=session_id, view_id=view_id, channel_order=[0]),
        )
        engine.dispatch(
            "layer.update",
            _request(
                106,
                idempotency_key="idem-composite-step5-style",
                session_id=session_id,
                layer_id=layer_b,
                patch={"visible": False, "opacity": 0.2, "render_mode": "alpha", "density_scale": 2.0},
            ),
        )
        plan = engine.frame_plan_3d_for_view(session_id, view_id)
        self.assertEqual(plan["layer_order"], [layer_a, layer_b])

        layer_by_id = {entry["layer_id"]: entry for entry in plan["layers"]}
        self.assertEqual(layer_by_id[layer_a]["visible"], True)
        self.assertEqual(layer_by_id[layer_a]["opacity"], 1.0)
        self.assertEqual(layer_by_id[layer_b]["visible"], False)
        self.assertEqual(layer_by_id[layer_b]["opacity"], 0.2)
        self.assertEqual(layer_by_id[layer_b]["channel_order"], [0])

    def test_two_axis_view_is_non_renderable_with_insufficient_volume_axes(self) -> None:
        engine = self._new_engine(seed=380)
        session_id = self._create_session(engine, key="idem-2d-step5")

        with tempfile.TemporaryDirectory() as tmpdir:
            uri = self._write_2d_fixture(Path(tmpdir))
            engine.dispatch(
                "dataset.open",
                _request(
                    110,
                    idempotency_key="idem-2d-step5-open",
                    session_id=session_id,
                    uri=uri,
                    read_only=True,
                ),
            )
            dataset_id = self._dataset_ids(engine, session_id)[-1]
            view_id = str(
                engine.dispatch(
                    "view.create",
                    _request(111, idempotency_key="idem-2d-step5-view", session_id=session_id, label="2d"),
                )["view_id"]
            )
            layer_id = str(
                engine.dispatch(
                    "layer.add_image",
                    _request(112, idempotency_key="idem-2d-step5-layer", session_id=session_id, dataset_id=dataset_id),
                )["layer_id"]
            )
            engine.dispatch(
                "view.bind_layer",
                _request(
                    113,
                    idempotency_key="idem-2d-step5-bind",
                    session_id=session_id,
                    view_id=view_id,
                    layer_id=layer_id,
                ),
            )
            plan = engine.frame_plan_3d_for_view(session_id, view_id)
            self.assertEqual(plan["renderable"], False)
            self.assertEqual(plan["non_renderable_reason"], "insufficient_volume_axes")


if __name__ == "__main__":
    unittest.main()
