#!/usr/bin/env python3
"""Validate that a PNG exists, decodes, and contains more than one color."""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PngError(RuntimeError):
    pass


def paeth_predictor(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def iter_chunks(data: bytes):
    pos = len(PNG_SIGNATURE)
    while pos < len(data):
        if pos + 8 > len(data):
            raise PngError("truncated PNG chunk header")
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        chunk_type = data[pos + 4 : pos + 8]
        pos += 8
        chunk_end = pos + length
        crc_end = chunk_end + 4
        if crc_end > len(data):
            raise PngError(f"truncated PNG chunk {chunk_type!r}")
        yield chunk_type, data[pos:chunk_end]
        pos = crc_end
        if chunk_type == b"IEND":
            break


def parse_png(data: bytes) -> tuple[int, int, int, int, bytes, bytes | None]:
    if not data.startswith(PNG_SIGNATURE):
        raise PngError("file does not start with a PNG signature")

    width = height = bit_depth = color_type = interlace = None
    idat_parts: list[bytes] = []
    palette: bytes | None = None

    for chunk_type, chunk in iter_chunks(data):
        if chunk_type == b"IHDR":
            if len(chunk) != 13:
                raise PngError("invalid IHDR length")
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if compression != 0 or filter_method != 0:
                raise PngError("unsupported PNG compression or filter method")
        elif chunk_type == b"PLTE":
            palette = chunk
        elif chunk_type == b"IDAT":
            idat_parts.append(chunk)
        elif chunk_type == b"IEND":
            break

    if width is None or height is None or bit_depth is None or color_type is None or interlace is None:
        raise PngError("missing IHDR")
    if width == 0 or height == 0:
        raise PngError("PNG has zero width or height")
    if bit_depth != 8:
        raise PngError(f"unsupported bit depth {bit_depth}; expected 8")
    if color_type not in {0, 2, 3, 4, 6}:
        raise PngError(f"unsupported color type {color_type}")
    if interlace != 0:
        raise PngError("interlaced PNGs are not supported by this smoke helper")
    if not idat_parts:
        raise PngError("missing IDAT data")

    return width, height, bit_depth, color_type, b"".join(idat_parts), palette


def bytes_per_pixel(color_type: int) -> int:
    return {
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4,
    }[color_type]


def reconstruct_scanlines(width: int, height: int, color_type: int, compressed: bytes) -> list[bytes]:
    bpp = bytes_per_pixel(color_type)
    stride = width * bpp
    raw = zlib.decompress(compressed)
    expected = height * (stride + 1)
    if len(raw) < expected:
        raise PngError(f"decompressed PNG data is truncated: {len(raw)} < {expected}")

    rows: list[bytes] = []
    previous = bytearray(stride)
    pos = 0
    for _ in range(height):
        filter_type = raw[pos]
        pos += 1
        scanline = bytearray(raw[pos : pos + stride])
        pos += stride

        for i, value in enumerate(scanline):
            left = scanline[i - bpp] if i >= bpp else 0
            up = previous[i]
            up_left = previous[i - bpp] if i >= bpp else 0
            if filter_type == 0:
                reconstructed = value
            elif filter_type == 1:
                reconstructed = value + left
            elif filter_type == 2:
                reconstructed = value + up
            elif filter_type == 3:
                reconstructed = value + ((left + up) // 2)
            elif filter_type == 4:
                reconstructed = value + paeth_predictor(left, up, up_left)
            else:
                raise PngError(f"unsupported PNG filter type {filter_type}")
            scanline[i] = reconstructed & 0xFF

        rows.append(bytes(scanline))
        previous = scanline

    return rows


def color_at(row: bytes, x: int, color_type: int, palette: bytes | None) -> tuple[int, int, int, int]:
    if color_type == 0:
        gray = row[x]
        return gray, gray, gray, 255
    if color_type == 2:
        pos = x * 3
        return row[pos], row[pos + 1], row[pos + 2], 255
    if color_type == 3:
        index = row[x]
        if palette is None:
            raise PngError("indexed PNG is missing PLTE")
        pos = index * 3
        if pos + 2 >= len(palette):
            raise PngError("indexed PNG references a missing palette color")
        return palette[pos], palette[pos + 1], palette[pos + 2], 255
    if color_type == 4:
        pos = x * 2
        gray = row[pos]
        return gray, gray, gray, row[pos + 1]
    if color_type == 6:
        pos = x * 4
        return row[pos], row[pos + 1], row[pos + 2], row[pos + 3]
    raise PngError(f"unsupported color type {color_type}")


def assert_nonblank(path: Path, *, min_colors: int) -> tuple[int, int, int]:
    data = path.read_bytes()
    width, height, _bit_depth, color_type, compressed, palette = parse_png(data)
    rows = reconstruct_scanlines(width, height, color_type, compressed)

    colors: set[tuple[int, int, int, int]] = set()
    sampled = 0
    step_x = max(1, width // 256)
    step_y = max(1, height // 256)

    for y in range(0, height, step_y):
        row = rows[y]
        for x in range(0, width, step_x):
            rgba = color_at(row, x, color_type, palette)
            colors.add(rgba)
            sampled += 1
            if len(colors) >= min_colors:
                return width, height, len(colors)

    raise PngError(
        f"PNG appears blank: sampled {sampled} pixels and found {len(colors)} distinct color(s)"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--min-colors", type=int, default=2)
    args = parser.parse_args()

    try:
        width, height, colors = assert_nonblank(args.path, min_colors=args.min_colors)
    except (OSError, PngError, zlib.error) as error:
        print(f"PNG check failed for {args.path}: {error}", file=sys.stderr)
        return 1

    print(f"PNG ok: {args.path} ({width}x{height}, >= {colors} sampled colors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
