from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any

import fsspec
import numpy as np
import zarr
from PIL import Image

from lucida.errors import LucidaError
from lucida.models.api import ApiWarning
from lucida.models.dataset_summary import AxisDef, DatasetSummary, MultiscaleImageDef, MultiscaleLevelDef
from lucida.models.render import RenderOutputSpec, RenderTimingMs
from lucida.models.view_state import AxisSelector, LayerState, SlabSettings, ViewState

_PLANE_ROLES: dict[str, tuple[str, str, str]] = {
    "xy": ("x", "y", "z"),
    "xz": ("x", "z", "y"),
    "yz": ("y", "z", "x"),
}

_DEFAULT_CHANNEL_COLORS: tuple[tuple[float, float, float, float], ...] = (
    (1.0, 0.0, 0.0, 1.0),
    (0.0, 1.0, 0.0, 1.0),
    (0.0, 0.0, 1.0, 1.0),
    (1.0, 1.0, 0.0, 1.0),
    (1.0, 0.0, 1.0, 1.0),
    (0.0, 1.0, 1.0, 1.0),
)


@dataclass(slots=True)
class Render2DResult:
    png_bytes: bytes
    pyramid_level_used: int
    warnings: list[ApiWarning] = field(default_factory=list)
    timing_ms: RenderTimingMs | None = None


def render_view_to_png(
    *,
    dataset_summary: DatasetSummary,
    view_state: ViewState,
    output: RenderOutputSpec,
) -> Render2DResult:
    if view_state.view_2d is None:
        raise LucidaError(
            code="unsupported_mode",
            message="Only mode=2d is supported for this renderer.",
            details={"mode": view_state.mode},
            status_code=422,
        )

    start_total = time.perf_counter()
    warnings: list[ApiWarning] = []

    io_start = time.perf_counter()
    try:
        mapper = fsspec.get_mapper(dataset_summary.uri)
        root = zarr.open_group(store=mapper, mode="r")
    except Exception as exc:
        raise LucidaError(
            code="render_failed",
            message="Failed to open dataset for rendering.",
            details={"dataset_id": dataset_summary.dataset_id, "reason": str(exc)},
            status_code=400,
        ) from exc
    io_after_open = time.perf_counter()

    role_to_axis = _roles_to_axis(dataset_summary.axes)
    u_role, v_role, orth_role = _plane_roles(view_state.view_2d.plane)
    missing_roles = [role for role in (u_role, v_role, orth_role) if role not in role_to_axis]
    if missing_roles:
        raise LucidaError(
            code="unsupported_plane",
            message="Requested plane is unsupported for dataset axes.",
            details={"plane": view_state.view_2d.plane, "missing_roles": missing_roles},
            status_code=422,
        )

    u_axis = role_to_axis[u_role]
    v_axis = role_to_axis[v_role]
    orth_axis = role_to_axis[orth_role]

    selectors_by_axis = {selector.axis: selector for selector in view_state.selectors}
    slice_index = 0
    if view_state.view_2d.slice is not None and view_state.view_2d.slice.index is not None:
        slice_index = int(view_state.view_2d.slice.index)

    background = _resolve_background_rgba(view_state)
    canvas_rgb = np.zeros((output.height_px, output.width_px, 3), dtype=np.float32)
    canvas_alpha = np.zeros((output.height_px, output.width_px), dtype=np.float32)
    canvas_rgb[:, :] = np.array(background[:3], dtype=np.float32)
    canvas_alpha[:, :] = float(background[3])

    rendered_layer_count = 0
    primary_level_used: int | None = None

    for layer in view_state.layers:
        if not layer.visible or layer.opacity <= 0:
            continue

        if layer.type != "image":
            warnings.append(
                ApiWarning(
                    code="non_image_layer_ignored",
                    message="Only image layers are rendered in this slice.",
                    details={"layer_id": layer.layer_id, "layer_type": layer.type},
                )
            )
            continue

        layer_dataset_id = layer.dataset_id or dataset_summary.dataset_id
        if layer_dataset_id != dataset_summary.dataset_id:
            warnings.append(
                ApiWarning(
                    code="non_image_layer_ignored",
                    message="Image layer dataset is not active for this render and was ignored.",
                    details={"layer_id": layer.layer_id, "dataset_id": layer_dataset_id},
                )
            )
            continue

        multiscale_name = _resolve_layer_multiscale_name(view_state=view_state, layer=layer)
        multiscale = _find_multiscale(dataset_summary, multiscale_name)
        level_def, level_warnings = _choose_level(
            multiscale=multiscale,
            view_state=view_state,
            u_axis=u_axis.name,
            v_axis=v_axis.name,
        )
        warnings.extend(level_warnings)

        channel_stack, layer_warnings = _extract_channel_stack(
            root=root,
            dataset_summary=dataset_summary,
            multiscale=multiscale,
            level=level_def,
            u_axis=u_axis.name,
            v_axis=v_axis.name,
            orth_axis=orth_axis.name,
            selectors_by_axis=selectors_by_axis,
            slice_index=slice_index,
            slab=view_state.view_2d.slice.slab if view_state.view_2d.slice and view_state.view_2d.slice.slab else SlabSettings(),
        )
        warnings.extend(layer_warnings)

        level_factors = _level_factors(multiscale=multiscale, level=level_def)
        axis_index = {name: idx for idx, name in enumerate(multiscale.axes_order)}
        f_u = level_factors[axis_index[u_axis.name]]
        f_v = level_factors[axis_index[v_axis.name]]

        sampled_stack, sample_alpha = _sample_channel_stack(
            stack=channel_stack,
            center_u=float(view_state.view_2d.camera.center_world[0]),
            center_v=float(view_state.view_2d.camera.center_world[1]),
            zoom=float(view_state.view_2d.camera.zoom),
            pixel_ratio=float(view_state.viewport.pixel_ratio),
            f_u=f_u,
            f_v=f_v,
            output_width=output.width_px,
            output_height=output.height_px,
            interpolation=(layer.image.interpolation if layer.image else "linear"),
        )

        layer_rgb, layer_alpha = _compose_layer(
            sampled_stack=sampled_stack,
            sample_alpha=sample_alpha,
            layer=layer,
        )

        src_alpha = np.clip(layer_alpha, 0.0, 1.0)
        src_rgb = np.clip(layer_rgb, 0.0, 1.0)
        canvas_rgb = src_rgb + (canvas_rgb * (1.0 - src_alpha[..., None]))
        canvas_alpha = src_alpha + (canvas_alpha * (1.0 - src_alpha))

        rendered_layer_count += 1
        if primary_level_used is None:
            primary_level_used = level_def.level

    if rendered_layer_count == 0:
        raise LucidaError(
            code="render_failed",
            message="No renderable image layers were available.",
            details={"view_id": view_state.view_id},
            status_code=422,
        )

    rgba = np.zeros((output.height_px, output.width_px, 4), dtype=np.float32)
    rgba[..., 0:3] = np.clip(canvas_rgb, 0.0, 1.0)
    rgba[..., 3] = np.clip(canvas_alpha, 0.0, 1.0)
    rgba_u8 = (rgba * 255.0).round().astype(np.uint8)

    encode_start = time.perf_counter()
    buffer = BytesIO()
    image = Image.fromarray(rgba_u8, mode="RGBA")
    image.save(buffer, format="PNG")
    png_bytes = buffer.getvalue()
    end_total = time.perf_counter()

    timing_ms = RenderTimingMs(
        total=(end_total - start_total) * 1000.0,
        io=(io_after_open - io_start) * 1000.0,
        decode=0.0,
        gpu_upload=0.0,
        render=(end_total - encode_start) * 1000.0,
    )

    return Render2DResult(
        png_bytes=png_bytes,
        pyramid_level_used=primary_level_used or 0,
        warnings=warnings,
        timing_ms=timing_ms,
    )


def _roles_to_axis(axes: list[AxisDef]) -> dict[str, AxisDef]:
    mapping: dict[str, AxisDef] = {}
    for axis in axes:
        if axis.role not in mapping:
            mapping[axis.role] = axis
    return mapping


def _plane_roles(plane: str) -> tuple[str, str, str]:
    roles = _PLANE_ROLES.get(plane)
    if roles is None:
        raise LucidaError(
            code="unsupported_plane",
            message="Requested plane is unsupported.",
            details={"plane": plane},
            status_code=422,
        )
    return roles


def _resolve_layer_multiscale_name(*, view_state: ViewState, layer: LayerState) -> str:
    if layer.source is not None and layer.source.multiscale_name:
        return layer.source.multiscale_name
    return view_state.datasets[0].multiscale_name


def _find_multiscale(dataset_summary: DatasetSummary, multiscale_name: str) -> MultiscaleImageDef:
    for multiscale in dataset_summary.multiscales:
        if multiscale.name == multiscale_name:
            return multiscale
    raise LucidaError(
        code="render_failed",
        message="Multiscale for layer source was not found.",
        details={
            "dataset_id": dataset_summary.dataset_id,
            "multiscale_name": multiscale_name,
        },
        status_code=422,
    )


def _choose_level(
    *,
    multiscale: MultiscaleImageDef,
    view_state: ViewState,
    u_axis: str,
    v_axis: str,
) -> tuple[MultiscaleLevelDef, list[ApiWarning]]:
    warnings: list[ApiWarning] = []
    axis_index = {name: idx for idx, name in enumerate(multiscale.axes_order)}
    if u_axis not in axis_index or v_axis not in axis_index:
        raise LucidaError(
            code="render_failed",
            message="Display axes are missing from multiscale axes order.",
            details={
                "multiscale_name": multiscale.name,
                "axes_order": multiscale.axes_order,
                "u_axis": u_axis,
                "v_axis": v_axis,
            },
            status_code=422,
        )

    performance = view_state.performance
    lod_mode = performance.lod_mode if performance is not None else "auto"
    fixed_level = performance.fixed_level if performance is not None else None

    if lod_mode == "fixed":
        if fixed_level is not None:
            for level in multiscale.levels:
                if level.level == fixed_level:
                    return level, warnings
        warnings.append(
            ApiWarning(
                code="lod_level_fallback_auto",
                message="Fixed LOD level was invalid; auto LOD selection was used.",
                details={
                    "requested_level": fixed_level,
                    "available_levels": [level.level for level in multiscale.levels],
                    "multiscale_name": multiscale.name,
                },
            )
        )

    zoom = float(view_state.view_2d.camera.zoom) if view_state.view_2d is not None else 1.0
    pixel_ratio = float(view_state.viewport.pixel_ratio)

    best_level = multiscale.levels[0]
    best_metric = math.inf

    for level in multiscale.levels:
        factors = _level_factors(multiscale=multiscale, level=level)
        f_u = factors[axis_index[u_axis]]
        f_v = factors[axis_index[v_axis]]
        f_uv = math.sqrt(max(1e-9, f_u * f_v))
        metric = abs(math.log2(max(1e-9, f_uv * zoom * pixel_ratio)))
        if metric < best_metric:
            best_metric = metric
            best_level = level

    return best_level, warnings


def _level_factors(*, multiscale: MultiscaleImageDef, level: MultiscaleLevelDef) -> list[float]:
    if level.downsample_factors is not None and len(level.downsample_factors) == len(multiscale.axes_order):
        return [max(1.0, float(value)) for value in level.downsample_factors]

    base_shape = multiscale.levels[0].shape
    factors: list[float] = []
    for base_size, level_size in zip(base_shape, level.shape, strict=True):
        if level_size <= 0:
            factors.append(1.0)
        else:
            factors.append(max(1.0, float(base_size) / float(level_size)))
    return factors


def _extract_channel_stack(
    *,
    root: zarr.Group,
    dataset_summary: DatasetSummary,
    multiscale: MultiscaleImageDef,
    level: MultiscaleLevelDef,
    u_axis: str,
    v_axis: str,
    orth_axis: str,
    selectors_by_axis: dict[str, AxisSelector],
    slice_index: int,
    slab: SlabSettings,
) -> tuple[np.ndarray, list[ApiWarning]]:
    warnings: list[ApiWarning] = []
    axis_index = {name: idx for idx, name in enumerate(multiscale.axes_order)}
    axes_by_name = {axis.name: axis for axis in dataset_summary.axes}

    try:
        array = root[level.path]
    except Exception as exc:
        raise LucidaError(
            code="render_failed",
            message="Failed to open multiscale level array.",
            details={
                "multiscale_name": multiscale.name,
                "path": level.path,
                "reason": str(exc),
            },
            status_code=422,
        ) from exc

    factors = _level_factors(multiscale=multiscale, level=level)

    c_axis_name = next((axis.name for axis in dataset_summary.axes if axis.role == "c"), None)
    orth_size = axes_by_name[orth_axis].size
    orth_selector = selectors_by_axis.get(orth_axis)
    orth_indices_base, explicit_span, orth_warnings = _orthogonal_indices(
        axis_name=orth_axis,
        axis_size=orth_size,
        selector=orth_selector,
        slice_index=slice_index,
        slab=slab,
    )
    warnings.extend(orth_warnings)

    orth_idx = axis_index[orth_axis]
    orth_factor = factors[orth_idx]
    orth_indices_level = sorted(
        {
            _clamp_index(_to_level_index(index=value, factor=orth_factor), level.shape[orth_idx])
            for value in orth_indices_base
        }
    )
    if not orth_indices_level:
        orth_indices_level = [0]

    if explicit_span:
        warnings.append(
            ApiWarning(
                code="slab_thickness_ignored",
                message="Slab thickness was ignored because orthogonal selector explicitly defines span.",
                details={"axis": orth_axis, "thickness_vox": slab.thickness_vox},
            )
        )

    fixed_indices_level: dict[str, int] = {}
    for axis_name in multiscale.axes_order:
        if axis_name in {u_axis, v_axis, orth_axis, c_axis_name}:
            continue

        selector = selectors_by_axis.get(axis_name)
        if selector is None:
            base_index = 0
        elif selector.kind == "index":
            assert selector.index is not None
            base_index = selector.index
        elif selector.kind == "range":
            assert selector.start is not None
            base_index = selector.start
            warnings.append(
                ApiWarning(
                    code="selector_reduced_to_index",
                    message="Range selector was reduced to its first index for non-display axis.",
                    details={"axis": axis_name, "kind": selector.kind, "index": base_index},
                )
            )
        else:
            assert selector.indices is not None
            base_index = selector.indices[0]
            warnings.append(
                ApiWarning(
                    code="selector_reduced_to_index",
                    message="Set selector was reduced to its first index for non-display axis.",
                    details={"axis": axis_name, "kind": selector.kind, "index": base_index},
                )
            )

        idx = axis_index[axis_name]
        level_index = _clamp_index(
            _to_level_index(index=base_index, factor=factors[idx]),
            level.shape[idx],
        )
        fixed_indices_level[axis_name] = level_index

    slab_planes: list[np.ndarray] = []
    for orth_index in orth_indices_level:
        indexer: list[Any] = []
        for axis_name in multiscale.axes_order:
            if axis_name in {u_axis, v_axis}:
                indexer.append(slice(None))
            elif axis_name == orth_axis:
                indexer.append(orth_index)
            elif c_axis_name is not None and axis_name == c_axis_name:
                indexer.append(slice(None))
            else:
                indexer.append(fixed_indices_level.get(axis_name, 0))

        sampled = np.asarray(array[tuple(indexer)], dtype=np.float32)
        remaining_axes = [
            axis_name
            for axis_name, axis_selector in zip(multiscale.axes_order, indexer, strict=True)
            if isinstance(axis_selector, slice)
        ]

        if c_axis_name is not None and c_axis_name in remaining_axes:
            expected = [c_axis_name, v_axis, u_axis]
        else:
            expected = [v_axis, u_axis]

        if any(axis_name not in remaining_axes for axis_name in expected):
            raise LucidaError(
                code="render_failed",
                message="Unexpected axis layout after slicing.",
                details={
                    "remaining_axes": remaining_axes,
                    "expected_axes": expected,
                    "multiscale_name": multiscale.name,
                    "level": level.level,
                },
                status_code=422,
            )

        transpose_order = [remaining_axes.index(axis_name) for axis_name in expected]
        sampled = np.transpose(sampled, axes=transpose_order)
        if c_axis_name is None:
            sampled = sampled[None, ...]
        slab_planes.append(sampled)

    slab_stack = np.stack(slab_planes, axis=0)
    mode = slab.mode
    if mode == "single":
        channel_stack = slab_stack[0]
    elif mode == "mip":
        channel_stack = np.max(slab_stack, axis=0)
    else:
        channel_stack = np.mean(slab_stack, axis=0)

    return channel_stack, warnings


def _orthogonal_indices(
    *,
    axis_name: str,
    axis_size: int,
    selector: AxisSelector | None,
    slice_index: int,
    slab: SlabSettings,
) -> tuple[list[int], bool, list[ApiWarning]]:
    warnings: list[ApiWarning] = []
    explicit_span = False

    if selector is None:
        indices = [_clamp_index(slice_index, axis_size)]
        return indices, explicit_span, warnings

    if selector.kind == "index":
        assert selector.index is not None
        base_indices = [_clamp_index(selector.index, axis_size)]
    elif selector.kind == "range":
        assert selector.start is not None
        assert selector.end_exclusive is not None
        explicit_span = True
        base_indices = list(range(selector.start, selector.end_exclusive))
    else:
        assert selector.indices is not None
        explicit_span = True
        base_indices = sorted(set(selector.indices))

    if not base_indices:
        base_indices = [0]

    if explicit_span:
        if slab.mode == "single":
            return [base_indices[0]], explicit_span, warnings
        return base_indices, explicit_span, warnings

    assert selector.kind == "index"
    if slab.mode == "single":
        return base_indices, explicit_span, warnings

    centered = _centered_window(
        center=base_indices[0],
        thickness=max(1, slab.thickness_vox),
        axis_size=axis_size,
    )
    return centered, explicit_span, warnings


def _centered_window(*, center: int, thickness: int, axis_size: int) -> list[int]:
    if thickness <= 1:
        return [_clamp_index(center, axis_size)]

    start = center - ((thickness - 1) // 2)
    end = start + thickness

    if start < 0:
        end += -start
        start = 0
    if end > axis_size:
        start -= end - axis_size
        end = axis_size
    if start < 0:
        start = 0

    if start >= end:
        return [_clamp_index(center, axis_size)]

    return list(range(start, end))


def _clamp_index(index: int, axis_size: int) -> int:
    if axis_size <= 1:
        return 0
    return max(0, min(int(index), axis_size - 1))


def _to_level_index(*, index: int, factor: float) -> int:
    if factor <= 0:
        return int(index)
    return int(round(float(index) / factor))


def _sample_channel_stack(
    *,
    stack: np.ndarray,
    center_u: float,
    center_v: float,
    zoom: float,
    pixel_ratio: float,
    f_u: float,
    f_v: float,
    output_width: int,
    output_height: int,
    interpolation: str,
) -> tuple[np.ndarray, np.ndarray]:
    sampled_channels: list[np.ndarray] = []
    sample_alpha: np.ndarray | None = None

    for channel_plane in stack:
        sampled, alpha = _sample_plane(
            plane=channel_plane,
            center_u=center_u,
            center_v=center_v,
            zoom=zoom,
            pixel_ratio=pixel_ratio,
            f_u=f_u,
            f_v=f_v,
            output_width=output_width,
            output_height=output_height,
            interpolation=interpolation,
        )
        sampled_channels.append(sampled)
        if sample_alpha is None:
            sample_alpha = alpha
        else:
            sample_alpha = np.maximum(sample_alpha, alpha)

    assert sample_alpha is not None
    return np.stack(sampled_channels, axis=0), sample_alpha


def _sample_plane(
    *,
    plane: np.ndarray,
    center_u: float,
    center_v: float,
    zoom: float,
    pixel_ratio: float,
    f_u: float,
    f_v: float,
    output_width: int,
    output_height: int,
    interpolation: str,
) -> tuple[np.ndarray, np.ndarray]:
    src_h, src_w = plane.shape

    zoom_safe = max(1e-6, zoom)
    pixel_ratio_safe = max(0.5, pixel_ratio)
    f_u_safe = max(1e-6, f_u)
    f_v_safe = max(1e-6, f_v)

    span_u = float(output_width) / (zoom_safe * pixel_ratio_safe * f_u_safe)
    span_v = float(output_height) / (zoom_safe * pixel_ratio_safe * f_v_safe)

    center_u_level = center_u / f_u_safe
    center_v_level = center_v / f_v_safe

    start_u = center_u_level - (span_u / 2.0)
    start_v = center_v_level - (span_v / 2.0)

    step_u = span_u / float(output_width)
    step_v = span_v / float(output_height)

    u_coords = start_u + (np.arange(output_width, dtype=np.float32) + 0.5) * step_u
    v_coords = start_v + (np.arange(output_height, dtype=np.float32) + 0.5) * step_v

    if interpolation == "nearest":
        u_idx = np.floor(u_coords).astype(np.int64)
        v_idx = np.floor(v_coords).astype(np.int64)

        valid_u = (u_idx >= 0) & (u_idx < src_w)
        valid_v = (v_idx >= 0) & (v_idx < src_h)
        valid = valid_v[:, None] & valid_u[None, :]

        u_clamped = np.clip(u_idx, 0, max(src_w - 1, 0))
        v_clamped = np.clip(v_idx, 0, max(src_h - 1, 0))

        sampled = plane[v_clamped[:, None], u_clamped[None, :]]
        sampled = np.where(valid, sampled, 0.0)
        alpha = valid.astype(np.float32)
        return sampled.astype(np.float32), alpha

    u0 = np.floor(u_coords).astype(np.int64)
    v0 = np.floor(v_coords).astype(np.int64)
    u1 = u0 + 1
    v1 = v0 + 1

    du = (u_coords - u0.astype(np.float32)).astype(np.float32)
    dv = (v_coords - v0.astype(np.float32)).astype(np.float32)

    valid_u = (u_coords >= 0.0) & (u_coords <= float(src_w - 1))
    valid_v = (v_coords >= 0.0) & (v_coords <= float(src_h - 1))
    valid = valid_v[:, None] & valid_u[None, :]

    u0c = np.clip(u0, 0, max(src_w - 1, 0))
    u1c = np.clip(u1, 0, max(src_w - 1, 0))
    v0c = np.clip(v0, 0, max(src_h - 1, 0))
    v1c = np.clip(v1, 0, max(src_h - 1, 0))

    s00 = plane[v0c[:, None], u0c[None, :]]
    s01 = plane[v0c[:, None], u1c[None, :]]
    s10 = plane[v1c[:, None], u0c[None, :]]
    s11 = plane[v1c[:, None], u1c[None, :]]

    w00 = (1.0 - dv)[:, None] * (1.0 - du)[None, :]
    w01 = (1.0 - dv)[:, None] * du[None, :]
    w10 = dv[:, None] * (1.0 - du)[None, :]
    w11 = dv[:, None] * du[None, :]

    sampled = (s00 * w00) + (s01 * w01) + (s10 * w10) + (s11 * w11)
    sampled = np.where(valid, sampled, 0.0)
    alpha = valid.astype(np.float32)
    return sampled.astype(np.float32), alpha


def _compose_layer(*, sampled_stack: np.ndarray, sample_alpha: np.ndarray, layer: LayerState) -> tuple[np.ndarray, np.ndarray]:
    layer_rgb = np.zeros((sample_alpha.shape[0], sample_alpha.shape[1], 3), dtype=np.float32)
    layer_alpha = np.zeros((sample_alpha.shape[0], sample_alpha.shape[1]), dtype=np.float32)

    if layer.image is None:
        return layer_rgb, layer_alpha

    settings_by_index = {setting.index: setting for setting in layer.image.channels if setting.enabled}
    if not settings_by_index:
        settings_by_index = {
            channel_index: _default_channel_setting(index=channel_index)
            for channel_index in range(sampled_stack.shape[0])
        }

    channel_mode = layer.image.channel_mode
    if channel_mode == "single":
        ordered_indices = sorted(settings_by_index.keys())
        selected = ordered_indices[:1]
        color_mode_override: dict[int, tuple[float, float, float, float]] = {}
    elif channel_mode == "rgb":
        ordered_indices = sorted(settings_by_index.keys())
        selected = ordered_indices[:3]
        rgb_colors = (
            (1.0, 0.0, 0.0, 1.0),
            (0.0, 1.0, 0.0, 1.0),
            (0.0, 0.0, 1.0, 1.0),
        )
        color_mode_override = {channel_index: rgb_colors[pos] for pos, channel_index in enumerate(selected)}
    else:
        selected = sorted(settings_by_index.keys())
        color_mode_override = {}

    for channel_index in selected:
        if channel_index < 0 or channel_index >= sampled_stack.shape[0]:
            continue

        setting = settings_by_index[channel_index]
        channel_data = sampled_stack[channel_index]
        normalized = _normalize_channel(channel_data=channel_data, setting=setting)

        if setting.gamma > 0:
            normalized = np.power(np.clip(normalized, 0.0, 1.0), 1.0 / float(setting.gamma))

        color = color_mode_override.get(channel_index, setting.color_rgba)
        if color is None:
            color = _DEFAULT_CHANNEL_COLORS[channel_index % len(_DEFAULT_CHANNEL_COLORS)]

        color_rgb = np.array(color[0:3], dtype=np.float32)
        color_alpha = float(color[3])

        strength = normalized * float(layer.opacity) * sample_alpha * color_alpha
        layer_rgb += strength[..., None] * color_rgb[None, None, :]
        layer_alpha += strength

    layer_rgb = np.clip(layer_rgb, 0.0, 1.0)
    layer_alpha = np.clip(layer_alpha, 0.0, 1.0)
    return layer_rgb, layer_alpha


def _normalize_channel(*, channel_data: np.ndarray, setting: Any) -> np.ndarray:
    contrast = setting.contrast
    if contrast is None:
        min_value = float(np.nanmin(channel_data))
        max_value = float(np.nanmax(channel_data))
    elif contrast.policy == "fixed":
        min_value = float(contrast.min) if contrast.min is not None else float(np.nanmin(channel_data))
        max_value = float(contrast.max) if contrast.max is not None else float(np.nanmax(channel_data))
    else:
        p_low = float(contrast.p_low)
        p_high = float(contrast.p_high)
        min_value = float(np.nanpercentile(channel_data, p_low))
        max_value = float(np.nanpercentile(channel_data, p_high))

    if not np.isfinite(min_value) or not np.isfinite(max_value) or max_value <= min_value:
        min_value = float(np.nanmin(channel_data))
        max_value = float(np.nanmax(channel_data))

    if not np.isfinite(min_value) or not np.isfinite(max_value) or max_value <= min_value:
        return np.zeros_like(channel_data, dtype=np.float32)

    normalized = (channel_data - min_value) / (max_value - min_value)
    return np.clip(normalized, 0.0, 1.0).astype(np.float32)


def _default_channel_setting(*, index: int) -> Any:
    class _Contrast:
        policy = "percentile"
        min = None
        max = None
        p_low = 1.0
        p_high = 99.0

    class _ChannelSetting:
        def __init__(self) -> None:
            self.index = index
            self.enabled = True
            self.color_rgba = None
            self.contrast = _Contrast()
            self.gamma = 1.0

    return _ChannelSetting()


def _resolve_background_rgba(view_state: ViewState) -> tuple[float, float, float, float]:
    if view_state.render_settings is None or view_state.render_settings.background_rgba is None:
        return (0.0, 0.0, 0.0, 1.0)
    background = view_state.render_settings.background_rgba
    return (
        float(background[0]),
        float(background[1]),
        float(background[2]),
        float(background[3]),
    )
