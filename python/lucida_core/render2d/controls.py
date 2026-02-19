"""2D pan/zoom control helpers with deterministic math."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite


MIN_ZOOM = 1e-4
MAX_ZOOM = 1e4
MIN_CAMERA_DEPTH = 1e-6


@dataclass(frozen=True)
class PanZoomState:
    center_x: float
    center_y: float
    zoom: float


def _as_float_triplet(value: object, *, key: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{key} must be a 3-item list")
    x, y, z = value
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not isinstance(z, (int, float)):
        raise ValueError(f"{key} entries must be numeric")
    out = (float(x), float(y), float(z))
    if not all(isfinite(v) for v in out):
        raise ValueError(f"{key} entries must be finite numbers")
    return out


def _clamp_zoom(value: float) -> float:
    if value < MIN_ZOOM:
        return MIN_ZOOM
    if value > MAX_ZOOM:
        return MAX_ZOOM
    return value


def panzoom_state_from_pose(pose: dict[str, object]) -> PanZoomState:
    """Map CameraPose to canonical 2D pan/zoom state."""
    target_x, target_y, target_z = _as_float_triplet(pose.get("target"), key="target")
    _ = _as_float_triplet(pose.get("up"), key="up")
    pos_x, pos_y, pos_z = _as_float_triplet(pose.get("position"), key="position")

    # Camera distance to target in canonical panzoom determines zoom.
    depth = max(pos_z - target_z, MIN_CAMERA_DEPTH)
    zoom = _clamp_zoom(1.0 / depth)
    center_x = float(target_x)
    center_y = float(target_y)

    # Position x/y are ignored, canonical center comes from target x/y.
    _ = pos_x
    _ = pos_y
    return PanZoomState(center_x=center_x, center_y=center_y, zoom=zoom)


def panzoom_state_to_pose(state: PanZoomState, *, target_z: float = 0.0) -> dict[str, object]:
    """Map canonical pan/zoom state back to CameraPose."""
    zoom = _clamp_zoom(float(state.zoom))
    depth = max(1.0 / zoom, MIN_CAMERA_DEPTH)
    center_x = float(state.center_x)
    center_y = float(state.center_y)
    z = float(target_z)
    return {
        "position": [center_x, center_y, z + depth],
        "target": [center_x, center_y, z],
        "up": [0.0, 1.0, 0.0],
        "fov_degrees": 45.0,
    }


def apply_cursor_anchored_zoom(
    state: PanZoomState,
    *,
    cursor_world_x: float,
    cursor_world_y: float,
    zoom_factor: float,
) -> PanZoomState:
    """Zoom around a world-space cursor anchor and keep that anchor stable."""
    if not isfinite(zoom_factor) or zoom_factor <= 0:
        raise ValueError("zoom_factor must be a finite positive number")

    old_zoom = _clamp_zoom(float(state.zoom))
    new_zoom = _clamp_zoom(old_zoom * zoom_factor)
    if new_zoom == old_zoom:
        return PanZoomState(center_x=state.center_x, center_y=state.center_y, zoom=old_zoom)

    ratio = old_zoom / new_zoom
    new_center_x = float(cursor_world_x) + (float(state.center_x) - float(cursor_world_x)) * ratio
    new_center_y = float(cursor_world_y) + (float(state.center_y) - float(cursor_world_y)) * ratio
    return PanZoomState(center_x=new_center_x, center_y=new_center_y, zoom=new_zoom)


def apply_pan_drag(state: PanZoomState, *, delta_screen_x: float, delta_screen_y: float) -> PanZoomState:
    """Translate pan center from drag deltas, scaled by current zoom."""
    zoom = _clamp_zoom(float(state.zoom))
    world_dx = float(delta_screen_x) / zoom
    world_dy = float(delta_screen_y) / zoom
    # Content should track the drag direction, so camera center moves opposite.
    return PanZoomState(
        center_x=float(state.center_x) - world_dx,
        center_y=float(state.center_y) - world_dy,
        zoom=zoom,
    )
