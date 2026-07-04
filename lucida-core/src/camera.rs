use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::framing::{Aabb, arcball_containment, slice_framing};
use crate::mat4::{
    cross3, invert4_f32, invert4_f64, look_at, mul4, normalize3, perspective, transform_point,
    unproject,
};
use crate::transform::VolumeTransform;

/// Fit factors for "fit the data to the view", re-exported from [`crate::framing`]
/// so callers can reach them as `camera::FIT_*` while there is one definition:
///
/// - [`FIT_PADDING`] (`1.8`): the **minimap's** overview inset only.
/// - [`FIT_MARGIN_2D`] (`1.15`): the **main 2D** fit — data fills ~87% of the
///   limiting axis.
/// - [`FIT_MARGIN_3D`] (`1.10`): the **main 3D** fit — 10% slack around the
///   data's bounding sphere.
pub use crate::framing::{FIT_MARGIN_2D, FIT_MARGIN_3D, FIT_PADDING};

/// Axis-aligned bounding box in voxel space, plus effective zoom for LOD selection.
/// This is what chunk planning needs — not a camera.
#[derive(Debug, Clone, Serialize)]
pub struct VisibleRegion {
    /// [min_x, min_y, max_x, max_y] in voxel coordinates.
    pub xy_bounds: [f64; 4],
    /// Voxel z range.
    #[serde(serialize_with = "serialize_range_as_array")]
    pub z_range: Range<u32>,
    /// For LOD selection: screen pixels per world unit at the focal plane.
    pub effective_zoom: f64,
    /// Radius basis in voxels for view-relative render-radius controls.
    ///
    /// Slice mode uses the visible view half-diagonal. 3D mode uses the
    /// focal-plane viewport half-diagonal; the full frustum AABB can be
    /// enormous because it includes the far plane.
    pub radius_basis_vox: f64,
    /// Optional sort center in voxel coordinates [x, y, z] for center-out chunk loading.
    /// When `Some`, chunks are sorted by distance to this point instead of the grid midpoint.
    pub sort_center: Option<[f64; 3]>,
    /// Optional frustum planes in full-resolution voxel coordinates for per-chunk culling.
    /// Each plane is [a, b, c, d] where ax + by + cz + d >= 0 means inside.
    pub frustum_planes: Option<[[f64; 4]; 6]>,
}

fn serialize_range_as_array<S: serde::Serializer>(
    range: &Range<u32>,
    s: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeTuple;
    let mut tup = s.serialize_tuple(2)?;
    tup.serialize_element(&range.start)?;
    tup.serialize_element(&range.end)?;
    tup.end()
}

fn visible_radius_basis_from_bounds(bounds: [f64; 4], z_range: &Range<u32>) -> f64 {
    let half_x = ((bounds[2] - bounds[0]) / 2.0).max(0.0);
    let half_y = ((bounds[3] - bounds[1]) / 2.0).max(0.0);
    let half_z = ((z_range.end.saturating_sub(z_range.start)) as f64 / 2.0).max(0.0);
    (half_x * half_x + half_y * half_y + half_z * half_z)
        .sqrt()
        .max(1.0)
}

fn focal_plane_radius_basis(viewport: [u32; 2], zoom_per_voxel: f64) -> f64 {
    let zoom = zoom_per_voxel.abs().max(1e-12);
    let half_x = viewport[0] as f64 / (2.0 * zoom);
    let half_y = viewport[1] as f64 / (2.0 * zoom);
    (half_x * half_x + half_y * half_y).sqrt().max(1.0)
}

/// Clip mode for near-clip distance: plane (perpendicular to view direction)
/// or sphere (radial distance from camera position).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum ClipMode {
    #[default]
    Plane,
    Sphere,
}

/// Unified camera: 2D slice viewing, 3D arcball, or free-fly.
///
/// `PartialEq` (not `Eq` — the variants hold `f64`) so a type that embeds a
/// camera (e.g. [`crate::saved_view::SavedView`] captured on a
/// [`crate::scene::Annotation`]) can itself derive `PartialEq`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum Camera {
    #[serde(rename = "slice")]
    Slice(Slice),
    #[serde(rename = "arcball")]
    Arcball(Arcball),
    #[serde(rename = "fly")]
    Fly(Fly),
}

/// 2D pan/zoom camera for slice viewing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Slice {
    /// Center of the viewport in world coordinates.
    pub center: [f64; 2],
    /// Zoom level. 1.0 = native resolution, 2.0 = 2x magnification.
    pub zoom: f64,
    /// Viewport size in screen pixels.
    pub viewport: [u32; 2],
}

/// 3D arcball camera for volume rendering.
/// Uses spherical coordinates (theta, phi, distance) around a target point.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Arcball {
    pub target: [f64; 3],
    pub theta: f64,
    pub phi: f64,
    pub distance: f64,
    pub fov: f64,
    pub viewport: [u32; 2],
    pub near: f64,
    pub far: f64,
    /// Near clip distance: samples closer than this to the camera are transparent.
    #[serde(default)]
    pub clip_distance: f64,
    /// Whether clipping uses a plane or sphere.
    #[serde(default)]
    pub clip_mode: ClipMode,
}

/// Free-fly camera with position + quaternion orientation.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Fly {
    pub position: [f64; 3],
    /// Quaternion (x, y, z, w) where w is the scalar part.
    pub orientation: [f64; 4],
    pub fov: f64,
    pub viewport: [u32; 2],
    pub near: f64,
    pub far: f64,
    pub speed_multiplier: f64,
    /// Base movement speed in world units per second.
    /// Typically set to `volume_diagonal * 0.3` so navigation feels natural
    /// regardless of dataset size.
    #[serde(default = "default_base_speed")]
    pub base_speed: f64,
    /// Near clip distance: samples closer than this to the camera are transparent.
    #[serde(default)]
    pub clip_distance: f64,
    /// Whether clipping uses a plane or sphere.
    #[serde(default)]
    pub clip_mode: ClipMode,
}

fn default_base_speed() -> f64 {
    1.0
}

impl std::fmt::Debug for Fly {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Fly")
            .field("position", &self.position)
            .field("orientation", &self.orientation)
            .finish()
    }
}

impl std::fmt::Debug for Arcball {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Arcball")
            .field("target", &self.target)
            .field("theta", &self.theta)
            .field("phi", &self.phi)
            .field("distance", &self.distance)
            .finish()
    }
}

impl Camera {
    pub fn new_2d(viewport: [u32; 2]) -> Self {
        Camera::Slice(Slice::new(viewport))
    }

    pub fn new_3d(viewport: [u32; 2]) -> Self {
        Camera::Arcball(Arcball::new(viewport))
    }

    pub fn viewport(&self) -> [u32; 2] {
        match self {
            Camera::Slice(v) => v.viewport,
            Camera::Arcball(v) => v.viewport,
            Camera::Fly(v) => v.viewport,
        }
    }

    pub fn set_viewport(&mut self, w: u32, h: u32) {
        match self {
            Camera::Slice(v) => v.viewport = [w, h],
            Camera::Arcball(v) => v.viewport = [w, h],
            Camera::Fly(v) => v.viewport = [w, h],
        }
    }

    /// Clamp an externally sourced camera (a peer's presence, a saved view)
    /// into the same ranges the interactive mutators enforce, and repair
    /// non-finite or degenerate fields, so an import can never install state
    /// the local mutation paths could not produce — e.g. a `Slice` with
    /// `zoom: 0.0` (finite, serializes fine) would otherwise turn the next
    /// `pan` into a `0/0 = NaN` center, and NaN state defeats epoch change
    /// detection permanently (NaN is self-unequal, so every subsequent camera
    /// command reads as a change).
    ///
    /// Idempotent, and bit-preserving for any camera already in range: values
    /// inside the clamp bounds pass through untouched (no renormalization),
    /// so an unchanged presence re-import still compares equal and stays
    /// epoch-silent.
    pub fn sanitize(&mut self) {
        fn finite_or(v: &mut f64, fallback: f64) {
            if !v.is_finite() {
                *v = fallback;
            }
        }
        // Positional components get the same bound the pan/tick mutators
        // enforce via `step_position`.
        fn position_or(v: &mut f64, fallback: f64) {
            *v = if v.is_finite() {
                v.clamp(-CAMERA_POSITION_MAX, CAMERA_POSITION_MAX)
            } else {
                fallback
            };
        }
        match self {
            Camera::Slice(v) => {
                position_or(&mut v.center[0], 0.0);
                position_or(&mut v.center[1], 0.0);
                v.zoom = if v.zoom.is_finite() {
                    v.zoom.clamp(SLICE_ZOOM_MIN, SLICE_ZOOM_MAX)
                } else {
                    1.0
                };
            }
            Camera::Arcball(v) => {
                for c in &mut v.target {
                    position_or(c, 0.5);
                }
                finite_or(&mut v.theta, 0.5);
                finite_or(&mut v.phi, 0.8);
                v.theta = wrap_angle(v.theta);
                v.phi = wrap_angle(v.phi);
                sanitize_projection(&mut v.fov, &mut v.near, &mut v.far);
                // The non-finite fallback goes through the same max/min as a
                // finite value: `sanitize_projection` has already bounded
                // `near`, so the result always satisfies
                // `near <= distance <= ARCBALL_DISTANCE_MAX` and a second
                // sanitize pass is a no-op (idempotence).
                let distance = if v.distance.is_finite() {
                    v.distance
                } else {
                    1.8
                };
                v.distance = distance.max(v.near).min(ARCBALL_DISTANCE_MAX);
                v.clip_distance = if v.clip_distance.is_finite() {
                    v.clip_distance.clamp(0.0, CLIP_DISTANCE_MAX)
                } else {
                    0.0
                };
            }
            Camera::Fly(v) => {
                for c in &mut v.position {
                    position_or(c, 0.5);
                }
                // Repair only a clearly broken quaternion (non-finite or
                // near-zero norm — `quat_rotate_vector` with it degenerates
                // the camera axes toward zero, collapsing the view basis;
                // `quat_normalize` itself returns identity below its own
                // cutoff, so this repairs earlier, at norm² < 1e-12, rather
                // than waiting for that). A merely non-unit quaternion is
                // left alone: renormalizing would perturb the last bit of a
                // legitimate unit quaternion and make unchanged re-imports
                // compare unequal.
                let norm_sq: f64 = v.orientation.iter().map(|c| c * c).sum();
                if !norm_sq.is_finite() || norm_sq < 1e-12 {
                    v.orientation = [0.0, 0.0, 0.0, 1.0];
                }
                sanitize_projection(&mut v.fov, &mut v.near, &mut v.far);
                v.speed_multiplier = if v.speed_multiplier.is_finite() {
                    v.speed_multiplier
                        .clamp(FLY_SPEED_MULTIPLIER_MIN, FLY_SPEED_MULTIPLIER_MAX)
                } else {
                    1.0
                };
                v.base_speed = if v.base_speed.is_finite() {
                    v.base_speed.clamp(FLY_BASE_SPEED_MIN, FLY_BASE_SPEED_MAX)
                } else {
                    1.0
                };
                v.clip_distance = if v.clip_distance.is_finite() {
                    v.clip_distance.clamp(0.0, CLIP_DISTANCE_MAX)
                } else {
                    0.0
                };
            }
        }
    }

    pub fn effective_zoom(&self) -> f64 {
        match self {
            Camera::Slice(v) => v.zoom,
            Camera::Arcball(v) => v.effective_zoom(),
            Camera::Fly(v) => v.effective_zoom(),
        }
    }

    /// Returns the camera position in world space.
    pub fn eye_position(&self) -> [f64; 3] {
        match self {
            Camera::Slice(v) => [v.center[0], v.center[1], 0.0],
            Camera::Arcball(v) => v.eye_position(),
            Camera::Fly(v) => v.eye_position(),
        }
    }

    /// GPU view matrices for an off-screen volume render at `viewport`:
    /// `(inv_view_proj, eye, view_proj)` in the exact layout the volume
    /// renderer's uniform buffer wants (the same triple
    /// [`crate::scene::Scene::minimap_camera`] packs).
    ///
    /// The `viewport` argument overrides the camera's own viewport so a
    /// caller can render a small thumbnail of a view whose stored camera was
    /// sized for the full canvas — the aspect ratio comes from `viewport`,
    /// not from `self`.
    ///
    /// 3D modes ([`Camera::Arcball`]/[`Camera::Fly`]) project their actual
    /// orbit/fly view, so a rotated/elevated child camera renders the volume
    /// from that angle. A 2D [`Camera::Slice`] has no perspective view of a
    /// volume, so this synthesizes a front-on arcball that frames the unit
    /// `[0,1]^3` cube — mirroring how the minimap always shows the volume even
    /// while the main view is a 2D slice. This is the thumbnail analogue of
    /// `minimap_camera`; the scene-level framing (target/distance from the
    /// member boxes) is applied by the caller's transient descriptor model
    /// matrix, exactly as in the minimap path.
    pub fn gpu_view_matrices(&self, viewport: [u32; 2]) -> ([f32; 16], [f32; 3], [f32; 16]) {
        let (vp_f64, eye) = match self {
            Camera::Arcball(a) => {
                let mut a = a.clone();
                a.viewport = viewport;
                (a.view_proj_f64(), a.eye_position())
            }
            Camera::Fly(f) => {
                let mut f = f.clone();
                f.viewport = viewport;
                (f.view_proj_f64(), f.eye_position())
            }
            // A 2D slice can't render a perspective volume; frame the unit cube
            // head-on so the thumbnail shows the same overview the minimap does.
            Camera::Slice(_) => {
                let a = Arcball {
                    target: [0.5, 0.5, 0.5],
                    theta: 0.0,
                    phi: std::f64::consts::FRAC_PI_2,
                    distance: 1.8,
                    fov: std::f64::consts::FRAC_PI_4,
                    viewport,
                    near: 0.01,
                    far: 100.0,
                    clip_distance: 0.0,
                    clip_mode: ClipMode::default(),
                };
                (a.view_proj_f64(), a.eye_position())
            }
        };
        let inv = invert4_f32(vp_f64);
        let mut view_proj = [0.0f32; 16];
        for i in 0..16 {
            view_proj[i] = vp_f64[i] as f32;
        }
        let eye_f32 = [eye[0] as f32, eye[1] as f32, eye[2] as f32];
        (inv, eye_f32, view_proj)
    }

    /// Projects a world-space point to screen-space pixel coordinates.
    /// Returns `None` if the point is behind the camera (3D modes only).
    pub fn project_to_screen(&self, world_point: [f64; 3]) -> Option<[f64; 2]> {
        match self {
            Camera::Slice(v) => {
                let sx = (world_point[0] - v.center[0]) * v.zoom + v.viewport[0] as f64 / 2.0;
                let sy = (world_point[1] - v.center[1]) * v.zoom + v.viewport[1] as f64 / 2.0;
                Some([sx, sy])
            }
            Camera::Arcball(v) => project_3d(world_point, &v.view_proj_f64(), v.viewport),
            Camera::Fly(v) => project_3d(world_point, &v.view_proj_f64(), v.viewport),
        }
    }

    /// Unproject screen coordinates to a world-space ray.
    pub fn unproject_ray(&self, screen_x: f64, screen_y: f64) -> crate::ray::Ray {
        match self {
            Camera::Slice(s) => {
                let world_x = (screen_x - s.viewport[0] as f64 / 2.0) / s.zoom + s.center[0];
                let world_y = (screen_y - s.viewport[1] as f64 / 2.0) / s.zoom + s.center[1];
                crate::ray::Ray::new([world_x, world_y, -1000.0], [0.0, 0.0, 1.0])
            }
            Camera::Arcball(a) => {
                unproject_screen_ray(screen_x, screen_y, a.viewport, &a.view_proj_f64())
            }
            Camera::Fly(f) => {
                unproject_screen_ray(screen_x, screen_y, f.viewport, &f.view_proj_f64())
            }
        }
    }

    /// Compute the visible region in voxel coordinates for chunk planning.
    ///
    /// - `view_z_range`: z range from ViewState (used in 2D mode)
    /// - `volume_transform`: maps voxel [0,1]^3 to world space (used in 3D mode)
    /// - `volume_shape`: [Z, Y, X] voxel dimensions (used in 3D mode)
    pub fn visible_region(
        &self,
        view_z_range: &Range<u32>,
        volume_transform: Option<&VolumeTransform>,
        volume_shape: Option<&[u32; 3]>,
    ) -> VisibleRegion {
        match self {
            Camera::Slice(v) => {
                let bounds = v.world_bounds();
                VisibleRegion {
                    xy_bounds: bounds,
                    z_range: view_z_range.clone(),
                    effective_zoom: v.zoom,
                    radius_basis_vox: visible_radius_basis_from_bounds(bounds, view_z_range),
                    sort_center: None,
                    frustum_planes: None,
                }
            }
            Camera::Arcball(v) => v.frustum_visible_region(volume_transform, volume_shape),
            Camera::Fly(v) => v.frustum_visible_region(volume_transform, volume_shape),
        }
    }

    /// Frame the world-space box `[min, max]` so the **whole** dataset lands
    /// centered and fully in view.
    ///
    /// Dispatches on the current variant and **preserves the mode** — a 2D
    /// `Slice` stays 2D ([`FIT_MARGIN_2D`]), a 3D `Arcball` stays 3D
    /// ([`FIT_MARGIN_3D`], true bounding-sphere containment plus a depth-clip
    /// range that contains the box); this never flips between them. The 2D path
    /// uses only the XY extent of the box. The `Fly` camera keeps its
    /// orientation and is repositioned to look at the box from a containing
    /// distance (best-effort; the contract pins 2D/3D).
    ///
    /// This is a complete framing decision: the caller need not patch
    /// `near`/`far` afterward.
    pub fn fit_to_bounds(&mut self, min: [f64; 3], max: [f64; 3]) {
        match self {
            Camera::Slice(s) => {
                s.fit_to_bounds([min[0], min[1]], [max[0], max[1]], FIT_MARGIN_2D);
            }
            Camera::Arcball(a) => a.fit_to_bounds(min, max, FIT_MARGIN_3D),
            Camera::Fly(f) => f.fit_to_bounds(min, max, FIT_MARGIN_3D),
        }
    }
}

// --- Interactive-range clamps ---
//
// Every camera mutator clamps its writes into these ranges so that FINITE
// inputs — of ANY magnitude — can only ever produce FINITE state. This is
// load-bearing for epoch change detection: `Scene::apply` diffs camera state
// before/after each command, and a non-finite value minted by camera math is
// self-unequal once a NaN lands (NaN != NaN), so every later camera-scope
// command (including the per-render-tick viewport re-assert) would read as
// "changed" and force a full replan per frame, permanently; a stored NaN
// also serializes to JSON `null`, which breaks every peer's presence parse.
// Every kind of accumulator gets its own guard, closing every way camera
// math can go non-finite:
//
// - multiplicative state (`Slice::zoom`, `Arcball::distance`) saturates at a
//   floor/ceiling, so repeated scaling can neither underflow to exactly 0.0
//   (poisoning later divides) nor overflow to Inf;
// - additive accumulators (`clip_distance`) saturate at
//   `[0, CLIP_DISTANCE_MAX]` on every nudge, so repeated huge deltas cannot
//   stack to Inf, and a huge negative delta always comes back down to 0;
// - positional state (`Slice::center`, `Arcball::target`, `Fly::position`)
//   accumulates through [`step_position`], which saturates an overflowing
//   step at the bound and drops a NaN step (an `Inf − Inf` cancellation from
//   an extreme finite input) instead of storing it; absolute positional
//   writes (set-center, center-on-voxel, the fit targets) clamp to the same
//   bound;
// - orbit angles accumulate through [`wrap_angle`]: a bit-identical
//   pass-through across the whole interactive range, wrapping by 2π (which
//   is trig-periodic — the identical camera) only past a huge guard, so
//   repeated huge deltas cannot reach ±Inf, where `sin(Inf) = NaN` would
//   poison `eye_position` every frame.
//
// The bounds are far beyond any dataset scale (world space is normalized;
// slice space is voxels; slice zoom is screen pixels per world unit) yet far
// inside f64 range, so the multiplies/divides downstream of a clamped value
// stay finite by construction.

/// Floor for [`Slice::zoom`]. Keeps `Slice::pan`'s divide-by-zoom finite.
pub const SLICE_ZOOM_MIN: f64 = 1e-9;
/// Ceiling for [`Slice::zoom`].
pub const SLICE_ZOOM_MAX: f64 = 1e9;
/// Ceiling for [`Arcball::distance`]; the floor is the camera's own `near`
/// (mirroring [`Arcball::zoom`]'s `.max(near)`). Without a ceiling, repeated
/// zoom-out multiplies `distance` to Inf, and `Arcball::pan` with a zero
/// delta then computes `0 × Inf = NaN` into `target`.
pub const ARCBALL_DISTANCE_MAX: f64 = 1e9;
/// Component-wise bound for positional camera state (slice `center`, arcball
/// `target`, fly `position`). Generous for any real world coordinate (slice
/// space is voxels; the largest images are ~1e9 voxels across) while keeping
/// sums and products with the other clamped ranges finite.
pub const CAMERA_POSITION_MAX: f64 = 1e12;
/// Ceiling for `clip_distance` (arcball and fly). Clipping farther away than
/// the maximum orbit distance is meaningless, and the accumulate-per-nudge
/// entry point needs a ceiling so repeated huge deltas saturate instead of
/// stacking to Inf. The floor is 0 (no clip).
pub const CLIP_DISTANCE_MAX: f64 = 1e9;
/// Bounds for [`Fly::base_speed`] (world units per second). Bounded so the
/// per-tick displacement (`base_speed × speed_multiplier × dt`) can never
/// overflow position to Inf in a realistic number of ticks.
pub const FLY_BASE_SPEED_MIN: f64 = 1e-9;
/// Upper bound for [`Fly::base_speed`]. See [`FLY_BASE_SPEED_MIN`].
pub const FLY_BASE_SPEED_MAX: f64 = 1e9;
/// Bounds for [`Fly::speed_multiplier`] (the scroll-wheel speed scale on top
/// of `base_speed`). Every write — the multiplicative `FlyAdjustSpeed`
/// accumulate and the [`Camera::sanitize`] import repair — clamps into this
/// range, so repeated scroll steps can neither collapse the multiplier
/// toward 0 nor stack it toward Inf.
pub const FLY_SPEED_MULTIPLIER_MIN: f64 = 0.01;
/// Upper bound for [`Fly::speed_multiplier`]. See [`FLY_SPEED_MULTIPLIER_MIN`].
pub const FLY_SPEED_MULTIPLIER_MAX: f64 = 100.0;
/// Guard for accumulated orbit angles (`theta`/`phi`). Inside this range
/// [`wrap_angle`] is a bit-identical pass-through — ~159,000 full turns, far
/// past any real session, so ordinary rotation state (including large
/// accumulated over-the-pole values) is untouched. Past it, the angle wraps
/// by 2π, which describes the identical camera.
pub const ANGLE_WRAP_LIMIT: f64 = 1e6;

/// Accumulate an orbit angle without ever reaching ±Inf. Values inside
/// [`ANGLE_WRAP_LIMIT`] pass through bit-identical; beyond it the value
/// wraps by 2π (`sin`/`cos` are 2π-periodic, so the camera is unchanged).
/// Because stored angles are always inside the guard, adding any finite
/// delta stays finite (|state| + f64::MAX rounds to f64::MAX, never Inf).
fn wrap_angle(v: f64) -> f64 {
    if v.abs() <= ANGLE_WRAP_LIMIT {
        v
    } else {
        v % std::f64::consts::TAU
    }
}

/// Advance one positional component by `step`, keeping the result inside
/// `±CAMERA_POSITION_MAX`.
///
/// Saturates at the bound when the sum overflows to `±Inf`, and leaves the
/// component **unchanged** when the sum is NaN — an `Inf − Inf` cancellation
/// between overflowing terms carries no usable direction, and storing the
/// NaN would defeat epoch change detection permanently.
fn step_position(current: f64, step: f64) -> f64 {
    let next = current + step;
    if next.is_finite() {
        next.clamp(-CAMERA_POSITION_MAX, CAMERA_POSITION_MAX)
    } else if next == f64::INFINITY {
        CAMERA_POSITION_MAX
    } else if next == f64::NEG_INFINITY {
        -CAMERA_POSITION_MAX
    } else {
        current
    }
}

/// Repair a perspective triple to a renderable state: `fov` strictly inside
/// `(0, π)`; `near` positive and no larger than [`ARCBALL_DISTANCE_MAX`] (so
/// a distance clamped to the ceiling can still satisfy `distance >= near`);
/// `far > near`. Values already in range pass through bit-identical (this
/// must be idempotent — see [`Camera::sanitize`]).
fn sanitize_projection(fov: &mut f64, near: &mut f64, far: &mut f64) {
    if !fov.is_finite() || *fov <= 1e-3 || *fov >= std::f64::consts::PI - 1e-3 {
        *fov = std::f64::consts::FRAC_PI_4;
    }
    if !near.is_finite() || *near <= 0.0 || *near > ARCBALL_DISTANCE_MAX {
        *near = 0.01;
    }
    if !far.is_finite() || *far <= *near {
        *far = *near * 1e4;
    }
}

// --- Slice implementation ---

impl Slice {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            center: [0.0, 0.0],
            zoom: 1.0,
            viewport,
        }
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        // The divide is never by zero (every write to `zoom` clamps to
        // `SLICE_ZOOM_MIN..=SLICE_ZOOM_MAX`), and `step_position` bounds the
        // accumulated center — a huge finite delta at the zoom floor saturates
        // at ±CAMERA_POSITION_MAX instead of storing Inf. Center stays finite
        // for every finite input.
        self.center[0] = step_position(self.center[0], dx / self.zoom);
        self.center[1] = step_position(self.center[1], dy / self.zoom);
    }

    pub fn zoom_by(&mut self, factor: f64) {
        // Saturates at the range ends: a zero/tiny factor lands on the floor
        // instead of underflowing to 0.0 (which would poison `pan`'s divide),
        // and repeated zoom-in lands on the ceiling instead of Inf.
        self.zoom = (self.zoom * factor).clamp(SLICE_ZOOM_MIN, SLICE_ZOOM_MAX);
    }

    /// Set the zoom directly, clamped into the interactive range. Zero,
    /// negative, and out-of-range values saturate — `zoom` must stay a
    /// positive finite divisor for [`Self::pan`].
    pub fn set_zoom(&mut self, value: f64) {
        self.zoom = value.clamp(SLICE_ZOOM_MIN, SLICE_ZOOM_MAX);
    }

    /// Set the center directly, each component clamped to the same
    /// `±CAMERA_POSITION_MAX` bound the pan path enforces — an absolute
    /// write must not be able to install a coordinate the accumulating
    /// writes could never reach.
    pub fn set_center(&mut self, x: f64, y: f64) {
        self.center = [
            x.clamp(-CAMERA_POSITION_MAX, CAMERA_POSITION_MAX),
            y.clamp(-CAMERA_POSITION_MAX, CAMERA_POSITION_MAX),
        ];
    }

    /// The visible region in world coordinates: (min_x, min_y, max_x, max_y).
    pub fn world_bounds(&self) -> [f64; 4] {
        let half_w = (self.viewport[0] as f64) / (2.0 * self.zoom);
        let half_h = (self.viewport[1] as f64) / (2.0 * self.zoom);
        [
            self.center[0] - half_w,
            self.center[1] - half_h,
            self.center[0] + half_w,
            self.center[1] + half_h,
        ]
    }

    /// Center on the world rect `[min, max]` and zoom so it is fully visible,
    /// centered, and tight with `margin` slack in the limiting axis.
    ///
    /// With this camera's convention (`world_bounds` = `center ± viewport /
    /// (2·zoom)`), `zoom` is the largest value that still fits `margin × data`
    /// in **both** axes, so every corner of the rect projects inside the
    /// viewport and `world_bounds()` contains the rect. Inverted input
    /// (`min > max`) is normalized per-axis and non-finite input is sanitized; a
    /// degenerate axis (single plane / line) is floored so `zoom` stays finite
    /// and positive — the camera then fits the non-degenerate axis. The shared
    /// math lives in [`crate::framing::slice_framing`].
    pub fn fit_to_bounds(&mut self, min: [f64; 2], max: [f64; 2], margin: f64) {
        let (center, zoom) = slice_framing(min, max, self.viewport, margin);
        // Positional write: same component bound as the pan path.
        self.set_center(center[0], center[1]);
        // `slice_framing` already guarantees a finite positive zoom; the clamp
        // keeps "zoom is always in the interactive range" a single invariant
        // with no exceptions.
        self.zoom = zoom.clamp(SLICE_ZOOM_MIN, SLICE_ZOOM_MAX);
    }
}

// --- Arcball implementation ---

impl Arcball {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            target: [0.5, 0.5, 0.5],
            theta: 0.5,
            phi: 0.8,
            distance: 1.8,
            fov: std::f64::consts::FRAC_PI_4,
            viewport,
            near: 0.01,
            far: 100.0,
            clip_distance: 0.0,
            clip_mode: ClipMode::default(),
        }
    }

    /// Frame the world-space box `[min, max]` so the **whole** box is in view at
    /// the current orbit angle, with `margin` slack — true containment, not a
    /// rough framing.
    ///
    /// Sets `target = midpoint`, then sits back along the view ray by
    /// `distance = (R / sin(limiting)) · margin`, where `R` is the box's
    /// bounding-sphere radius (half the space diagonal — so containment holds at
    /// *any* `theta`/`phi`) and `limiting = min(fov/2, atan(tan(fov/2)·aspect))`
    /// is the narrower frustum half-angle (so the sphere fits both viewport
    /// axes). Also sets `near`/`far` to bracket the box
    /// (`near = max(distance − R, distance·1e-3, 1e-4)`,
    /// `far = (distance + R)·1.05`, `0 < near < far`) so a large or offset
    /// dataset is not clipped to a blank viewport. `theta`/`phi`/`fov` are left
    /// untouched.
    ///
    /// Inverted (`min > max`) and non-finite inputs are normalized/sanitized so
    /// `target`, `distance`, `near`, and `far` stay finite with `distance > 0`
    /// and `0 < near < far`. The shared math lives in
    /// [`crate::framing::arcball_containment`].
    pub fn fit_to_bounds(&mut self, min: [f64; 3], max: [f64; 3], margin: f64) {
        let (target, distance, near, far) =
            arcball_containment(min, max, self.viewport, self.fov, margin);
        // Positional write: same component bound as the pan path.
        for (dst, src) in self.target.iter_mut().zip(target) {
            *dst = src.clamp(-CAMERA_POSITION_MAX, CAMERA_POSITION_MAX);
        }
        // Same ceiling as [`Self::zoom`] — every distance write clamps. When
        // the cap engages (absurdly large finite bounds), rebuild the
        // near/far bracket around the capped distance; containment's bracket
        // was derived from the uncapped one and could exceed it.
        self.distance = distance.min(ARCBALL_DISTANCE_MAX);
        if self.distance < distance {
            self.near = (self.distance * 1e-3).max(1e-4);
            self.far = self.distance * 2.0;
        } else {
            self.near = near;
            self.far = far;
        }
    }

    /// Camera forward direction (normalized), pointing from eye toward target.
    pub fn forward_direction(&self) -> [f64; 3] {
        let eye = self.eye_position();
        normalize3([
            self.target[0] - eye[0],
            self.target[1] - eye[1],
            self.target[2] - eye[2],
        ])
    }

    pub fn rotate(&mut self, d_theta: f64, d_phi: f64) {
        // Unconstrained across the whole interactive range (phi is NOT
        // clamped to a hemisphere — rotating over the pole accumulates
        // freely); `wrap_angle` only steps in past its huge guard so the
        // angles can never accumulate to ±Inf.
        self.theta = wrap_angle(self.theta + d_theta);
        self.phi = wrap_angle(self.phi + d_phi);
    }

    pub fn zoom(&mut self, delta: f64) {
        // Floor at `near` (a zoom-in can't pass through the target plane) and
        // ceiling at the interactive range end so repeated zoom-out saturates
        // instead of multiplying `distance` to Inf — `pan` scales by
        // `distance`, and `0 × Inf` would put NaN into `target`.
        self.distance = (self.distance * (1.0 + delta))
            .max(self.near)
            .min(ARCBALL_DISTANCE_MAX);
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        let eye = self.eye_position();
        let forward = normalize3([
            self.target[0] - eye[0],
            self.target[1] - eye[1],
            self.target[2] - eye[2],
        ]);
        let right = normalize3(cross3(forward, self.up_vector()));
        let up = cross3(right, forward);
        let scale = self.distance * 0.002;
        // `step_position` keeps `target` inside ±CAMERA_POSITION_MAX: a huge
        // finite delta saturates instead of storing Inf, and an Inf − Inf
        // cancellation between the two terms is dropped instead of storing
        // NaN. Without the bound, an Inf target would make the NEXT pan's
        // `normalize3(target − eye)` all-NaN and poison every component.
        for i in 0..3 {
            self.target[i] = step_position(self.target[i], (right[i] * -dx + up[i] * dy) * scale);
        }
    }

    pub fn eye_position(&self) -> [f64; 3] {
        let sin_phi = self.phi.sin();
        [
            self.target[0] + self.distance * sin_phi * self.theta.sin(),
            self.target[1] + self.distance * self.phi.cos(),
            self.target[2] + self.distance * sin_phi * self.theta.cos(),
        ]
    }

    /// Up vector derived from spherical coordinates (tangent along phi meridian).
    /// Always perpendicular to the view direction at any phi value.
    pub fn up_vector(&self) -> [f64; 3] {
        [
            -self.phi.cos() * self.theta.sin(),
            self.phi.sin(),
            -self.phi.cos() * self.theta.cos(),
        ]
    }

    /// Compute where the center-screen ray hits the unit [0,1]^3 volume box.
    /// Returns the intersection point in unit space, or the closest point on the
    /// box to the view ray if the ray misses (so distance calculations remain
    /// aligned with where the user is looking).
    pub fn ray_hit_local(&self, inv_model: &[f64; 16]) -> [f64; 3] {
        let eye_unit = transform_point(self.eye_position(), inv_model);
        let target_unit = transform_point(self.target, inv_model);
        let dir = [
            target_unit[0] - eye_unit[0],
            target_unit[1] - eye_unit[1],
            target_unit[2] - eye_unit[2],
        ];
        ray_aabb_hit(eye_unit, dir, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]).unwrap_or_else(|| {
            closest_point_on_aabb_to_ray(eye_unit, dir, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
        })
    }

    /// Effective zoom: screen pixels per world unit at the target plane.
    pub fn effective_zoom(&self) -> f64 {
        self.viewport[1] as f64 / (2.0 * self.distance * (self.fov / 2.0).tan())
    }

    /// Inverse view-projection matrix as f32 for the GPU.
    pub fn inv_view_proj(&self) -> [f32; 16] {
        let vp = self.view_proj_f64();
        invert4_f32(vp)
    }

    /// View-projection matrix as f32 for the GPU.
    pub fn view_proj(&self) -> [f32; 16] {
        let vp = self.view_proj_f64();
        let mut out = [0.0f32; 16];
        for i in 0..16 {
            out[i] = vp[i] as f32;
        }
        out
    }

    /// View-projection matrix in f64.
    pub(crate) fn view_proj_f64(&self) -> [f64; 16] {
        let aspect = self.viewport[0] as f64 / self.viewport[1] as f64;
        let proj = perspective(self.fov, aspect, self.near, self.far);
        let eye = self.eye_position();
        let view = look_at(eye, self.target, self.up_vector());
        mul4(proj, view)
    }

    /// Compute the visible region in voxel coordinates by unprojecting the frustum.
    fn frustum_visible_region(
        &self,
        volume_transform: Option<&VolumeTransform>,
        volume_shape: Option<&[u32; 3]>,
    ) -> VisibleRegion {
        let shape = volume_shape.copied().unwrap_or([1, 1, 1]);
        // shape is [Z, Y, X]
        let shape_x = shape[2] as f64;
        let shape_y = shape[1] as f64;
        let shape_z = shape[0] as f64;

        let inv_vp = invert4_f64(self.view_proj_f64());

        let inv_model: [f64; 16] = match volume_transform {
            Some(t) => t.inv_model.map(|v| v as f64),
            None => [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        };

        // Unproject 8 NDC corners → world → inv_model → voxel directly (single AABB step).
        // This avoids the double-AABB expansion that occurs when computing an intermediate
        // world-space AABB then transforming its corners to voxel space.
        let ndc_corners: [[f64; 3]; 8] = [
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [-1.0, 1.0, 1.0],
            [1.0, 1.0, 1.0],
        ];

        let mut voxel_min = [f64::MAX; 3];
        let mut voxel_max = [f64::MIN; 3];

        for corner in &ndc_corners {
            let world = unproject(corner, &inv_vp);
            let unit = transform_point(world, &inv_model);
            // unit is in [0,1]^3; scale to voxel coords
            let vx = unit[0] * shape_x;
            let vy = (1.0 - unit[1]) * shape_y;
            let vz = unit[2] * shape_z;
            voxel_min[0] = voxel_min[0].min(vx);
            voxel_min[1] = voxel_min[1].min(vy);
            voxel_min[2] = voxel_min[2].min(vz);
            voxel_max[0] = voxel_max[0].max(vx);
            voxel_max[1] = voxel_max[1].max(vy);
            voxel_max[2] = voxel_max[2].max(vz);
        }

        // Clamp Z to volume bounds (members don't have Z offsets).
        // XY bounds are NOT clamped to [0, shape] — for plates, the camera
        // may be looking at a well at a large XY offset. The per-member AABB
        // test in chunk_plan_for handles member-level visibility, and the
        // chunk grid iteration in visible_chunks clamps to valid grid indices.
        voxel_min[2] = voxel_min[2].max(0.0);
        voxel_max[2] = voxel_max[2].min(shape_z);

        let z_start = voxel_min[2].floor().max(0.0) as u32;
        let z_end = voxel_max[2].ceil().max(0.0) as u32;

        // Extract frustum planes in full-resolution voxel space using Gribb-Hartmann method.
        // Build voxel-to-clip matrix: view_proj * model * Scale(1/shape_x, 1/shape_y, 1/shape_z)
        let model_f64: [f64; 16] = match volume_transform {
            Some(t) => t.model.map(|v| v as f64),
            None => [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        };
        let vp_model = mul4(self.view_proj_f64(), model_f64);
        // Scale columns to convert from image-convention voxel coords to unit [0,1]^3,
        // with Y flipped (image row 0 = top = unit Y 1.0).
        let mut m = vp_model;
        for i in 0..4 {
            let c1 = m[4 + i]; // save col 1 before modification
            m[i] /= shape_x; // col 0 (X voxels)
            m[4 + i] /= -shape_y; // col 1 (Y voxels, negated for flip)
            m[8 + i] /= shape_z; // col 2 (Z voxels)
            m[12 + i] += c1; // col 3 (translation from Y flip)
        }

        // Extract 6 frustum planes from column-major MVP matrix.
        // Plane [a, b, c, d] where a*vx + b*vy + c*vz + d >= 0 means inside.
        let frustum_planes = [
            // Left:   row3 + row0
            [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
            // Right:  row3 - row0
            [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
            // Bottom: row3 + row1
            [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
            // Top:    row3 - row1
            [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
            // Near:   row3 + row2
            [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
            // Far:    row3 - row2
            [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
        ];

        // Convert effective_zoom from pixels-per-world-unit to pixels-per-voxel.
        // The model matrix scales each axis: model[0]=sx, model[5]=sy, model[10]=sz.
        // Voxels per world unit in each axis = shape[i] / model_scale[i].
        // Use the max to get the most conservative (coarsest) LOD selection.
        let (sx, sy, sz) = match volume_transform {
            Some(t) => (t.model[0] as f64, t.model[5] as f64, t.model[10] as f64),
            None => (1.0, 1.0, 1.0),
        };
        let vpw_x = shape_x / sx.abs().max(1e-12);
        let vpw_y = shape_y / sy.abs().max(1e-12);
        let vpw_z = shape_z / sz.abs().max(1e-12);
        let max_vpw = vpw_x.max(vpw_y).max(vpw_z);

        // Cast a ray from the eye toward the target to find where it hits the
        // volume surface. Use distance to this hit point (not self.distance to
        // the orbit target) for LOD — the surface is what we're resolving.
        let hit_unit = self.ray_hit_local(&inv_model);
        let hit_world = transform_point(hit_unit, &model_f64);
        let eye = self.eye_position();
        let dx = hit_world[0] - eye[0];
        let dy = hit_world[1] - eye[1];
        let dz = hit_world[2] - eye[2];
        let dist_to_surface = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6);

        // pixels-per-world-unit at the surface, then convert to pixels-per-voxel
        let base_zoom = self.viewport[1] as f64 / (2.0 * (self.fov / 2.0).tan());
        let zoom_per_voxel = (base_zoom / dist_to_surface) / max_vpw;

        let sort_center = Some([
            hit_unit[0] * shape_x,
            (1.0 - hit_unit[1]) * shape_y,
            hit_unit[2] * shape_z,
        ]);

        VisibleRegion {
            xy_bounds: [voxel_min[0], voxel_min[1], voxel_max[0], voxel_max[1]],
            z_range: z_start..z_end.max(z_start),
            effective_zoom: zoom_per_voxel,
            radius_basis_vox: focal_plane_radius_basis(self.viewport, zoom_per_voxel),
            sort_center,
            frustum_planes: Some(frustum_planes),
        }
    }
}

// --- Quaternion math ---

/// Hamilton product of two quaternions (x, y, z, w).
pub(crate) fn quat_multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [ax, ay, az, aw] = a;
    let [bx, by, bz, bw] = b;
    [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
}

/// Create a quaternion from an axis-angle rotation.
pub(crate) fn quat_from_axis_angle(axis: [f64; 3], angle: f64) -> [f64; 4] {
    let half = angle / 2.0;
    let s = half.sin();
    [axis[0] * s, axis[1] * s, axis[2] * s, half.cos()]
}

/// Normalize a quaternion to unit length. Degenerate input — near-zero or
/// non-finite length (NaN included: the `is_finite` check runs first, since
/// `NaN < x` is false and would slip past the near-zero test alone) —
/// returns the identity quaternion instead of dividing a NaN/Inf through.
pub(crate) fn quat_normalize(q: [f64; 4]) -> [f64; 4] {
    let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if !len.is_finite() || len < 1e-12 {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [q[0] / len, q[1] / len, q[2] / len, q[3] / len]
}

/// Rotate a vector by a quaternion: q * v * q^-1
pub(crate) fn quat_rotate_vector(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [qx, qy, qz, qw] = q;
    // Optimized rotation: v' = v + 2*qw*(q_xyz x v) + 2*(q_xyz x (q_xyz x v))
    let cx = qy * v[2] - qz * v[1];
    let cy = qz * v[0] - qx * v[2];
    let cz = qx * v[1] - qy * v[0];
    [
        v[0] + 2.0 * (qw * cx + qy * cz - qz * cy),
        v[1] + 2.0 * (qw * cy + qz * cx - qx * cz),
        v[2] + 2.0 * (qw * cz + qx * cy - qy * cx),
    ]
}

/// Convert a quaternion (x, y, z, w) to a 3x3 rotation matrix (row-major).
#[allow(dead_code)]
pub(crate) fn quat_to_rotation_matrix(q: [f64; 4]) -> [[f64; 3]; 3] {
    let [x, y, z, w] = q;
    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;
    [
        [1.0 - (yy + zz), xy - wz, xz + wy],
        [xy + wz, 1.0 - (xx + zz), yz - wx],
        [xz - wy, yz + wx, 1.0 - (xx + yy)],
    ]
}

// --- Fly camera implementation ---

impl Fly {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            position: [0.5, 0.5, 0.5],
            orientation: [0.0, 0.0, 0.0, 1.0], // identity quaternion
            fov: std::f64::consts::FRAC_PI_4,
            viewport,
            near: 0.01,
            far: 100.0,
            speed_multiplier: 1.0,
            base_speed: 1.0,
            clip_distance: 0.0,
            clip_mode: ClipMode::default(),
        }
    }

    /// Frame the world-space box `[min, max]` best-effort: keep the current
    /// orientation and pull `position` back along the view direction so the box
    /// center sits ahead at a *containing* distance, with `near`/`far` bracketing
    /// the box. Uses the same containment math as the arcball
    /// ([`crate::framing::arcball_containment`]) so a large/offset dataset isn't
    /// clipped. `base_speed` is refreshed to the documented `volume_diagonal ·
    /// 0.3` so navigation stays scaled to the data.
    ///
    /// The 2D/3D fit contract is pinned by `Slice`/`Arcball`; this keeps the fly
    /// camera coherent (and finite) when a fit lands in fly mode — it never
    /// panics, and normalizes/sanitizes inverted or non-finite input.
    pub fn fit_to_bounds(&mut self, min: [f64; 3], max: [f64; 3], margin: f64) {
        let (center, distance, near, far) =
            arcball_containment(min, max, self.viewport, self.fov, margin);
        // Same distance ceiling as the arcball fit; positional writes go
        // through the shared component bound. When the cap engages, rebuild
        // the near/far bracket around the capped distance (containment's
        // bracket was derived from the uncapped one).
        let capped = distance.min(ARCBALL_DISTANCE_MAX);
        let forward = self.forward_vector();
        // Place the eye `distance` behind the box center along the look ray, so
        // the center is straight ahead.
        for i in 0..3 {
            self.position[i] =
                (center[i] - forward[i] * capped).clamp(-CAMERA_POSITION_MAX, CAMERA_POSITION_MAX);
        }
        if capped < distance {
            self.near = (capped * 1e-3).max(1e-4);
            self.far = capped * 2.0;
        } else {
            self.near = near;
            self.far = far;
        }
        // Diagonal from sanitized bounds so an inverted/non-finite box still
        // yields a finite, positive base speed — clamped like every other
        // base-speed write.
        let diagonal = 2.0 * Aabb::sanitized(min, max).bounding_radius();
        self.base_speed = (diagonal * 0.3).clamp(1e-6, FLY_BASE_SPEED_MAX);
    }

    /// Advance the fly camera by one tick.
    ///
    /// `dt`: seconds since last tick (clamped to 0.1)
    /// `forward/right/up`: movement input (-1, 0, or 1)
    /// `yaw/pitch/roll`: rotation input (radians per second)
    // Args mirror raw input axes (3 translation + 3 rotation + dt); bundling
    // them into a struct would just rename the noise.
    #[allow(clippy::too_many_arguments)]
    pub fn fly_tick(
        &mut self,
        dt: f64,
        forward: f64,
        right: f64,
        up: f64,
        yaw: f64,
        pitch: f64,
        roll: f64,
    ) {
        // Clamp both ends: the ceiling bounds a hitchy frame, the zero floor
        // rejects a negative dt (a raw caller's bad clock delta), which would
        // otherwise integrate a huge finite displacement toward ±Inf.
        let dt = dt.clamp(0.0, 0.1);

        // Apply rotation: build axis-angle quaternions for each rotation axis
        // yaw = rotation around camera's local Y axis
        // pitch = rotation around camera's local X axis
        // roll = rotation around camera's local -Z axis (forward)
        //
        // Rotation rates need no clamp for state finiteness: sin/cos are
        // bounded for any finite argument and the product is renormalized, so
        // orientation stays a finite unit quaternion — an extreme rate merely
        // lands at an arbitrary angle.
        if yaw.abs() > 1e-12 || pitch.abs() > 1e-12 || roll.abs() > 1e-12 {
            let q_yaw = quat_from_axis_angle([0.0, 1.0, 0.0], yaw * dt);
            let q_pitch = quat_from_axis_angle([1.0, 0.0, 0.0], pitch * dt);
            let q_roll = quat_from_axis_angle([0.0, 0.0, -1.0], roll * dt);
            // Apply in order: yaw, then pitch, then roll (local-space rotations)
            // For local rotations: new_orientation = orientation * local_rotation
            let local_rot = quat_multiply(quat_multiply(q_yaw, q_pitch), q_roll);
            self.orientation = quat_normalize(quat_multiply(self.orientation, local_rot));
        }

        // Apply translation using camera's local axes. The axes are unit
        // inputs by contract (-1, 0, or 1); clamping enforces it so a raw
        // caller passing a huge finite axis can't teleport the camera —
        // per-tick displacement stays bounded by `base_speed × multiplier ×
        // dt`, and `step_position` bounds the accumulated position.
        let forward = forward.clamp(-1.0, 1.0);
        let right = right.clamp(-1.0, 1.0);
        let up = up.clamp(-1.0, 1.0);
        if forward.abs() > 1e-12 || right.abs() > 1e-12 || up.abs() > 1e-12 {
            let forward_vec = quat_rotate_vector(self.orientation, [0.0, 0.0, -1.0]);
            let right_vec = quat_rotate_vector(self.orientation, [1.0, 0.0, 0.0]);
            let up_vec = quat_rotate_vector(self.orientation, [0.0, 1.0, 0.0]);
            let speed = self.base_speed * self.speed_multiplier * dt;
            for i in 0..3 {
                self.position[i] = step_position(
                    self.position[i],
                    (forward_vec[i] * forward + right_vec[i] * right + up_vec[i] * up) * speed,
                );
            }
        }
    }

    pub fn eye_position(&self) -> [f64; 3] {
        self.position
    }

    pub fn up_vector(&self) -> [f64; 3] {
        quat_rotate_vector(self.orientation, [0.0, 1.0, 0.0])
    }

    /// Forward direction (negative Z in camera space).
    pub fn forward_vector(&self) -> [f64; 3] {
        quat_rotate_vector(self.orientation, [0.0, 0.0, -1.0])
    }

    /// Camera forward direction (normalized), pointing from eye toward target.
    pub fn forward_direction(&self) -> [f64; 3] {
        self.forward_vector()
    }

    /// Target point for look-at-style computations.
    fn target(&self) -> [f64; 3] {
        let fwd = self.forward_vector();
        [
            self.position[0] + fwd[0],
            self.position[1] + fwd[1],
            self.position[2] + fwd[2],
        ]
    }

    /// Effective zoom: screen pixels per world unit at distance=1.
    pub fn effective_zoom(&self) -> f64 {
        self.viewport[1] as f64 / (2.0 * (self.fov / 2.0).tan())
    }

    /// View-projection matrix in f64.
    pub(crate) fn view_proj_f64(&self) -> [f64; 16] {
        let aspect = self.viewport[0] as f64 / self.viewport[1] as f64;
        let proj = perspective(self.fov, aspect, self.near, self.far);
        let eye = self.position;
        let target = self.target();
        let up = self.up_vector();
        let view = look_at(eye, target, up);
        mul4(proj, view)
    }

    /// View-projection matrix as f32 for the GPU.
    pub fn view_proj(&self) -> [f32; 16] {
        let vp = self.view_proj_f64();
        let mut out = [0.0f32; 16];
        for i in 0..16 {
            out[i] = vp[i] as f32;
        }
        out
    }

    /// Inverse view-projection matrix as f32 for the GPU.
    pub fn inv_view_proj(&self) -> [f32; 16] {
        let vp = self.view_proj_f64();
        invert4_f32(vp)
    }

    /// Compute where the center-screen ray hits the unit [0,1]^3 volume box.
    /// Returns the closest point on the box to the view ray if the ray misses.
    pub fn ray_hit_local(&self, inv_model: &[f64; 16]) -> [f64; 3] {
        let eye_unit = transform_point(self.position, inv_model);
        let target = self.target();
        let target_unit = transform_point(target, inv_model);
        let dir = [
            target_unit[0] - eye_unit[0],
            target_unit[1] - eye_unit[1],
            target_unit[2] - eye_unit[2],
        ];
        ray_aabb_hit(eye_unit, dir, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]).unwrap_or_else(|| {
            closest_point_on_aabb_to_ray(eye_unit, dir, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
        })
    }

    /// Compute the visible region in voxel coordinates by unprojecting the frustum.
    /// This reuses the same logic as Arcball's frustum_visible_region.
    fn frustum_visible_region(
        &self,
        volume_transform: Option<&VolumeTransform>,
        volume_shape: Option<&[u32; 3]>,
    ) -> VisibleRegion {
        let shape = volume_shape.copied().unwrap_or([1, 1, 1]);
        let shape_x = shape[2] as f64;
        let shape_y = shape[1] as f64;
        let shape_z = shape[0] as f64;

        let inv_vp = invert4_f64(self.view_proj_f64());

        let inv_model: [f64; 16] = match volume_transform {
            Some(t) => t.inv_model.map(|v| v as f64),
            None => [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        };

        let ndc_corners: [[f64; 3]; 8] = [
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [-1.0, 1.0, 1.0],
            [1.0, 1.0, 1.0],
        ];

        let mut voxel_min = [f64::MAX; 3];
        let mut voxel_max = [f64::MIN; 3];

        for corner in &ndc_corners {
            let world = unproject(corner, &inv_vp);
            let unit = transform_point(world, &inv_model);
            let vx = unit[0] * shape_x;
            let vy = (1.0 - unit[1]) * shape_y;
            let vz = unit[2] * shape_z;
            voxel_min[0] = voxel_min[0].min(vx);
            voxel_min[1] = voxel_min[1].min(vy);
            voxel_min[2] = voxel_min[2].min(vz);
            voxel_max[0] = voxel_max[0].max(vx);
            voxel_max[1] = voxel_max[1].max(vy);
            voxel_max[2] = voxel_max[2].max(vz);
        }

        // Clamp Z only — see Arcball::frustum_visible_region for rationale.
        voxel_min[2] = voxel_min[2].max(0.0);
        voxel_max[2] = voxel_max[2].min(shape_z);

        let z_start = voxel_min[2].floor().max(0.0) as u32;
        let z_end = voxel_max[2].ceil().max(0.0) as u32;

        let model_f64: [f64; 16] = match volume_transform {
            Some(t) => t.model.map(|v| v as f64),
            None => [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        };
        let vp_model = mul4(self.view_proj_f64(), model_f64);
        let mut m = vp_model;
        for i in 0..4 {
            let c1 = m[4 + i];
            m[i] /= shape_x;
            m[4 + i] /= -shape_y;
            m[8 + i] /= shape_z;
            m[12 + i] += c1;
        }

        let frustum_planes = [
            [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
            [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
            [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
            [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
            [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
            [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
        ];

        let (sx, sy, sz) = match volume_transform {
            Some(t) => (t.model[0] as f64, t.model[5] as f64, t.model[10] as f64),
            None => (1.0, 1.0, 1.0),
        };
        let vpw_x = shape_x / sx.abs().max(1e-12);
        let vpw_y = shape_y / sy.abs().max(1e-12);
        let vpw_z = shape_z / sz.abs().max(1e-12);
        let max_vpw = vpw_x.max(vpw_y).max(vpw_z);

        // For the fly camera, effective_zoom() is a constant (no distance term).
        // Compute the actual distance to the volume surface and factor it in,
        // mirroring how the arcball divides by its target distance.
        let hit_unit = self.ray_hit_local(&inv_model);

        let model_f64_for_hit: [f64; 16] = match volume_transform {
            Some(t) => t.model.map(|v| v as f64),
            None => [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        };
        let hit_world = transform_point(hit_unit, &model_f64_for_hit);
        let dx = hit_world[0] - self.position[0];
        let dy = hit_world[1] - self.position[1];
        let dz = hit_world[2] - self.position[2];
        let dist_to_surface = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6);

        // effective_zoom at distance d = base_zoom / d
        let zoom_per_voxel = (self.effective_zoom() / dist_to_surface) / max_vpw;

        let sort_center = Some([
            hit_unit[0] * shape_x,
            (1.0 - hit_unit[1]) * shape_y,
            hit_unit[2] * shape_z,
        ]);

        VisibleRegion {
            xy_bounds: [voxel_min[0], voxel_min[1], voxel_max[0], voxel_max[1]],
            z_range: z_start..z_end.max(z_start),
            effective_zoom: zoom_per_voxel,
            radius_basis_vox: focal_plane_radius_basis(self.viewport, zoom_per_voxel),
            sort_center,
            frustum_planes: Some(frustum_planes),
        }
    }
}

// --- Fly to Arcball conversion ---

impl Fly {
    /// Convert this fly camera to an arcball camera, preserving eye position and view direction.
    ///
    /// Picks a target point along the view ray: uses the volume center [0.5, 0.5, 0.5]
    /// if it's in front of the camera, otherwise uses a point at distance 1.8 ahead.
    /// Then derives spherical coordinates (theta, phi, distance) from the offset.
    pub fn to_arcball(&self) -> Arcball {
        let forward = self.forward_vector();

        // Compute target: point along view ray
        let volume_center = [0.5, 0.5, 0.5];
        let to_center = [
            volume_center[0] - self.position[0],
            volume_center[1] - self.position[1],
            volume_center[2] - self.position[2],
        ];
        let dot_forward =
            to_center[0] * forward[0] + to_center[1] * forward[1] + to_center[2] * forward[2];

        let target = if dot_forward > 0.1 {
            // Volume center is in front of camera, use it
            volume_center
        } else {
            // Volume center is behind, use point ahead at default distance
            [
                self.position[0] + forward[0] * 1.8,
                self.position[1] + forward[1] * 1.8,
                self.position[2] + forward[2] * 1.8,
            ]
        };

        // Compute spherical coordinates from position relative to target
        let dx = self.position[0] - target[0];
        let dy = self.position[1] - target[1];
        let dz = self.position[2] - target[2];
        let distance = (dx * dx + dy * dy + dz * dz).sqrt();

        // theta = atan2(dx, dz), phi = acos(dy / distance)
        let theta = dx.atan2(dz);
        let phi = if distance > 1e-10 {
            (dy / distance).clamp(-1.0, 1.0).acos()
        } else {
            0.8
        };

        Arcball {
            target,
            theta,
            phi,
            distance: distance.max(self.near),
            fov: self.fov,
            viewport: self.viewport,
            near: self.near,
            far: self.far,
            clip_distance: self.clip_distance,
            clip_mode: self.clip_mode,
        }
    }
}

// --- Arcball to Fly conversion ---

impl Arcball {
    /// Convert this arcball camera to a fly camera, preserving eye position and view direction.
    pub fn to_fly(&self) -> Fly {
        let eye = self.eye_position();
        let view_dir = normalize3([
            self.target[0] - eye[0],
            self.target[1] - eye[1],
            self.target[2] - eye[2],
        ]);

        // Build rotation matrix: right, up, -forward
        let rough_up = [0.0, 1.0, 0.0];
        let mut right = normalize3(cross3(view_dir, rough_up));
        // If view_dir is nearly parallel to rough_up, pick a different rough_up
        if right[0].abs() < 1e-6 && right[1].abs() < 1e-6 && right[2].abs() < 1e-6 {
            right = normalize3(cross3(view_dir, [0.0, 0.0, 1.0]));
        }
        let corrected_up = normalize3(cross3(right, view_dir));

        // Rotation matrix rows: right=X, corrected_up=Y, -view_dir=Z
        let rot = [
            [right[0], corrected_up[0], -view_dir[0]],
            [right[1], corrected_up[1], -view_dir[1]],
            [right[2], corrected_up[2], -view_dir[2]],
        ];

        let orientation = rotation_matrix_to_quat(rot);

        Fly {
            position: eye,
            orientation,
            fov: self.fov,
            viewport: self.viewport,
            near: self.near,
            far: self.far,
            speed_multiplier: 1.0,
            base_speed: 1.0,
            clip_distance: self.clip_distance,
            clip_mode: self.clip_mode,
        }
    }
}

/// Convert a 3x3 rotation matrix (row-major) to a quaternion (x, y, z, w).
fn rotation_matrix_to_quat(m: [[f64; 3]; 3]) -> [f64; 4] {
    let trace = m[0][0] + m[1][1] + m[2][2];
    if trace > 0.0 {
        let s = 0.5 / (trace + 1.0).sqrt();
        [
            (m[2][1] - m[1][2]) * s,
            (m[0][2] - m[2][0]) * s,
            (m[1][0] - m[0][1]) * s,
            0.25 / s,
        ]
    } else if m[0][0] > m[1][1] && m[0][0] > m[2][2] {
        let s = 2.0 * (1.0 + m[0][0] - m[1][1] - m[2][2]).sqrt();
        [
            0.25 * s,
            (m[0][1] + m[1][0]) / s,
            (m[0][2] + m[2][0]) / s,
            (m[2][1] - m[1][2]) / s,
        ]
    } else if m[1][1] > m[2][2] {
        let s = 2.0 * (1.0 + m[1][1] - m[0][0] - m[2][2]).sqrt();
        [
            (m[0][1] + m[1][0]) / s,
            0.25 * s,
            (m[1][2] + m[2][1]) / s,
            (m[0][2] - m[2][0]) / s,
        ]
    } else {
        let s = 2.0 * (1.0 + m[2][2] - m[0][0] - m[1][1]).sqrt();
        [
            (m[0][2] + m[2][0]) / s,
            (m[1][2] + m[2][1]) / s,
            0.25 * s,
            (m[1][0] - m[0][1]) / s,
        ]
    }
}

/// Project a world-space point to screen-space pixels using a view-projection matrix.
/// Returns `None` if the point is behind the camera (clip-space w <= 0).
fn project_3d(
    world_point: [f64; 3],
    view_proj: &[f64; 16],
    viewport: [u32; 2],
) -> Option<[f64; 2]> {
    let [x, y, z] = world_point;
    let vp = view_proj;
    let clip_x = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    let clip_y = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    let clip_w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];

    if clip_w <= 0.0 {
        return None;
    }

    let ndc_x = clip_x / clip_w;
    let ndc_y = clip_y / clip_w;

    let sx = (ndc_x + 1.0) * 0.5 * viewport[0] as f64;
    let sy = (1.0 - ndc_y) * 0.5 * viewport[1] as f64;

    Some([sx, sy])
}

/// Unproject screen coordinates to a world-space ray using a view-projection matrix.
fn unproject_screen_ray(
    screen_x: f64,
    screen_y: f64,
    viewport: [u32; 2],
    view_proj: &[f64; 16],
) -> crate::ray::Ray {
    let ndc_x = (screen_x / viewport[0] as f64) * 2.0 - 1.0;
    let ndc_y = 1.0 - (screen_y / viewport[1] as f64) * 2.0;

    let inv_vp = invert4_f64(*view_proj);
    let near_world = unproject(&[ndc_x, ndc_y, -1.0], &inv_vp);
    let far_world = unproject(&[ndc_x, ndc_y, 1.0], &inv_vp);

    let dir = [
        far_world[0] - near_world[0],
        far_world[1] - near_world[1],
        far_world[2] - near_world[2],
    ];

    crate::ray::Ray::new(near_world, dir)
}

/// Closest point on an AABB to a given point (clamped to the box bounds).
fn closest_point_on_aabb(point: [f64; 3], box_min: [f64; 3], box_max: [f64; 3]) -> [f64; 3] {
    [
        point[0].clamp(box_min[0], box_max[0]),
        point[1].clamp(box_min[1], box_max[1]),
        point[2].clamp(box_min[2], box_max[2]),
    ]
}

fn closest_point_on_aabb_to_ray(
    origin: [f64; 3],
    dir: [f64; 3],
    box_min: [f64; 3],
    box_max: [f64; 3],
) -> [f64; 3] {
    let dir_len_sq = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
    if dir_len_sq <= 1e-24 {
        return closest_point_on_aabb(origin, box_min, box_max);
    }

    if point_aabb_distance_derivative_along_ray(origin, dir, box_min, box_max, 0.0) >= 0.0 {
        return closest_point_on_aabb(origin, box_min, box_max);
    }

    let mut lo = 0.0;
    let mut hi = 1.0;
    while point_aabb_distance_derivative_along_ray(origin, dir, box_min, box_max, hi) < 0.0 {
        lo = hi;
        hi *= 2.0;
        if !hi.is_finite() {
            return closest_point_on_aabb(
                [
                    origin[0] + lo * dir[0],
                    origin[1] + lo * dir[1],
                    origin[2] + lo * dir[2],
                ],
                box_min,
                box_max,
            );
        }
    }

    for _ in 0..80 {
        let mid = (lo + hi) * 0.5;
        if point_aabb_distance_derivative_along_ray(origin, dir, box_min, box_max, mid) < 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    closest_point_on_aabb(
        [
            origin[0] + hi * dir[0],
            origin[1] + hi * dir[1],
            origin[2] + hi * dir[2],
        ],
        box_min,
        box_max,
    )
}

fn point_aabb_distance_derivative_along_ray(
    origin: [f64; 3],
    dir: [f64; 3],
    box_min: [f64; 3],
    box_max: [f64; 3],
    t: f64,
) -> f64 {
    let mut derivative = 0.0;
    for i in 0..3 {
        let p = origin[i] + t * dir[i];
        if p < box_min[i] {
            derivative += (p - box_min[i]) * dir[i];
        } else if p > box_max[i] {
            derivative += (p - box_max[i]) * dir[i];
        }
    }
    derivative
}

/// Ray-AABB intersection using the slab method.
/// Returns the hit point if the ray intersects the box, or None.
/// If the ray origin is inside the box, returns the origin.
pub(crate) fn ray_aabb_hit(
    origin: [f64; 3],
    dir: [f64; 3],
    box_min: [f64; 3],
    box_max: [f64; 3],
) -> Option<[f64; 3]> {
    let mut t_near = f64::NEG_INFINITY;
    let mut t_far = f64::INFINITY;
    for i in 0..3 {
        if dir[i].abs() < 1e-12 {
            if origin[i] < box_min[i] || origin[i] > box_max[i] {
                return None;
            }
        } else {
            let mut t1 = (box_min[i] - origin[i]) / dir[i];
            let mut t2 = (box_max[i] - origin[i]) / dir[i];
            if t1 > t2 {
                std::mem::swap(&mut t1, &mut t2);
            }
            t_near = t_near.max(t1);
            t_far = t_far.min(t2);
            if t_near > t_far {
                return None;
            }
        }
    }
    if t_far < 0.0 {
        return None;
    }
    let t = t_near.max(0.0);
    Some([
        origin[0] + t * dir[0],
        origin[1] + t * dir[1],
        origin[2] + t * dir[2],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Slice tests (preserved from original Camera tests) ---

    #[test]
    fn initial_camera_centered_at_origin() {
        let cam = Camera::new_2d([800, 600]);
        if let Camera::Slice(v) = &cam {
            assert_eq!(v.center, [0.0, 0.0]);
            assert_eq!(v.zoom, 1.0);
        } else {
            panic!("expected Slice");
        }
    }

    #[test]
    fn pan_moves_center_in_world_space() {
        let cam = Camera::new_2d([800, 600]);
        if let Camera::Slice(mut v) = cam {
            v.pan(100.0, -50.0);
            assert_eq!(v.center, [100.0, -50.0]);
        }
    }

    #[test]
    fn pan_is_scaled_by_zoom() {
        let cam = Camera::new_2d([800, 600]);
        if let Camera::Slice(mut v) = cam {
            v.zoom = 2.0;
            v.pan(100.0, 0.0);
            assert_eq!(v.center[0], 50.0);
        }
    }

    #[test]
    fn world_bounds_at_default_zoom() {
        let v = Slice::new([800, 600]);
        let [min_x, min_y, max_x, max_y] = v.world_bounds();
        assert_eq!(min_x, -400.0);
        assert_eq!(min_y, -300.0);
        assert_eq!(max_x, 400.0);
        assert_eq!(max_y, 300.0);
    }

    #[test]
    fn world_bounds_shrink_when_zoomed_in() {
        let mut v = Slice::new([800, 600]);
        v.zoom_by(2.0);
        let [min_x, min_y, max_x, max_y] = v.world_bounds();
        assert_eq!(min_x, -200.0);
        assert_eq!(min_y, -150.0);
        assert_eq!(max_x, 200.0);
        assert_eq!(max_y, 150.0);
    }

    // --- Arcball tests (preserved from original Camera3D tests) ---

    #[test]
    fn default_eye_position() {
        let cam = Arcball::new([800, 600]);
        let eye = cam.eye_position();
        let dx = eye[0] - cam.target[0];
        let dy = eye[1] - cam.target[1];
        let dz = eye[2] - cam.target[2];
        let dist = (dx * dx + dy * dy + dz * dz).sqrt();
        assert!((dist - 1.8).abs() < 1e-10);
    }

    #[test]
    fn rotate_phi_unconstrained() {
        let mut cam = Arcball::new([800, 600]);
        let initial_phi = cam.phi;
        cam.rotate(0.0, 100.0);
        assert!((cam.phi - (initial_phi + 100.0)).abs() < 1e-10);
        cam.rotate(0.0, -200.0);
        assert!((cam.phi - (initial_phi - 100.0)).abs() < 1e-10);
        // Verify view matrix is still valid at extreme phi values
        let m = cam.inv_view_proj();
        for val in &m {
            assert!(
                val.is_finite(),
                "Matrix contains non-finite value at extreme phi: {}",
                val
            );
        }
    }

    #[test]
    fn zoom_clamps_min() {
        let mut cam = Arcball::new([800, 600]);
        cam.zoom(-0.99);
        assert!(cam.distance >= cam.near);
    }

    #[test]
    fn pan_moves_target() {
        let mut cam = Arcball::new([800, 600]);
        let orig = cam.target;
        cam.pan(10.0, 10.0);
        assert!(cam.target != orig);
    }

    #[test]
    fn inv_view_proj_is_finite() {
        let cam = Arcball::new([800, 600]);
        let m = cam.inv_view_proj();
        for val in &m {
            assert!(val.is_finite(), "Matrix contains non-finite value: {}", val);
        }
    }

    // --- New unified camera tests ---

    #[test]
    fn effective_zoom_2d_returns_zoom() {
        let cam = Camera::new_2d([800, 600]);
        assert_eq!(cam.effective_zoom(), 1.0);
    }

    #[test]
    fn effective_zoom_3d_returns_expected_value() {
        let cam = Arcball::new([800, 600]);
        let expected = 600.0 / (2.0 * 1.8 * (std::f64::consts::FRAC_PI_4 / 2.0).tan());
        assert!((cam.effective_zoom() - expected).abs() < 1e-10);
    }

    #[test]
    fn frustum_visible_region_identity_returns_sensible_aabb() {
        let cam = Arcball::new([800, 600]);
        let region = cam.frustum_visible_region(None, Some(&[100, 200, 300]));
        // With no volume transform (identity), the frustum AABB should produce some region
        // The exact values depend on the camera position, but bounds should be finite
        assert!(region.xy_bounds[0].is_finite());
        assert!(region.xy_bounds[2] >= region.xy_bounds[0]);
        assert!(region.xy_bounds[3] >= region.xy_bounds[1]);
        assert!(region.effective_zoom > 0.0);
        assert!(region.radius_basis_vox > 0.0);
    }

    #[test]
    fn frustum_radius_basis_uses_focal_plane_not_far_aabb() {
        let cam = Arcball::new([800, 600]);
        let region = cam.frustum_visible_region(None, Some(&[100, 200, 300]));
        let half_x = (region.xy_bounds[2] - region.xy_bounds[0]) / 2.0;
        let half_y = (region.xy_bounds[3] - region.xy_bounds[1]) / 2.0;
        let half_z = (region.z_range.end - region.z_range.start) as f64 / 2.0;
        let frustum_aabb_basis = (half_x * half_x + half_y * half_y + half_z * half_z).sqrt();

        assert!(region.radius_basis_vox < frustum_aabb_basis);
    }

    #[test]
    fn ray_miss_fallback_uses_closest_point_to_view_ray() {
        let point = closest_point_on_aabb_to_ray(
            [2.0, -2.0, 0.5],
            [0.0, 1.0, 0.2],
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
        );

        assert!((point[0] - 1.0).abs() < 1e-12, "x: {}", point[0]);
        assert!(point[1].abs() < 1e-12, "y: {}", point[1]);
        assert!((point[2] - 0.9).abs() < 1e-12, "z: {}", point[2]);
    }

    #[test]
    fn ray_miss_fallback_clamps_eye_when_ray_points_away() {
        let point = closest_point_on_aabb_to_ray(
            [2.0, -2.0, 0.5],
            [0.0, -1.0, 0.2],
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
        );

        assert!((point[0] - 1.0).abs() < 1e-12, "x: {}", point[0]);
        assert!(point[1].abs() < 1e-12, "y: {}", point[1]);
        assert!((point[2] - 0.5).abs() < 1e-12, "z: {}", point[2]);
    }

    #[test]
    fn visible_region_2d_uses_view_z_range() {
        let cam = Camera::new_2d([512, 512]);
        let region = cam.visible_region(&(10..20), None, None);
        assert_eq!(region.z_range, 10..20);
        assert!(
            (region.radius_basis_vox - (256.0_f64 * 256.0 * 2.0 + 5.0 * 5.0).sqrt()).abs() < 1e-10
        );
    }

    #[test]
    fn set_viewport_works_for_both_modes() {
        let mut cam = Camera::new_2d([800, 600]);
        cam.set_viewport(1920, 1080);
        assert_eq!(cam.viewport(), [1920, 1080]);

        let mut cam = Camera::new_3d([800, 600]);
        cam.set_viewport(1920, 1080);
        assert_eq!(cam.viewport(), [1920, 1080]);
    }

    // --- Quaternion tests ---

    #[test]
    fn quat_multiply_identity() {
        let identity = [0.0, 0.0, 0.0, 1.0];
        let q = [0.1, 0.2, 0.3, 0.9];
        let result = quat_multiply(q, identity);
        for i in 0..4 {
            assert!(
                (result[i] - q[i]).abs() < 1e-12,
                "q * identity mismatch at {i}"
            );
        }
        let result2 = quat_multiply(identity, q);
        for i in 0..4 {
            assert!(
                (result2[i] - q[i]).abs() < 1e-12,
                "identity * q mismatch at {i}"
            );
        }
    }

    #[test]
    fn quat_multiply_composition_two_90_degrees() {
        // Two 90-degree rotations around Y = one 180-degree rotation
        let q90 = quat_from_axis_angle([0.0, 1.0, 0.0], std::f64::consts::FRAC_PI_2);
        let q180 = quat_multiply(q90, q90);
        let expected = quat_from_axis_angle([0.0, 1.0, 0.0], std::f64::consts::PI);
        // Quaternions q and -q represent the same rotation
        let sign = if q180[3] * expected[3] < 0.0 {
            -1.0
        } else {
            1.0
        };
        for i in 0..4 {
            assert!(
                (q180[i] - sign * expected[i]).abs() < 1e-10,
                "180-degree composition mismatch at {i}: {} vs {}",
                q180[i],
                expected[i]
            );
        }
    }

    #[test]
    fn quat_from_axis_angle_produces_unit() {
        let q = quat_from_axis_angle([0.0, 1.0, 0.0], 1.23);
        let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        assert!(
            (len - 1.0).abs() < 1e-12,
            "quaternion not unit length: {len}"
        );
    }

    #[test]
    fn quat_rotate_vector_90_around_y() {
        // 90 degrees around Y should rotate [1,0,0] to [0,0,-1]
        let q = quat_from_axis_angle([0.0, 1.0, 0.0], std::f64::consts::FRAC_PI_2);
        let v = quat_rotate_vector(q, [1.0, 0.0, 0.0]);
        assert!(v[0].abs() < 1e-10, "x should be ~0: {}", v[0]);
        assert!(v[1].abs() < 1e-10, "y should be ~0: {}", v[1]);
        assert!((v[2] + 1.0).abs() < 1e-10, "z should be ~-1: {}", v[2]);
    }

    #[test]
    fn quat_normalize_produces_unit_length() {
        let q = quat_normalize([1.0, 2.0, 3.0, 4.0]);
        let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        assert!((len - 1.0).abs() < 1e-12, "normalized length: {len}");
    }

    // --- Fly camera tests ---

    #[test]
    fn fly_tick_forward_moves_minus_z() {
        let mut cam = Fly::new([800, 600]);
        let orig_z = cam.position[2];
        cam.fly_tick(1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        // dt is clamped to 0.1
        assert!(cam.position[2] < orig_z, "forward should decrease Z");
    }

    #[test]
    fn fly_tick_right_moves_plus_x() {
        let mut cam = Fly::new([800, 600]);
        let orig_x = cam.position[0];
        cam.fly_tick(1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0);
        assert!(cam.position[0] > orig_x, "right should increase X");
    }

    #[test]
    fn fly_tick_up_moves_plus_y() {
        let mut cam = Fly::new([800, 600]);
        let orig_y = cam.position[1];
        cam.fly_tick(1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0);
        assert!(cam.position[1] > orig_y, "up should increase Y");
    }

    #[test]
    fn fly_tick_yaw_rotates_orientation() {
        let mut cam = Fly::new([800, 600]);
        let orig = cam.orientation;
        cam.fly_tick(0.05, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        assert!(cam.orientation != orig, "yaw should change orientation");
    }

    #[test]
    fn fly_tick_dt_clamping() {
        let mut cam1 = Fly::new([800, 600]);
        let mut cam2 = Fly::new([800, 600]);
        cam1.fly_tick(1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        cam2.fly_tick(0.1, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        // dt=1.0 should be clamped to 0.1, so both should produce identical results
        for i in 0..3 {
            assert!(
                (cam1.position[i] - cam2.position[i]).abs() < 1e-12,
                "position mismatch at {i}: {} vs {}",
                cam1.position[i],
                cam2.position[i]
            );
        }
    }

    #[test]
    fn fly_view_proj_is_invertible() {
        let cam = Fly::new([800, 600]);
        let vp = cam.view_proj();
        let ivp = cam.inv_view_proj();
        // Multiply vp * ivp should be approximately identity
        let mut vp64 = [0.0f64; 16];
        let mut ivp64 = [0.0f64; 16];
        for i in 0..16 {
            vp64[i] = vp[i] as f64;
            ivp64[i] = ivp[i] as f64;
        }
        let prod = mul4(vp64, ivp64);
        for i in 0..4 {
            for j in 0..4 {
                let expected = if i == j { 1.0 } else { 0.0 };
                let actual = prod[j * 4 + i];
                assert!(
                    (actual - expected).abs() < 1e-3,
                    "vp*inv_vp [{i},{j}] = {actual}, expected {expected}"
                );
            }
        }
    }

    #[test]
    fn fly_eye_position_returns_position() {
        let cam = Fly::new([800, 600]);
        assert_eq!(cam.eye_position(), cam.position);
    }

    #[test]
    fn arcball_to_fly_preserves_eye_position() {
        let arcball = Arcball::new([800, 600]);
        let fly = arcball.to_fly();
        let arcball_eye = arcball.eye_position();
        let fly_eye = fly.eye_position();
        for i in 0..3 {
            assert!(
                (arcball_eye[i] - fly_eye[i]).abs() < 1e-6,
                "eye position mismatch at {i}: {} vs {}",
                arcball_eye[i],
                fly_eye[i]
            );
        }
    }

    #[test]
    fn arcball_to_fly_preserves_view_direction() {
        let arcball = Arcball::new([800, 600]);
        let fly = arcball.to_fly();
        let arcball_dir = arcball.forward_direction();
        let fly_dir = fly.forward_vector();
        for i in 0..3 {
            assert!(
                (arcball_dir[i] - fly_dir[i]).abs() < 1e-6,
                "view direction mismatch at {i}: {} vs {}",
                arcball_dir[i],
                fly_dir[i]
            );
        }
    }

    #[test]
    fn fly_quaternion_stays_unit_after_many_ticks() {
        let mut cam = Fly::new([800, 600]);
        for _ in 0..1000 {
            cam.fly_tick(0.016, 1.0, 0.5, -0.3, 0.1, -0.05, 0.02);
        }
        let len = (cam.orientation[0].powi(2)
            + cam.orientation[1].powi(2)
            + cam.orientation[2].powi(2)
            + cam.orientation[3].powi(2))
        .sqrt();
        assert!(
            (len - 1.0).abs() < 1e-6,
            "quaternion drifted from unit length: {len}"
        );
    }

    #[test]
    fn fly_camera_serializes_with_mode_tag() {
        let cam = Camera::Fly(Fly::new([800, 600]));
        let json = serde_json::to_string(&cam).unwrap();
        assert!(
            json.contains("\"mode\":\"fly\""),
            "should contain fly mode tag"
        );
        let parsed: Camera = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, Camera::Fly(_)));
    }

    #[test]
    fn set_viewport_works_for_fly() {
        let mut cam = Camera::Fly(Fly::new([800, 600]));
        cam.set_viewport(1920, 1080);
        assert_eq!(cam.viewport(), [1920, 1080]);
    }

    // --- Clip distance tests ---

    #[test]
    fn arcball_clip_distance_defaults_to_zero() {
        let cam = Arcball::new([800, 600]);
        assert_eq!(cam.clip_distance, 0.0);
        assert_eq!(cam.clip_mode, ClipMode::Plane);
    }

    #[test]
    fn fly_clip_distance_defaults_to_zero() {
        let cam = Fly::new([800, 600]);
        assert_eq!(cam.clip_distance, 0.0);
        assert_eq!(cam.clip_mode, ClipMode::Plane);
    }

    // --- Fly to Arcball conversion tests ---

    #[test]
    fn fly_to_arcball_produces_reasonable_values() {
        let fly = Fly {
            position: [1.0, 1.0, 2.0],
            orientation: [0.0, 0.0, 0.0, 1.0], // identity: looking down -Z
            fov: std::f64::consts::FRAC_PI_4,
            viewport: [800, 600],
            near: 0.01,
            far: 100.0,
            speed_multiplier: 1.0,
            base_speed: 1.0,
            clip_distance: 0.0,
            clip_mode: ClipMode::default(),
        };
        let arcball = fly.to_arcball();
        // Should have a positive distance
        assert!(
            arcball.distance > 0.0,
            "distance should be positive: {}",
            arcball.distance
        );
        // theta and phi should be finite
        assert!(arcball.theta.is_finite(), "theta should be finite");
        assert!(arcball.phi.is_finite(), "phi should be finite");
        // fov should be preserved
        assert!(
            (arcball.fov - fly.fov).abs() < 1e-10,
            "fov should be preserved"
        );
        // viewport should be preserved
        assert_eq!(
            arcball.viewport, fly.viewport,
            "viewport should be preserved"
        );
    }

    #[test]
    fn arcball_to_fly_to_arcball_preserves_eye_position() {
        let arcball = Arcball {
            target: [0.5, 0.5, 0.5],
            theta: 0.7,
            phi: 1.2,
            distance: 2.0,
            fov: std::f64::consts::FRAC_PI_4,
            viewport: [800, 600],
            near: 0.01,
            far: 100.0,
            clip_distance: 0.0,
            clip_mode: ClipMode::default(),
        };
        let original_eye = arcball.eye_position();
        let original_dir = arcball.forward_direction();

        // Round-trip: arcball -> fly -> arcball
        let fly = arcball.to_fly();
        let arcball2 = fly.to_arcball();

        // Eye position of the round-tripped arcball should be close to original
        let rt_eye = arcball2.eye_position();
        for i in 0..3 {
            assert!(
                (original_eye[i] - rt_eye[i]).abs() < 1e-3,
                "eye position mismatch at {i}: {} vs {}",
                original_eye[i],
                rt_eye[i]
            );
        }

        // Forward direction should be approximately preserved
        let rt_dir = arcball2.forward_direction();
        let dot =
            original_dir[0] * rt_dir[0] + original_dir[1] * rt_dir[1] + original_dir[2] * rt_dir[2];
        assert!(
            dot > 0.99,
            "forward direction should be preserved (dot={})",
            dot
        );
    }

    #[test]
    fn fly_to_arcball_preserves_eye_position() {
        // Create a fly camera at a known position looking toward volume center
        let arcball = Arcball::new([800, 600]);
        let fly = arcball.to_fly();
        let fly_eye = fly.eye_position();

        let arcball2 = fly.to_arcball();
        let arcball2_eye = arcball2.eye_position();

        for i in 0..3 {
            assert!(
                (fly_eye[i] - arcball2_eye[i]).abs() < 1e-3,
                "eye position mismatch at {i}: {} vs {}",
                fly_eye[i],
                arcball2_eye[i]
            );
        }
    }

    #[test]
    fn clip_mode_serde_roundtrip() {
        let mut cam = Arcball::new([800, 600]);
        cam.clip_distance = 0.5;
        cam.clip_mode = ClipMode::Sphere;
        let json = serde_json::to_string(&Camera::Arcball(cam)).unwrap();
        let parsed: Camera = serde_json::from_str(&json).unwrap();
        if let Camera::Arcball(v) = parsed {
            assert_eq!(v.clip_distance, 0.5);
            assert_eq!(v.clip_mode, ClipMode::Sphere);
        } else {
            panic!("expected Arcball");
        }
    }

    #[test]
    fn clip_distance_backward_compat() {
        // Deserializing old JSON without clip fields should default to 0.0 / Plane
        let json = r#"{"mode":"arcball","target":[0.5,0.5,0.5],"theta":0.5,"phi":0.8,"distance":1.8,"fov":0.7853981633974483,"viewport":[800,600],"near":0.01,"far":100.0}"#;
        let cam: Camera = serde_json::from_str(json).unwrap();
        if let Camera::Arcball(v) = cam {
            assert_eq!(v.clip_distance, 0.0);
            assert_eq!(v.clip_mode, ClipMode::Plane);
        } else {
            panic!("expected Arcball");
        }
    }

    // --- Fly camera serde round-trip tests ---

    #[test]
    fn fly_camera_serde_roundtrip_with_state() {
        let mut fly = Fly::new([1024, 768]);
        fly.position = [1.0, 2.0, 3.0];
        fly.orientation = quat_normalize([0.1, 0.2, 0.3, 0.9]);
        fly.speed_multiplier = 2.5;
        let camera = Camera::Fly(fly.clone());
        let json = serde_json::to_string(&camera).unwrap();
        let deserialized: Camera = serde_json::from_str(&json).unwrap();
        if let Camera::Fly(v) = deserialized {
            assert_eq!(v.position, fly.position);
            for i in 0..4 {
                assert!(
                    (v.orientation[i] - fly.orientation[i]).abs() < 1e-12,
                    "orientation mismatch at {i}"
                );
            }
            assert_eq!(v.fov, fly.fov);
            assert_eq!(v.viewport, fly.viewport);
            assert_eq!(v.speed_multiplier, fly.speed_multiplier);
        } else {
            panic!("expected Fly");
        }
    }

    #[test]
    fn fly_camera_clip_distance_serde_roundtrip() {
        let mut fly = Fly::new([800, 600]);
        fly.clip_distance = 0.75;
        fly.clip_mode = ClipMode::Sphere;
        let camera = Camera::Fly(fly);
        let json = serde_json::to_string(&camera).unwrap();
        let deserialized: Camera = serde_json::from_str(&json).unwrap();
        if let Camera::Fly(v) = deserialized {
            assert_eq!(v.clip_distance, 0.75);
            assert_eq!(v.clip_mode, ClipMode::Sphere);
        } else {
            panic!("expected Fly");
        }
    }

    #[test]
    fn fly_clip_distance_backward_compat() {
        // Deserializing old JSON without clip fields should default to 0.0 / Plane
        let json = r#"{"mode":"fly","position":[0.5,0.5,0.5],"orientation":[0.0,0.0,0.0,1.0],"fov":0.7853981633974483,"viewport":[800,600],"near":0.01,"far":100.0,"speed_multiplier":1.0}"#;
        let cam: Camera = serde_json::from_str(json).unwrap();
        if let Camera::Fly(v) = cam {
            assert_eq!(v.clip_distance, 0.0);
            assert_eq!(v.clip_mode, ClipMode::Plane);
        } else {
            panic!("expected Fly");
        }
    }

    // --- fit_to_bounds tests (Slice / Arcball / Camera dispatch) ---

    /// Every corner of the world rect `[min, max]` must project inside the
    /// viewport `[0, vw] × [0, vh]`.
    fn assert_rect_corners_visible(cam: &Camera, min: [f64; 2], max: [f64; 2]) {
        let [vw, vh] = cam.viewport();
        let (vw, vh) = (vw as f64, vh as f64);
        for &x in &[min[0], max[0]] {
            for &y in &[min[1], max[1]] {
                let s = cam
                    .project_to_screen([x, y, 0.0])
                    .expect("corner should project");
                assert!(
                    s[0] >= -1e-6 && s[0] <= vw + 1e-6 && s[1] >= -1e-6 && s[1] <= vh + 1e-6,
                    "corner ({x}, {y}) projected off-screen at {s:?} (viewport {vw}x{vh})"
                );
            }
        }
    }

    /// Every one of the 8 box corners must project inside the viewport — true
    /// containment at the current orbit angle (the headline 3D promise).
    fn assert_box_corners_visible(cam: &Camera, min: [f64; 3], max: [f64; 3]) {
        let [vw, vh] = cam.viewport();
        let (vw, vh) = (vw as f64, vh as f64);
        for &x in &[min[0], max[0]] {
            for &y in &[min[1], max[1]] {
                for &z in &[min[2], max[2]] {
                    let s = cam
                        .project_to_screen([x, y, z])
                        .expect("corner should project (not behind camera / clipped)");
                    assert!(
                        s[0] >= -1e-6 && s[0] <= vw + 1e-6 && s[1] >= -1e-6 && s[1] <= vh + 1e-6,
                        "corner ({x}, {y}, {z}) projected off-screen at {s:?}"
                    );
                }
            }
        }
    }

    /// Every box corner must lie within the arcball's depth-clip range
    /// `[near, far]` along the view direction — the far-plane-blanking guard.
    fn assert_box_within_depth_clip(a: &Arcball, min: [f64; 3], max: [f64; 3]) {
        assert!(
            a.near.is_finite() && a.far.is_finite() && a.near > 0.0 && a.near < a.far,
            "bad clip range: near {} far {}",
            a.near,
            a.far
        );
        let eye = a.eye_position();
        let fwd = a.forward_direction();
        for &x in &[min[0], max[0]] {
            for &y in &[min[1], max[1]] {
                for &z in &[min[2], max[2]] {
                    // Signed distance from eye along the view direction.
                    let depth =
                        (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2];
                    assert!(
                        depth >= a.near - 1e-9 && depth <= a.far + 1e-9,
                        "corner ({x},{y},{z}) depth {depth} outside [near {}, far {}]",
                        a.near,
                        a.far
                    );
                }
            }
        }
    }

    #[test]
    fn slice_fit_centers_on_midpoint() {
        let mut s = Slice::new([800, 600]);
        s.fit_to_bounds([10.0, 20.0], [110.0, 220.0], FIT_MARGIN_2D);
        assert!(
            (s.center[0] - 60.0).abs() < 1e-9,
            "center x: {}",
            s.center[0]
        );
        assert!(
            (s.center[1] - 120.0).abs() < 1e-9,
            "center y: {}",
            s.center[1]
        );
    }

    #[test]
    fn slice_fit_makes_full_rect_visible_and_contained() {
        let min = [0.0, 0.0];
        let max = [100.0, 40.0];
        let mut cam = Camera::new_2d([800, 600]);
        cam.fit_to_bounds([min[0], min[1], 0.0], [max[0], max[1], 0.0]);
        assert_rect_corners_visible(&cam, min, max);
        if let Camera::Slice(s) = &cam {
            let [bx0, by0, bx1, by1] = s.world_bounds();
            assert!(
                bx0 <= min[0] + 1e-9
                    && by0 <= min[1] + 1e-9
                    && bx1 >= max[0] - 1e-9
                    && by1 >= max[1] - 1e-9,
                "world_bounds {:?} must contain rect",
                s.world_bounds()
            );
        } else {
            panic!("expected Slice");
        }
    }

    #[test]
    fn slice_fit_is_tight_in_limiting_axis() {
        // Wide rect (width-limited) in 800x600: data fills ~1/FIT_MARGIN_2D of
        // the width (most of the view).
        let mut s = Slice::new([800, 600]);
        let min = [0.0, 0.0];
        let max = [200.0, 20.0];
        s.fit_to_bounds(min, max, FIT_MARGIN_2D);
        let data_w = max[0] - min[0];
        let fraction = (data_w * s.zoom) / s.viewport[0] as f64;
        assert!(
            (fraction - 1.0 / FIT_MARGIN_2D).abs() < 1e-6,
            "limiting-axis fill fraction {fraction}, expected {}",
            1.0 / FIT_MARGIN_2D
        );
        // "A little padding" — the data should fill most (>80%) of the axis.
        assert!(
            fraction > 0.8,
            "data should fill most of the view: {fraction}"
        );
    }

    #[test]
    fn slice_fit_is_tight_in_limiting_axis_when_height_binds() {
        // Tall rect (height-limited) in 800x600.
        let mut s = Slice::new([800, 600]);
        let min = [0.0, 0.0];
        let max = [10.0, 300.0];
        s.fit_to_bounds(min, max, FIT_MARGIN_2D);
        let data_h = max[1] - min[1];
        let fraction = (data_h * s.zoom) / s.viewport[1] as f64;
        assert!(
            (fraction - 1.0 / FIT_MARGIN_2D).abs() < 1e-6,
            "limiting-axis fill fraction {fraction}, expected {}",
            1.0 / FIT_MARGIN_2D
        );
    }

    #[test]
    fn slice_fit_handles_large_offset_well() {
        // A plate well at a large XY offset must still be centered and visible.
        let min = [100_000.0, 250_000.0];
        let max = [100_500.0, 250_300.0];
        let mut cam = Camera::new_2d([800, 600]);
        cam.fit_to_bounds([min[0], min[1], 0.0], [max[0], max[1], 0.0]);
        if let Camera::Slice(s) = &cam {
            assert!((s.center[0] - 100_250.0).abs() < 1e-6);
            assert!((s.center[1] - 250_150.0).abs() < 1e-6);
        }
        assert_rect_corners_visible(&cam, min, max);
    }

    #[test]
    fn slice_fit_normalizes_inverted_bounds() {
        // min > max must be normalized, not collapse the fit.
        let mut s = Slice::new([800, 600]);
        s.fit_to_bounds([110.0, 220.0], [10.0, 20.0], FIT_MARGIN_2D);
        assert!(
            (s.center[0] - 60.0).abs() < 1e-9,
            "center x: {}",
            s.center[0]
        );
        assert!(
            (s.center[1] - 120.0).abs() < 1e-9,
            "center y: {}",
            s.center[1]
        );
        assert!(s.zoom.is_finite() && s.zoom > 0.0, "zoom: {}", s.zoom);
    }

    #[test]
    fn slice_fit_sanitizes_non_finite_inputs() {
        let mut s = Slice::new([800, 600]);
        s.fit_to_bounds([f64::NAN, 0.0], [100.0, f64::INFINITY], FIT_MARGIN_2D);
        assert!(
            s.center[0].is_finite() && s.center[1].is_finite(),
            "center: {:?}",
            s.center
        );
        assert!(s.zoom.is_finite() && s.zoom > 0.0, "zoom: {}", s.zoom);
    }

    #[test]
    fn slice_fit_degenerate_axis_finite_positive_zoom() {
        // Zero-height (single Y plane / horizontal line).
        let mut s = Slice::new([800, 600]);
        s.fit_to_bounds([0.0, 5.0], [100.0, 5.0], FIT_MARGIN_2D);
        assert!(s.zoom.is_finite() && s.zoom > 0.0, "zoom: {}", s.zoom);
        // Fully degenerate (a point) must also stay sane.
        let mut s2 = Slice::new([800, 600]);
        s2.fit_to_bounds([3.0, 3.0], [3.0, 3.0], FIT_MARGIN_2D);
        assert!(s2.zoom.is_finite() && s2.zoom > 0.0, "zoom: {}", s2.zoom);
        assert_eq!(s2.center, [3.0, 3.0]);
    }

    #[test]
    fn arcball_fit_centers_target_on_midpoint() {
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds([0.0, 0.0, 0.0], [4.0, 8.0, 2.0], FIT_MARGIN_3D);
        assert_eq!(a.target, [2.0, 4.0, 1.0]);
    }

    #[test]
    fn arcball_fit_preserves_viewing_angle() {
        let mut a = Arcball::new([800, 600]);
        let (theta0, phi0, fov0) = (a.theta, a.phi, a.fov);
        a.fit_to_bounds([0.0, 0.0, 0.0], [10.0, 10.0, 10.0], FIT_MARGIN_3D);
        assert_eq!(a.theta, theta0);
        assert_eq!(a.phi, phi0);
        assert_eq!(a.fov, fov0);
    }

    #[test]
    fn arcball_fit_contains_anisotropic_box() {
        // A typical anisotropic volume: all 8 corners visible and within clip.
        let min = [0.0, 0.0, 0.0];
        let max = [3.0, 5.0, 2.0];
        let mut cam = Camera::new_3d([800, 600]);
        cam.fit_to_bounds(min, max);
        assert_box_corners_visible(&cam, min, max);
        if let Camera::Arcball(a) = &cam {
            assert_box_within_depth_clip(a, min, max);
        }
    }

    #[test]
    fn arcball_fit_contains_isotropic_cube() {
        // The gen-0 bug: a cube's corners clipped ~10% off-screen with
        // distance = max_extent·1.8. True containment must keep ALL corners in.
        let min = [0.0, 0.0, 0.0];
        let max = [10.0, 10.0, 10.0];
        let mut cam = Camera::new_3d([800, 600]);
        cam.fit_to_bounds(min, max);
        assert_box_corners_visible(&cam, min, max);
        if let Camera::Arcball(a) = &cam {
            assert_box_within_depth_clip(a, min, max);
        }
    }

    #[test]
    fn arcball_fit_contains_large_offset_box_without_blanking() {
        // The gen-0 far-plane bug: a large offset box left near/far at
        // 0.01/100, so the eye sat beyond `far` → blank viewport. fit must now
        // set the clip range so every corner is visible AND within [near, far].
        let min = [10_000.0, 20_000.0, 5_000.0];
        let max = [10_300.0, 20_150.0, 5_080.0];
        let mut cam = Camera::new_3d([800, 600]);
        cam.fit_to_bounds(min, max);
        if let Camera::Arcball(a) = &cam {
            assert_eq!(a.target, [10_150.0, 20_075.0, 5_040.0]);
            assert_box_within_depth_clip(a, min, max);
        }
        assert_box_corners_visible(&cam, min, max);
    }

    #[test]
    fn arcball_fit_contains_box_in_wide_and_tall_viewports() {
        // Containment must hold regardless of aspect ratio (the distance uses
        // the narrower frustum half-angle).
        for vp in [[1920, 480], [480, 1920], [1000, 1000]] {
            let min = [0.0, 0.0, 0.0];
            let max = [4.0, 4.0, 4.0];
            let mut cam = Camera::new_3d(vp);
            cam.fit_to_bounds(min, max);
            assert_box_corners_visible(&cam, min, max);
        }
    }

    #[test]
    fn arcball_fit_normalizes_inverted_bounds() {
        // min > max must not collapse the camera onto the center.
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds([4.0, 8.0, 2.0], [0.0, 0.0, 0.0], FIT_MARGIN_3D);
        assert_eq!(a.target, [2.0, 4.0, 1.0]);
        assert!(
            a.distance.is_finite() && a.distance > 0.0,
            "distance: {}",
            a.distance
        );
        // Camera must sit outside the box (distance > bounding radius).
        let r = 0.5 * (4.0_f64 * 4.0 + 8.0 * 8.0 + 2.0 * 2.0).sqrt();
        assert!(
            a.distance > r,
            "camera inside box: dist {} <= R {r}",
            a.distance
        );
    }

    #[test]
    fn arcball_fit_sanitizes_non_finite_inputs() {
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds(
            [f64::NAN, 0.0, 5.0],
            [10.0, f64::INFINITY, f64::NEG_INFINITY],
            FIT_MARGIN_3D,
        );
        for v in a.target {
            assert!(v.is_finite(), "target non-finite: {v}");
        }
        assert!(
            a.distance.is_finite() && a.distance > 0.0,
            "distance: {}",
            a.distance
        );
        assert!(
            a.near.is_finite() && a.far.is_finite() && a.near > 0.0 && a.near < a.far,
            "clip range near {} far {}",
            a.near,
            a.far
        );
    }

    #[test]
    fn arcball_fit_degenerate_box_finite_positive_distance() {
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds([5.0, 5.0, 5.0], [5.0, 5.0, 5.0], FIT_MARGIN_3D);
        assert!(
            a.distance.is_finite() && a.distance > 0.0,
            "distance: {}",
            a.distance
        );
        assert!(
            a.near.is_finite() && a.far.is_finite() && a.near > 0.0 && a.near < a.far,
            "clip range near {} far {}",
            a.near,
            a.far
        );
        assert_eq!(a.target, [5.0, 5.0, 5.0]);
    }

    #[test]
    fn arcball_fit_sets_clip_range_bracketing_the_box() {
        // near clears the front of the sphere and stays > 0; far clears the back.
        let min = [0.0, 0.0, 0.0];
        let max = [6.0, 6.0, 6.0];
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds(min, max, FIT_MARGIN_3D);
        let r = 0.5 * (6.0_f64 * 6.0 * 3.0).sqrt();
        assert!(a.near > 0.0, "near must be positive: {}", a.near);
        assert!(a.near <= a.distance - r + 1e-9 || a.near >= 1e-4);
        assert!(
            a.far >= a.distance + r,
            "far {} < dist+R {}",
            a.far,
            a.distance + r
        );
        assert!(a.near < a.far);
    }

    #[test]
    fn arcball_fit_does_not_change_minimap_framing() {
        // The minimap keeps its OWN overview heuristic (max_extent · FIT_PADDING),
        // distinct from the main camera's containment fit — they must NOT agree
        // on distance (that would mean we regressed the minimap into the main
        // fit, or vice versa).
        let make_mat = |scale: f32, tx: f32, ty: f32, tz: f32| {
            let mut m = [0.0f32; 16];
            m[0] = scale;
            m[5] = scale;
            m[10] = scale;
            m[15] = 1.0;
            m[12] = tx;
            m[13] = ty;
            m[14] = tz;
            m
        };
        let (scale, tx, ty, tz) = (4.0f32, 10.0f32, -3.0f32, 2.0f32);
        let (mm_center, mm_distance) =
            crate::minimap::minimap_framing_boxes(&[(make_mat(scale, tx, ty, tz), true)]);
        // Minimap still uses the overview heuristic exactly.
        assert!(
            (mm_distance - (scale as f64) * FIT_PADDING).abs() < 1e-9,
            "minimap distance drifted from overview heuristic: {mm_distance}"
        );

        let min = [tx as f64, ty as f64, tz as f64];
        let max = [
            (tx + scale) as f64,
            (ty + scale) as f64,
            (tz + scale) as f64,
        ];
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds(min, max, FIT_MARGIN_3D);

        // Centers agree (shared Aabb/center), distances do NOT (different fits).
        for (i, &c) in mm_center.iter().enumerate() {
            assert!((a.target[i] - c).abs() < 1e-12, "target[{i}] vs minimap");
        }
        assert!(
            (a.distance - mm_distance).abs() > 1e-6,
            "main fit must differ from minimap overview: both {mm_distance}"
        );
    }

    #[test]
    fn camera_fit_preserves_slice_mode() {
        let mut cam = Camera::new_2d([800, 600]);
        cam.fit_to_bounds([0.0, 0.0, 0.0], [100.0, 50.0, 10.0]);
        assert!(matches!(cam, Camera::Slice(_)), "must stay 2D");
        if let Camera::Slice(s) = &cam {
            // Uses only XY; center is the XY midpoint.
            assert_eq!(s.center, [50.0, 25.0]);
            assert!(s.zoom.is_finite() && s.zoom > 0.0);
        }
    }

    #[test]
    fn camera_fit_preserves_arcball_mode() {
        let mut cam = Camera::new_3d([800, 600]);
        cam.fit_to_bounds([0.0, 0.0, 0.0], [10.0, 20.0, 5.0]);
        assert!(matches!(cam, Camera::Arcball(_)), "must stay 3D");
        if let Camera::Arcball(a) = &cam {
            assert_eq!(a.target, [5.0, 10.0, 2.5]);
        }
    }

    #[test]
    fn camera_fit_preserves_fly_mode_without_panic() {
        let mut cam = Camera::Fly(Fly::new([800, 600]));
        cam.fit_to_bounds([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
        assert!(matches!(cam, Camera::Fly(_)), "must stay fly");
        if let Camera::Fly(f) = &cam {
            for v in f.position {
                assert!(v.is_finite(), "fly position must be finite");
            }
            assert!(f.base_speed.is_finite() && f.base_speed > 0.0);
            assert!(
                f.near.is_finite() && f.far.is_finite() && f.near > 0.0 && f.near < f.far,
                "fly clip range near {} far {}",
                f.near,
                f.far
            );
        }
    }

    #[test]
    fn camera_fit_uses_margin_2d_for_slice() {
        // Camera::fit_to_bounds must use FIT_MARGIN_2D (not FIT_PADDING) for 2D.
        let mut cam = Camera::new_2d([800, 600]);
        let max = [200.0, 20.0];
        cam.fit_to_bounds([0.0, 0.0, 0.0], [max[0], max[1], 0.0]);
        if let Camera::Slice(s) = &cam {
            let fraction = (max[0] * s.zoom) / s.viewport[0] as f64;
            assert!(
                (fraction - 1.0 / FIT_MARGIN_2D).abs() < 1e-6,
                "fraction {fraction}, expected {}",
                1.0 / FIT_MARGIN_2D
            );
        }
    }

    #[test]
    fn camera_fit_uses_margin_3d_for_arcball() {
        // The 3D dispatch must contain the box with FIT_MARGIN_3D slack — verify
        // it matches the standalone containment math at that margin.
        let min = [0.0, 0.0, 0.0];
        let max = [4.0, 6.0, 2.0];
        let mut cam = Camera::new_3d([800, 600]);
        let fov = if let Camera::Arcball(a) = &cam {
            a.fov
        } else {
            0.0
        };
        cam.fit_to_bounds(min, max);
        let (_, dist, near, far) =
            crate::framing::arcball_containment(min, max, [800, 600], fov, FIT_MARGIN_3D);
        if let Camera::Arcball(a) = &cam {
            assert!(
                (a.distance - dist).abs() < 1e-9,
                "distance {} vs {dist}",
                a.distance
            );
            assert!((a.near - near).abs() < 1e-9 && (a.far - far).abs() < 1e-9);
        }
    }

    #[test]
    fn slice_fit_respects_aspect_ratio_both_orientations() {
        // A square box in a wide viewport: height binds (vh < vw), so the data
        // fills 1/FIT_MARGIN_2D of the height and less of the width.
        let mut s = Slice::new([800, 400]);
        let min = [0.0, 0.0];
        let max = [100.0, 100.0];
        s.fit_to_bounds(min, max, FIT_MARGIN_2D);
        let frac_h = (100.0 * s.zoom) / 400.0;
        let frac_w = (100.0 * s.zoom) / 800.0;
        assert!(
            (frac_h - 1.0 / FIT_MARGIN_2D).abs() < 1e-6,
            "height should bind: {frac_h}"
        );
        assert!(
            frac_w < frac_h,
            "width fraction should be smaller: {frac_w}"
        );
    }

    // --- gpu_view_matrices (thumbnail / minimap off-screen render) ---

    /// `view_proj * inv_view_proj` should be (near) identity — the inverse is
    /// what the volume shader unprojects with, so a bad inverse means a blank
    /// thumbnail.
    fn assert_vp_inv_roundtrips(view_proj: [f32; 16], inv: [f32; 16]) {
        let a: [f64; 16] = view_proj.map(|v| v as f64);
        let b: [f64; 16] = inv.map(|v| v as f64);
        let prod = mul4(a, b);
        for r in 0..4 {
            for c in 0..4 {
                let expected = if r == c { 1.0 } else { 0.0 };
                let got = prod[c * 4 + r];
                assert!(
                    (got - expected).abs() < 1e-3,
                    "vp*inv[{r}][{c}] = {got}, expected {expected}"
                );
            }
        }
    }

    #[test]
    fn gpu_view_matrices_arcball_roundtrips_and_overrides_viewport() {
        let mut a = Arcball::new([800, 600]);
        a.target = [0.5, 0.5, 0.5];
        a.theta = 0.7;
        a.phi = 0.9;
        let cam = Camera::Arcball(a.clone());
        let (inv, eye, view_proj) = cam.gpu_view_matrices([140, 140]);
        assert_vp_inv_roundtrips(view_proj, inv);
        // Eye matches the arcball's own eye (matrices follow the child angle).
        let want = a.eye_position();
        for i in 0..3 {
            assert!((eye[i] as f64 - want[i]).abs() < 1e-4, "eye[{i}]");
        }
        // The square thumbnail viewport (aspect 1) differs from the stored 4:3,
        // so the projection must differ from the camera's own view_proj.
        let own = a.view_proj();
        let differs = (0..16).any(|i| (view_proj[i] - own[i]).abs() > 1e-4);
        assert!(differs, "viewport override should change the projection");
    }

    #[test]
    fn gpu_view_matrices_slice_frames_unit_cube_head_on() {
        // A 2D slice has no perspective volume view; the helper synthesizes a
        // front-on arcball framing [0,1]^3, so the eye sits in front of the cube
        // center looking down -Z (theta=0, phi=pi/2 → eye.z = target.z + dist).
        let cam = Camera::Slice(Slice::new([800, 600]));
        let (inv, eye, view_proj) = cam.gpu_view_matrices([140, 140]);
        assert_vp_inv_roundtrips(view_proj, inv);
        assert!((eye[0] as f64 - 0.5).abs() < 1e-4, "eye x centered");
        assert!((eye[1] as f64 - 0.5).abs() < 1e-4, "eye y centered");
        assert!(eye[2] as f64 > 0.5, "eye sits in front of the cube on +Z");
    }

    // --- Finite inputs must produce finite state (camera-level) ---

    #[test]
    fn arcball_fit_caps_distance_and_keeps_bracket_consistent() {
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds([-1e15; 3], [1e15; 3], FIT_MARGIN_3D);
        assert_eq!(a.distance, ARCBALL_DISTANCE_MAX, "ceiling must engage");
        assert!(
            a.near.is_finite() && a.near > 0.0 && a.near < a.distance,
            "bracket floor must sit below the capped distance, got near {}",
            a.near
        );
        assert!(a.far.is_finite() && a.far > a.near);
        for c in a.target {
            assert!(c.is_finite());
        }

        // Normal-scale bounds are untouched by the cap: same bracket the
        // containment math computed.
        let mut b = Arcball::new([800, 600]);
        b.fit_to_bounds([0.0; 3], [1.0; 3], FIT_MARGIN_3D);
        assert!(b.distance < ARCBALL_DISTANCE_MAX);
        assert!(b.near > 0.0 && b.near < b.distance && b.far > b.near);
    }

    #[test]
    fn arcball_fit_clamps_target_components() {
        // The fit target is an absolute positional write and must obey the
        // same component bound as the pan path — one rule for the whole
        // positional-write family.
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds([1e300; 3], [1e300; 3], FIT_MARGIN_3D);
        assert_eq!(a.target, [CAMERA_POSITION_MAX; 3]);
        assert!(a.distance.is_finite() && a.distance > 0.0);
        assert!(a.near > 0.0 && a.far > a.near);
    }

    #[test]
    fn fly_fit_clamps_base_speed_and_position() {
        let mut f = Fly::new([800, 600]);
        f.fit_to_bounds([-1e15; 3], [1e15; 3], FIT_MARGIN_3D);
        assert_eq!(
            f.base_speed, FLY_BASE_SPEED_MAX,
            "base speed must clamp like every other write"
        );
        for c in f.position {
            assert!(c.is_finite() && c.abs() <= CAMERA_POSITION_MAX);
        }
        assert!(f.near > 0.0 && f.far > f.near);
    }

    #[test]
    fn sanitize_is_idempotent_with_large_near() {
        // A peer can send a large-but-valid near plane; the non-finite
        // distance fallback must still land at >= near so a second sanitize
        // changes nothing.
        let mut cam = Camera::Arcball(Arcball {
            near: 5000.0,
            far: 10000.0,
            distance: f64::NAN,
            ..Arcball::new([64, 64])
        });
        cam.sanitize();
        match &cam {
            Camera::Arcball(v) => {
                assert!(v.distance >= v.near, "fallback must respect near");
                assert_eq!(v.distance, 5000.0);
            }
            other => panic!("expected Arcball, got {other:?}"),
        }
        let once = cam.clone();
        cam.sanitize();
        assert_eq!(cam, once, "sanitize(sanitize(x)) must equal sanitize(x)");

        // A near beyond the distance ceiling resets, keeping
        // `near <= distance <= ceiling` satisfiable.
        let mut cam = Camera::Arcball(Arcball {
            near: 1e300,
            far: 1e301,
            ..Arcball::new([64, 64])
        });
        cam.sanitize();
        match &cam {
            Camera::Arcball(v) => {
                assert!(v.near <= ARCBALL_DISTANCE_MAX && v.near > 0.0);
                assert!(v.distance >= v.near && v.distance <= ARCBALL_DISTANCE_MAX);
            }
            other => panic!("expected Arcball, got {other:?}"),
        }
        let once = cam.clone();
        cam.sanitize();
        assert_eq!(cam, once);
    }

    #[test]
    fn sanitize_bounds_positional_state() {
        // Positional fields obey the same component bound the pan/tick
        // mutators enforce.
        let mut cam = Camera::Slice(Slice {
            center: [1e300, -1e300],
            zoom: 1.0,
            viewport: [64, 64],
        });
        cam.sanitize();
        match &cam {
            Camera::Slice(v) => {
                assert_eq!(v.center, [CAMERA_POSITION_MAX, -CAMERA_POSITION_MAX]);
            }
            other => panic!("expected Slice, got {other:?}"),
        }
        let once = cam.clone();
        cam.sanitize();
        assert_eq!(cam, once);
    }
}
