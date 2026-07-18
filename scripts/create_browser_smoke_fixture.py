#!/usr/bin/env python3
"""Create Lucida's deterministic real-browser wide-collection OME-Zarr fixture.

The fixture is intentionally generated instead of checked in as opaque binary
data. It is a real Zarr v3 / OME 0.5 collection with twelve populated columns.
Every member has three uint8 channels and one uncompressed chunk per channel,
so it remains small enough for cross-stack CI while exercising collection
navigation and remaining visually distinct enough that a wrong-channel or
black-canvas capture is obvious.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path


WIDTH = 64
HEIGHT = 64
CHANNELS = 3
COLLECTION_ROW = "A"
COLLECTION_COLUMNS = tuple(str(index) for index in range(1, 13))


def _channel_bytes(channel: int) -> bytes:
    pixels = bytearray(WIDTH * HEIGHT)
    for y in range(HEIGHT):
        for x in range(WIDTH):
            if channel == 0:
                value = x * 255 // (WIDTH - 1)
            elif channel == 1:
                value = y * 255 // (HEIGHT - 1)
            else:
                checker = ((x // 8) + (y // 8)) % 2
                value = 224 if checker else 32
            pixels[y * WIDTH + x] = value
    return bytes(pixels)


def _image_metadata(column: str) -> dict[str, object]:
    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "multiscales": [
                    {
                        "name": f"lucida-browser-smoke-{COLLECTION_ROW}{column}",
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
                                    {"type": "scale", "scale": [1, 1, 1, 1, 1]}
                                ],
                            }
                        ],
                    }
                ],
                "omero": {
                    "version": "0.5",
                    "channels": [
                        {
                            "label": "horizontal uint8 gradient",
                            "color": "FF4040",
                            "window": {"min": 0, "max": 255, "start": 0, "end": 255},
                        },
                        {
                            "label": "vertical uint8 gradient",
                            "color": "40FF40",
                            "window": {"min": 0, "max": 255, "start": 0, "end": 255},
                        },
                        {
                            "label": "uint8 checkerboard",
                            "color": "4080FF",
                            "window": {"min": 0, "max": 255, "start": 0, "end": 255},
                        },
                    ],
                },
            }
        },
    }


def _root_metadata() -> dict[str, object]:
    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "plate": {
                    "version": "0.5",
                    "name": "lucida-browser-smoke-wide-collection",
                    "rows": [{"name": COLLECTION_ROW}],
                    "columns": [{"name": column} for column in COLLECTION_COLUMNS],
                    "wells": [
                        {
                            "path": f"{COLLECTION_ROW}/{column}",
                            "rowIndex": 0,
                            "columnIndex": column_index,
                        }
                        for column_index, column in enumerate(COLLECTION_COLUMNS)
                    ],
                    "field_count": 1,
                },
            }
        },
    }


def _row_metadata() -> dict[str, object]:
    return {"zarr_format": 3, "node_type": "group", "attributes": {}}


def _well_metadata() -> dict[str, object]:
    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "well": {"images": [{"path": "0"}]},
            }
        },
    }


def _member_root(root: Path, column: str) -> Path:
    return root / COLLECTION_ROW / column / "0"


def _array_metadata() -> dict[str, object]:
    return {
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, CHANNELS, 1, HEIGHT, WIDTH],
        "data_type": "uint8",
        "chunk_grid": {
            "name": "regular",
            "configuration": {"chunk_shape": [1, 1, 1, HEIGHT, WIDTH]},
        },
        "chunk_key_encoding": {
            "name": "default",
            "configuration": {"separator": "/"},
        },
        "fill_value": 0,
        # Lucida's admission boundary requires the v3 bytes codec to spell out
        # endianness even for one-byte elements. Keeping the canonical config in
        # the generated fixture proves the real metadata parser, not a test-only
        # shortcut.
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "attributes": {},
        "dimension_names": ["t", "c", "z", "y", "x"],
        "storage_transformers": [],
    }


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def validate_fixture(root: Path) -> None:
    group = json.loads((root / "zarr.json").read_text(encoding="utf-8"))
    if group.get("zarr_format") != 3 or group.get("node_type") != "group":
        raise ValueError("root is not a Zarr v3 group")
    plate = group.get("attributes", {}).get("ome", {}).get("plate", {})
    if plate.get("rows") != [{"name": COLLECTION_ROW}]:
        raise ValueError("browser fixture must retain its single collection row")
    if plate.get("columns") != [{"name": column} for column in COLLECTION_COLUMNS]:
        raise ValueError("browser fixture must retain all twelve collection columns")
    wells = plate.get("wells", [])
    if len(wells) != len(COLLECTION_COLUMNS):
        raise ValueError("browser fixture must populate every collection column")

    expected_window = {"min": 0, "max": 255, "start": 0, "end": 255}
    for column_index, column in enumerate(COLLECTION_COLUMNS):
        expected_well = {
            "path": f"{COLLECTION_ROW}/{column}",
            "rowIndex": 0,
            "columnIndex": column_index,
        }
        if wells[column_index] != expected_well:
            raise ValueError(f"unexpected collection member declaration: {wells[column_index]!r}")
        member = _member_root(root, column)
        image = json.loads((member / "zarr.json").read_text(encoding="utf-8"))
        array = json.loads((member / "0" / "zarr.json").read_text(encoding="utf-8"))
        if array.get("shape") != [1, CHANNELS, 1, HEIGHT, WIDTH]:
            raise ValueError("unexpected fixture shape")
        if array.get("data_type") != "uint8":
            raise ValueError("browser fixture must retain its non-u16 dtype")
        if array.get("codecs") != [
            {"name": "bytes", "configuration": {"endian": "little"}}
        ]:
            raise ValueError("browser fixture must use the canonical little-endian bytes codec")
        channels = (
            image.get("attributes", {})
            .get("ome", {})
            .get("omero", {})
            .get("channels", [])
        )
        if len(channels) != CHANNELS or any(
            channel.get("window") != expected_window for channel in channels
        ):
            raise ValueError("fixture channel windows must declare the full uint8 range")
        chunks = [
            member / "0" / "c" / "0" / str(channel) / "0" / "0" / "0"
            for channel in range(CHANNELS)
        ]
        payloads = [path.read_bytes() for path in chunks]
        if any(len(payload) != WIDTH * HEIGHT for payload in payloads):
            raise ValueError("fixture chunk byte length does not match metadata")
        if len(set(payloads)) != CHANNELS or any(len(set(payload)) < 2 for payload in payloads):
            raise ValueError("fixture channels must be distinct and non-constant")
        if any((min(payload), max(payload)) != (0, 255) for payload in payloads[:2]):
            raise ValueError("fixture gradient channels must span the declared uint8 window")


def create_fixture(output: Path, *, force: bool = False) -> Path:
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not force:
        raise FileExistsError(f"output already exists: {output} (pass --force to replace it)")

    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    try:
        _write_json(staging / "zarr.json", _root_metadata())
        row = staging / COLLECTION_ROW
        row.mkdir()
        _write_json(row / "zarr.json", _row_metadata())
        for column in COLLECTION_COLUMNS:
            well = row / column
            well.mkdir()
            _write_json(well / "zarr.json", _well_metadata())
            member = _member_root(staging, column)
            member.mkdir()
            _write_json(member / "zarr.json", _image_metadata(column))
            level = member / "0"
            level.mkdir()
            _write_json(level / "zarr.json", _array_metadata())
            for channel in range(CHANNELS):
                chunk = level / "c" / "0" / str(channel) / "0" / "0" / "0"
                chunk.parent.mkdir(parents=True, exist_ok=True)
                chunk.write_bytes(_channel_bytes(channel))
        validate_fixture(staging)
        if output.exists():
            shutil.rmtree(output)
        os.replace(staging, output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    output = create_fixture(args.output, force=args.force)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
