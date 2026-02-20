from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core import NDStateEngine, SequenceClock, SequenceUUIDFactory
from lucida_core.errors import LucidaError
from lucida_daemon import DaemonConfig, LucidaDaemon
from lucida_sdk.ids import make_idempotency_key, uuid7_str

from lucida_gateway.config import GatewayConfig
from lucida_gateway.render import FrameRenderer2D, RemoteRenderState


class Step11GatewayComponentTests(unittest.TestCase):
    def _req(self, **kwargs: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "protocol_version": "1.0.0",
            "request_id": uuid7_str(),
        }
        payload.update(kwargs)
        return payload

    def test_config_rejects_non_local_bind_without_tls(self) -> None:
        config = GatewayConfig(host="0.0.0.0", port=8765, token="step11token", tls_termination=False)
        with self.assertRaises(LucidaError) as ctx:
            config.validate()
        self.assertEqual(ctx.exception.code, "LUCIDA_INVALID_PARAMS")

    def test_renderer_supports_local_ome_zarr_dataset(self) -> None:
        engine = NDStateEngine(
            clock=SequenceClock(start=datetime(2026, 1, 1, tzinfo=UTC), tick_seconds=1),
            uuid_factory=SequenceUUIDFactory(seed=1),
        )
        daemon = LucidaDaemon(
            engine=engine,
            config=DaemonConfig(),
            uuid_factory=SequenceUUIDFactory(seed=5_000),
        )
        daemon.start()

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                dataset_uri = self._write_local_zarr(Path(tmpdir) / "sample.zarr")
                conn = daemon.connect()
                daemon.dispatch(
                    conn,
                    "system.hello",
                    self._req(
                        client_name="step11-components",
                        client_version="1.0.0",
                        supported_versions={"min_version": "1.0.0", "max_version": "1.0.0"},
                        transport="ipc",
                    ),
                )
                created = daemon.dispatch(
                    conn,
                    "session.create",
                    self._req(idempotency_key=make_idempotency_key(prefix="idem-step11-components-create")),
                )
                session_id = str(created["session_id"])

                daemon.dispatch(
                    conn,
                    "dataset.open",
                    self._req(
                        idempotency_key=make_idempotency_key(prefix="idem-step11-components-open"),
                        session_id=session_id,
                        uri=dataset_uri,
                        read_only=True,
                    ),
                )

                snapshot = daemon.snapshot()
                session = next(item for item in snapshot["sessions"] if item["session_id"] == session_id)
                view_id = sorted(session["views"])[0]
                dataset_id = sorted(session["datasets"])[0]

                layer = daemon.dispatch(
                    conn,
                    "layer.add_image",
                    self._req(
                        idempotency_key=make_idempotency_key(prefix="idem-step11-components-layer"),
                        session_id=session_id,
                        dataset_id=dataset_id,
                        channel=0,
                    ),
                )
                layer_id = str(layer["layer_id"])
                daemon.dispatch(
                    conn,
                    "view.bind_layer",
                    self._req(
                        idempotency_key=make_idempotency_key(prefix="idem-step11-components-bind"),
                        session_id=session_id,
                        view_id=view_id,
                        layer_id=layer_id,
                    ),
                )

                renderer = FrameRenderer2D(
                    daemon=daemon,
                    tile_size_px=256,
                    jpeg_quality=75,
                )
                state = RemoteRenderState()
                _plan_seq, tiles = renderer.render_tiles(
                    session_id=session_id,
                    view_id=view_id,
                    state=state,
                )
                self.assertGreater(len(tiles), 0)
                self.assertIn(tiles[0].format, {"jpeg", "png"})
        finally:
            daemon.stop()

    def _write_local_zarr(self, path: Path) -> str:
        import numpy as np
        import zarr

        group = zarr.open_group(str(path), mode="w")
        array = group.create_dataset("0", shape=(1, 1, 1, 64, 64), chunks=(1, 1, 1, 64, 64), dtype="uint16")
        yy, xx = np.mgrid[0:64, 0:64]
        array[0, 0, 0, :, :] = (xx + yy).astype("uint16")
        group.attrs["multiscales"] = [
            {
                "name": "local",
                "version": "0.5",
                "axes": ["t", "c", "z", "y", "x"],
                "datasets": [{"path": "0"}],
            }
        ]
        return str(path)


if __name__ == "__main__":
    unittest.main()
