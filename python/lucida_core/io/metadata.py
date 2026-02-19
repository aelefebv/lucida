"""OME-NGFF metadata normalization helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


CANONICAL_AXIS_HINTS = {"t", "c", "z", "y", "x"}


class AxisMapError(ValueError):
    """Raised when axis_map is invalid or produces conflicting labels."""


@dataclass(frozen=True)
class NormalizedTransform:
    scale: list[float]
    translate: list[float]

    def as_dict(self) -> dict[str, list[float]]:
        return {"scale": list(self.scale), "translate": list(self.translate)}


def axis_type_for_label(label: str) -> str:
    if label == "t":
        return "time"
    if label == "c":
        return "channel"
    return "space"


def default_axis_labels(rank: int) -> list[str]:
    base = ["t", "c", "z", "y", "x"]
    if rank <= len(base):
        return base[-rank:]
    extra_count = rank - len(base)
    extra = [f"d{i}" for i in range(extra_count)]
    return extra + base


def apply_axis_map(axis_labels: list[str], axis_map: dict[str, str] | None) -> list[str]:
    if axis_map is None:
        return list(axis_labels)
    if not isinstance(axis_map, dict):
        raise AxisMapError("axis_map must be an object mapping source axis labels to canonical labels")

    for source, target in axis_map.items():
        if not isinstance(source, str) or not isinstance(target, str):
            raise AxisMapError("axis_map keys and values must be strings")
        if source not in axis_labels:
            raise AxisMapError(f"axis_map key '{source}' is not present in source axis labels")
        if not target:
            raise AxisMapError("axis_map target labels cannot be empty")

    mapped = [axis_map.get(axis, axis) for axis in axis_labels]
    if len(set(mapped)) != len(mapped):
        raise AxisMapError("axis_map produced duplicate canonical axis labels")
    return mapped


def parse_transform(
    dataset_entry: dict[str, Any],
    axis_rank: int,
) -> NormalizedTransform:
    scale = [1.0] * axis_rank
    translate = [0.0] * axis_rank
    transforms = dataset_entry.get("coordinateTransformations")
    if not isinstance(transforms, list):
        return NormalizedTransform(scale=scale, translate=translate)
    for entry in transforms:
        if not isinstance(entry, dict):
            continue
        transform_type = entry.get("type")
        values = entry.get("scale") if transform_type == "scale" else entry.get("translation")
        if not isinstance(values, list):
            continue
        parsed = [float(v) for v in values]
        if len(parsed) != axis_rank:
            continue
        if transform_type == "scale":
            scale = parsed
        if transform_type == "translation":
            translate = parsed
    return NormalizedTransform(scale=scale, translate=translate)
