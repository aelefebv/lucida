"""Tile slicing, encoding, and diff helpers for gateway frame streaming."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import io

from PIL import Image


@dataclass(frozen=True)
class EncodedTile:
    x: int
    y: int
    width: int
    height: int
    format: str
    quality: int
    payload_b64: str
    tile_hash: str


def _encode_jpeg(tile: Image.Image, *, quality: int) -> bytes:
    out = io.BytesIO()
    tile.convert("RGB").save(out, format="JPEG", quality=quality)
    return out.getvalue()


def _encode_png(tile: Image.Image) -> bytes:
    out = io.BytesIO()
    tile.save(out, format="PNG")
    return out.getvalue()


def encode_changed_tiles(
    *,
    image: Image.Image,
    previous_hashes: dict[tuple[int, int, int, int], str],
    tile_size_px: int,
    jpeg_quality: int,
    lossless: bool,
) -> list[EncodedTile]:
    width, height = image.size
    if width <= 0 or height <= 0:
        return []

    changed: list[EncodedTile] = []
    seen_keys: set[tuple[int, int, int, int]] = set()

    for y in range(0, height, tile_size_px):
        for x in range(0, width, tile_size_px):
            box = (x, y, min(x + tile_size_px, width), min(y + tile_size_px, height))
            tile = image.crop(box)
            key = (x, y, tile.width, tile.height)
            seen_keys.add(key)

            fmt = "png"
            quality = 100
            encoded: bytes
            if not lossless:
                try:
                    encoded = _encode_jpeg(tile, quality=jpeg_quality)
                    fmt = "jpeg"
                    quality = jpeg_quality
                except Exception:
                    encoded = _encode_png(tile)
            else:
                encoded = _encode_png(tile)

            tile_hash = hashlib.sha256(encoded).hexdigest()
            previous = previous_hashes.get(key)
            if previous == tile_hash:
                continue

            previous_hashes[key] = tile_hash
            changed.append(
                EncodedTile(
                    x=x,
                    y=y,
                    width=tile.width,
                    height=tile.height,
                    format=fmt,
                    quality=quality,
                    payload_b64=base64.b64encode(encoded).decode("ascii"),
                    tile_hash=tile_hash,
                )
            )

    stale_keys = [key for key in previous_hashes if key not in seen_keys]
    for key in stale_keys:
        previous_hashes.pop(key, None)

    return changed


__all__ = ["EncodedTile", "encode_changed_tiles"]
