from __future__ import annotations

import base64
from io import BytesIO

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
