"""Data models for deterministic points-layer frame planning."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class FramePlanLayerPoints:
    """Resolved points-layer entry for one bound points layer."""

    layer_id: str
    visible: bool
    opacity: float
    point_count: int
    edge_count: int
    filter_applied: bool
    lod_cell_px: int
    lod_max_points: int
    candidate_points: int
    visible_points: int
    selected_points: int
    attribute_columns: list[str] = field(default_factory=list)
    coordinate_axes: list[str] = field(default_factory=list)
    active_filter: dict[str, Any] | None = None


@dataclass(frozen=True)
class FramePlanPoints:
    """Deterministic, protocol-internal points frame plan for a single view."""

    session_id: str
    view_id: str
    plan_seq: int
    invalidation_kind: str
    invalidation_reasons: list[str]
    axis_order: list[str]
    slice_axes: dict[str, int]
    layer_order: list[str]
    total_points: int
    total_visible_points: int
    total_selected_points: int
    layers: list[FramePlanLayerPoints] = field(default_factory=list)
