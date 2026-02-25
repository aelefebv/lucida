#!/usr/bin/env python3
"""CLI helper for converting OME-TIFF files to OME-Zarr."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from lucida.io.ome_tiff_to_zarr import (
    ConversionOptions,
    ConversionSummary,
    convert_ome_tiff_to_omezarr,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert one or many OME-TIFF files into OME-Zarr datasets.",
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        help="Input OME-TIFF file paths.",
    )
    parser.add_argument(
        "--output",
        help="Explicit output .zarr path (only valid for a single input).",
    )
    parser.add_argument(
        "--out-dir",
        help="Output directory for generated .zarr folders (defaults to each input parent).",
    )
    parser.add_argument(
        "--pyramid-levels",
        type=int,
        default=4,
        help="Maximum number of pyramid levels to write (including level 0).",
    )
    parser.add_argument(
        "--downsample-factor",
        type=int,
        default=2,
        help="Per-level downsample factor for selected spatial axes.",
    )
    parser.add_argument(
        "--downsample-axes",
        default="zyx",
        help="Spatial axes to downsample each level (any combination of z,y,x).",
    )
    parser.add_argument(
        "--chunks",
        help="Optional TCZYX chunk shape, e.g. 1,1,8,256,256.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace any existing output path.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON summary.",
    )
    return parser


def _parse_chunk_shape(raw_value: str | None) -> tuple[int, int, int, int, int] | None:
    if raw_value is None:
        return None
    values = [int(piece.strip()) for piece in raw_value.split(",") if piece.strip()]
    if len(values) != 5:
        raise ValueError("--chunks must include exactly 5 comma-separated values in TCZYX order.")
    return (values[0], values[1], values[2], values[3], values[4])


def _parse_downsample_axes(raw_value: str) -> tuple[str, ...]:
    axes = tuple(character for character in raw_value.lower() if character in {"z", "y", "x"})
    if not axes:
        raise ValueError("--downsample-axes must include at least one of z, y, or x.")
    return axes


def _resolve_output_paths(
    *,
    input_paths: list[Path],
    explicit_output: str | None,
    output_dir: str | None,
) -> list[Path]:
    if explicit_output and len(input_paths) != 1:
        raise ValueError("--output is only valid when converting exactly one input file.")
    if explicit_output and output_dir:
        raise ValueError("Use either --output or --out-dir, not both.")

    if explicit_output:
        return [Path(explicit_output).expanduser()]

    base_dir = Path(output_dir).expanduser() if output_dir else None
    outputs: list[Path] = []
    for input_path in input_paths:
        target_dir = base_dir or input_path.parent
        outputs.append(target_dir / f"{_strip_tiff_suffix(input_path.name)}.zarr")
    return outputs


def _strip_tiff_suffix(file_name: str) -> str:
    lowered = file_name.lower()
    if lowered.endswith(".ome.tiff"):
        return file_name[:-9]
    if lowered.endswith(".ome.tif"):
        return file_name[:-8]
    if lowered.endswith(".tiff"):
        return file_name[:-5]
    if lowered.endswith(".tif"):
        return file_name[:-4]
    return Path(file_name).stem


def _to_json_summary(input_path: Path, output_path: Path, summary: ConversionSummary) -> dict[str, object]:
    return {
        "input_path": str(input_path.resolve(strict=False)),
        "output_path": str(output_path.resolve(strict=False)),
        "shape_tczyx": list(summary.shape_tczyx),
        "chunk_shape": list(summary.chunk_shape),
        "dtype": summary.dtype,
        "pyramid_levels_written": summary.pyramid_levels_written,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    input_paths = [Path(raw).expanduser() for raw in args.inputs]
    output_paths = _resolve_output_paths(
        input_paths=input_paths,
        explicit_output=args.output,
        output_dir=args.out_dir,
    )
    chunk_shape = _parse_chunk_shape(args.chunks)
    options = ConversionOptions(
        pyramid_levels=args.pyramid_levels,
        downsample_factor=args.downsample_factor,
        downsample_axes=_parse_downsample_axes(args.downsample_axes),
        chunk_shape=chunk_shape,
        overwrite=args.overwrite,
    )

    summaries: list[dict[str, object]] = []
    for input_path, output_path in zip(input_paths, output_paths):
        conversion = convert_ome_tiff_to_omezarr(
            input_path=input_path,
            output_path=output_path,
            options=options,
        )
        summaries.append(_to_json_summary(input_path, output_path, conversion))

    if args.json:
        print(json.dumps({"conversions": summaries}, indent=2))
    else:
        for summary in summaries:
            print(
                f"{summary['input_path']} -> {summary['output_path']} "
                f"(shape={tuple(summary['shape_tczyx'])}, levels={summary['pyramid_levels_written']})"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
