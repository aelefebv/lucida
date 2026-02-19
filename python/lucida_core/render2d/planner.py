"""Build deterministic per-view 2D frame plans."""

from __future__ import annotations

from dataclasses import asdict
import math
from typing import TYPE_CHECKING, Any

from .controls import PanZoomState, panzoom_state_from_pose
from .model import FramePlan2D, FramePlanLayer2D
from .scheduler import InvalidationTicket


if TYPE_CHECKING:
    from lucida_core.engine import DatasetState, LayerState, SessionState, ViewState


HYSTERESIS_MIN = 0.67
HYSTERESIS_MAX = 1.5


def _display_axes(axis_order: list[str]) -> list[str]:
    if len(axis_order) >= 2:
        return [axis_order[-2], axis_order[-1]]
    if len(axis_order) == 1:
        return [axis_order[0], axis_order[0]]
    return ["y", "x"]


def _slice_axes(view_axis_order: list[str], axis_indices: dict[str, int], display_axes: list[str]) -> dict[str, int]:
    display = set(display_axes)
    return {
        axis: int(axis_indices.get(axis, 0))
        for axis in view_axis_order
        if axis not in display
    }


def _safe_shape_index(axis_labels: list[str], shape: list[int], axis: str) -> int | None:
    if axis not in axis_labels:
        return None
    idx = axis_labels.index(axis)
    if idx < 0 or idx >= len(shape):
        return None
    return int(shape[idx])


def _dataset_level_shapes(dataset: "DatasetState") -> list[dict[str, Any]]:
    levels: list[dict[str, Any]] = []
    for summary in dataset.multiscales:
        if not isinstance(summary, dict):
            continue
        axes_value = summary.get("axes")
        if not isinstance(axes_value, list) or not all(isinstance(axis, str) for axis in axes_value):
            continue
        level_entries = summary.get("levels")
        if not isinstance(level_entries, list):
            continue
        for entry in level_entries:
            if not isinstance(entry, dict):
                continue
            shape = entry.get("shape")
            if not isinstance(shape, list) or not all(isinstance(v, int) and v > 0 for v in shape):
                continue
            levels.append({"axes": list(axes_value), "shape": list(shape)})
    return levels


def _level_downsample(base_shape: dict[str, int], level_shape: dict[str, int], axes: list[str]) -> float:
    factors: list[float] = []
    for axis in axes:
        base = base_shape.get(axis)
        level = level_shape.get(axis)
        if base is None or level is None:
            continue
        if base <= 0 or level <= 0:
            continue
        factors.append(base / level)
    if not factors:
        return 1.0
    product = 1.0
    for value in factors:
        product *= value
    return product ** (1.0 / len(factors))


def _screen_match_score(zoom: float, downsample: float) -> float:
    p = max(zoom * downsample, 1e-12)
    return abs(math.log2(p))


def _screen_match_value(zoom: float, downsample: float) -> float:
    return max(zoom * downsample, 1e-12)


def _choose_level(
    *,
    dataset: "DatasetState",
    display_axes: list[str],
    zoom: float,
    previous_level: int | None,
) -> tuple[int, float]:
    axis_labels = list(dataset.axis_labels)
    base_shape: dict[str, int] = {}
    for axis in axis_labels:
        size = _safe_shape_index(axis_labels, dataset.shape, axis)
        if size is not None:
            base_shape[axis] = size

    levels = _dataset_level_shapes(dataset)
    if not levels:
        return (0, _screen_match_value(zoom, 1.0))

    candidates: list[tuple[int, float, float]] = []
    for idx, level in enumerate(levels):
        level_axes = level["axes"]
        level_shape_list = level["shape"]
        level_shape: dict[str, int] = {}
        for axis, size in zip(level_axes, level_shape_list, strict=False):
            level_shape[axis] = int(size)
        downsample = _level_downsample(base_shape, level_shape, display_axes)
        score = _screen_match_score(zoom, downsample)
        p = _screen_match_value(zoom, downsample)
        candidates.append((idx, score, p))

    if not candidates:
        return (0, _screen_match_value(zoom, 1.0))

    if previous_level is not None:
        for idx, _score, p in candidates:
            if idx == previous_level and HYSTERESIS_MIN <= p <= HYSTERESIS_MAX:
                return (idx, p)

    best_idx, _score, best_p = min(candidates, key=lambda item: (item[1], item[0]))
    return (best_idx, best_p)


def _collect_layers(session: "SessionState", view: "ViewState") -> list["LayerState"]:
    layers: list["LayerState"] = []
    for layer_id in view.bound_layer_ids:
        layer = session.layers.get(layer_id)
        if layer is not None:
            layers.append(layer)
    return layers


def _first_dataset(session: "SessionState", layers: list["LayerState"]) -> "DatasetState" | None:
    for layer in layers:
        if layer.dataset_id is None:
            continue
        dataset = session.datasets.get(layer.dataset_id)
        if dataset is not None:
            return dataset
    return None


def _layer_plan_entries(view: "ViewState", layers: list["LayerState"]) -> list[FramePlanLayer2D]:
    entries: list[FramePlanLayer2D] = []
    for layer in layers:
        entries.append(
            FramePlanLayer2D(
                layer_id=layer.layer_id,
                layer_type=layer.layer_type,
                visible=bool(layer.visible),
                opacity=float(layer.opacity),
                channel_order=list(view.channel_order),
                dataset_id=layer.dataset_id,
            )
        )
    return entries


def build_frame_plan_2d(
    *,
    session: "SessionState",
    view: "ViewState",
    ticket: InvalidationTicket,
    previous_plan: FramePlan2D | None,
) -> FramePlan2D:
    display_axes = _display_axes(list(view.axis_order))
    slice_axes = _slice_axes(list(view.axis_order), dict(view.axis_indices), display_axes)
    layers = _collect_layers(session, view)
    dataset = _first_dataset(session, layers)

    previous_level = previous_plan.selected_level if previous_plan is not None else None
    try:
        panzoom = panzoom_state_from_pose(dict(view.camera_pose))
    except ValueError:
        panzoom = PanZoomState(center_x=0.0, center_y=0.0, zoom=1.0)
    if dataset is None:
        selected_level = 0
        screen_match = 1.0
    else:
        selected_level, screen_match = _choose_level(
            dataset=dataset,
            display_axes=display_axes,
            zoom=panzoom.zoom,
            previous_level=previous_level,
        )

    layer_entries = _layer_plan_entries(view, layers)
    return FramePlan2D(
        session_id=session.session_id,
        view_id=view.view_id,
        plan_seq=ticket.plan_seq,
        invalidation_kind=ticket.kind.value,
        invalidation_reasons=list(ticket.reasons),
        display_axes=display_axes,
        slice_axes=slice_axes,
        selected_level=int(selected_level),
        level_screen_match=float(screen_match),
        channel_order=list(view.channel_order),
        layer_order=[layer.layer_id for layer in layers],
        layers=layer_entries,
    )


def frame_plan_to_dict(plan: FramePlan2D) -> dict[str, Any]:
    return asdict(plan)
