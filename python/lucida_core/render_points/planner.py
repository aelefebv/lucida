"""Build deterministic per-view points frame plans."""

from __future__ import annotations

from dataclasses import asdict
import hashlib
import json
from typing import TYPE_CHECKING, Any

from .model import FramePlanLayerPoints, FramePlanPoints
from .scheduler import InvalidationTicketPoints


if TYPE_CHECKING:
    from lucida_core.engine import LayerState, SessionState, ViewState


def _slice_axes(view_axis_order: list[str], axis_indices: dict[str, int]) -> dict[str, int]:
    return {axis: int(axis_indices.get(axis, 0)) for axis in view_axis_order}


def _bound_points_layers(session: "SessionState", view: "ViewState") -> list["LayerState"]:
    layers: list[LayerState] = []
    for layer_id in view.bound_layer_ids:
        layer = session.layers.get(layer_id)
        if layer is not None and layer.layer_type == "points":
            layers.append(layer)
    return layers


def _dataref_shape(data_ref: dict[str, Any] | None) -> list[int]:
    if not isinstance(data_ref, dict):
        return []
    shape = data_ref.get("shape")
    if not isinstance(shape, list):
        return []
    if not all(isinstance(value, int) and value > 0 for value in shape):
        return []
    return [int(value) for value in shape]


def _point_count(layer: "LayerState") -> int:
    shape = _dataref_shape(layer.data_ref)
    if len(shape) < 1:
        return 0
    return int(shape[0])


def _edge_count(layer: "LayerState") -> int:
    shape = _dataref_shape(layer.edges_ref)
    if len(shape) < 1:
        return 0
    return int(shape[0])


def _patch_int(patch: dict[str, Any], key: str, *, default: int, minimum: int = 1) -> int:
    value = patch.get(key, default)
    if not isinstance(value, int) or value < minimum:
        return default
    return int(value)


def _selection_count(selection: dict[str, Any]) -> int:
    resolved = selection.get("resolved")
    if isinstance(resolved, dict):
        count = resolved.get("count")
        if isinstance(count, int) and count >= 0:
            return int(count)
    indices = selection.get("indices")
    if isinstance(indices, list):
        dedup = {idx for idx in indices if isinstance(idx, int) and idx >= 0}
        return len(dedup)
    return 0


def _filter_ratio(predicate: dict[str, Any]) -> float:
    canonical = json.dumps(predicate, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).digest()
    # Keep filtering deterministic while avoiding pathological full-drop behavior.
    return 0.35 + (digest[0] / 255.0) * 0.65


def _candidate_point_count(point_count: int, active_filter: dict[str, Any] | None) -> int:
    if point_count <= 0:
        return 0
    if active_filter is None:
        return point_count
    return max(0, min(point_count, int(round(point_count * _filter_ratio(active_filter)))))


def _layer_plan_entry(view: "ViewState", layer: "LayerState") -> FramePlanLayerPoints:
    patch = layer.patch if isinstance(layer.patch, dict) else {}
    active_filter = patch.get("points_filter")
    if not isinstance(active_filter, dict):
        active_filter = None

    point_count = _point_count(layer)
    candidate_points = _candidate_point_count(point_count, active_filter)
    lod_cell_px = _patch_int(patch, "lod_cell_px", default=2, minimum=1)
    lod_max_points = _patch_int(patch, "lod_max_points", default=250_000, minimum=1)
    visible_points = min(candidate_points, lod_max_points)
    selected_points = min(visible_points, _selection_count(view.selection))

    return FramePlanLayerPoints(
        layer_id=layer.layer_id,
        visible=bool(layer.visible),
        opacity=float(layer.opacity),
        point_count=point_count,
        edge_count=_edge_count(layer),
        filter_applied=active_filter is not None,
        lod_cell_px=lod_cell_px,
        lod_max_points=lod_max_points,
        candidate_points=candidate_points,
        visible_points=visible_points,
        selected_points=selected_points,
        attribute_columns=list(layer.attribute_columns),
        coordinate_axes=list(layer.coordinate_axes),
        active_filter=active_filter,
    )


def build_frame_plan_points(
    *,
    session: "SessionState",
    view: "ViewState",
    ticket: InvalidationTicketPoints,
    previous_plan: FramePlanPoints | None,  # noqa: ARG001 - parity with other planners
) -> FramePlanPoints:
    layers = _bound_points_layers(session, view)
    layer_entries = [_layer_plan_entry(view, layer) for layer in layers]

    total_points = sum(layer.point_count for layer in layer_entries)
    total_visible = sum(layer.visible_points for layer in layer_entries if layer.visible)
    total_selected = sum(layer.selected_points for layer in layer_entries if layer.visible)

    return FramePlanPoints(
        session_id=session.session_id,
        view_id=view.view_id,
        plan_seq=ticket.plan_seq,
        invalidation_kind=ticket.kind.value,
        invalidation_reasons=list(ticket.reasons),
        axis_order=list(view.axis_order),
        slice_axes=_slice_axes(list(view.axis_order), dict(view.axis_indices)),
        layer_order=[layer.layer_id for layer in layers],
        total_points=total_points,
        total_visible_points=total_visible,
        total_selected_points=total_selected,
        layers=layer_entries,
    )


def frame_plan_points_to_dict(plan: FramePlanPoints) -> dict[str, Any]:
    return asdict(plan)
