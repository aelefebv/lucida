"""Data models for deterministic 2D frame planning."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class FramePlanLayer2D:
    """Resolved compositing entry for one bound layer."""

    layer_id: str
    layer_type: str
    visible: bool
    opacity: float
    channel_order: list[int]
    dataset_id: str | None = None


@dataclass(frozen=True)
class FramePlan2D:
    """Deterministic, protocol-internal 2D render plan for a single view."""

    session_id: str
    view_id: str
    plan_seq: int
    invalidation_kind: str
    invalidation_reasons: list[str]
    display_axes: list[str]
    slice_axes: dict[str, int]
    selected_level: int
    level_screen_match: float
    channel_order: list[int]
    layer_order: list[str]
    layers: list[FramePlanLayer2D] = field(default_factory=list)
