"""2D image rendering for Step 11 gateway tile streaming."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from lucida_core.errors import invalid_params, not_found, unsupported
from lucida_core.io.backends import IOBackendError, MissingDependencyError, _open_zarr_group, detect_backend
import numpy as np
from PIL import Image

from .tiles import EncodedTile, encode_changed_tiles


@dataclass
class RemoteRenderState:
    last_plan_seq: int | None = None
    tile_hashes: dict[tuple[int, int, int, int], str] = field(default_factory=dict)


class FrameRenderer2D:
    """Render one attached session/view into encoded changed tiles."""

    def __init__(
        self,
        *,
        daemon: Any,
        tile_size_px: int,
        jpeg_quality: int,
    ) -> None:
        self._daemon = daemon
        self._tile_size_px = tile_size_px
        self._jpeg_quality = jpeg_quality

    def render_tiles(
        self,
        *,
        session_id: str,
        view_id: str,
        state: RemoteRenderState,
        lossless: bool = False,
    ) -> tuple[int, list[EncodedTile]]:
        snapshot = self._daemon.snapshot()
        session = self._session_snapshot(snapshot=snapshot, session_id=session_id)

        frame_plans = session.get("frame_plans")
        if not isinstance(frame_plans, dict):
            raise not_found("Session frame plans are unavailable", {"session_id": session_id})
        plan = frame_plans.get(view_id)
        if not isinstance(plan, dict):
            raise not_found(
                "Frame plan does not exist for view",
                {"session_id": session_id, "view_id": view_id},
            )
        plan_seq = int(plan.get("plan_seq", 0))
        if state.last_plan_seq is not None and plan_seq == state.last_plan_seq:
            return plan_seq, []

        image = self._render_composited_image(session=session, view_id=view_id, plan=plan)
        changed = encode_changed_tiles(
            image=image,
            previous_hashes=state.tile_hashes,
            tile_size_px=self._tile_size_px,
            jpeg_quality=self._jpeg_quality,
            lossless=lossless,
        )
        state.last_plan_seq = plan_seq
        return plan_seq, changed

    def _session_snapshot(self, *, snapshot: dict[str, Any], session_id: str) -> dict[str, Any]:
        sessions = snapshot.get("sessions")
        if not isinstance(sessions, list):
            raise invalid_params("Runtime snapshot has invalid sessions payload", {})
        for session in sessions:
            if isinstance(session, dict) and session.get("session_id") == session_id:
                return session
        raise not_found("Session does not exist", {"session_id": session_id})

    def _render_composited_image(
        self,
        *,
        session: dict[str, Any],
        view_id: str,
        plan: dict[str, Any],
    ) -> Image.Image:
        views = session.get("views")
        if not isinstance(views, dict):
            raise invalid_params("Session views payload is invalid", {})
        view = views.get(view_id)
        if not isinstance(view, dict):
            raise not_found("View does not exist", {"view_id": view_id})

        layer_ids = view.get("bound_layer_ids")
        if not isinstance(layer_ids, list):
            raise invalid_params("View bound_layer_ids payload is invalid", {"view_id": view_id})

        layers = session.get("layers")
        datasets = session.get("datasets")
        if not isinstance(layers, dict) or not isinstance(datasets, dict):
            raise invalid_params("Session layer/dataset payload is invalid", {})

        composed: np.ndarray | None = None
        for layer_id in layer_ids:
            layer = layers.get(layer_id)
            if not isinstance(layer, dict):
                continue
            if layer.get("layer_type") != "image":
                continue
            if not bool(layer.get("visible", True)):
                continue

            dataset_id = layer.get("dataset_id")
            if not isinstance(dataset_id, str):
                continue
            dataset = datasets.get(dataset_id)
            if not isinstance(dataset, dict):
                continue

            plane = self._render_layer_plane(
                dataset=dataset,
                layer=layer,
                view=view,
                plan=plan,
            )
            alpha = float(layer.get("opacity", 1.0))
            alpha = min(1.0, max(0.0, alpha))

            if composed is None:
                composed = np.zeros((plane.shape[0], plane.shape[1], 3), dtype=np.float32)
            if composed.shape[0] != plane.shape[0] or composed.shape[1] != plane.shape[1]:
                raise invalid_params(
                    "Composited layers must share the same rendered dimensions",
                    {
                        "view_id": view_id,
                        "expected": [int(composed.shape[0]), int(composed.shape[1])],
                        "got": [int(plane.shape[0]), int(plane.shape[1])],
                    },
                )

            rgb = np.repeat(plane[:, :, None], 3, axis=2).astype(np.float32)
            composed = rgb * alpha + composed * (1.0 - alpha)

        if composed is None:
            composed = np.zeros((256, 256, 3), dtype=np.float32)

        clipped = np.clip(composed, 0.0, 255.0).astype(np.uint8)
        return Image.fromarray(clipped, mode="RGB")

    def _render_layer_plane(
        self,
        *,
        dataset: dict[str, Any],
        layer: dict[str, Any],
        view: dict[str, Any],
        plan: dict[str, Any],
    ) -> np.ndarray:
        backend = dataset.get("backend")
        if not isinstance(backend, str):
            raise invalid_params("Dataset backend payload is invalid", {"dataset": dataset})

        display_axes = plan.get("display_axes")
        slice_axes = plan.get("slice_axes")
        selected_level = plan.get("selected_level")
        if (
            not isinstance(display_axes, list)
            or len(display_axes) != 2
            or not all(isinstance(axis, str) for axis in display_axes)
            or not isinstance(slice_axes, dict)
            or not isinstance(selected_level, int)
        ):
            raise invalid_params("Frame plan payload is invalid for rendering", {"plan": plan})

        channel_index = self._resolve_channel_index(layer=layer, view=view, dataset=dataset)

        if backend == "synthetic":
            return self._render_synthetic_plane(
                dataset=dataset,
                display_axes=[str(display_axes[0]), str(display_axes[1])],
                slice_axes={str(k): int(v) for k, v in slice_axes.items() if isinstance(k, str)},
                selected_level=selected_level,
                channel_index=channel_index,
            )

        uri = dataset.get("uri")
        if not isinstance(uri, str):
            raise invalid_params("Dataset uri payload is invalid", {"dataset": dataset})

        try:
            group = self._cached_open_group(uri)
            plane = self._render_zarr_plane(
                group=group,
                dataset=dataset,
                display_axes=[str(display_axes[0]), str(display_axes[1])],
                slice_axes={str(k): int(v) for k, v in slice_axes.items() if isinstance(k, str)},
                selected_level=selected_level,
                channel_index=channel_index,
            )
            return self._normalize_to_uint8(plane)
        except MissingDependencyError as exc:
            raise unsupported(
                "Dataset backend dependency is not installed",
                {"backend": backend, "uri": uri, "error": str(exc)},
            ) from exc
        except IOBackendError as exc:
            raise unsupported(
                "Dataset backend is unsupported for remote rendering",
                {"backend": backend, "uri": uri, "error": str(exc)},
            ) from exc

    @lru_cache(maxsize=32)
    def _cached_open_group(self, uri: str):
        backend = detect_backend(uri)
        return _open_zarr_group(uri, backend)

    def _render_synthetic_plane(
        self,
        *,
        dataset: dict[str, Any],
        display_axes: list[str],
        slice_axes: dict[str, int],
        selected_level: int,
        channel_index: int,
    ) -> np.ndarray:
        axes, shape = self._level_axes_and_shape(dataset=dataset, selected_level=selected_level)
        axis_to_size = {axis: int(size) for axis, size in zip(axes, shape, strict=False)}
        axis_y = display_axes[0]
        axis_x = display_axes[1]
        height = max(1, int(axis_to_size.get(axis_y, 256)))
        width = max(1, int(axis_to_size.get(axis_x, 256)))

        yy, xx = np.mgrid[0:height, 0:width]
        seed = 0
        for axis, value in sorted(slice_axes.items()):
            seed += (len(axis) * 37) + int(value)
        seed += int(channel_index) * 97
        seed += int(selected_level) * 131

        plane = ((xx * 3 + yy * 5 + seed) % 65535).astype(np.float32)
        return self._normalize_to_uint8(plane)

    def _render_zarr_plane(
        self,
        *,
        group: Any,
        dataset: dict[str, Any],
        display_axes: list[str],
        slice_axes: dict[str, int],
        selected_level: int,
        channel_index: int,
    ) -> np.ndarray:
        axes, _shape = self._level_axes_and_shape(dataset=dataset, selected_level=selected_level)
        level_path = self._level_path(dataset=dataset, selected_level=selected_level)
        array = group[level_path]

        # Align axis labels to the selected zarr array rank.
        rank = int(len(array.shape))
        axis_labels = list(axes)
        if len(axis_labels) != rank:
            fallback = dataset.get("axis_labels")
            if isinstance(fallback, list) and len(fallback) == rank and all(isinstance(v, str) for v in fallback):
                axis_labels = [str(v) for v in fallback]
            else:
                axis_labels = [f"axis_{idx}" for idx in range(rank)]

        index: list[object] = []
        output_axes: list[str] = []
        for dim, axis in enumerate(axis_labels):
            size = int(array.shape[dim])
            if axis in display_axes:
                index.append(slice(None))
                output_axes.append(axis)
                continue
            if axis == "c":
                index.append(self._clamp_index(channel_index, size=size))
                continue
            idx = int(slice_axes.get(axis, 0))
            index.append(self._clamp_index(idx, size=size))

        data = np.asarray(array[tuple(index)])

        if data.ndim == 0:
            data = np.full((1, 1), float(data), dtype=np.float32)
        elif data.ndim == 1:
            data = np.expand_dims(data, axis=0)
        elif data.ndim > 2:
            # Remaining higher dims are unexpected for 2D display; keep first plane deterministically.
            while data.ndim > 2:
                data = data[0]

        if len(output_axes) == 2 and output_axes != display_axes:
            try:
                perm = [output_axes.index(display_axes[0]), output_axes.index(display_axes[1])]
                data = np.transpose(data, axes=perm)
            except ValueError:
                pass

        return data

    def _level_path(self, *, dataset: dict[str, Any], selected_level: int) -> str:
        multiscales = dataset.get("multiscales")
        if isinstance(multiscales, list) and multiscales and isinstance(multiscales[0], dict):
            levels = multiscales[0].get("levels")
            if isinstance(levels, list) and levels:
                idx = max(0, min(selected_level, len(levels) - 1))
                level = levels[idx]
                if isinstance(level, dict):
                    path = level.get("path")
                    if isinstance(path, str) and path:
                        return path
        return "0"

    def _level_axes_and_shape(self, *, dataset: dict[str, Any], selected_level: int) -> tuple[list[str], list[int]]:
        multiscales = dataset.get("multiscales")
        if isinstance(multiscales, list) and multiscales and isinstance(multiscales[0], dict):
            summary = multiscales[0]
            axes = summary.get("axes")
            levels = summary.get("levels")
            if (
                isinstance(axes, list)
                and all(isinstance(axis, str) for axis in axes)
                and isinstance(levels, list)
                and levels
            ):
                idx = max(0, min(selected_level, len(levels) - 1))
                level = levels[idx]
                if isinstance(level, dict):
                    shape = level.get("shape")
                    if isinstance(shape, list) and all(isinstance(dim, int) and dim > 0 for dim in shape):
                        return ([str(axis) for axis in axes], [int(dim) for dim in shape])

        axes_fallback = dataset.get("axis_labels")
        shape_fallback = dataset.get("shape")
        if (
            isinstance(axes_fallback, list)
            and all(isinstance(axis, str) for axis in axes_fallback)
            and isinstance(shape_fallback, list)
            and all(isinstance(dim, int) and dim > 0 for dim in shape_fallback)
        ):
            return ([str(axis) for axis in axes_fallback], [int(dim) for dim in shape_fallback])
        raise invalid_params("Dataset axis/shape payload is invalid", {"dataset": dataset})

    def _resolve_channel_index(self, *, layer: dict[str, Any], view: dict[str, Any], dataset: dict[str, Any]) -> int:
        layer_channel = layer.get("channel")
        if isinstance(layer_channel, int) and layer_channel >= 0:
            return layer_channel

        channel_order = view.get("channel_order")
        if isinstance(channel_order, list):
            for item in channel_order:
                if isinstance(item, int) and item >= 0:
                    return item

        axes, shape = self._level_axes_and_shape(dataset=dataset, selected_level=0)
        if "c" in axes:
            c_idx = axes.index("c")
            if c_idx < len(shape) and shape[c_idx] > 0:
                return 0
        return 0

    def _normalize_to_uint8(self, plane: np.ndarray) -> np.ndarray:
        values = np.asarray(plane)
        if values.dtype == np.uint8:
            return values
        values = values.astype(np.float32)
        if values.size == 0:
            return np.zeros((1, 1), dtype=np.uint8)

        finite_mask = np.isfinite(values)
        if not finite_mask.all():
            values = np.where(finite_mask, values, 0.0)

        min_value = float(values.min())
        max_value = float(values.max())
        if max_value <= min_value:
            return np.zeros(values.shape, dtype=np.uint8)

        scaled = (values - min_value) / (max_value - min_value)
        return np.clip(scaled * 255.0, 0.0, 255.0).astype(np.uint8)

    def _clamp_index(self, value: int, *, size: int) -> int:
        if size <= 0:
            return 0
        if value < 0:
            return 0
        if value >= size:
            return size - 1
        return value


__all__ = ["FrameRenderer2D", "RemoteRenderState"]
