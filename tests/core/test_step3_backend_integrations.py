from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime
import importlib.util
import os
from pathlib import Path
import socketserver
import tempfile
from threading import Thread
from http.server import SimpleHTTPRequestHandler
import unittest


ROOT = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(ROOT / "python"))

from lucida_core import NDStateEngine, SequenceClock, SequenceUUIDFactory


def _request(base_id: int, **kwargs: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocol_version": "1.0.0",
        "request_id": f"0194c8f0-c7fa-7a2d-8abc-{base_id:012x}",
    }
    payload.update(kwargs)
    return payload


@contextmanager
def _http_server(directory: Path):
    class QuietHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    class ThreadingTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    try:
        server = ThreadingTCPServer(("127.0.0.1", 0), QuietHandler)
    except PermissionError as exc:
        raise unittest.SkipTest(f"loopback bind unavailable in this environment: {exc}") from exc
    host, port = server.server_address
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class Step3BackendIntegrationTests(unittest.TestCase):
    def _new_engine(self, seed: int = 1) -> NDStateEngine:
        return NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=seed),
        )

    def _create_session(self, engine: NDStateEngine) -> str:
        result = engine.dispatch(
            "session.create",
            _request(1, idempotency_key="idem-session-integ-1", label="main"),
        )
        return str(result["session_id"])

    def _write_fixture(self, root: Path, *, name: str = "sample.zarr") -> Path:
        import zarr

        path = root / name
        grp = zarr.open_group(str(path), mode="w")
        create_array = getattr(grp, "create_array", None)
        if callable(create_array):
            try:
                create_array(
                    name="0",
                    shape=(1, 1, 4, 16, 16),
                    chunks=(1, 1, 2, 8, 8),
                    dtype="uint16",
                    fill_value=0,
                )
            except TypeError:
                create_array(
                    "0",
                    shape=(1, 1, 4, 16, 16),
                    chunks=(1, 1, 2, 8, 8),
                    dtype="uint16",
                    fill_value=0,
                )
        else:
            grp.create_dataset("0", shape=(1, 1, 4, 16, 16), chunks=(1, 1, 2, 8, 8), dtype="uint16", fill_value=0)
        grp.attrs["multiscales"] = [
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
                    {
                        "path": "0",
                        "coordinateTransformations": [
                            {"type": "scale", "scale": [1, 1, 1, 1, 1]},
                            {"type": "translation", "translation": [0, 0, 0, 0, 0]},
                        ],
                    }
                ],
            }
        ]
        return path

    def test_http_backend_open(self) -> None:
        engine = self._new_engine(seed=10)
        session_id = self._create_session(engine)

        with tempfile.TemporaryDirectory() as tmpdir:
            fixture_path = self._write_fixture(Path(tmpdir))
            with _http_server(Path(tmpdir)) as base:
                uri = f"{base}/{fixture_path.name}"
                engine.dispatch(
                    "dataset.open",
                    _request(
                        2,
                        idempotency_key="idem-open-http",
                        session_id=session_id,
                        uri=uri,
                        read_only=True,
                    ),
                )
            opened = [e for e in engine.events_for_session(session_id) if e["event_type"] == "dataset.opened"]
            dataset_id = opened[-1]["payload"]["dataset_id"]
            metadata = engine.dispatch("dataset.get", _request(3, session_id=session_id, dataset_id=dataset_id))
            self.assertEqual(metadata["backend"], "http")

    def test_s3_backend_open_if_configured(self) -> None:
        if importlib.util.find_spec("s3fs") is None:
            self.skipTest("s3fs is not installed")
        uri = os.environ.get("LUCIDA_TEST_S3_URI")
        if not uri:
            self.skipTest("LUCIDA_TEST_S3_URI not configured")

        engine = self._new_engine(seed=20)
        session_id = self._create_session(engine)
        engine.dispatch(
            "dataset.open",
            _request(
                2,
                idempotency_key="idem-open-s3",
                session_id=session_id,
                uri=uri,
                read_only=True,
            ),
        )
        opened = [e for e in engine.events_for_session(session_id) if e["event_type"] == "dataset.opened"]
        dataset_id = opened[-1]["payload"]["dataset_id"]
        metadata = engine.dispatch("dataset.get", _request(3, session_id=session_id, dataset_id=dataset_id))
        self.assertEqual(metadata["backend"], "s3")

    def test_gcs_backend_open_if_configured(self) -> None:
        if importlib.util.find_spec("gcsfs") is None:
            self.skipTest("gcsfs is not installed")
        uri = os.environ.get("LUCIDA_TEST_GCS_URI")
        if not uri:
            self.skipTest("LUCIDA_TEST_GCS_URI not configured")

        engine = self._new_engine(seed=30)
        session_id = self._create_session(engine)
        engine.dispatch(
            "dataset.open",
            _request(
                2,
                idempotency_key="idem-open-gcs",
                session_id=session_id,
                uri=uri,
                read_only=True,
            ),
        )
        opened = [e for e in engine.events_for_session(session_id) if e["event_type"] == "dataset.opened"]
        dataset_id = opened[-1]["payload"]["dataset_id"]
        metadata = engine.dispatch("dataset.get", _request(3, session_id=session_id, dataset_id=dataset_id))
        self.assertEqual(metadata["backend"], "gcs")


if __name__ == "__main__":
    unittest.main()
