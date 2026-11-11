use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::framing::{
    Aabb, FitBounds, PlaneBox, WorldBox, arcball_containment, arcball_view_containment,
    depth_bracket, slice_framing,
};
use crate::mat4::{
    cross3, invert4_f32, invert4_f64, look_at, mul4, normalize3, perspective, transform_point,
    unproject,
};
use crate::placement::{Affine, SpaceMap};
use crate::slice_plane::SlicePlane;
use crate::transform::VolumeTransform;
use lucida_content::SpatialAxis;

/// Fit factors for "fit the data to the view", re-exported from [`crate::framing`]
/// so callers can reach them as `camera::FIT_*` while there is one definition:
///
/// - [`FIT_PADDING`] (`1.8`): the **minimap's** overview inset only.
/// - [`FIT_MARGIN_2D`] (`1.15`): the **main 2D** fit — data fills ~87% of the
///   limiting axis.
/// - [`FIT_MARGIN_3D`] (`1.10`): the **main 3D** fit — 10% slack around the
///   data's bounding sphere.
pub use crate::framing::{FIT_MARGIN_2D, FIT_MARGIN_3D, FIT_PADDING};

/// Axis-aligned bounding box in voxel space, plus device pixels per sample at
/// the focal plane. This is what chunk planning needs — not a camera.
#[derive(Debug, Clone, Serialize)]
pub struct VisibleRegion {
    /// [min_x, min_y, max_x, max_y] in voxel coordinates.
    pub xy_bounds: [f64; 4],
    /// Voxel z range.
    #[serde(serialize_with = "serialize_range_as_array")]
    pub z_range: Range<u32>,
    /// Device pixels per level-0 sample at the focal plane. A slice view
    /// reports its zoom. A volume view reports the measure where the
    /// center-screen ray meets the volume.
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
    /// A slice view of a dataset its placement turns in the plane: the
    /// screen's four edges in the dataset's frame, each `[a, b, c, d]` with
    /// `ax + by + cz + d >= 0` inside, so planning leaves out the chunks of
    /// the box around them that the screen doesn't show. `None` otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side_planes: Option<[[f64; 4]; 4]>,
    /// The axis a slice view cuts. Its extent here is the dataset's own
    /// planes the view cuts; the other two are what the screen shows. A
    /// volume view leaves it at Z and ignores it.
    #[serde(default, skip_serializing_if = "SpatialAxis::is_z")]
    pub cut_axis: SpatialAxis,
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

fn visible_radius_basis_from_box(min: [f64; 3], max: [f64; 3]) -> f64 {
    let half = |a: usize| ((max[a] - min[a]) / 2.0).max(0.0);
    let (half_x, half_y, half_z) = (half(0), half(1), half(2));
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

/// What chose a camera's pose, which decides what a new canvas does to it.
///
/// It rides the wire with the camera, so a view means the same wherever it is
/// shown. An absent field reads as placed, which every view written before
/// the field existed was.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Framing {
    /// Someone chose it: a person steering, a saved view, a followed peer. On
    /// another canvas it keeps the region it showed.
    #[default]
    Placed,
    /// The fit of everything visible. A new canvas or new content fits it
    /// again, so it fills whatever canvas shows it.
    Framed,
    /// A stand-in pose nothing chose. The scene fits it as soon as there is
    /// something to fit, and a client never persists it.
    Unframed,
}

impl Framing {
    pub fn is_placed(&self) -> bool {
        *self == Framing::Placed
    }
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
    /// Device pixels per world unit, so the same zoom shows half the CSS size
    /// at twice the pixel ratio.
    pub zoom: f64,
    /// The canvas in device pixels.
    pub viewport: [u32; 2],
    #[serde(default, skip_serializing_if = "Framing::is_placed")]
    pub framing: Framing,
    /// The plane the view cuts. The center is in that plane's world, so a
    /// view of another plane is another camera. Absent reads as XY, which
    /// every view written before the field existed was.
    #[serde(default, skip_serializing_if = "SlicePlane::is_xy")]
    pub plane: SlicePlane,
    /// Draw the plane's down axis across the screen and its across axis
    /// down it, as four-up's YZ view does so that it shares XY's rows. Only
    /// the screen turns: the center stays in the plane's own frame, so
    /// planning, pools and links read the view alike either way.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub transposed: bool,
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
    #[serde(default, skip_serializing_if = "Framing::is_placed")]
    pub framing: Framing,
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
    #[serde(default, skip_serializing_if = "Framing::is_placed")]
    pub framing: Framing,
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

    pub fn framing(&self) -> Framing {
        match self {
            Camera::Slice(v) => v.framing,
            Camera::Arcball(v) => v.framing,
            Camera::Fly(v) => v.framing,
        }
    }

    pub fn set_framing(&mut self, framing: Framing) {
        match self {
            Camera::Slice(v) => v.framing = framing,
            Camera::Arcball(v) => v.framing = framing,
            Camera::Fly(v) => v.framing = framing,
        }
    }

    /// Whether this is a volume camera (arcball or fly), as against the slice
    /// camera. The two families work in different spaces.
    pub fn is_volume(&self) -> bool {
        !matches!(self, Camera::Slice(_))
    }

    /// Resize the canvas and keep the zoom, as a window resize does: the
    /// region in view grows or shrinks with the canvas.
    pub fn set_viewport(&mut self, w: u32, h: u32) {
        match self {
            Camera::Slice(v) => v.viewport = [w, h],
            Camera::Arcball(v) => v.viewport = [w, h],
            Camera::Fly(v) => v.viewport = [w, h],
        }
    }

    /// Move this camera onto a canvas of `viewport`, keeping the region it
    /// showed on its own canvas in view and centered where it was. On a canvas
    /// of the same shape the region fills it exactly, so it shows at the same
    /// CSS size at any pixel ratio. On another shape it fits inside.
    ///
    /// A slice's region is `viewport / zoom`. An arcball's is the rectangle at
    /// its target plane, whose height the vertical field of view fixes, so
    /// only a narrower canvas moves the eye back. A fly camera has no target
    /// plane and keeps its pose.
    pub fn fit_region_to_viewport(&mut self, viewport: [u32; 2]) {
        let from = self.viewport();
        let sized = |v: [u32; 2]| v[0] > 0 && v[1] > 0;
        if sized(from) && sized(viewport) {
            let [fw, fh] = from.map(f64::from);
            let [tw, th] = viewport.map(f64::from);
            match self {
                Camera::Slice(s) => s.set_zoom(s.zoom * (tw / fw).min(th / fh)),
                Camera::Arcball(a) => {
                    let narrowing = (fw / fh) / (tw / th);
                    if narrowing > 1.0 {
                        a.back_off(narrowing);
                    }
                }
                Camera::Fly(_) => {}
            }
        }
        self.set_viewport(viewport[0], viewport[1]);
    }

    /// Carry this camera's pose into other spaces by `map`, so it shows the
    /// same region of the data there. The slice camera moves by the map
    /// between scene frames and the volume cameras by the one between world
    /// spaces. Each map scales every axis alike, so a volume camera keeps its
    /// orientation and its lengths (orbit distance, depth range, near clip,
    /// fly speed) scale with the map.
    pub fn change_space(&mut self, map: &SpaceMap) {
        let place = |affine: &Affine, point: [f64; 3]| {
            affine
                .apply(point)
                .map(|v| v.clamp(-CAMERA_POSITION_MAX, CAMERA_POSITION_MAX))
        };
        match self {
            Camera::Slice(s) => {
                // The center is in the plane the camera cuts.
                let [across, down, _] = s.plane.axes().map(SpatialAxis::xyz);
                let mut point = [0.0; 3];
                (point[across], point[down]) = (s.center[0], s.center[1]);
                let moved = place(&map.scene, point);
                s.set_center(moved[across], moved[down]);
                s.set_zoom(s.zoom / map.scene.length_scale());
            }
            Camera::Arcball(a) => {
                let k = map.world.length_scale();
                a.target = place(&map.world, a.target);
                a.distance *= k;
                a.near *= k;
                a.far *= k;
                a.clip_distance *= k;
            }
            Camera::Fly(f) => {
                let k = map.world.length_scale();
                f.position = place(&map.world, f.position);
                f.near *= k;
                f.far *= k;
                f.clip_distance *= k;
                f.base_speed *= k;
            }
        }
        // Back into the ranges the mutators keep, should a scale overshoot.
        self.sanitize();
    }

    /// Clamp an externally sourced camera (a peer's presence, a saved view)
    /// into the ranges the interactive mutators enforce, and repair
    /// non-finite or degenerate fields, so an import never installs state the
    /// local paths could not produce. A `Slice` with `zoom: 0.0` would turn
    /// the next `pan` into a NaN center, and NaN is self-unequal, so every
    /// later camera command would read as an epoch change.
    ///
    /// Idempotent, and bit-preserving for a camera already in range, so an
    /// unchanged presence re-import still compares equal and stays
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

    /// Device pixels per level-0 sample of a volume, the measure the target
    /// level is chosen from.
    ///
    /// A volume view measures where the center-screen ray meets the volume and
    /// along the axis with the most samples per world unit, the axis the
    /// screen resolves finest, so the level errs coarse rather than fine. A
    /// slice view has no depth. Its samples sit `zoom` device pixels apart
    /// everywhere, so the slice arm ignores `transform` and `shape`.
    pub fn pixels_per_sample(&self, transform: &VolumeTransform, shape: [u32; 3]) -> f64 {
        match self {
            Camera::Slice(v) => v.zoom,
            Camera::Arcball(v) => v.pixels_per_sample_at_hit(Some(transform), shape),
            Camera::Fly(v) => v.pixels_per_sample_at_hit(Some(transform), shape),
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
    /// `(inv_view_proj, eye, view_proj)` in the layout the volume renderer's
    /// uniform buffer wants, the same triple
    /// [`crate::scene::Scene::minimap_camera`] packs.
    ///
    /// `viewport` overrides the camera's own, so a thumbnail takes its aspect
    /// ratio from `viewport`. 3D modes project their actual view. A 2D
    /// [`Camera::Slice`] gets a synthesized front-on arcball framing the unit
    /// `[0,1]^3` cube, as the minimap does; the caller's descriptor model
    /// matrix applies the scene-level framing.
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
                    framing: Framing::Placed,
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
            Camera::Slice(v) => Some(v.to_screen([world_point[0], world_point[1]])),
            Camera::Arcball(v) => project_3d(world_point, &v.view_proj_f64(), v.viewport),
            Camera::Fly(v) => project_3d(world_point, &v.view_proj_f64(), v.viewport),
        }
    }

    /// Unproject screen coordinates to a world-space ray.
    pub fn unproject_ray(&self, screen_x: f64, screen_y: f64) -> crate::ray::Ray {
        match self {
            Camera::Slice(s) => {
                let [across, down] = s.from_screen([screen_x, screen_y]);
                crate::ray::Ray::new([across, down, -1000.0], [0.0, 0.0, 1.0])
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
    /// - `planes`: the planes a slice view cuts along its cut axis (ignored in 3D mode)
    /// - `volume_transform`: maps voxel [0,1]^3 to world space (used in 3D mode)
    /// - `volume_shape`: [Z, Y, X] voxel dimensions (used in 3D mode)
    ///
    /// A slice view reads its region in the scene frame; see
    /// [`Slice::visible_region`] for one dataset's frame.
    pub fn visible_region(
        &self,
        planes: &Range<u32>,
        volume_transform: Option<&VolumeTransform>,
        volume_shape: Option<&[u32; 3]>,
    ) -> VisibleRegion {
        match self {
            Camera::Slice(v) => v.visible_region(&Affine::IDENTITY, planes),
            Camera::Arcball(v) => v.frustum_visible_region(volume_transform, volume_shape),
            Camera::Fly(v) => v.frustum_visible_region(volume_transform, volume_shape),
        }
    }

    /// Put `bounds` centered and fully in view, each camera taking the box in
    /// its own space. Leaves the framing state to the caller.
    ///
    /// Preserves the mode: a `Slice` frames the plane box's XY extent
    /// ([`FIT_MARGIN_2D`]), an `Arcball` contains the world box's bounding
    /// sphere ([`FIT_MARGIN_3D`]) with a depth range around it, and a `Fly`
    /// keeps its orientation and backs off to a containing distance. The
    /// caller need not patch `near`/`far` afterward.
    pub fn fit(&mut self, bounds: &FitBounds) {
        match self {
            Camera::Slice(s) => s.fit_to_bounds(bounds.plane, FIT_MARGIN_2D),
            Camera::Arcball(a) => a.fit_to_bounds(bounds.world, FIT_MARGIN_3D),
            Camera::Fly(f) => f.fit_to_bounds(bounds.world, FIT_MARGIN_3D),
        }
    }
}

// Every camera mutator clamps its writes into these ranges so finite inputs
// of any magnitude can only produce finite state. `Scene::apply` diffs camera
// state around each command, and a stored NaN is self-unequal, so every later
// camera command would read as changed and force a full replan per frame. A
// NaN also serializes to JSON `null` and breaks every peer's presence parse.
//
// Multiplicative state (`Slice::zoom`, `Arcball::distance`) saturates at a
// floor and ceiling. `clip_distance` saturates at `[0, CLIP_DISTANCE_MAX]`.
// Positional state goes through [`step_position`], which saturates overflow
// and drops a NaN step. Orbit angles go through [`wrap_angle`], which wraps
// by 2π only past a huge guard so `sin` never sees ±Inf. The bounds are far
// beyond any dataset scale yet far inside f64 range.

/// Floor for [`Slice::zoom`]. Keeps `Slice::pan`'s divide-by-zoom finite.
pub const SLICE_ZOOM_MIN: f64 = 1e-9;
/// Ceiling for [`Slice::zoom`].
pub const SLICE_ZOOM_MAX: f64 = 1e9;
/// Ceiling for [`Arcball::distance`]; the floor is the camera's own `near`
/// (mirroring [`Arcball::zoom`]'s `.max(near)`). Without a ceiling, repeated
/// zoom-out multiplies `distance` to Inf, and `Arcball::pan` with a zero
/// delta then computes `0 × Inf = NaN` into `target`.
pub const ARCBALL_DISTANCE_MAX: f64 = 1e9;
/// The least `near` a volume camera pulls the near plane down to, as a share
/// of `far`: a fresh camera's 0.01 against 100.
const NEAR_PER_FAR: f64 = 1e-4;
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

impl Slice {
    /// A stand-in camera, unframed, for the scene to fit.
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            center: [0.0, 0.0],
            zoom: 1.0,
            viewport,
            framing: Framing::Unframed,
            plane: SlicePlane::Xy,
            transposed: false,
        }
    }

    /// The axes of the scene frame drawn across the screen and down it.
    pub fn screen_axes(&self) -> [SpatialAxis; 2] {
        let [across, down, _] = self.plane.axes();
        if self.transposed {
            [down, across]
        } else {
            [across, down]
        }
    }

    /// The viewport measured along the plane's own across and down axes:
    /// its height across the plane, and its width down it, when transposed.
    fn plane_viewport(&self) -> [u32; 2] {
        let [width, height] = self.viewport;
        if self.transposed {
            [height, width]
        } else {
            [width, height]
        }
    }

    /// Where `point`, across and down the plane, falls on the screen, in
    /// device pixels from its top left.
    pub fn to_screen(&self, point: [f64; 2]) -> [f64; 2] {
        let [width, height] = self.plane_viewport().map(f64::from);
        let across = (point[0] - self.center[0]) * self.zoom + width / 2.0;
        let down = (point[1] - self.center[1]) * self.zoom + height / 2.0;
        if self.transposed {
            [down, across]
        } else {
            [across, down]
        }
    }

    /// The point across and down the plane under `screen`, in device pixels
    /// from the screen's top left; [`Self::to_screen`] undone.
    pub fn from_screen(&self, screen: [f64; 2]) -> [f64; 2] {
        let [x, y] = if self.transposed {
            [screen[1], screen[0]]
        } else {
            screen
        };
        let [width, height] = self.plane_viewport().map(f64::from);
        [
            (x - width / 2.0) / self.zoom + self.center[0],
            (y - height / 2.0) / self.zoom + self.center[1],
        ]
    }

    /// What this view shows of a dataset that `frame_to_scene` places, in
    /// the dataset's own frame, since planning works in a dataset's samples:
    /// the box around the screen's bounds read back through the placement on
    /// the two axes on screen, and `planes`, the dataset's own planes along
    /// the cut axis, which the placement keeps, so its planes lie across it.
    pub fn visible_region(&self, frame_to_scene: &Affine, planes: &Range<u32>) -> VisibleRegion {
        let [across, down, cut] = self.plane.axes().map(SpatialAxis::xyz);
        let [u0, v0, u1, v1] = self.world_bounds();
        let (mut lo, mut hi) = ([0.0; 3], [0.0; 3]);
        (lo[across], hi[across], lo[down], hi[down]) = (u0, u1, v0, v1);
        let (mut min, mut max) = frame_to_scene.inverse().apply_box(lo, hi);
        (min[cut], max[cut]) = (planes.start as f64, planes.end as f64);
        // A turned dataset's box around the screen holds corners the screen
        // doesn't show, which its edges, read into the frame, cut away.
        let side_planes = (!frame_to_scene.is_axis_aligned()).then(|| {
            let row = |axis: usize| frame_to_scene.linear[axis];
            let edge = |axis: usize, sign: f64, bound: f64| {
                let r = row(axis);
                [
                    sign * r[0],
                    sign * r[1],
                    sign * r[2],
                    sign * (frame_to_scene.offset[axis] - bound),
                ]
            };
            [
                edge(across, 1.0, u0),
                edge(across, -1.0, u1),
                edge(down, 1.0, v0),
                edge(down, -1.0, v1),
            ]
        });
        // A cut along Z names its planes. A view that draws Z covers every
        // plane its bounds touch.
        let z_range = if cut == 2 {
            planes.clone()
        } else {
            let plane = |z: f64| z.max(0.0).min(u32::MAX as f64) as u32;
            let start = plane(min[2].floor());
            start..plane(max[2].ceil()).max(start)
        };
        VisibleRegion {
            xy_bounds: [min[0], min[1], max[0], max[1]],
            z_range,
            effective_zoom: self.zoom * self.plane.sample_extent(frame_to_scene),
            radius_basis_vox: visible_radius_basis_from_box(min, max),
            sort_center: None,
            frustum_planes: None,
            side_planes,
            cut_axis: self.plane.cut(),
        }
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        // The divide is never by zero (every write to `zoom` clamps to
        // `SLICE_ZOOM_MIN..=SLICE_ZOOM_MAX`), and `step_position` bounds the
        // accumulated center — a huge finite delta at the zoom floor saturates
        // at ±CAMERA_POSITION_MAX instead of storing Inf. Center stays finite
        // for every finite input.
        // A drag across the screen moves along whichever plane axis it draws.
        let [du, dv] = if self.transposed { [dy, dx] } else { [dx, dy] };
        self.center[0] = step_position(self.center[0], du / self.zoom);
        self.center[1] = step_position(self.center[1], dv / self.zoom);
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

    /// The visible region across and down the plane: (min_across,
    /// min_down, max_across, max_down).
    pub fn world_bounds(&self) -> [f64; 4] {
        let [width, height] = self.plane_viewport();
        let half_w = (width as f64) / (2.0 * self.zoom);
        let half_h = (height as f64) / (2.0 * self.zoom);
        [
            self.center[0] - half_w,
            self.center[1] - half_h,
            self.center[0] + half_w,
            self.center[1] + half_h,
        ]
    }

    /// Center on the XY extent of `bounds` and zoom so it is fully visible,
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
    pub fn fit_to_bounds(&mut self, bounds: PlaneBox, margin: f64) {
        let (min, max) = (bounds.min, bounds.max);
        let (center, zoom) = slice_framing(
            [min[0], min[1]],
            [max[0], max[1]],
            self.plane_viewport(),
            margin,
        );
        // Positional write: same component bound as the pan path.
        self.set_center(center[0], center[1]);
        // `slice_framing` already guarantees a finite positive zoom; the clamp
        // keeps "zoom is always in the interactive range" a single invariant
        // with no exceptions.
        self.zoom = zoom.clamp(SLICE_ZOOM_MIN, SLICE_ZOOM_MAX);
    }
}

/// A volume transform's model and inverse-model matrices in `f64`, or the
/// identity pair when there is none.
fn model_matrices_f64(volume_transform: Option<&VolumeTransform>) -> ([f64; 16], [f64; 16]) {
    const IDENTITY: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    match volume_transform {
        Some(t) => (t.model.map(f64::from), t.inv_model.map(f64::from)),
        None => (IDENTITY, IDENTITY),
    }
}

/// Device pixels per level-0 sample at `hit_unit`, a point in the volume's
/// unit cube, along the axis with the most samples per world unit.
///
/// `pixels_per_world_at_unit_distance` is the camera's perspective scale.
/// Divided by the distance from `eye` to the hit it gives pixels per world
/// unit at the surface being resolved, and divided again by the densest
/// axis's samples per world unit it gives pixels per sample there. The
/// densest axis is the conservative choice. It reports the smallest spacing,
/// so the level chosen from it errs coarse. `shape` is `[z, y, x]`. Each of
/// the model matrix's first three columns is where the cube's edge along that
/// axis goes, so its length is the axis's world extent however the model
/// turns it.
fn pixels_per_sample_from_eye(
    pixels_per_world_at_unit_distance: f64,
    eye: [f64; 3],
    hit_unit: [f64; 3],
    model: &[f64; 16],
    shape: [u32; 3],
) -> f64 {
    let hit_world = transform_point(hit_unit, model);
    let dx = hit_world[0] - eye[0];
    let dy = hit_world[1] - eye[1];
    let dz = hit_world[2] - eye[2];
    let distance = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6);
    pixels_per_world_at_unit_distance / distance / densest_samples_per_world(model, shape)
}

/// Level-0 samples per world unit along the volume's densest axis.
fn densest_samples_per_world(model: &[f64; 16], shape: [u32; 3]) -> f64 {
    let edge = |c: usize| {
        let column = &model[4 * c..4 * c + 3];
        (column[0] * column[0] + column[1] * column[1] + column[2] * column[2])
            .sqrt()
            .max(1e-12)
    };
    let samples_per_world = [
        shape[2] as f64 / edge(0),
        shape[1] as f64 / edge(1),
        shape[0] as f64 / edge(2),
    ];
    samples_per_world.into_iter().fold(0.0, f64::max).max(1e-12)
}

impl Arcball {
    /// A stand-in camera, unframed, for the scene to fit.
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
            framing: Framing::Unframed,
        }
    }

    /// Frame `bounds` so the whole box is in view at the current orbit angle,
    /// with `margin` slack: true containment.
    ///
    /// `target` is the midpoint and `distance = (R / sin(limiting)) · margin`,
    /// where `R` is the bounding-sphere radius, so containment holds at any
    /// `theta`/`phi`, and `limiting` is the narrower frustum half-angle.
    /// `near`/`far` bracket the box so a large or offset dataset is not
    /// clipped. `theta`/`phi`/`fov` are untouched, and inverted or non-finite
    /// inputs are sanitized. The math lives in
    /// [`crate::framing::arcball_containment`].
    ///
    /// A portrait viewport frames the box as it is seen now instead
    /// ([`crate::framing::arcball_view_containment`]): there the sphere is fit
    /// into the narrow horizontal angle and leaves most of the height empty,
    /// so the data would sit small in the middle of a phone's canvas.
    pub fn fit_to_bounds(&mut self, bounds: WorldBox, margin: f64) {
        let (min, max) = (bounds.min, bounds.max);
        let (target, distance, near, far) = if self.viewport[0] < self.viewport[1] {
            arcball_view_containment(
                min,
                max,
                self.viewport,
                self.fov,
                margin,
                self.screen_axes(),
            )
        } else {
            arcball_containment(min, max, self.viewport, self.fov, margin)
        };
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
        // Unconstrained across the whole interactive range (phi is not
        // clamped to a hemisphere — rotating over the pole accumulates
        // freely); `wrap_angle` only steps in past its huge guard so the
        // angles can never accumulate to ±Inf.
        self.theta = wrap_angle(self.theta + d_theta);
        self.phi = wrap_angle(self.phi + d_phi);
    }

    /// Face the target from `theta` and `phi`, as a rotation to them would.
    pub fn set_angles(&mut self, theta: f64, phi: f64) {
        self.theta = wrap_angle(theta);
        self.phi = wrap_angle(phi);
    }

    /// Orbit `target`, each component bounded as a pan bounds it.
    pub fn set_target(&mut self, target: [f64; 3]) {
        self.target = target.map(|v| step_position(0.0, v));
    }

    /// Stand `distance` from the target, moving the depth slab as a zoom
    /// does. A distance that can't be reached by zooming, nothing or no
    /// number, leaves the camera where it is.
    pub fn set_distance(&mut self, distance: f64) {
        if self.distance > 0.0 && distance.is_finite() && distance > 0.0 {
            self.zoom(distance / self.distance - 1.0);
        }
    }

    pub fn zoom(&mut self, delta: f64) {
        let before = self.distance;
        let next = self.distance * (1.0 + delta);
        // A fit puts `near` just short of the data, where it would stop a
        // zoom-in at the data's edge. Moving in, the near plane comes in by as
        // much, down to the ratio to `far` a fresh camera has, so the camera
        // can still reach the target. Never raised. A NaN `next` fails the
        // comparison and leaves it alone.
        if next < self.distance {
            let floor = (self.far * NEAR_PER_FAR).min(self.near);
            self.near = (self.near - (self.distance - next)).max(floor);
        }
        // Floor at `near` (a zoom-in can't pass through the target plane) and
        // ceiling at the interactive range end so repeated zoom-out saturates
        // instead of multiplying `distance` to Inf — `pan` scales by
        // `distance`, and `0 × Inf` would put NaN into `target`.
        self.distance = next.max(self.near).min(ARCBALL_DISTANCE_MAX);
        // A fit puts `far` just past the data's back. The far plane moves with
        // the eye, so it stays the same depth behind the target: a zoom-out
        // never leaves it in front of the data, and zooming back in returns
        // it, and the near floor above, to where they were. A far plane
        // already short of the target is left alone, since moving it in could
        // put it in front of `near`.
        if self.distance != before && self.far > before {
            self.far += self.distance - before;
        }
    }

    /// Multiply the orbit distance by `factor` and carry the depth slab with
    /// the eye. Every point's depth grows by the same amount, so the near and
    /// far planes and a near clip cut the same world as before; left in place,
    /// a far plane fitted around the data would end up in front of it.
    fn back_off(&mut self, factor: f64) {
        let distance = (self.distance * factor).min(ARCBALL_DISTANCE_MAX);
        let step = distance - self.distance;
        if !(step.is_finite() && step > 0.0) {
            return;
        }
        self.distance = distance;
        self.near += step;
        self.far += step;
        if self.clip_distance > 0.0 {
            self.clip_distance = (self.clip_distance + step).min(CLIP_DISTANCE_MAX);
        }
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
        // NaN. Without the bound, an Inf target would make the next pan's
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

    /// The view's `[right, up, back]` unit axes, as [`look_at`] builds them;
    /// `back` points from the target toward the eye. They depend only on the
    /// orbit angles.
    fn screen_axes(&self) -> [[f64; 3]; 3] {
        let sin_phi = self.phi.sin();
        let back = [
            sin_phi * self.theta.sin(),
            self.phi.cos(),
            sin_phi * self.theta.cos(),
        ];
        let right = normalize3(cross3(self.up_vector(), back));
        [right, cross3(back, right), back]
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

    /// Screen pixels per world unit one unit from the eye. The viewport
    /// height and field of view set this perspective scale, and distance
    /// then divides it.
    fn pixels_per_world_at_unit_distance(&self) -> f64 {
        self.viewport[1] as f64 / (2.0 * (self.fov / 2.0).tan())
    }

    /// Device pixels per level-0 sample where the center-screen ray meets the
    /// volume, along the axis with the most samples per world unit. See
    /// [`Camera::pixels_per_sample`].
    pub fn pixels_per_sample_at_hit(
        &self,
        volume_transform: Option<&VolumeTransform>,
        shape: [u32; 3],
    ) -> f64 {
        let (model, inv_model) = model_matrices_f64(volume_transform);
        let hit_unit = self.ray_hit_local(&inv_model);
        pixels_per_sample_from_eye(
            self.pixels_per_world_at_unit_distance(),
            self.eye_position(),
            hit_unit,
            &model,
            shape,
        )
    }

    /// Move the eye along the view axis, keeping the target and the angles,
    /// until [`Self::pixels_per_sample_at_hit`] measures `pixels_per_sample`,
    /// and bracket the depth around `bounds`, the box the camera must not
    /// clip.
    ///
    /// The center ray meets the volume where the view axis enters it on the
    /// eye's side, a point that stays put as the eye slides along the axis.
    /// The measure is the perspective scale over the eye's distance to that
    /// point, so one distance gives it exactly.
    ///
    /// Returns `false`, changing nothing, when the view axis misses the
    /// volume or the distance it needs is out of range.
    pub fn set_pixels_per_sample(
        &mut self,
        volume_transform: &VolumeTransform,
        shape: [u32; 3],
        pixels_per_sample: f64,
        bounds: WorldBox,
    ) -> bool {
        if !(pixels_per_sample.is_finite() && pixels_per_sample > 0.0) {
            return false;
        }
        let (model, inv_model) = model_matrices_f64(Some(volume_transform));
        let back = self.screen_axes()[2];
        let origin = transform_point(self.target, &inv_model);
        let ahead = transform_point(
            std::array::from_fn(|i| self.target[i] + back[i]),
            &inv_model,
        );
        // The axis in the unit cube is `origin + s · direction`, `s` counting
        // world units from the target toward the eye.
        let direction: [f64; 3] = std::array::from_fn(|i| ahead[i] - origin[i]);
        let (mut s_min, mut s_max) = (f64::NEG_INFINITY, f64::INFINITY);
        for i in 0..3 {
            if direction[i].abs() < 1e-12 {
                if !(0.0..=1.0).contains(&origin[i]) {
                    return false;
                }
                continue;
            }
            let (a, b) = (-origin[i] / direction[i], (1.0 - origin[i]) / direction[i]);
            s_min = s_min.max(a.min(b));
            s_max = s_max.min(a.max(b));
        }
        if s_min > s_max || !s_max.is_finite() {
            return false;
        }
        let depth = self.pixels_per_world_at_unit_distance()
            / (densest_samples_per_world(&model, shape) * pixels_per_sample);
        let distance = s_max + depth;
        if !(distance.is_finite() && distance > 0.0 && distance <= ARCBALL_DISTANCE_MAX) {
            return false;
        }
        let farthest_corner = (0..8)
            .map(|corner| {
                (0..3)
                    .map(|axis| {
                        let end = if corner & (1 << axis) == 0 {
                            bounds.min[axis]
                        } else {
                            bounds.max[axis]
                        };
                        (end - self.target[axis]).powi(2)
                    })
                    .sum::<f64>()
                    .sqrt()
            })
            .fold(0.0, f64::max);
        let (near, far) = depth_bracket(distance, farthest_corner);
        self.distance = distance;
        self.near = near;
        self.far = far;
        true
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
        // XY bounds are not clamped to [0, shape] — for collections, the camera
        // may be looking at a group at a large XY offset. The per-member AABB
        // test in chunk_plan_for handles member-level visibility, and chunk
        // enumeration clamps to valid grid indices.
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

        let hit_unit = self.ray_hit_local(&inv_model);
        let zoom_per_voxel = self.pixels_per_sample_at_hit(volume_transform, shape);

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
            side_planes: None,
            cut_axis: SpatialAxis::Z,
        }
    }
}

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
            framing: Framing::Unframed,
        }
    }

    /// Frame `bounds` best-effort: keep the
    /// orientation and pull `position` back so the box center sits ahead at a
    /// containing distance ([`crate::framing::arcball_containment`]), with
    /// `near`/`far` bracketing the box. `base_speed` becomes
    /// `volume_diagonal · 0.3` so navigation stays scaled to the data. Never
    /// panics, and sanitizes inverted or non-finite input.
    pub fn fit_to_bounds(&mut self, bounds: WorldBox, margin: f64) {
        let (min, max) = (bounds.min, bounds.max);
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

    /// Put `near` and `far` around `data`'s bounding sphere as the eye sees it
    /// now, at the depth of the sphere's center along the look ray, so the
    /// bracket holds at any orientation. From where a fit leaves the eye it
    /// is the fit's own bracket.
    ///
    /// An arcball carries its planes with the eye because its target stays
    /// at the data. A fly camera has no target, so it brackets again from the
    /// data after every move: planes left where a fit put them would sit in
    /// front of the data once the camera flies away, and past the part of it
    /// nearest the eye once it flies in.
    pub fn bracket_depth(&mut self, data: WorldBox) {
        let aabb = Aabb::sanitized(data.min, data.max);
        let center = aabb.center();
        let radius = aabb.bounding_radius();
        let forward = self.forward_vector();
        let depth: f64 = (0..3)
            .map(|i| (center[i] - self.position[i]) * forward[i])
            .sum();
        // The fit's slack past the back. With the data behind the eye the
        // range still spans the sphere, because a range that collapses onto
        // `near` leaves a projection too ill-conditioned to unproject a ray.
        let far = (depth.max(0.0) + radius) * 1.05;
        let near = (depth - radius).max(far * NEAR_PER_FAR);
        if near.is_finite() && far.is_finite() {
            // `sanitize` resets a larger `near`, and must pass every camera
            // this produces through unchanged. `far` still clears it.
            self.near = near.min(ARCBALL_DISTANCE_MAX);
            self.far = far;
        }
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

    /// Device pixels per level-0 sample where the center-screen ray meets the
    /// volume, along the axis with the most samples per world unit. See
    /// [`Camera::pixels_per_sample`].
    pub fn pixels_per_sample_at_hit(
        &self,
        volume_transform: Option<&VolumeTransform>,
        shape: [u32; 3],
    ) -> f64 {
        let (model, inv_model) = model_matrices_f64(volume_transform);
        let hit_unit = self.ray_hit_local(&inv_model);
        pixels_per_sample_from_eye(
            self.effective_zoom(),
            self.position,
            hit_unit,
            &model,
            shape,
        )
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

        let hit_unit = self.ray_hit_local(&inv_model);
        let zoom_per_voxel = self.pixels_per_sample_at_hit(volume_transform, shape);

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
            side_planes: None,
            cut_axis: SpatialAxis::Z,
        }
    }
}

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
            framing: converted_framing(self.framing),
        }
    }
}

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
            framing: converted_framing(self.framing),
        }
    }
}

/// The framing of a camera converted between arcball and fly. The converted
/// pose is the old one seen another way, which only a stand-in shares with
/// the fit; a fitted pose becomes a placed one, so a later canvas change
/// keeps the eye where the switch put it.
fn converted_framing(framing: Framing) -> Framing {
    match framing {
        Framing::Unframed => Framing::Unframed,
        Framing::Placed | Framing::Framed => Framing::Placed,
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

    #[test]
    fn a_turned_volume_reads_the_same_densest_axis() {
        let shape = [16, 64, 256];
        let unturned = crate::placement::Affine::axis_aligned([0.5, 0.25, 0.125], [0.0; 3]);
        // The same box turned a sixth of a turn about Y.
        let (s, c) = (std::f64::consts::FRAC_PI_3).sin_cos();
        let turned = crate::placement::Affine {
            linear: [
                [0.5 * c, 0.0, 0.125 * s],
                [0.0, 0.25, 0.0],
                [-0.5 * s, 0.0, 0.125 * c],
            ],
            offset: [1.0, 2.0, 3.0],
        };
        let densest =
            |a: &crate::placement::Affine| densest_samples_per_world(&a.matrix_f64(), shape);
        assert!((densest(&turned) - densest(&unturned)).abs() < 1e-9);
        assert!((densest(&unturned) - 512.0).abs() < 1e-9);
    }

    /// A slice fit box over a 2D rect.
    fn vox2(min: [f64; 2], max: [f64; 2]) -> PlaneBox {
        PlaneBox::new([min[0], min[1], 0.0], [max[0], max[1], 0.0])
    }

    /// The same box in both spaces, so a test of one camera's fit reads the
    /// box it gave whichever camera it is.
    fn both(min: [f64; 3], max: [f64; 3]) -> FitBounds {
        FitBounds {
            plane: PlaneBox::new(min, max),
            world: WorldBox::new(min, max),
        }
    }

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
    fn a_transposed_slice_turns_only_the_screen() {
        let mut slice = Slice::new([400, 200]);
        slice.plane = SlicePlane::Yz;
        slice.center = [50.0, 10.0];
        slice.zoom = 2.0;
        let standalone = slice.clone();
        slice.transposed = true;
        // The plane's across axis, Y, runs down the screen, whose 200 pixels
        // cover 100 units of it; its down axis, Z, runs across 400 pixels.
        assert_eq!(slice.world_bounds(), [0.0, -90.0, 100.0, 110.0]);
        assert_eq!(standalone.world_bounds(), [-50.0, -40.0, 150.0, 60.0]);
        let point = [60.0, 15.0];
        assert_eq!(slice.to_screen(point), [210.0, 120.0]);
        assert_eq!(slice.from_screen(slice.to_screen(point)), point);
        // A drag across the screen moves along Z.
        slice.pan(20.0, 0.0);
        assert_eq!(slice.center, [50.0, 20.0]);
        // A fit lays the plane's across extent down the screen.
        let bounds = PlaneBox {
            min: [0.0, 0.0, 0.0],
            max: [100.0, 50.0, 0.0],
        };
        slice.fit_to_bounds(bounds, 1.0);
        assert_eq!(slice.zoom, 2.0);
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
    fn zoom_never_raises_a_fresh_cameras_near_plane() {
        let mut cam = Arcball::new([800, 600]);
        for _ in 0..50 {
            cam.zoom(-0.5);
        }
        assert!(cam.near <= 0.01, "near {}", cam.near);
        assert_eq!(cam.distance, cam.near);
    }

    /// The far plane's depth behind the orbit target.
    fn far_behind_target(cam: &Arcball) -> f64 {
        cam.far - cam.distance
    }

    #[test]
    fn zoom_moves_in_past_a_fitted_near_plane() {
        // A fit sets `near` at the data's front; zooming in carries it along
        // instead of stopping there, down to a fresh camera's share of `far`.
        let mut cam = Arcball::new([390, 608]);
        cam.fit_to_bounds(WorldBox::new([0.0; 3], [1.0, 1.0, 0.25]), FIT_MARGIN_3D);
        let (fitted, near, far) = (cam.distance, cam.near, cam.far);
        let behind = far_behind_target(&cam);
        cam.zoom(-0.5);
        assert!(
            (cam.distance - fitted * 0.5).abs() < 1e-12,
            "distance {}",
            cam.distance
        );
        let expected = (near - fitted * 0.5).max(far * NEAR_PER_FAR);
        assert!(
            (cam.near - expected).abs() < 1e-12,
            "near {} vs {expected}",
            cam.near
        );
        for _ in 0..60 {
            cam.zoom(-0.5);
        }
        assert!(
            (cam.near - cam.far * NEAR_PER_FAR).abs() < cam.near * 1e-6,
            "near {} far {}",
            cam.near,
            cam.far
        );
        assert_eq!(cam.distance, cam.near);
        assert!((far_behind_target(&cam) - behind).abs() < 1e-12);
        // Zooming back out leaves the near plane where it came to.
        let near_in = cam.near;
        cam.zoom(1.0);
        assert_eq!(cam.near, near_in);
        // A NaN step changes nothing it shouldn't.
        cam.zoom(f64::NAN);
        assert_eq!(cam.near, near_in);
        assert!(cam.distance.is_finite());
        assert!(cam.far > cam.distance);
    }

    #[test]
    fn zoom_out_carries_the_far_plane_back_past_the_data() {
        let (min, max) = ([0.0; 3], [1.0, 4.0, 4.0]);
        let radius = Aabb::sanitized(min, max).bounding_radius();
        let mut cam = Arcball::new([800, 600]);
        cam.fit_to_bounds(WorldBox::new(min, max), FIT_MARGIN_3D);
        let (fitted, far) = (cam.distance, cam.far);
        let behind = far_behind_target(&cam);
        for multiple in [2.0, 8.0, 64.0] {
            let mut out = cam.clone();
            out.zoom(multiple - 1.0);
            assert!(
                out.far >= out.distance + radius,
                "{multiple}x: far {} short of the data's back at {}",
                out.far,
                out.distance + radius
            );
            assert!((far_behind_target(&out) - behind).abs() < 1e-9);
        }
        // Saturating the zoom keeps the far plane finite, and zooming back to
        // the fit returns it, so the near floor a later zoom-in reaches is
        // the fitted one.
        cam.zoom(1e12);
        assert_eq!(cam.distance, ARCBALL_DISTANCE_MAX);
        assert!(cam.far.is_finite() && cam.far > cam.distance);
        cam.zoom(fitted / cam.distance - 1.0);
        assert!((cam.distance - fitted).abs() < 1e-6);
        assert!((cam.far - far).abs() < 1e-6, "far {} vs {far}", cam.far);
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

    fn slice(center: [f64; 2], zoom: f64, viewport: [u32; 2]) -> Slice {
        Slice {
            center,
            zoom,
            viewport,
            framing: Framing::Placed,
            plane: SlicePlane::Xy,
            transposed: false,
        }
    }

    #[test]
    fn a_side_view_region_spans_its_cut_plane_and_the_z_the_screen_shows() {
        // An XZ view 200 world units tall over Z drawn at twice its samples.
        let mut cam = slice([100.0, 50.0], 1.0, [200, 200]);
        cam.plane = SlicePlane::Xz;
        let placed = Affine::axis_aligned([1.0, 1.0, 2.0], [0.0; 3]);
        let region = cam.visible_region(&placed, &(7..8));
        assert_eq!(region.cut_axis, SpatialAxis::Y);
        assert_eq!(region.xy_bounds, [0.0, 7.0, 200.0, 8.0]);
        // World -50..150 is Z -25..75, of which 0..75 is real.
        assert_eq!(region.z_range, 0..75);
        let json = serde_json::to_string(&region).unwrap();
        assert!(json.contains(r#""cut_axis":"y""#), "{json}");
        let xy = slice([100.0, 50.0], 1.0, [200, 200]).visible_region(&Affine::IDENTITY, &(3..4));
        assert!(!serde_json::to_string(&xy).unwrap().contains("cut_axis"));
    }

    #[test]
    fn a_slice_camera_reads_without_a_plane_as_xy_and_writes_xy_without_one() {
        let json = r#"{"mode":"slice","center":[1.0,2.0],"zoom":3.0,"viewport":[4,5]}"#;
        let camera: Camera = serde_json::from_str(json).unwrap();
        let Camera::Slice(ref s) = camera else {
            panic!("a slice camera");
        };
        assert_eq!(s.plane, SlicePlane::Xy);
        assert_eq!(serde_json::to_string(&camera).unwrap(), json);
        let mut side = s.clone();
        side.plane = SlicePlane::Yz;
        let written = serde_json::to_string(&Camera::Slice(side.clone())).unwrap();
        assert!(written.contains(r#""plane":"yz""#), "{written}");
        assert_eq!(
            serde_json::from_str::<Camera>(&written).unwrap(),
            Camera::Slice(side)
        );
    }

    #[test]
    fn a_slice_region_fills_a_canvas_of_the_same_shape_at_any_pixel_ratio() {
        let at_1x = slice([300.0, 200.0], 0.5, [1280, 800]);
        let mut at_2x = Camera::Slice(at_1x.clone());
        at_2x.fit_region_to_viewport([2560, 1600]);
        let Camera::Slice(at_2x) = at_2x else {
            unreachable!()
        };
        assert_eq!(at_2x.zoom, 1.0);
        assert_eq!(at_2x.world_bounds(), at_1x.world_bounds());
    }

    #[test]
    fn a_slice_region_fits_inside_a_canvas_of_another_shape() {
        for (from, to) in [
            ([1280, 800], [1170, 2532]),
            ([390, 844], [1280, 800]),
            ([1280, 800], [800, 1280]),
        ] {
            let saved = slice([50.0, -20.0], 3.0, from);
            let mut shown = Camera::Slice(saved.clone());
            shown.fit_region_to_viewport(to);
            let Camera::Slice(shown) = shown else {
                unreachable!()
            };
            let [a0, b0, a1, b1] = saved.world_bounds();
            let [x0, y0, x1, y1] = shown.world_bounds();
            let eps = 1e-9;
            assert!(
                x0 <= a0 + eps && y0 <= b0 + eps && x1 >= a1 - eps && y1 >= b1 - eps,
                "{from:?} -> {to:?}: {:?} must contain {:?}",
                shown.world_bounds(),
                saved.world_bounds()
            );
            let tight = ((x0 - a0).abs() < eps && (x1 - a1).abs() < eps)
                || ((y0 - b0).abs() < eps && (y1 - b1).abs() < eps);
            assert!(tight, "{from:?} -> {to:?}: the region spans one axis");
            assert_eq!(shown.center, saved.center);
        }
    }

    #[test]
    fn a_camera_keeps_its_zoom_on_the_canvas_it_came_from_or_a_zero_sized_one() {
        let saved = Camera::Slice(slice([1.0, 2.0], 0.37, [1280, 800]));
        let mut same = saved.clone();
        same.fit_region_to_viewport([1280, 800]);
        assert_eq!(same, saved);

        let mut hidden = saved.clone();
        hidden.fit_region_to_viewport([0, 0]);
        assert_eq!(hidden.effective_zoom(), 0.37);

        let mut from_unsized = Camera::Slice(slice([1.0, 2.0], 0.37, [0, 0]));
        from_unsized.fit_region_to_viewport([1280, 800]);
        assert_eq!(from_unsized.effective_zoom(), 0.37);
        assert_eq!(from_unsized.viewport(), [1280, 800]);
    }

    #[test]
    fn an_arcball_backs_off_on_a_narrower_canvas_and_carries_its_depth_slab() {
        let saved = Arcball {
            target: [0.5, 0.5, 0.5],
            distance: 2.0,
            near: 1.0,
            far: 3.0,
            clip_distance: 1.5,
            ..Arcball::new([1280, 800])
        };
        let half_extent_at_target = |a: &Arcball| {
            let half_h = a.distance * (a.fov / 2.0).tan();
            let aspect = a.viewport[0] as f64 / a.viewport[1] as f64;
            [half_h * aspect, half_h]
        };

        let mut portrait = Camera::Arcball(saved.clone());
        portrait.fit_region_to_viewport([390, 844]);
        let Camera::Arcball(portrait) = portrait else {
            unreachable!()
        };
        let [sw, sh] = half_extent_at_target(&saved);
        let [pw, ph] = half_extent_at_target(&portrait);
        assert!((pw - sw).abs() < 1e-9, "the saved width spans the canvas");
        assert!(ph > sh);
        let step = portrait.distance - saved.distance;
        assert!(step > 0.0);
        assert!((portrait.near - (saved.near + step)).abs() < 1e-12);
        assert!((portrait.far - (saved.far + step)).abs() < 1e-12);
        assert!((portrait.clip_distance - (saved.clip_distance + step)).abs() < 1e-12);

        // Wider, or the same shape at another pixel ratio, the height already
        // fits and nothing moves.
        for to in [[2560, 800], [2560, 1600]] {
            let mut shown = Camera::Arcball(saved.clone());
            shown.fit_region_to_viewport(to);
            let Camera::Arcball(shown) = shown else {
                unreachable!()
            };
            assert_eq!(shown.distance, saved.distance);
            assert_eq!(shown.near, saved.near);
            assert_eq!(shown.far, saved.far);
        }
    }

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

    /// The nearest and farthest depth along `cam`'s look ray of any corner of
    /// the box.
    fn corner_depths(cam: &Fly, min: [f64; 3], max: [f64; 3]) -> (f64, f64) {
        let forward = cam.forward_vector();
        (0..8)
            .map(|corner| {
                (0..3)
                    .map(|i| {
                        let end = if corner >> i & 1 == 1 { max[i] } else { min[i] };
                        (end - cam.position[i]) * forward[i]
                    })
                    .sum::<f64>()
            })
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), d| {
                (lo.min(d), hi.max(d))
            })
    }

    #[test]
    fn bracket_depth_keeps_the_data_between_the_planes_wherever_the_fly_camera_goes() {
        let (min, max) = ([0.0; 3], [1.0, 4.0, 4.0]);
        let data = WorldBox::new(min, max);
        let mut cam = Fly::new([800, 600]);
        cam.fit_to_bounds(data, FIT_MARGIN_3D);
        let (near, far) = (cam.near, cam.far);
        // In place, it is the fit's own bracket.
        cam.bracket_depth(data);
        assert!((cam.near - near).abs() < 1e-9 && (cam.far - far).abs() < 1e-9);
        // Backed out far past the fit, flown in to the middle of the data, and
        // turned partly away. Inside the data `near` drops to a sliver of it.
        let radius = Aabb::sanitized(min, max).bounding_radius();
        for (back, yaw) in [
            (100.0, 0.0),
            (-cam.near - 2.0, 0.0),
            (20.0, 4.0),
            (0.0, 15.0),
        ] {
            let mut moved = cam.clone();
            moved.base_speed = f64::abs(back) / 0.1;
            moved.fly_tick(0.1, -f64::signum(back), 0.0, 0.0, yaw, 0.0, 0.0);
            moved.bracket_depth(data);
            let (lo, hi) = corner_depths(&moved, min, max);
            assert!(
                moved.near > 0.0
                    && (lo >= moved.near || moved.near <= radius * 1e-3)
                    && hi <= moved.far,
                "back {back} yaw {yaw}: near {} far {} around corners at {lo}..{hi}",
                moved.near,
                moved.far
            );
        }
        // Flying back to the fit returns the planes to it.
        let mut out = cam.clone();
        out.base_speed = 100.0;
        out.fly_tick(0.1, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        out.fly_tick(0.1, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        out.bracket_depth(data);
        assert!((out.near - near).abs() < 1e-9 && (out.far - far).abs() < 1e-9);
    }

    #[test]
    fn bracket_depth_keeps_a_usable_range_with_the_data_behind() {
        let data = WorldBox::new([0.0; 3], [1.0; 3]);
        let radius = Aabb::sanitized(data.min, data.max).bounding_radius();
        let mut cam = Fly::new([800, 600]);
        cam.fit_to_bounds(data, FIT_MARGIN_3D);
        cam.fly_tick(0.1, 0.0, 0.0, 0.0, std::f64::consts::PI / 0.1, 0.0, 0.0);
        cam.bracket_depth(data);
        assert!(
            cam.far >= radius,
            "far {} under the radius {radius}",
            cam.far
        );
        assert!(cam.near >= cam.far * NEAR_PER_FAR, "near {}", cam.near);
    }

    #[test]
    fn bracket_depth_stays_inside_what_sanitize_passes() {
        let mut cam = Fly::new([800, 600]);
        cam.position = [0.0, 0.0, CAMERA_POSITION_MAX];
        cam.bracket_depth(WorldBox::new([0.0; 3], [1.0; 3]));
        assert!(cam.near <= ARCBALL_DISTANCE_MAX && cam.far > cam.near);
        let mut sanitized = Camera::Fly(cam.clone());
        sanitized.sanitize();
        assert_eq!(sanitized, Camera::Fly(cam));
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
            framing: Framing::Placed,
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
            framing: Framing::Placed,
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
        s.fit_to_bounds(vox2([10.0, 20.0], [110.0, 220.0]), FIT_MARGIN_2D);
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
        cam.fit(&both([min[0], min[1], 0.0], [max[0], max[1], 0.0]));
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
        s.fit_to_bounds(vox2(min, max), FIT_MARGIN_2D);
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
        s.fit_to_bounds(vox2(min, max), FIT_MARGIN_2D);
        let data_h = max[1] - min[1];
        let fraction = (data_h * s.zoom) / s.viewport[1] as f64;
        assert!(
            (fraction - 1.0 / FIT_MARGIN_2D).abs() < 1e-6,
            "limiting-axis fill fraction {fraction}, expected {}",
            1.0 / FIT_MARGIN_2D
        );
    }

    #[test]
    fn slice_fit_handles_large_offset_group() {
        // A collection group at a large XY offset must still be centered and visible.
        let min = [100_000.0, 250_000.0];
        let max = [100_500.0, 250_300.0];
        let mut cam = Camera::new_2d([800, 600]);
        cam.fit(&both([min[0], min[1], 0.0], [max[0], max[1], 0.0]));
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
        s.fit_to_bounds(vox2([110.0, 220.0], [10.0, 20.0]), FIT_MARGIN_2D);
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
        s.fit_to_bounds(vox2([f64::NAN, 0.0], [100.0, f64::INFINITY]), FIT_MARGIN_2D);
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
        s.fit_to_bounds(vox2([0.0, 5.0], [100.0, 5.0]), FIT_MARGIN_2D);
        assert!(s.zoom.is_finite() && s.zoom > 0.0, "zoom: {}", s.zoom);
        // Fully degenerate (a point) must also stay sane.
        let mut s2 = Slice::new([800, 600]);
        s2.fit_to_bounds(vox2([3.0, 3.0], [3.0, 3.0]), FIT_MARGIN_2D);
        assert!(s2.zoom.is_finite() && s2.zoom > 0.0, "zoom: {}", s2.zoom);
        assert_eq!(s2.center, [3.0, 3.0]);
    }

    #[test]
    fn arcball_fit_centers_target_on_midpoint() {
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds(
            WorldBox::new([0.0, 0.0, 0.0], [4.0, 8.0, 2.0]),
            FIT_MARGIN_3D,
        );
        assert_eq!(a.target, [2.0, 4.0, 1.0]);
    }

    #[test]
    fn arcball_fit_preserves_viewing_angle() {
        let mut a = Arcball::new([800, 600]);
        let (theta0, phi0, fov0) = (a.theta, a.phi, a.fov);
        a.fit_to_bounds(
            WorldBox::new([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]),
            FIT_MARGIN_3D,
        );
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
        cam.fit(&both(min, max));
        assert_box_corners_visible(&cam, min, max);
        if let Camera::Arcball(a) = &cam {
            assert_box_within_depth_clip(a, min, max);
        }
    }

    #[test]
    fn arcball_fit_contains_isotropic_cube() {
        // A loose fit (distance = max_extent·1.8) clips a cube's corners ~10%
        // off-screen. True containment must keep all corners in.
        let min = [0.0, 0.0, 0.0];
        let max = [10.0, 10.0, 10.0];
        let mut cam = Camera::new_3d([800, 600]);
        cam.fit(&both(min, max));
        assert_box_corners_visible(&cam, min, max);
        if let Camera::Arcball(a) = &cam {
            assert_box_within_depth_clip(a, min, max);
        }
    }

    #[test]
    fn arcball_fit_contains_large_offset_box_without_blanking() {
        // A large offset box with near/far left at 0.01/100 puts the eye beyond
        // `far` and blanks the viewport. fit must set the clip range so every
        // corner is visible and within [near, far].
        let min = [10_000.0, 20_000.0, 5_000.0];
        let max = [10_300.0, 20_150.0, 5_080.0];
        let mut cam = Camera::new_3d([800, 600]);
        cam.fit(&both(min, max));
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
            cam.fit(&both(min, max));
            assert_box_corners_visible(&cam, min, max);
        }
    }

    /// The widest share of the viewport any corner of the box reaches, per
    /// axis, measured from the center (1.0 is the edge).
    fn box_screen_reach(cam: &Camera, min: [f64; 3], max: [f64; 3]) -> [f64; 2] {
        let [vw, vh] = cam.viewport();
        let (half_w, half_h) = (vw as f64 / 2.0, vh as f64 / 2.0);
        let mut reach = [0.0_f64; 2];
        for corner in 0..8 {
            let p: [f64; 3] = std::array::from_fn(|i| {
                if corner & (1 << i) == 0 {
                    min[i]
                } else {
                    max[i]
                }
            });
            let s = cam.project_to_screen(p).expect("corner projects");
            reach[0] = reach[0].max((s[0] - half_w).abs() / half_w);
            reach[1] = reach[1].max((s[1] - half_h).abs() / half_h);
        }
        reach
    }

    #[test]
    fn arcball_fit_frames_a_flat_box_tightly_in_a_portrait_viewport() {
        // A flat volume on a phone-shaped canvas, at the default orbit angle:
        // the box keeps all its corners in view and reaches near the edge of
        // the binding axis, instead of sitting small inside its bounding sphere.
        let (min, max) = ([0.0, 0.0, 0.0], [1.0, 1.0, 0.25]);
        let mut cam = Camera::new_3d([1170, 1824]);
        cam.fit(&both(min, max));
        assert_box_corners_visible(&cam, min, max);
        if let Camera::Arcball(a) = &cam {
            assert_box_within_depth_clip(a, min, max);
            let (_, sphere, _, _) = arcball_containment(min, max, a.viewport, a.fov, FIT_MARGIN_3D);
            assert!(
                a.distance < sphere * 0.9,
                "distance {} vs sphere {sphere}",
                a.distance
            );
        }
        let reach = box_screen_reach(&cam, min, max);
        let widest = reach[0].max(reach[1]);
        assert!(
            widest > 0.85 && widest <= 1.0 / FIT_MARGIN_3D + 1e-6,
            "reach {reach:?}"
        );
    }

    #[test]
    fn arcball_fit_keeps_the_sphere_fit_in_landscape_viewports() {
        // Wider than tall, the fit still holds at every orbit angle.
        let (min, max) = ([0.0, 0.0, 0.0], [1.0, 1.0, 0.25]);
        for vp in [[1280, 800], [1000, 1000]] {
            let mut a = Arcball::new(vp);
            a.fit_to_bounds(WorldBox::new(min, max), FIT_MARGIN_3D);
            let (_, sphere, near, far) = arcball_containment(min, max, vp, a.fov, FIT_MARGIN_3D);
            assert_eq!((a.distance, a.near, a.far), (sphere, near, far));
        }
    }

    #[test]
    fn arcball_fit_contains_boxes_from_any_angle_in_a_portrait_viewport() {
        let boxes = [
            ([0.0, 0.0, 0.0], [1.0, 1.0, 0.25]),
            ([0.0, 0.0, 0.0], [0.1, 1.0, 0.1]),
            ([-3.0, 2.0, 5.0], [4.0, 2.5, 9.0]),
        ];
        for (min, max) in boxes {
            for (theta, phi) in [
                (0.0, 0.01),
                (0.5, 0.8),
                (2.0, 1.5),
                (-1.0, 3.0),
                (0.785, 0.955),
            ] {
                let mut a = Arcball::new([390, 608]);
                a.theta = theta;
                a.phi = phi;
                a.fit_to_bounds(WorldBox::new(min, max), FIT_MARGIN_3D);
                assert_box_within_depth_clip(&a, min, max);
                assert_box_corners_visible(&Camera::Arcball(a), min, max);
            }
        }
    }

    #[test]
    fn arcball_fit_normalizes_inverted_bounds() {
        // min > max must not collapse the camera onto the center.
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds(
            WorldBox::new([4.0, 8.0, 2.0], [0.0, 0.0, 0.0]),
            FIT_MARGIN_3D,
        );
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
            WorldBox::new(
                [f64::NAN, 0.0, 5.0],
                [10.0, f64::INFINITY, f64::NEG_INFINITY],
            ),
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
        a.fit_to_bounds(
            WorldBox::new([5.0, 5.0, 5.0], [5.0, 5.0, 5.0]),
            FIT_MARGIN_3D,
        );
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
        a.fit_to_bounds(WorldBox::new(min, max), FIT_MARGIN_3D);
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
        // The minimap keeps its own overview heuristic (max_extent · FIT_PADDING),
        // distinct from the main camera's containment fit, so the two must not
        // agree on distance.
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
        let framing = crate::minimap::minimap_framing(&[crate::minimap::MinimapMember {
            model: make_mat(scale, tx, ty, tz),
            visible: true,
            z_planes: 8,
        }]);
        let crate::minimap::MinimapFraming::Orbit {
            target: mm_center,
            distance: mm_distance,
        } = framing
        else {
            panic!("a volume must get the orbit framing: {framing:?}");
        };
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
        a.fit_to_bounds(WorldBox::new(min, max), FIT_MARGIN_3D);

        // Centers agree (shared Aabb/center), distances do not (different fits).
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
        cam.fit(&both([0.0, 0.0, 0.0], [100.0, 50.0, 10.0]));
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
        cam.fit(&both([0.0, 0.0, 0.0], [10.0, 20.0, 5.0]));
        assert!(matches!(cam, Camera::Arcball(_)), "must stay 3D");
        if let Camera::Arcball(a) = &cam {
            assert_eq!(a.target, [5.0, 10.0, 2.5]);
        }
    }

    #[test]
    fn camera_fit_preserves_fly_mode_without_panic() {
        let mut cam = Camera::Fly(Fly::new([800, 600]));
        cam.fit(&both([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]));
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
        // Camera::fit must use FIT_MARGIN_2D (not FIT_PADDING) for 2D.
        let mut cam = Camera::new_2d([800, 600]);
        let max = [200.0, 20.0];
        cam.fit(&both([0.0, 0.0, 0.0], [max[0], max[1], 0.0]));
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
        cam.fit(&both(min, max));
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
        s.fit_to_bounds(vox2(min, max), FIT_MARGIN_2D);
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

    #[test]
    fn arcball_fit_caps_distance_and_keeps_bracket_consistent() {
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds(WorldBox::new([-1e15; 3], [1e15; 3]), FIT_MARGIN_3D);
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
        b.fit_to_bounds(WorldBox::new([0.0; 3], [1.0; 3]), FIT_MARGIN_3D);
        assert!(b.distance < ARCBALL_DISTANCE_MAX);
        assert!(b.near > 0.0 && b.near < b.distance && b.far > b.near);
    }

    #[test]
    fn arcball_fit_clamps_target_components() {
        // The fit target is an absolute positional write and must obey the
        // same component bound as the pan path — one rule for the whole
        // positional-write family.
        let mut a = Arcball::new([800, 600]);
        a.fit_to_bounds(WorldBox::new([1e300; 3], [1e300; 3]), FIT_MARGIN_3D);
        assert_eq!(a.target, [CAMERA_POSITION_MAX; 3]);
        assert!(a.distance.is_finite() && a.distance > 0.0);
        assert!(a.near > 0.0 && a.far > a.near);
    }

    #[test]
    fn fly_fit_clamps_base_speed_and_position() {
        let mut f = Fly::new([800, 600]);
        f.fit_to_bounds(WorldBox::new([-1e15; 3], [1e15; 3]), FIT_MARGIN_3D);
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
            framing: Framing::Placed,
            plane: SlicePlane::Xy,
            transposed: false,
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

    #[test]
    fn slice_pixels_per_sample_is_the_zoom() {
        let mut cam = Camera::new_2d([800, 600]);
        if let Camera::Slice(v) = &mut cam {
            v.set_zoom(0.37);
        }
        let t = crate::transform::compute_volume_transform([1, 512, 512], [1.0, 1.0, 1.0]);
        assert_eq!(cam.pixels_per_sample(&t, [1, 512, 512]), 0.37);
    }

    #[test]
    fn hit_measure_takes_the_axis_with_the_most_samples_per_world_unit() {
        let cam = Arcball::new([800, 600]);
        let iso = crate::transform::compute_volume_transform([256, 256, 256], [1.0, 1.0, 1.0]);
        let dense_x =
            crate::transform::compute_volume_transform([256, 256, 1024], [1.0, 1.0, 0.25]);
        assert_eq!(
            iso.model, dense_x.model,
            "the boxes must coincide in world space"
        );
        let a = cam.pixels_per_sample_at_hit(Some(&iso), [256, 256, 256]);
        let b = cam.pixels_per_sample_at_hit(Some(&dense_x), [256, 256, 1024]);
        assert!(a > 0.0 && a.is_finite());
        assert!((b - a / 4.0).abs() < 1e-9, "{b} vs {}", a / 4.0);
    }

    #[test]
    fn hit_measure_scales_with_backing_pixels_and_falls_with_distance() {
        let t = crate::transform::compute_volume_transform([256, 256, 256], [1.0, 1.0, 1.0]);
        let shape = [256, 256, 256];
        let near = Arcball::new([800, 600]);
        let retina = Arcball::new([1600, 1200]);
        let a = near.pixels_per_sample_at_hit(Some(&t), shape);
        let b = retina.pixels_per_sample_at_hit(Some(&t), shape);
        assert!(
            (b - 2.0 * a).abs() < 1e-9,
            "twice the device pixels: {b} vs {a}"
        );

        let mut far = Arcball::new([800, 600]);
        far.distance *= 4.0;
        assert!(far.pixels_per_sample_at_hit(Some(&t), shape) < a);

        let fly = Fly::new([800, 600]);
        let f = fly.pixels_per_sample_at_hit(Some(&t), shape);
        assert!(f > 0.0 && f.is_finite());
    }

    #[test]
    fn visible_region_reports_the_hit_measure_as_its_effective_zoom() {
        let t = crate::transform::compute_volume_transform([256, 1024, 1024], [1.0, 1.0, 1.0]);
        let shape = [256u32, 1024, 1024];
        let arc = Arcball::new([800, 600]);
        let region = Camera::Arcball(arc.clone()).visible_region(&(0..256), Some(&t), Some(&shape));
        assert_eq!(
            region.effective_zoom,
            arc.pixels_per_sample_at_hit(Some(&t), shape)
        );
        let fly = Fly::new([800, 600]);
        let region = Camera::Fly(fly.clone()).visible_region(&(0..256), Some(&t), Some(&shape));
        assert_eq!(
            region.effective_zoom,
            fly.pixels_per_sample_at_hit(Some(&t), shape)
        );
    }
}
