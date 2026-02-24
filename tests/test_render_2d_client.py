from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
import uuid

from fastapi.testclient import TestClient
from PIL import Image

from lucida.client import LucidaClient
from lucida.server.app import create_app
from lucida.service.dataset_service import DatasetService


def _decode_size(payload_b64: str) -> tuple[int, int]:
    image = Image.open(BytesIO(base64.b64decode(payload_b64))).convert("RGBA")
    return image.size


def test_client_render_and_navigation_helpers(render_omezarr_uri: str) -> None:
    service = DatasetService()
    app = create_app(dataset_service=service)
    http_client = TestClient(app)
    explicit_path: Path | None = None
    auto_path: Path | None = None

    try:
        client = LucidaClient(client=http_client)

        session = client.create_session()
        opened = client.open_dataset(uri=render_omezarr_uri, session_id=session.session_id)
        created = client.create_view(
            dataset_id=opened.dataset_summary.dataset_id,
            session_id=session.session_id,
            mode="2d",
        )

        plane_updated = client.set_plane(
            view_id=created.view_state.view_id,
            plane="xz",
            session_id=session.session_id,
        )
        assert plane_updated.view_state.view_2d is not None
        assert plane_updated.view_state.view_2d.plane == "xz"

        panned = client.pan(
            view_id=created.view_state.view_id,
            dx_px=20.0,
            dy_px=-10.0,
            session_id=session.session_id,
        )
        assert panned.view_state.state_version == 2

        zoomed = client.zoom(
            view_id=created.view_state.view_id,
            factor=0.5,
            session_id=session.session_id,
        )
        assert zoomed.view_state.state_version == 3

        rendered = client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=96,
            height_px=64,
        )
        assert rendered.status == "ok"
        assert rendered.images[0].mime == "image/png"
        assert _decode_size(rendered.images[0].bytes_base64) == (96, 64)

        output_root = Path(__file__).resolve().parents[1] / "output"
        relative_path = f"snapshots/test-client-{uuid.uuid4().hex}.png"
        rendered_file = client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=80,
            height_px=56,
            delivery="file_path",
            file_path=relative_path,
        )
        explicit_path = Path(rendered_file.images[0].file_path or "")
        assert explicit_path.exists()
        assert explicit_path.is_relative_to(output_root)
        assert rendered_file.images[0].bytes_base64 is None

        stateless_inline = client.render_image(
            view_state=client.get_view(view_id=created.view_state.view_id).view_state,
            session_id=session.session_id,
            width_px=72,
            height_px=48,
        )
        assert stateless_inline.view_id is None
        assert stateless_inline.state_version is None
        assert _decode_size(stateless_inline.images[0].bytes_base64) == (72, 48)

        stateless_file = client.render_image(
            view_state=client.get_view(view_id=created.view_state.view_id).view_state,
            session_id=session.session_id,
            width_px=64,
            height_px=40,
            delivery="file_path",
        )
        auto_path = Path(stateless_file.images[0].file_path or "")
        assert auto_path.exists()
        assert auto_path.is_relative_to(output_root / "snapshots")

        fetched = client.get_view(view_id=created.view_state.view_id, session_id=session.session_id)
        assert fetched.view_state.state_version == 3
    finally:
        if explicit_path is not None and explicit_path.exists():
            explicit_path.unlink()
        if auto_path is not None and auto_path.exists():
            auto_path.unlink()
        http_client.close()
