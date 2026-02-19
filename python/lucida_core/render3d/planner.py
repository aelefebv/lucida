"""Build deterministic per-view 3D frame plans."""

from __future__ import annotations

from dataclasses import asdict
import math
from typing import TYPE_CHECKING, Any

from .controls import camera_zoom_scalar_from_pose, canonicalize_camera_pose_3d
from .model import FramePlan3D, FramePlanLayer3D
from .scheduler import InvalidationTicket3D


if TYPE_CHECKING:
    from lucida_core.engine import DatasetState, LayerState, SessionState, ViewState


HYSTERESIS_MIN = 0.67
HYSTERESIS_MAX = 1.5


def _volume_axes(axis_order: list[str]) -> list[str]:
    if len(axis_order) >= 3:
        return [axis_order[-3], axis_order[-2], axis_order[-1]]
    return list(axis_order)


def _slice_axes(view_axis_order: list[str], axis_indices: dict[str, int], volume_axes: list[str]) -> dict[str, int]:
    volume = set(volume_axes)
    return {
        axis: int(axis_indices.get(axis, 0))
        for axis in view_axis_order
        if axis not in volume
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
    volume_axes: list[str],
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
        downsample = _level_downsample(base_shape, level_shape, volume_axes)
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


def _resolve_layer_render_controls(layer: "LayerState") -> tuple[str, float, float, float]:
    patch = layer.patch if isinstance(layer.patch, dict) else {}

    render_mode = patch.get("render_mode", "mip")
    if render_mode not in {"mip", "alpha", "iso"}:
        render_mode = "mip"

    iso_threshold = patch.get("iso_threshold", 0.5)
    if not isinstance(iso_threshold, (int, float)):
        iso_threshold = 0.5
    iso_threshold = float(iso_threshold)

    density_scale = patch.get("density_scale", 1.0)
    if not isinstance(density_scale, (int, float)):
        density_scale = 1.0
    density_scale = float(density_scale)

    sample_step = patch.get("sample_step", 1.0)
    if not isinstance(sample_step, (int, float)):
        sample_step = 1.0
    sample_step = float(sample_step)

    return (render_mode, iso_threshold, density_scale, sample_step)


def _layer_plan_entries(view: "ViewState", layers: list["LayerState"]) -> list[FramePlanLayer3D]:
    entries: list[FramePlanLayer3D] = []
    for layer in layers:
        render_mode, iso_threshold, density_scale, sample_step = _resolve_layer_render_controls(layer)
        entries.append(
            FramePlanLayer3D(
                layer_id=layer.layer_id,
                layer_type=layer.layer_type,
                visible=bool(layer.visible),
                opacity=float(layer.opacity),
                channel_order=list(view.channel_order),
                render_mode=render_mode,
                iso_threshold=iso_threshold,
                density_scale=density_scale,
                sample_step=sample_step,
                dataset_id=layer.dataset_id,
            )
        )
    return entries


def _resolve_renderability(
    *,
    view: "ViewState",
    dataset: "DatasetState" | None,
    volume_axes: list[str],
) -> tuple[bool, str | None]:
    if len(view.axis_order) < 3:
        return (False, "insufficient_volume_axes")
    if len(volume_axes) != 3 or len(set(volume_axes)) != 3:
        return (False, "insufficient_volume_axes")
    if dataset is None:
        return (False, "missing_dataset")
    if any(axis not in dataset.axis_labels for axis in volume_axes):
        return (False, "insufficient_volume_axes")
    return (True, None)


def _canonical_camera(view: "ViewState") -> dict[str, Any]:
    pose = dict(view.camera_pose)
    if view.camera_mode in {"arcball", "freefly"}:
        return canonicalize_camera_pose_3d(pose, mode=view.camera_mode, strict=False)
    return pose


def build_frame_plan_3d(
    *,
    session: "SessionState",
    view: "ViewState",
    ticket: InvalidationTicket3D,
    previous_plan: FramePlan3D | None,
) -> FramePlan3D:
    volume_axes = _volume_axes(list(view.axis_order))
    slice_axes = _slice_axes(list(view.axis_order), dict(view.axis_indices), volume_axes)
    layers = _collect_layers(session, view)
    dataset = _first_dataset(session, layers)

    renderable, non_renderable_reason = _resolve_renderability(view=view, dataset=dataset, volume_axes=volume_axes)

    previous_level = previous_plan.selected_level if previous_plan is not None else None
    zoom = camera_zoom_scalar_from_pose(dict(view.camera_pose))

    if dataset is None or not renderable:
        selected_level = 0
        screen_match = 1.0
    else:
        selected_level, screen_match = _choose_level(
            dataset=dataset,
            volume_axes=volume_axes,
            zoom=zoom,
            previous_level=previous_level,
        )

    camera_pose = _canonical_camera(view)
    layer_entries = _layer_plan_entries(view, layers)
    return FramePlan3D(
        session_id=session.session_id,
        view_id=view.view_id,
        plan_seq=ticket.plan_seq,
        invalidation_kind=ticket.kind.value,
        invalidation_reasons=list(ticket.reasons),
        volume_axes=volume_axes,
        slice_axes=slice_axes,
        selected_level=int(selected_level),
        level_screen_match=float(screen_match),
        renderable=renderable,
        non_renderable_reason=non_renderable_reason,
        camera_mode=view.camera_mode,
        camera_pose=camera_pose,
        channel_order=list(view.channel_order),
        layer_order=[layer.layer_id for layer in layers],
        layers=layer_entries,
    )


def frame_plan_3d_to_dict(plan: FramePlan3D) -> dict[str, Any]:
    return asdict(plan)
