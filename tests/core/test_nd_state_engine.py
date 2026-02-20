from __future__ import annotations

from datetime import UTC, datetime
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


class NDStateEngineTests(unittest.TestCase):
    def _new_engine(self, seed: int = 1) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=seed),
        )

    def _create_session(self, engine: NDStateEngine, key: str = "idem-session-0001") -> str:
        result = engine.dispatch(
            "session.create",
            _request(1, idempotency_key=key, label="main"),
        )
        return str(result["session_id"])

    def _dataset_ids(self, engine: NDStateEngine, session_id: str) -> list[str]:
        events = engine.events_for_session(session_id)
        return [event["payload"]["dataset_id"] for event in events if event["event_type"] == "dataset.opened"]

    def _write_ome_zarr_fixture(
        self,
        root: Path,
        *,
        name: str = "sample.zarr",
        version: str = "0.5",
        shape: tuple[int, ...] = (1, 1, 4, 16, 16),
        dtype: str = "uint16",
    ) -> str:
        import zarr

        path = root / name
        grp = zarr.open_group(str(path), mode="w")
        create_array = getattr(grp, "create_array", None)
        if callable(create_array):
            try:
                create_array(
                    name="0",
                    shape=shape,
                    chunks=(1, 1, 2, 8, 8),
                    dtype=dtype,
                    fill_value=0,
                )
            except TypeError:
                create_array(
                    "0",
                    shape=shape,
                    chunks=(1, 1, 2, 8, 8),
                    dtype=dtype,
                    fill_value=0,
                )
        else:
            grp.create_dataset(
                "0",
                shape=shape,
                chunks=(1, 1, 2, 8, 8),
                dtype=dtype,
                fill_value=0,
            )
        grp.attrs["multiscales"] = [
            {
                "name": "main",
                "version": version,
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "c", "type": "channel"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"},
                ],
                "datasets": [
                    {
                        "path": "0",
                        "coordinateTransformations": [
                            {"type": "scale", "scale": [1, 1, 2, 0.5, 0.5]},
                            {"type": "translation", "translation": [0, 0, 0, 0, 0]},
                        ],
                    }
                ],
            }
        ]
        return f"file://{path}"

    def _run_deterministic_flow(self, engine: NDStateEngine) -> dict[str, object]:
        session_id = self._create_session(engine)

        engine.dispatch(
            "dataset.open",
            _request(2, idempotency_key="idem-open-0001", session_id=session_id, uri="synthetic://image", read_only=True),
        )
        engine.dispatch(
            "dataset.open",
            _request(3, idempotency_key="idem-open-0002", session_id=session_id, uri="synthetic://mask", read_only=True),
        )
        dataset_ids = self._dataset_ids(engine, session_id)

        layer_one = engine.dispatch(
            "layer.add_image",
            _request(4, idempotency_key="idem-layer-0001", session_id=session_id, dataset_id=dataset_ids[0], name="image"),
        )["layer_id"]
        layer_two = engine.dispatch(
            "layer.add_image",
            _request(5, idempotency_key="idem-layer-0002", session_id=session_id, dataset_id=dataset_ids[1], name="mask"),
        )["layer_id"]
        view_id = engine.dispatch(
            "view.create",
            _request(6, idempotency_key="idem-view-0001", session_id=session_id, label="overlay"),
        )["view_id"]
        engine.dispatch(
            "view.bind_layer",
            _request(7, idempotency_key="idem-bind-0001", session_id=session_id, view_id=view_id, layer_id=layer_one),
        )
        engine.dispatch(
            "view.bind_layer",
            _request(8, idempotency_key="idem-bind-0002", session_id=session_id, view_id=view_id, layer_id=layer_two),
        )
        engine.dispatch(
            "view.set_axis_index",
            _request(
                9,
                idempotency_key="idem-axis-0001",
                session_id=session_id,
                view_id=view_id,
                axis_index={"axis": "z", "index": 3},
            ),
        )
        engine.dispatch(
            "camera.set_mode",
            _request(10, idempotency_key="idem-cam-0001", session_id=session_id, view_id=view_id, mode="arcball"),
        )
        engine.dispatch(
            "selection.set",
            _request(
                11,
                idempotency_key="idem-select-0001",
                session_id=session_id,
                view_id=view_id,
                selection={"indices": [1, 2, 3]},
            ),
        )
        return {
            "snapshot": engine.snapshot(),
            "events": engine.events_for_session(session_id),
        }

    def test_determinism_same_command_stream_same_state(self) -> None:
        first = self._run_deterministic_flow(self._new_engine(seed=10))
        second = self._run_deterministic_flow(self._new_engine(seed=10))
        self.assertEqual(first, second)

    def test_idempotency_reuses_cached_mutation_result(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        first = engine.dispatch(
            "view.create",
            _request(2, idempotency_key="idem-view-create-1", session_id=session_id, label="left"),
        )
        second = engine.dispatch(
            "view.create",
            _request(3, idempotency_key="idem-view-create-1", session_id=session_id, label="left"),
        )
        self.assertEqual(first, second)
        snapshot = engine.snapshot()
        views = snapshot["sessions"][0]["views"]
        self.assertEqual(len(views), 2)  # default view + one user-created view

    def test_multi_dataset_overlay_binds_layers_to_single_view(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        engine.dispatch(
            "dataset.open",
            _request(2, idempotency_key="idem-open-a", session_id=session_id, uri="synthetic://image", read_only=True),
        )
        engine.dispatch(
            "dataset.open",
            _request(3, idempotency_key="idem-open-b", session_id=session_id, uri="synthetic://mask", read_only=True),
        )
        dataset_one, dataset_two = self._dataset_ids(engine, session_id)

        layer_one = engine.dispatch(
            "layer.add_image",
            _request(4, idempotency_key="idem-layer-a", session_id=session_id, dataset_id=dataset_one),
        )["layer_id"]
        layer_two = engine.dispatch(
            "layer.add_image",
            _request(5, idempotency_key="idem-layer-b", session_id=session_id, dataset_id=dataset_two),
        )["layer_id"]
        view_id = engine.dispatch(
            "view.create",
            _request(6, idempotency_key="idem-view-a", session_id=session_id),
        )["view_id"]
        engine.dispatch(
            "view.bind_layer",
            _request(7, idempotency_key="idem-bind-a", session_id=session_id, view_id=view_id, layer_id=layer_one),
        )
        engine.dispatch(
            "view.bind_layer",
            _request(8, idempotency_key="idem-bind-b", session_id=session_id, view_id=view_id, layer_id=layer_two),
        )
        view = engine.dispatch(
            "view.get",
            _request(9, session_id=session_id, view_id=view_id),
        )
        self.assertEqual(len(view["bound_layer_ids"]), 2)

    def test_side_by_side_views_do_not_leak_state(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        engine.dispatch(
            "dataset.open",
            _request(2, idempotency_key="idem-open-1", session_id=session_id, uri="synthetic://image", read_only=True),
        )
        engine.dispatch(
            "dataset.open",
            _request(3, idempotency_key="idem-open-2", session_id=session_id, uri="synthetic://mask", read_only=True),
        )
        dataset_one, dataset_two = self._dataset_ids(engine, session_id)
        layer_one = engine.dispatch(
            "layer.add_image",
            _request(4, idempotency_key="idem-layer-1", session_id=session_id, dataset_id=dataset_one),
        )["layer_id"]
        layer_two = engine.dispatch(
            "layer.add_image",
            _request(5, idempotency_key="idem-layer-2", session_id=session_id, dataset_id=dataset_two),
        )["layer_id"]
        left_view = engine.dispatch(
            "view.create",
            _request(6, idempotency_key="idem-view-left", session_id=session_id, label="left"),
        )["view_id"]
        right_view = engine.dispatch(
            "view.create",
            _request(7, idempotency_key="idem-view-right", session_id=session_id, label="right"),
        )["view_id"]

        engine.dispatch(
            "view.bind_layer",
            _request(8, idempotency_key="idem-bind-left", session_id=session_id, view_id=left_view, layer_id=layer_one),
        )
        engine.dispatch(
            "view.bind_layer",
            _request(9, idempotency_key="idem-bind-right", session_id=session_id, view_id=right_view, layer_id=layer_two),
        )
        engine.dispatch(
            "view.set_axis_index",
            _request(
                10,
                idempotency_key="idem-axis-left",
                session_id=session_id,
                view_id=left_view,
                axis_index={"axis": "z", "index": 5},
            ),
        )

        left = engine.dispatch("view.get", _request(11, session_id=session_id, view_id=left_view))
        right = engine.dispatch("view.get", _request(12, session_id=session_id, view_id=right_view))
        self.assertEqual(left["bound_layer_ids"], [layer_one])
        self.assertEqual(right["bound_layer_ids"], [layer_two])
        self.assertEqual(left["axis_indices"]["z"], 5)
        self.assertEqual(right["axis_indices"]["z"], 0)

    def test_incompatible_dataset_bind_returns_conflict(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        engine.dispatch(
            "dataset.open",
            _request(2, idempotency_key="idem-open-a", session_id=session_id, uri="synthetic://image", read_only=True),
        )
        engine.dispatch(
            "dataset.open",
            _request(3, idempotency_key="idem-open-b", session_id=session_id, uri="synthetic://anisotropic", read_only=True),
        )
        dataset_one, dataset_two = self._dataset_ids(engine, session_id)
        layer_one = engine.dispatch(
            "layer.add_image",
            _request(4, idempotency_key="idem-layer-a", session_id=session_id, dataset_id=dataset_one),
        )["layer_id"]
        layer_two = engine.dispatch(
            "layer.add_image",
            _request(5, idempotency_key="idem-layer-b", session_id=session_id, dataset_id=dataset_two),
        )["layer_id"]
        view_id = engine.dispatch(
            "view.create",
            _request(6, idempotency_key="idem-view-a", session_id=session_id),
        )["view_id"]
        engine.dispatch(
            "view.bind_layer",
            _request(7, idempotency_key="idem-bind-a", session_id=session_id, view_id=view_id, layer_id=layer_one),
        )
        with self.assertRaises(LucidaError) as ctx:
            engine.dispatch(
                "view.bind_layer",
                _request(8, idempotency_key="idem-bind-b", session_id=session_id, view_id=view_id, layer_id=layer_two),
            )
        self.assertEqual(ctx.exception.code, "LUCIDA_CONFLICT")

    def test_unsupported_dataset_scheme_is_rejected(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        with self.assertRaises(LucidaError) as ctx:
            engine.dispatch(
                "dataset.open",
                _request(2, idempotency_key="idem-open-file", session_id=session_id, uri="ftp://example.com/data.zarr", read_only=True),
            )
        self.assertEqual(ctx.exception.code, "LUCIDA_UNSUPPORTED_CAPABILITY")

    def test_local_dataset_uri_surfaces_step3_metadata(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        with tempfile.TemporaryDirectory() as tmpdir:
            uri = self._write_ome_zarr_fixture(Path(tmpdir))
            engine.dispatch(
                "dataset.open",
                _request(2, idempotency_key="idem-open-local", session_id=session_id, uri=uri, read_only=True),
            )
            dataset_id = self._dataset_ids(engine, session_id)[0]
            payload = engine.dispatch(
                "dataset.get",
                _request(3, session_id=session_id, dataset_id=dataset_id),
            )
            self.assertEqual(payload["backend"], "local")
            self.assertEqual(payload["ngff"]["ngff_version"], "0.5")
            self.assertEqual(payload["ngff"]["zarr_format"], 2)
            self.assertIn("cache", payload)
            self.assertIn("counters", payload["cache"])

    def test_local_dataset_uri_supports_ngff_v04_metadata(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        with tempfile.TemporaryDirectory() as tmpdir:
            uri = self._write_ome_zarr_fixture(Path(tmpdir), version="0.4")
            engine.dispatch(
                "dataset.open",
                _request(2, idempotency_key="idem-open-local-v04", session_id=session_id, uri=uri, read_only=True),
            )
            dataset_id = self._dataset_ids(engine, session_id)[0]
            payload = engine.dispatch(
                "dataset.get",
                _request(3, session_id=session_id, dataset_id=dataset_id),
            )
            self.assertEqual(payload["ngff"]["ngff_version"], "0.4")

    def test_dataset_get_cache_snapshot_reflects_live_counters(self) -> None:
        engine = self._new_engine()
        with tempfile.TemporaryDirectory() as tmpdir:
            uri = self._write_ome_zarr_fixture(Path(tmpdir))
            first_session = self._create_session(engine, key="idem-session-cache-1")
            second_session = self._create_session(engine, key="idem-session-cache-2")

            engine.dispatch(
                "dataset.open",
                _request(2, idempotency_key="idem-open-cache-1", session_id=first_session, uri=uri, read_only=True),
            )
            engine.dispatch(
                "dataset.open",
                _request(3, idempotency_key="idem-open-cache-2", session_id=second_session, uri=uri, read_only=True),
            )

            dataset_id = self._dataset_ids(engine, second_session)[0]
            payload = engine.dispatch("dataset.get", _request(4, session_id=second_session, dataset_id=dataset_id))
            counters = payload["cache"]["counters"]
            self.assertGreaterEqual(counters["metadata_hits"], 1)
            self.assertGreaterEqual(counters["metadata_misses"], 1)

    def test_axis_map_is_strictly_validated(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        with self.assertRaises(LucidaError) as missing_axis:
            engine.dispatch(
                "dataset.open",
                _request(
                    2,
                    idempotency_key="idem-open-axis-a",
                    session_id=session_id,
                    uri="synthetic://image",
                    read_only=True,
                    axis_map={"foo": "t"},
                ),
            )
        self.assertEqual(missing_axis.exception.code, "LUCIDA_INVALID_PARAMS")

        with self.assertRaises(LucidaError) as duplicate_axis:
            engine.dispatch(
                "dataset.open",
                _request(
                    3,
                    idempotency_key="idem-open-axis-b",
                    session_id=session_id,
                    uri="synthetic://image",
                    read_only=True,
                    axis_map={"t": "x", "x": "x"},
                ),
            )
        self.assertEqual(duplicate_axis.exception.code, "LUCIDA_INVALID_PARAMS")

    def test_dataset_export_is_async_and_creates_local_v05_dataset(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        engine.dispatch(
            "dataset.open",
            _request(2, idempotency_key="idem-open-export", session_id=session_id, uri="synthetic://image", read_only=True),
        )
        dataset_id = self._dataset_ids(engine, session_id)[0]
        with tempfile.TemporaryDirectory() as tmpdir:
            destination = str(Path(tmpdir) / "exported.zarr")
            export_result = engine.dispatch(
                "dataset.export",
                _request(
                    3,
                    idempotency_key="idem-export-1",
                    session_id=session_id,
                    dataset_id=dataset_id,
                    destination_uri=destination,
                ),
            )
            job_id = export_result["job"]["job_id"]
            self.assertEqual(export_result["job"]["state"], "queued")

            job = engine.dispatch("job.get", _request(4, session_id=session_id, job_id=job_id))
            self.assertEqual(job["state"], "completed")

            engine.dispatch(
                "dataset.open",
                _request(
                    5,
                    idempotency_key="idem-open-exported",
                    session_id=session_id,
                    uri=f"file://{destination}",
                    read_only=True,
                ),
            )
            exported_dataset = self._dataset_ids(engine, session_id)[1]
            exported = engine.dispatch(
                "dataset.get",
                _request(6, session_id=session_id, dataset_id=exported_dataset),
            )
            self.assertEqual(exported["ngff"]["ngff_version"], "0.5")
            exported_events = [e for e in engine.events_for_session(session_id) if e["event_type"] == "dataset.exported"]
            self.assertEqual(len(exported_events), 1)
            self.assertEqual(exported_events[0]["payload"]["dataset_id"], dataset_id)

    def test_dataset_export_job_can_be_cancelled_before_execution(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        engine.dispatch(
            "dataset.open",
            _request(2, idempotency_key="idem-open-cancel", session_id=session_id, uri="synthetic://image", read_only=True),
        )
        dataset_id = self._dataset_ids(engine, session_id)[0]
        with tempfile.TemporaryDirectory() as tmpdir:
            destination = str(Path(tmpdir) / "cancelled.zarr")
            export_result = engine.dispatch(
                "dataset.export",
                _request(
                    3,
                    idempotency_key="idem-export-cancel",
                    session_id=session_id,
                    dataset_id=dataset_id,
                    destination_uri=destination,
                ),
            )
            job_id = export_result["job"]["job_id"]
            cancelled = engine.dispatch(
                "job.cancel",
                _request(4, idempotency_key="idem-cancel-job", session_id=session_id, job_id=job_id),
            )
            self.assertEqual(cancelled["state"], "cancelled")
            self.assertFalse(Path(destination).exists())

    def test_dataset_open_timeout_maps_to_typed_timeout_error(self) -> None:
        class AlwaysTimeoutScheduler:
            def execute(self, *_args: object, **_kwargs: object) -> object:
                from lucida_core.io import SchedulerTimeout

                raise SchedulerTimeout("simulated timeout")

        engine = NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=1),
            io_scheduler=AlwaysTimeoutScheduler(),
        )
        session_id = self._create_session(engine)
        with self.assertRaises(LucidaError) as ctx:
            engine.dispatch(
                "dataset.open",
                _request(
                    2,
                    idempotency_key="idem-open-timeout",
                    session_id=session_id,
                    uri="synthetic://image",
                    read_only=True,
                    timeout_ms=5,
                ),
            )
        self.assertEqual(ctx.exception.code, "LUCIDA_TIMEOUT")

    def test_async_jobs_follow_queued_running_completed_lifecycle(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        open_result = engine.dispatch(
            "dataset.open",
            _request(2, idempotency_key="idem-open", session_id=session_id, uri="synthetic://image", read_only=True),
        )
        job_id = open_result["job"]["job_id"]
        self.assertEqual(open_result["job"]["state"], "queued")
        job = engine.dispatch("job.get", _request(3, session_id=session_id, job_id=job_id))
        self.assertEqual(job["state"], "completed")
        lifecycle_states = [
            event["payload"]["state"]
            for event in engine.events_for_session(session_id)
            if event["event_type"] == "job.lifecycle" and event["payload"]["job_id"] == job_id
        ]
        self.assertEqual(lifecycle_states, ["queued", "running", "completed"])

    def test_events_subscribe_returns_memory_transport_handle(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        sub = engine.dispatch(
            "events.subscribe",
            _request(2, session_id=session_id, topics=["job.lifecycle", "state.changed"]),
        )
        self.assertTrue(str(sub["transport_uri"]).startswith(f"memory://{session_id}/"))
        snapshot = engine.snapshot()
        self.assertIn(sub["subscription_id"], snapshot["sessions"][0]["subscriptions"])

    def test_command_log_methods_support_export_import_replay(self) -> None:
        engine = self._new_engine()
        session_id = self._create_session(engine)
        export_result = engine.dispatch(
            "command_log.export",
            _request(2, session_id=session_id, destination_uri="memory://step9-empty.jsonl"),
        )
        self.assertEqual(export_result["record_count"], 0)

        imported = engine.dispatch(
            "command_log.import",
            _request(
                3,
                idempotency_key="idem-import",
                session_id=session_id,
                source_uri="memory://step9-empty.jsonl",
            ),
        )
        import_job = engine.dispatch(
            "job.get",
            _request(4, session_id=session_id, job_id=imported["job"]["job_id"]),
        )
        self.assertEqual(import_job["state"], "completed")

        replayed = engine.dispatch(
            "command_log.replay",
            _request(
                5,
                idempotency_key="idem-replay",
                session_id=session_id,
                source_uri="memory://step9-empty.jsonl",
                dry_run=True,
            ),
        )
        replay_job = engine.dispatch(
            "job.get",
            _request(6, session_id=session_id, job_id=replayed["job"]["job_id"]),
        )
        self.assertEqual(replay_job["state"], "completed")


if __name__ == "__main__":
    unittest.main()
