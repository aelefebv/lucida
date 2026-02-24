from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
import uuid

import numpy as np
import pytest
from PIL import Image

from lucida.errors import LucidaError
from lucida.models.render import RenderOutputSpec
from lucida.models.view_state import ViewState


def _decode_rgba(payload_b64: str) -> np.ndarray:
    raw = base64.b64decode(payload_b64)
    image = Image.open(BytesIO(raw)).convert("RGBA")
    return np.asarray(image, dtype=np.uint8)


def _configure_predictable_view(dataset_service, view_id: str) -> None:
    dataset_service.update_view(
        view_id=view_id,
        patch=[
            {
                "op": "replace",
                "path": "/layers/0/image",
                "value": {
                    "channel_mode": "single",
                    "channels": [
                        {
                            "index": 0,
                            "enabled": True,
                            "color_rgba": [1.0, 1.0, 1.0, 1.0],
                            "contrast": {
                                "policy": "fixed",
                                "min": 0.0,
                                "max": 500.0,
                                "p_low": 1.0,
                                "p_high": 99.0,
                            },
                            "gamma": 1.0,
                        }
                    ],
                    "interpolation": "nearest",
                },
            },
            {"op": "replace", "path": "/view_2d/camera/zoom", "value": 1.0},
            {"op": "replace", "path": "/view_2d/camera/center_world", "value": [3.0, 2.0]},
            {
                "op": "replace",
                "path": "/view_2d/slice",
                "value": {
                    "axis": "z",
                    "index": 2,
                    "slab": {"thickness_vox": 1, "mode": "single"},
                },
            },
        ],
    )


def test_render_image_success_and_plane_orientation(dataset_service, render_omezarr_uri: str) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)
    _configure_predictable_view(dataset_service, created.view_state.view_id)

    rendered_xy = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=6, height_px=5),
    )
    image_xy = _decode_rgba(rendered_xy.images[0].bytes_base64)
    assert image_xy.shape == (5, 6, 4)
    assert int(image_xy[0, -1, 0]) > int(image_xy[0, 0, 0])
    assert int(image_xy[-1, 0, 0]) > int(image_xy[0, 0, 0])

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[
            {"op": "replace", "path": "/view_2d/plane", "value": "xz"},
            {"op": "replace", "path": "/view_2d/slice/index", "value": 1},
            {"op": "replace", "path": "/view_2d/camera/center_world", "value": [3.0, 2.0]},
        ],
    )
    rendered_xz = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=6, height_px=4),
    )
    image_xz = _decode_rgba(rendered_xz.images[0].bytes_base64)
    assert image_xz.shape == (4, 6, 4)
    assert int(image_xz[-1, 0, 0]) > int(image_xz[0, 0, 0])

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[
            {"op": "replace", "path": "/view_2d/plane", "value": "yz"},
            {"op": "replace", "path": "/view_2d/slice/index", "value": 2},
            {"op": "replace", "path": "/view_2d/camera/center_world", "value": [2.0, 2.0]},
        ],
    )
    rendered_yz = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=5, height_px=4),
    )
    image_yz = _decode_rgba(rendered_yz.images[0].bytes_base64)
    assert image_yz.shape == (4, 5, 4)
    assert int(image_yz[0, -1, 0]) > int(image_yz[0, 0, 0])


def test_render_slab_modes_and_selector_precedence(dataset_service, render_omezarr_uri: str) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)
    _configure_predictable_view(dataset_service, created.view_state.view_id)

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[
            {
                "op": "replace",
                "path": "/selectors",
                "value": [{"axis": "z", "kind": "range", "start": 1, "end_exclusive": 4, "clamp": True}],
            },
            {
                "op": "replace",
                "path": "/view_2d/slice/slab",
                "value": {"thickness_vox": 5, "mode": "single"},
            },
        ],
    )
    single = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=6, height_px=5),
    )
    assert any(item.code == "slab_thickness_ignored" for item in single.warnings)
    single_img = _decode_rgba(single.images[0].bytes_base64)
    single_value = int(single_img[2, 3, 0])

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[
            {
                "op": "replace",
                "path": "/view_2d/slice/slab",
                "value": {"thickness_vox": 5, "mode": "mip"},
            }
        ],
    )
    mip = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=6, height_px=5),
    )
    mip_img = _decode_rgba(mip.images[0].bytes_base64)
    mip_value = int(mip_img[2, 3, 0])

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[
            {
                "op": "replace",
                "path": "/view_2d/slice/slab",
                "value": {"thickness_vox": 5, "mode": "mean"},
            }
        ],
    )
    mean = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=6, height_px=5),
    )
    mean_img = _decode_rgba(mean.images[0].bytes_base64)
    mean_value = int(mean_img[2, 3, 0])

    assert mip_value > mean_value > single_value


def test_render_lod_and_fixed_override(dataset_service, render_omezarr_uri: str) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[{"op": "replace", "path": "/view_2d/camera/zoom", "value": 0.5}],
    )
    auto = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=120, height_px=80),
    )
    assert auto.meta.pyramid_level_used == 1

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[
            {
                "op": "replace",
                "path": "/performance",
                "value": {"lod_mode": "fixed", "fixed_level": 0},
            }
        ],
    )
    fixed = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=120, height_px=80),
    )
    assert fixed.meta.pyramid_level_used == 0

    dataset_service.update_view(
        view_id=created.view_state.view_id,
        patch=[
            {
                "op": "replace",
                "path": "/performance",
                "value": {"lod_mode": "fixed", "fixed_level": 99},
            }
        ],
    )
    fallback = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=120, height_px=80),
    )
    assert any(item.code == "lod_level_fallback_auto" for item in fallback.warnings)


def test_render_patch_is_ephemeral(dataset_service, render_omezarr_uri: str) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)

    original = dataset_service.get_view(view_id=created.view_state.view_id).view_state
    rendered = dataset_service.render_image(
        view_id=created.view_state.view_id,
        output=RenderOutputSpec(width_px=64, height_px=64),
        overrides_json_patch=[
            {
                "op": "replace",
                "path": "/selectors",
                "value": [{"axis": "z", "kind": "index", "index": 3, "clamp": True}],
            }
        ],
    )

    assert rendered.state_hash != original.state_hash

    current = dataset_service.get_view(view_id=created.view_state.view_id).view_state
    assert current.state_version == original.state_version
    assert current.state_hash == original.state_hash


def test_render_errors(dataset_service, render_omezarr_uri: str) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)

    with pytest.raises(LucidaError) as view_error:
        dataset_service.render_image(
            view_id="view_missing",
            output=RenderOutputSpec(width_px=64, height_px=64),
        )
    assert view_error.value.code == "view_not_found"

    with pytest.raises(LucidaError) as size_error:
        dataset_service.render_image(
            view_id=created.view_state.view_id,
            output=RenderOutputSpec(width_px=5000, height_px=64),
        )
    assert size_error.value.code == "render_output_too_large"


def test_render_stateless_inline_and_optional_state_fields(
    dataset_service, render_omezarr_uri: str
) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)
    current = dataset_service.get_view(view_id=created.view_state.view_id).view_state

    rendered = dataset_service.render_image(
        view_state=current,
        output=RenderOutputSpec(width_px=40, height_px=32),
    )

    assert rendered.status == "ok"
    assert rendered.view_id is None
    assert rendered.state_version is None
    assert rendered.images[0].delivery == "inline_base64"
    assert rendered.images[0].bytes_base64 is not None
    assert rendered.images[0].file_path is None


def test_render_file_delivery_explicit_and_auto_path(dataset_service, render_omezarr_uri: str) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)
    view_id = created.view_state.view_id

    output_root = Path(__file__).resolve().parents[1] / "output"
    explicit_relative = f"snapshots/test-service-{uuid.uuid4().hex}.png"
    explicit_render = dataset_service.render_image(
        view_id=view_id,
        output=RenderOutputSpec(
            width_px=48,
            height_px=36,
            delivery="file_path",
            file_path=explicit_relative,
        ),
    )
    explicit_artifact = explicit_render.images[0]
    explicit_path = Path(explicit_artifact.file_path or "")
    try:
        assert explicit_artifact.delivery == "file_path"
        assert explicit_artifact.bytes_base64 is None
        assert explicit_path.exists()
        assert explicit_path.is_relative_to(output_root)

        auto_render = dataset_service.render_image(
            view_id=view_id,
            output=RenderOutputSpec(width_px=32, height_px=24, delivery="file_path"),
        )
        auto_artifact = auto_render.images[0]
        auto_path = Path(auto_artifact.file_path or "")
        assert auto_path.exists()
        assert auto_path.is_relative_to(output_root / "snapshots")
    finally:
        if explicit_path.exists():
            explicit_path.unlink()
        auto_path = Path(auto_render.images[0].file_path or "") if "auto_render" in locals() else None
        if auto_path is not None and auto_path.exists():
            auto_path.unlink()


def test_render_snapshot_contract_errors(dataset_service, render_omezarr_uri: str) -> None:
    opened = dataset_service.open_dataset(uri=render_omezarr_uri)
    created = dataset_service.create_view(dataset_id=opened.dataset_summary.dataset_id)
    view_id = created.view_state.view_id

    with pytest.raises(LucidaError) as both_error:
        dataset_service.render_image(
            view_id=view_id,
            view_state=created.view_state,
            output=RenderOutputSpec(width_px=32, height_px=32),
        )
    assert both_error.value.code == "invalid_render_request"

    with pytest.raises(LucidaError) as neither_error:
        dataset_service.render_image(output=RenderOutputSpec(width_px=32, height_px=32))
    assert neither_error.value.code == "invalid_render_request"

    with pytest.raises(LucidaError) as unsafe_path_error:
        dataset_service.render_image(
            view_id=view_id,
            output=RenderOutputSpec(
                width_px=32,
                height_px=32,
                delivery="file_path",
                file_path="../outside-root.png",
            ),
        )
    assert unsafe_path_error.value.code == "render_output_path_invalid"

    with pytest.raises(LucidaError) as missing_session_error:
        dataset_service.render_image(
            view_state=created.view_state,
            session_id="session_missing",
            output=RenderOutputSpec(width_px=32, height_px=32),
        )
    assert missing_session_error.value.code == "session_not_found"

    state_payload = created.view_state.model_dump(mode="json")
    state_payload["datasets"][0]["dataset_id"] = "ds_missing"
    missing_dataset_state = ViewState.model_validate(state_payload)

    with pytest.raises(LucidaError) as missing_dataset_error:
        dataset_service.render_image(
            view_state=missing_dataset_state,
            output=RenderOutputSpec(width_px=32, height_px=32),
        )
    assert missing_dataset_error.value.code == "dataset_not_found"
