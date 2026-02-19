"""3D camera control helpers with deterministic canonicalization math."""

from __future__ import annotations

from dataclasses import dataclass
from math import cos, isfinite, sin, sqrt
from typing import TypeAlias


MIN_CAMERA_RADIUS = 1e-6
_DEFAULT_FOV_DEGREES = 45.0


Vec3: TypeAlias = tuple[float, float, float]


@dataclass(frozen=True)
class Pose3D:
    position: Vec3
    target: Vec3
    up: Vec3
    fov_degrees: float | None = None


def _dot(left: Vec3, right: Vec3) -> float:
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]


def _cross(left: Vec3, right: Vec3) -> Vec3:
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def _norm(vec: Vec3) -> float:
    return sqrt(_dot(vec, vec))


def _scale(vec: Vec3, scalar: float) -> Vec3:
    return (vec[0] * scalar, vec[1] * scalar, vec[2] * scalar)


def _add(left: Vec3, right: Vec3) -> Vec3:
    return (left[0] + right[0], left[1] + right[1], left[2] + right[2])


def _sub(left: Vec3, right: Vec3) -> Vec3:
    return (left[0] - right[0], left[1] - right[1], left[2] - right[2])


def _normalize(vec: Vec3, *, fallback: Vec3) -> Vec3:
    length = _norm(vec)
    if length < MIN_CAMERA_RADIUS:
        return fallback
    inv = 1.0 / length
    return (vec[0] * inv, vec[1] * inv, vec[2] * inv)


def _as_float_triplet(value: object, *, key: str) -> Vec3:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{key} must be a 3-item list")
    x, y, z = value
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not isinstance(z, (int, float)):
        raise ValueError(f"{key} entries must be numeric")
    out = (float(x), float(y), float(z))
    if not all(isfinite(v) for v in out):
        raise ValueError(f"{key} entries must be finite numbers")
    return out


def _canonical_fov(value: object, *, strict: bool) -> float | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or not isfinite(float(value)):
        if strict:
            raise ValueError("fov_degrees must be a finite number")
        return _DEFAULT_FOV_DEGREES
    return float(value)


def _pose_from_dict(pose: dict[str, object], *, strict: bool) -> Pose3D:
    position = _as_float_triplet(pose.get("position"), key="position")
    target = _as_float_triplet(pose.get("target"), key="target")
    up = _as_float_triplet(pose.get("up"), key="up")
    fov_degrees = _canonical_fov(pose.get("fov_degrees"), strict=strict)
    return Pose3D(position=position, target=target, up=up, fov_degrees=fov_degrees)


def _pose_to_dict(pose: Pose3D) -> dict[str, object]:
    out: dict[str, object] = {
        "position": [pose.position[0], pose.position[1], pose.position[2]],
        "target": [pose.target[0], pose.target[1], pose.target[2]],
        "up": [pose.up[0], pose.up[1], pose.up[2]],
    }
    if pose.fov_degrees is not None:
        out["fov_degrees"] = pose.fov_degrees
    return out


def _default_pose() -> Pose3D:
    return Pose3D(
        position=(0.0, 0.0, 1.0),
        target=(0.0, 0.0, 0.0),
        up=(0.0, 1.0, 0.0),
        fov_degrees=_DEFAULT_FOV_DEGREES,
    )


def _rotate_vector(vec: Vec3, *, axis: Vec3, radians: float) -> Vec3:
    if abs(radians) < 1e-12:
        return vec
    axis_norm = _normalize(axis, fallback=(0.0, 1.0, 0.0))
    cos_theta = cos(radians)
    sin_theta = sin(radians)
    term_one = _scale(vec, cos_theta)
    term_two = _scale(_cross(axis_norm, vec), sin_theta)
    term_three = _scale(axis_norm, _dot(axis_norm, vec) * (1.0 - cos_theta))
    return _add(_add(term_one, term_two), term_three)


def canonicalize_camera_pose_3d(
    pose: dict[str, object],
    *,
    mode: str,
    strict: bool,
) -> dict[str, object]:
    """Canonicalize arcball/freefly camera pose to finite vectors and normalized up."""

    try:
        parsed = _pose_from_dict(pose, strict=strict)
    except ValueError:
        if strict:
            raise
        parsed = _default_pose()

    position = parsed.position
    target = parsed.target
    up = _normalize(parsed.up, fallback=(0.0, 1.0, 0.0))

    if mode == "arcball":
        offset = _sub(position, target)
        radius = max(_norm(offset), MIN_CAMERA_RADIUS)
        direction = _normalize(offset, fallback=(0.0, 0.0, 1.0))
        position = _add(target, _scale(direction, radius))
    elif mode == "freefly":
        forward = _sub(target, position)
        if _norm(forward) < MIN_CAMERA_RADIUS:
            target = _add(position, (0.0, 0.0, -1.0))
    else:
        raise ValueError(f"unsupported 3D camera mode: {mode}")

    return _pose_to_dict(Pose3D(position=position, target=target, up=up, fov_degrees=parsed.fov_degrees))


def camera_zoom_scalar_from_pose(pose: dict[str, object]) -> float:
    """Derive a scalar zoom surrogate from camera distance to target."""

    try:
        parsed = _pose_from_dict(pose, strict=False)
    except ValueError:
        return 1.0
    distance = max(_norm(_sub(parsed.position, parsed.target)), MIN_CAMERA_RADIUS)
    return 1.0 / distance


def apply_arcball_orbit(
    pose: dict[str, object],
    *,
    delta_yaw: float,
    delta_pitch: float,
    delta_roll: float = 0.0,
) -> dict[str, object]:
    """Apply deterministic arcball orbit around target while preserving radius."""

    canonical = _pose_from_dict(canonicalize_camera_pose_3d(pose, mode="arcball", strict=True), strict=True)
    target = canonical.target
    radius = max(_norm(_sub(canonical.position, canonical.target)), MIN_CAMERA_RADIUS)
    forward = _normalize(_sub(canonical.target, canonical.position), fallback=(0.0, 0.0, -1.0))
    up = _normalize(canonical.up, fallback=(0.0, 1.0, 0.0))

    right = _normalize(_cross(forward, up), fallback=(1.0, 0.0, 0.0))
    forward = _normalize(_rotate_vector(forward, axis=up, radians=float(delta_yaw)), fallback=forward)
    right = _normalize(_cross(forward, up), fallback=right)

    forward = _normalize(_rotate_vector(forward, axis=right, radians=float(delta_pitch)), fallback=forward)
    up = _normalize(_rotate_vector(up, axis=right, radians=float(delta_pitch)), fallback=up)

    if abs(float(delta_roll)) > 1e-12:
        up = _normalize(_rotate_vector(up, axis=forward, radians=float(delta_roll)), fallback=up)

    position = _sub(target, _scale(forward, radius))
    out = Pose3D(position=position, target=target, up=up, fov_degrees=canonical.fov_degrees)
    return canonicalize_camera_pose_3d(_pose_to_dict(out), mode="arcball", strict=True)


def apply_freefly_motion(
    pose: dict[str, object],
    *,
    move_forward: float = 0.0,
    move_right: float = 0.0,
    move_up: float = 0.0,
    delta_yaw: float = 0.0,
    delta_pitch: float = 0.0,
    delta_roll: float = 0.0,
) -> dict[str, object]:
    """Apply deterministic freefly orientation and local-axis movement."""

    canonical = _pose_from_dict(canonicalize_camera_pose_3d(pose, mode="freefly", strict=True), strict=True)

    position = canonical.position
    target = canonical.target
    up = _normalize(canonical.up, fallback=(0.0, 1.0, 0.0))

    forward = _normalize(_sub(target, position), fallback=(0.0, 0.0, -1.0))
    right = _normalize(_cross(forward, up), fallback=(1.0, 0.0, 0.0))

    if abs(float(delta_yaw)) > 1e-12:
        forward = _normalize(_rotate_vector(forward, axis=up, radians=float(delta_yaw)), fallback=forward)
        right = _normalize(_rotate_vector(right, axis=up, radians=float(delta_yaw)), fallback=right)

    if abs(float(delta_pitch)) > 1e-12:
        forward = _normalize(_rotate_vector(forward, axis=right, radians=float(delta_pitch)), fallback=forward)
        up = _normalize(_rotate_vector(up, axis=right, radians=float(delta_pitch)), fallback=up)

    if abs(float(delta_roll)) > 1e-12:
        right = _normalize(_rotate_vector(right, axis=forward, radians=float(delta_roll)), fallback=right)
        up = _normalize(_rotate_vector(up, axis=forward, radians=float(delta_roll)), fallback=up)

    right = _normalize(_cross(forward, up), fallback=right)
    up = _normalize(_cross(right, forward), fallback=up)

    look_distance = max(_norm(_sub(target, position)), MIN_CAMERA_RADIUS)
    translation = _add(
        _add(
            _scale(forward, float(move_forward)),
            _scale(right, float(move_right)),
        ),
        _scale(up, float(move_up)),
    )
    position = _add(position, translation)
    target = _add(position, _scale(forward, look_distance))

    out = Pose3D(position=position, target=target, up=up, fov_degrees=canonical.fov_degrees)
    return canonicalize_camera_pose_3d(_pose_to_dict(out), mode="freefly", strict=True)
