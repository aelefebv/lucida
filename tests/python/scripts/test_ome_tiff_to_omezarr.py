from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import zarr
from PIL import Image, TiffImagePlugin

from lucida.io.ome_tiff_to_zarr import ConversionOptions, convert_ome_tiff_to_omezarr


REPO_ROOT = Path(__file__).resolve().parents[3]


def _write_fixture_ome_tiff(path: Path) -> np.ndarray:
    shape = (2, 2, 3, 6, 8)  # (t, c, z, y, x)
    data = np.zeros(shape, dtype=np.uint16)
    frames: list[Image.Image] = []
    tiff_data_entries: list[str] = []

    ifd = 0
    for t_index in range(shape[0]):
        for c_index in range(shape[1]):
            for z_index in range(shape[2]):
                frame = np.fromfunction(
                    lambda y, x: (t_index * 1000) + (c_index * 100) + (z_index * 10) + (y * 2) + x,
                    (shape[3], shape[4]),
                    dtype=np.uint16,
                ).astype(np.uint16)
                data[t_index, c_index, z_index, :, :] = frame
                frames.append(Image.fromarray(frame))
                tiff_data_entries.append(
                    f'<TiffData FirstT="{t_index}" FirstC="{c_index}" '
                    f'FirstZ="{z_index}" IFD="{ifd}" PlaneCount="1"/>'
                )
                ifd += 1

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        '<Image ID="Image:0">'
        '<Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16" '
        f'SizeX="{shape[4]}" SizeY="{shape[3]}" SizeZ="{shape[2]}" SizeC="{shape[1]}" SizeT="{shape[0]}" '
        'PhysicalSizeX="0.3" PhysicalSizeXUnit="um" '
        'PhysicalSizeY="0.3" PhysicalSizeYUnit="um" '
        'PhysicalSizeZ="0.5" PhysicalSizeZUnit="um">'
        '<Channel ID="Channel:0:0" Name="mito" SamplesPerPixel="1"/>'
        '<Channel ID="Channel:0:1" Name="nucleus" SamplesPerPixel="1"/>'
        f'{"".join(tiff_data_entries)}'
        "</Pixels>"
        "</Image>"
        "</OME>"
    )
    tiff_info = TiffImagePlugin.ImageFileDirectory_v2()
    tiff_info[270] = xml
    frames[0].save(path, save_all=True, append_images=frames[1:], compression="raw", tiffinfo=tiff_info)
    return data


def test_convert_ome_tiff_to_omezarr_preserves_data_and_metadata(tmp_path: Path) -> None:
    source_tiff = tmp_path / "fixture.ome.tif"
    output_zarr = tmp_path / "fixture.zarr"
    expected = _write_fixture_ome_tiff(source_tiff)

    summary = convert_ome_tiff_to_omezarr(
        input_path=source_tiff,
        output_path=output_zarr,
        options=ConversionOptions(
            pyramid_levels=3,
            downsample_factor=2,
            downsample_axes=("z", "y", "x"),
            chunk_shape=(1, 1, 2, 4, 4),
        ),
    )

    assert summary.shape_tczyx == expected.shape
    assert summary.pyramid_levels_written == 3

    root = zarr.open_group(str(output_zarr), mode="r")
    level0 = root["0"]
    level1 = root["1"]
    level2 = root["2"]

    assert tuple(level0.shape) == expected.shape
    assert tuple(level1.shape) == (2, 2, 2, 3, 4)
    assert tuple(level2.shape) == (2, 2, 1, 2, 2)
    assert np.array_equal(np.asarray(level0), expected)
    assert np.array_equal(np.asarray(level1[1, 1, 1, :, :]), expected[1, 1, 2, ::2, ::2])

    multiscales = root.attrs["multiscales"][0]
    assert [axis["name"] for axis in multiscales["axes"]] == ["t", "c", "z", "y", "x"]
    scale_level1 = multiscales["datasets"][1]["coordinateTransformations"][0]["scale"]
    assert np.allclose(scale_level1, [1.0, 1.0, 1.0, 0.6, 0.6])

    channels = root.attrs["omero"]["channels"]
    assert channels[0]["label"] == "mito"
    assert channels[1]["label"] == "nucleus"


def test_convert_ome_tiff_to_omezarr_cli(tmp_path: Path) -> None:
    source_tiff = tmp_path / "fixture_cli.ome.tif"
    output_zarr = tmp_path / "fixture_cli.zarr"
    _write_fixture_ome_tiff(source_tiff)

    result = subprocess.run(
        [
            "uv",
            "run",
            "python",
            "scripts/data/convert_ome_tiff_to_omezarr.py",
            str(source_tiff),
            "--output",
            str(output_zarr),
            "--pyramid-levels",
            "2",
            "--json",
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=True,
    )

    payload = json.loads(result.stdout)
    assert len(payload["conversions"]) == 1
    assert payload["conversions"][0]["output_path"] == str(output_zarr.resolve())
    assert output_zarr.exists()

    root = zarr.open_group(str(output_zarr), mode="r")
    assert "0" in root
    assert "1" in root
