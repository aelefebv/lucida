from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import fsspec
import numpy as np
import zarr


def _open_group_for_write(uri: str) -> zarr.Group:
    parsed = urlparse(uri)
    if parsed.scheme in ("", "file"):
        if parsed.scheme == "file":
            path = Path(unquote(parsed.path))
        else:
            path = Path(uri)
        path = path.expanduser().resolve(strict=False)
        path.mkdir(parents=True, exist_ok=True)
        return zarr.open_group(store=str(path), mode="w")

    mapper = fsspec.get_mapper(uri, create=True)
    return zarr.open_group(store=mapper, mode="w")


def create_sample_omezarr(
    uri: str,
    *,
    include_multiscale_name: bool = True,
    include_level_one_scale: bool = True,
    include_channel_indices: bool = True,
    extra_root_attrs: dict[str, Any] | None = None,
) -> str:
    root = _open_group_for_write(uri)

    shape_level0 = (1, 2, 4, 8, 10)
    shape_level1 = (1, 2, 2, 4, 5)
    data_level0 = np.arange(np.prod(shape_level0), dtype=np.uint16).reshape(shape_level0)
    data_level1 = np.arange(np.prod(shape_level1), dtype=np.uint16).reshape(shape_level1)

    root.create_array("0", data=data_level0, chunks=(1, 1, 2, 4, 5), overwrite=True)
    root.create_array("1", data=data_level1, chunks=(1, 1, 1, 2, 3), overwrite=True)

    axes = [
        {"name": "t", "type": "t"},
        {"name": "c", "type": "c"},
        {"name": "z", "type": "z", "unit": "micron"},
        {"name": "y", "type": "y", "unit": "micron"},
        {"name": "x", "type": "x", "unit": "micron"},
    ]

    level0 = {
        "path": "0",
        "coordinateTransformations": [
            {"type": "scale", "scale": [1, 1, 1, 1, 1]},
            {"type": "translation", "translation": [0, 0, 0, 0, 0]},
        ],
    }
    level1: dict[str, Any] = {"path": "1"}
    if include_level_one_scale:
        level1["coordinateTransformations"] = [{"type": "scale", "scale": [1, 1, 2, 2, 2]}]

    multiscale: dict[str, Any] = {"axes": axes, "datasets": [level0, level1]}
    if include_multiscale_name:
        multiscale["name"] = "primary"

    root.attrs["multiscales"] = [multiscale]
    root.attrs["omero"] = {
        "channels": [
            {
                "label": "DNA",
                "color": "FF0000",
                "window": {"start": 10, "end": 400},
                **({"index": 0} if include_channel_indices else {}),
            },
            {
                "label": "RNA",
                "color": "00FF00",
                "window": {"start": 20, "end": 200},
                **({"index": 1} if include_channel_indices else {}),
            },
        ]
    }

    if extra_root_attrs:
        for key, value in extra_root_attrs.items():
            root.attrs[key] = value

    return uri


def create_invalid_zarr(uri: str) -> str:
    root = _open_group_for_write(uri)
    root.create_array("0", data=np.zeros((4, 4), dtype=np.uint8), chunks=(2, 2), overwrite=True)
    root.attrs["description"] = "missing multiscales metadata"
    return uri


def create_render_omezarr(uri: str) -> str:
    root = _open_group_for_write(uri)

    shape_level0 = (1, 3, 4, 5, 6)
    data_level0 = np.zeros(shape_level0, dtype=np.uint16)
    for c in range(shape_level0[1]):
        for z in range(shape_level0[2]):
            for y in range(shape_level0[3]):
                for x in range(shape_level0[4]):
                    data_level0[0, c, z, y, x] = np.uint16((c * 1000) + (z * 100) + (y * 10) + x)

    data_level1 = data_level0[:, :, ::2, ::2, ::2]

    root.create_array("0", data=data_level0, chunks=(1, 1, 2, 3, 3), overwrite=True)
    root.create_array("1", data=data_level1, chunks=(1, 1, 1, 2, 2), overwrite=True)

    root.attrs["multiscales"] = [
        {
            "name": "primary",
            "axes": [
                {"name": "t", "type": "t"},
                {"name": "c", "type": "c"},
                {"name": "z", "type": "z"},
                {"name": "y", "type": "y"},
                {"name": "x", "type": "x"},
            ],
            "datasets": [
                {
                    "path": "0",
                    "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 1, 1, 1]}],
                },
                {
                    "path": "1",
                    "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 2, 2, 2]}],
                },
            ],
        }
    ]

    root.attrs["omero"] = {
        "channels": [
            {"index": 0, "label": "c0", "color": "ffffff", "window": {"start": 0, "end": 500}},
            {"index": 1, "label": "c1", "color": "ff0000", "window": {"start": 0, "end": 1500}},
            {"index": 2, "label": "c2", "color": "00ff00", "window": {"start": 0, "end": 2500}},
        ]
    }
    return uri


@dataclass(frozen=True, slots=True)
class Phase1DatasetUris:
    local_uri: str
    invalid_uri: str
    render_uri: str


def build_phase1_dataset_uris(tmp_path: Path) -> Phase1DatasetUris:
    return Phase1DatasetUris(
        local_uri=create_sample_omezarr(str(tmp_path / "sample.zarr")),
        invalid_uri=create_invalid_zarr(str(tmp_path / "invalid.zarr")),
        render_uri=create_render_omezarr(str(tmp_path / "render.zarr")),
    )
