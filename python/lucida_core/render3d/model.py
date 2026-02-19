"""Data models for deterministic 3D frame planning."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class FramePlanLayer3D:
    """Resolved compositing and volume-style entry for one bound layer."""

    layer_id: str
    layer_type: str
    visible: bool
    opacity: float
    channel_order: list[int]
    render_mode: str
    iso_threshold: float
    density_scale: float
    sample_step: float
    dataset_id: str | None = None


@dataclass(frozen=True)
class FramePlan3D:
    """Deterministic, protocol-internal 3D render plan for a single view."""

    session_id: str
    view_id: str
    plan_seq: int
    invalidation_kind: str
    invalidation_reasons: list[str]
    volume_axes: list[str]
    slice_axes: dict[str, int]
    selected_level: int
    level_screen_match: float
    renderable: bool
    non_renderable_reason: str | None
    camera_mode: str
    camera_pose: dict[str, Any]
    channel_order: list[int]
    layer_order: list[str]
    layers: list[FramePlanLayer3D] = field(default_factory=list)
