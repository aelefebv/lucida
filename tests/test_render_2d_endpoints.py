from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
import uuid

from PIL import Image


def _decode_size(payload_b64: str) -> tuple[int, int]:
    image = Image.open(BytesIO(base64.b64decode(payload_b64))).convert("RGBA")
    return image.size


def test_render_image_endpoint_success(api_client, render_omezarr_uri: str) -> None:
    opened = api_client.post("/dataset/open", json={"schema_version": 1, "uri": render_omezarr_uri})
    dataset_id = opened.json()["dataset_summary"]["dataset_id"]

    created = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"},
    )
    view_id = created.json()["view_state"]["view_id"]

    rendered = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        },
    )

    assert rendered.status_code == 200
    payload = rendered.json()
    assert payload["schema_version"] == 1
    assert payload["status"] == "ok"
    assert payload["view_id"] == view_id
    assert isinstance(payload["state_version"], int)
    assert payload["images"][0]["mime"] == "image/png"
    assert _decode_size(payload["images"][0]["bytes_base64"]) == (64, 48)


def test_render_image_endpoint_invalid_patch(api_client, render_omezarr_uri: str) -> None:
    opened = api_client.post("/dataset/open", json={"schema_version": 1, "uri": render_omezarr_uri})
    dataset_id = opened.json()["dataset_summary"]["dataset_id"]
    created = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"},
    )
    view_id = created.json()["view_state"]["view_id"]

    rendered = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "overrides_json_patch": [{"op": "replace", "path": "/selectors/100/index", "value": 1}],
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        },
    )

    assert rendered.status_code == 422
    assert rendered.json()["code"] == "invalid_patch"


def test_render_image_endpoint_session_and_size_errors(api_client, render_omezarr_uri: str) -> None:
    opened = api_client.post("/dataset/open", json={"schema_version": 1, "uri": render_omezarr_uri})
    dataset_id = opened.json()["dataset_summary"]["dataset_id"]
    created = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"},
    )
    view_id = created.json()["view_state"]["view_id"]

    missing_session = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "session_id": "session_missing",
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        },
    )
    assert missing_session.status_code == 404
    assert missing_session.json()["code"] == "session_not_found"

    too_large = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 5000,
                "height_px": 48,
            },
        },
    )
    assert too_large.status_code == 422
    assert too_large.json()["code"] == "render_output_too_large"


def test_render_image_endpoint_stateless_inline_and_optional_fields(
    api_client, render_omezarr_uri: str
) -> None:
    opened = api_client.post("/dataset/open", json={"schema_version": 1, "uri": render_omezarr_uri})
    dataset_id = opened.json()["dataset_summary"]["dataset_id"]
    created = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"},
    )
    view_id = created.json()["view_state"]["view_id"]
    view_state = api_client.get(f"/view/{view_id}").json()["view_state"]

    rendered = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_state": view_state,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 40,
                "height_px": 30,
            },
        },
    )

    assert rendered.status_code == 200
    payload = rendered.json()
    assert payload["status"] == "ok"
    assert "view_id" not in payload
    assert "state_version" not in payload
    assert payload["images"][0]["delivery"] == "inline_base64"
    assert _decode_size(payload["images"][0]["bytes_base64"]) == (40, 30)


def test_render_image_endpoint_file_delivery_and_safe_root(
    api_client, render_omezarr_uri: str
) -> None:
    opened = api_client.post("/dataset/open", json={"schema_version": 1, "uri": render_omezarr_uri})
    dataset_id = opened.json()["dataset_summary"]["dataset_id"]
    created = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"},
    )
    view_id = created.json()["view_state"]["view_id"]
    output_root = Path(__file__).resolve().parents[1] / "output"
    explicit_relative = f"snapshots/test-endpoint-{uuid.uuid4().hex}.png"

    explicit = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "file_path",
                "file_path": explicit_relative,
                "width_px": 40,
                "height_px": 30,
            },
        },
    )
    explicit_payload = explicit.json()
    explicit_path = Path(explicit_payload["images"][0]["file_path"])

    try:
        assert explicit.status_code == 200
        assert explicit_path.exists()
        assert explicit_path.is_relative_to(output_root)
        assert "bytes_base64" not in explicit_payload["images"][0]

        auto = api_client.post(
            "/render/image",
            json={
                "schema_version": 1,
                "view_id": view_id,
                "output": {
                    "format": "png",
                    "delivery": "file_path",
                    "width_px": 40,
                    "height_px": 30,
                },
            },
        )
        auto_payload = auto.json()
        auto_path = Path(auto_payload["images"][0]["file_path"])
        assert auto.status_code == 200
        assert auto_path.exists()
        assert auto_path.is_relative_to(output_root / "snapshots")
    finally:
        if explicit_path.exists():
            explicit_path.unlink()
        auto_path = Path(auto_payload["images"][0]["file_path"]) if "auto_payload" in locals() else None
        if auto_path is not None and auto_path.exists():
            auto_path.unlink()


def test_render_image_endpoint_snapshot_contract_errors(api_client, render_omezarr_uri: str) -> None:
    opened = api_client.post("/dataset/open", json={"schema_version": 1, "uri": render_omezarr_uri})
    dataset_id = opened.json()["dataset_summary"]["dataset_id"]
    created = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"},
    )
    view_id = created.json()["view_state"]["view_id"]
    view_state = api_client.get(f"/view/{view_id}").json()["view_state"]

    both = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "view_state": view_state,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 32,
                "height_px": 24,
            },
        },
    )
    assert both.status_code == 422
    assert both.json()["code"] == "invalid_render_request"

    neither = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 32,
                "height_px": 24,
            },
        },
    )
    assert neither.status_code == 422
    assert neither.json()["code"] == "invalid_render_request"

    bad_path = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "file_path",
                "file_path": "../bad.png",
                "width_px": 32,
                "height_px": 24,
            },
        },
    )
    assert bad_path.status_code == 422
    assert bad_path.json()["code"] == "render_output_path_invalid"

    missing_session = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "session_id": "session_missing",
            "view_state": view_state,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 32,
                "height_px": 24,
            },
        },
    )
    assert missing_session.status_code == 404
    assert missing_session.json()["code"] == "session_not_found"

    invalid_view_state = dict(view_state)
    invalid_view_state["datasets"] = [dict(view_state["datasets"][0])]
    invalid_view_state["datasets"][0]["dataset_id"] = "ds_missing"

    missing_dataset = api_client.post(
        "/render/image",
        json={
            "schema_version": 1,
            "view_state": invalid_view_state,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 32,
                "height_px": 24,
            },
        },
    )
    assert missing_dataset.status_code == 404
    assert missing_dataset.json()["code"] == "dataset_not_found"
