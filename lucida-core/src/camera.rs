use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::mat4::{
    cross3, invert4_f32, invert4_f64, look_at, mul4, normalize3, perspective, transform_point,
    unproject,
};
use crate::transform::VolumeTransform;

/// Axis-aligned bounding box in voxel space, plus effective zoom for LOD selection.
/// This is what chunk planning needs — not a camera.
#[derive(Debug, Clone)]
pub struct VisibleRegion {
    /// [min_x, min_y, max_x, max_y] in voxel coordinates.
    pub xy_bounds: [f64; 4],
    /// Voxel z range.
    pub z_range: Range<u32>,
    /// For LOD selection: screen pixels per world unit at the focal plane.
    pub effective_zoom: f64,
    /// Optional sort center in voxel coordinates [x, y, z] for center-out chunk loading.
    /// When `Some`, chunks are sorted by distance to this point instead of the grid midpoint.
    pub sort_center: Option<[f64; 3]>,
    /// Optional frustum planes in full-resolution voxel coordinates for per-chunk culling.
    /// Each plane is [a, b, c, d] where ax + by + cz + d >= 0 means inside.
    pub frustum_planes: Option<[[f64; 4]; 6]>,
}

/// Clip mode for near-clip distance: plane (perpendicular to view direction)
/// or sphere (radial distance from camera position).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ClipMode {
    Plane,
    Sphere,
}

impl Default for ClipMode {
    fn default() -> Self {
        ClipMode::Plane
    }
}

/// Unified camera: 2D slice viewing, 3D arcball, or free-fly.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Clone, Serialize, Deserialize)]
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
#[derive(Clone, Serialize, Deserialize)]
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

    /// Projects a world-space point to screen-space pixel coordinates.
    /// Returns `None` if the point is behind the camera (3D modes only).
    pub fn project_to_screen(&self, world_point: [f64; 3]) -> Option<[f64; 2]> {
        match self {
            Camera::Slice(v) => {
                let sx = (world_point[0] - v.center[0]) * v.zoom + v.viewport[0] as f64 / 2.0;
                let sy = (world_point[1] - v.center[1]) * v.zoom + v.viewport[1] as f64 / 2.0;
                Some([sx, sy])
            }
            Camera::Arcball(v) => {
                project_3d(world_point, &v.view_proj_f64(), v.viewport)
            }
            Camera::Fly(v) => {
                project_3d(world_point, &v.view_proj_f64(), v.viewport)
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
                    sort_center: None,
                    frustum_planes: None,
                }
            }
            Camera::Arcball(v) => {
                v.frustum_visible_region(volume_transform, volume_shape)
            }
            Camera::Fly(v) => {
                v.frustum_visible_region(volume_transform, volume_shape)
            }
        }
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
        self.center[0] += dx / self.zoom;
        self.center[1] += dy / self.zoom;
    }

    pub fn zoom_by(&mut self, factor: f64) {
        self.zoom *= factor;
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
        self.theta += d_theta;
        self.phi += d_phi;
    }

    pub fn zoom(&mut self, delta: f64) {
        self.distance = (self.distance * (1.0 + delta)).max(self.near);
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
        for i in 0..3 {
            self.target[i] += (right[i] * -dx + up[i] * dy) * scale;
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
    /// box surface if the ray misses (so distance calculations remain meaningful).
    pub fn ray_hit_local(&self, inv_model: &[f64; 16]) -> [f64; 3] {
        let eye_unit = transform_point(self.eye_position(), inv_model);
        let target_unit = transform_point(self.target, inv_model);
        let dir = [
            target_unit[0] - eye_unit[0],
            target_unit[1] - eye_unit[1],
            target_unit[2] - eye_unit[2],
        ];
        ray_aabb_hit(eye_unit, dir, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
            .unwrap_or_else(|| closest_point_on_aabb(eye_unit, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]))
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
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };

        // Unproject 8 NDC corners → world → inv_model → voxel directly (single AABB step).
        // This avoids the double-AABB expansion that occurs when computing an intermediate
        // world-space AABB then transforming its corners to voxel space.
        let ndc_corners: [[f64; 3]; 8] = [
            [-1.0, -1.0, -1.0],
            [ 1.0, -1.0, -1.0],
            [-1.0,  1.0, -1.0],
            [ 1.0,  1.0, -1.0],
            [-1.0, -1.0,  1.0],
            [ 1.0, -1.0,  1.0],
            [-1.0,  1.0,  1.0],
            [ 1.0,  1.0,  1.0],
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
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };
        let vp_model = mul4(self.view_proj_f64(), model_f64);
        // Scale columns to convert from image-convention voxel coords to unit [0,1]^3,
        // with Y flipped (image row 0 = top = unit Y 1.0).
        let mut m = vp_model;
        for i in 0..4 {
            let c1 = m[4 + i]; // save col 1 before modification
            m[i]      /= shape_x;  // col 0 (X voxels)
            m[4 + i]  /= -shape_y; // col 1 (Y voxels, negated for flip)
            m[8 + i]  /= shape_z;  // col 2 (Z voxels)
            m[12 + i] += c1;       // col 3 (translation from Y flip)
        }

        // Extract 6 frustum planes from column-major MVP matrix.
        // Plane [a, b, c, d] where a*vx + b*vy + c*vz + d >= 0 means inside.
        let frustum_planes = [
            // Left:   row3 + row0
            [m[3] + m[0], m[7] + m[4], m[11] + m[8],  m[15] + m[12]],
            // Right:  row3 - row0
            [m[3] - m[0], m[7] - m[4], m[11] - m[8],  m[15] - m[12]],
            // Bottom: row3 + row1
            [m[3] + m[1], m[7] + m[5], m[11] + m[9],  m[15] + m[13]],
            // Top:    row3 - row1
            [m[3] - m[1], m[7] - m[5], m[11] - m[9],  m[15] - m[13]],
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

/// Normalize a quaternion to unit length.
pub(crate) fn quat_normalize(q: [f64; 4]) -> [f64; 4] {
    let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if len < 1e-12 {
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
    let x2 = x + x; let y2 = y + y; let z2 = z + z;
    let xx = x * x2; let xy = x * y2; let xz = x * z2;
    let yy = y * y2; let yz = y * z2; let zz = z * z2;
    let wx = w * x2; let wy = w * y2; let wz = w * z2;
    [
        [1.0 - (yy + zz), xy - wz,         xz + wy        ],
        [xy + wz,         1.0 - (xx + zz),  yz - wx        ],
        [xz - wy,         yz + wx,          1.0 - (xx + yy)],
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

    /// Advance the fly camera by one tick.
    ///
    /// `dt`: seconds since last tick (clamped to 0.1)
    /// `forward/right/up`: movement input (-1, 0, or 1)
    /// `yaw/pitch/roll`: rotation input (radians per second)
    pub fn fly_tick(&mut self, dt: f64, forward: f64, right: f64, up: f64, yaw: f64, pitch: f64, roll: f64) {
        let dt = dt.min(0.1);

        // Apply rotation: build axis-angle quaternions for each rotation axis
        // yaw = rotation around camera's local Y axis
        // pitch = rotation around camera's local X axis
        // roll = rotation around camera's local -Z axis (forward)
        if yaw.abs() > 1e-12 || pitch.abs() > 1e-12 || roll.abs() > 1e-12 {
            let q_yaw = quat_from_axis_angle([0.0, 1.0, 0.0], yaw * dt);
            let q_pitch = quat_from_axis_angle([1.0, 0.0, 0.0], pitch * dt);
            let q_roll = quat_from_axis_angle([0.0, 0.0, -1.0], roll * dt);
            // Apply in order: yaw, then pitch, then roll (local-space rotations)
            // For local rotations: new_orientation = orientation * local_rotation
            let local_rot = quat_multiply(quat_multiply(q_yaw, q_pitch), q_roll);
            self.orientation = quat_normalize(quat_multiply(self.orientation, local_rot));
        }

        // Apply translation using camera's local axes
        if forward.abs() > 1e-12 || right.abs() > 1e-12 || up.abs() > 1e-12 {
            let forward_vec = quat_rotate_vector(self.orientation, [0.0, 0.0, -1.0]);
            let right_vec = quat_rotate_vector(self.orientation, [1.0, 0.0, 0.0]);
            let up_vec = quat_rotate_vector(self.orientation, [0.0, 1.0, 0.0]);
            let speed = self.base_speed * self.speed_multiplier * dt;
            for i in 0..3 {
                self.position[i] +=
                    (forward_vec[i] * forward + right_vec[i] * right + up_vec[i] * up) * speed;
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
    /// Returns the closest point on the box surface if the ray misses.
    pub fn ray_hit_local(&self, inv_model: &[f64; 16]) -> [f64; 3] {
        let eye_unit = transform_point(self.position, inv_model);
        let target = self.target();
        let target_unit = transform_point(target, inv_model);
        let dir = [
            target_unit[0] - eye_unit[0],
            target_unit[1] - eye_unit[1],
            target_unit[2] - eye_unit[2],
        ];
        ray_aabb_hit(eye_unit, dir, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
            .unwrap_or_else(|| closest_point_on_aabb(eye_unit, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]))
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
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };

        let ndc_corners: [[f64; 3]; 8] = [
            [-1.0, -1.0, -1.0],
            [ 1.0, -1.0, -1.0],
            [-1.0,  1.0, -1.0],
            [ 1.0,  1.0, -1.0],
            [-1.0, -1.0,  1.0],
            [ 1.0, -1.0,  1.0],
            [-1.0,  1.0,  1.0],
            [ 1.0,  1.0,  1.0],
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
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };
        let vp_model = mul4(self.view_proj_f64(), model_f64);
        let mut m = vp_model;
        for i in 0..4 {
            let c1 = m[4 + i];
            m[i]      /= shape_x;
            m[4 + i]  /= -shape_y;
            m[8 + i]  /= shape_z;
            m[12 + i] += c1;
        }

        let frustum_planes = [
            [m[3] + m[0], m[7] + m[4], m[11] + m[8],  m[15] + m[12]],
            [m[3] - m[0], m[7] - m[4], m[11] - m[8],  m[15] - m[12]],
            [m[3] + m[1], m[7] + m[5], m[11] + m[9],  m[15] + m[13]],
            [m[3] - m[1], m[7] - m[5], m[11] - m[9],  m[15] - m[13]],
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
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
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
fn project_3d(world_point: [f64; 3], view_proj: &[f64; 16], viewport: [u32; 2]) -> Option<[f64; 2]> {
    let [x, y, z] = world_point;
    let vp = view_proj;
    // Multiply by view-projection matrix (column-major)
    let clip_x = vp[0] * x + vp[4] * y + vp[8]  * z + vp[12];
    let clip_y = vp[1] * x + vp[5] * y + vp[9]  * z + vp[13];
    let clip_w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];

    if clip_w <= 0.0 {
        return None;
    }

    // Perspective divide -> NDC [-1, 1]
    let ndc_x = clip_x / clip_w;
    let ndc_y = clip_y / clip_w;

    // NDC to screen pixels: x: [-1,1] -> [0, width], y: [-1,1] -> [height, 0] (y flipped)
    let sx = (ndc_x + 1.0) * 0.5 * viewport[0] as f64;
    let sy = (1.0 - ndc_y) * 0.5 * viewport[1] as f64;

    Some([sx, sy])
}

/// Closest point on an AABB to a given point (clamped to the box surface).
fn closest_point_on_aabb(
    point: [f64; 3],
    box_min: [f64; 3],
    box_max: [f64; 3],
) -> [f64; 3] {
    [
        point[0].clamp(box_min[0], box_max[0]),
        point[1].clamp(box_min[1], box_max[1]),
        point[2].clamp(box_min[2], box_max[2]),
    ]
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
            assert!(val.is_finite(), "Matrix contains non-finite value at extreme phi: {}", val);
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
    }

    #[test]
    fn visible_region_2d_uses_view_z_range() {
        let cam = Camera::new_2d([512, 512]);
        let region = cam.visible_region(&(10..20), None, None);
        assert_eq!(region.z_range, 10..20);
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
            assert!((result[i] - q[i]).abs() < 1e-12, "q * identity mismatch at {i}");
        }
        let result2 = quat_multiply(identity, q);
        for i in 0..4 {
            assert!((result2[i] - q[i]).abs() < 1e-12, "identity * q mismatch at {i}");
        }
    }

    #[test]
    fn quat_multiply_composition_two_90_degrees() {
        // Two 90-degree rotations around Y = one 180-degree rotation
        let q90 = quat_from_axis_angle([0.0, 1.0, 0.0], std::f64::consts::FRAC_PI_2);
        let q180 = quat_multiply(q90, q90);
        let expected = quat_from_axis_angle([0.0, 1.0, 0.0], std::f64::consts::PI);
        // Quaternions q and -q represent the same rotation
        let sign = if q180[3] * expected[3] < 0.0 { -1.0 } else { 1.0 };
        for i in 0..4 {
            assert!((q180[i] - sign * expected[i]).abs() < 1e-10,
                "180-degree composition mismatch at {i}: {} vs {}", q180[i], expected[i]);
        }
    }

    #[test]
    fn quat_from_axis_angle_produces_unit() {
        let q = quat_from_axis_angle([0.0, 1.0, 0.0], 1.23);
        let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        assert!((len - 1.0).abs() < 1e-12, "quaternion not unit length: {len}");
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
            assert!((cam1.position[i] - cam2.position[i]).abs() < 1e-12,
                "position mismatch at {i}: {} vs {}", cam1.position[i], cam2.position[i]);
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
                assert!((actual - expected).abs() < 1e-3,
                    "vp*inv_vp [{i},{j}] = {actual}, expected {expected}");
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
            assert!((arcball_eye[i] - fly_eye[i]).abs() < 1e-6,
                "eye position mismatch at {i}: {} vs {}", arcball_eye[i], fly_eye[i]);
        }
    }

    #[test]
    fn arcball_to_fly_preserves_view_direction() {
        let arcball = Arcball::new([800, 600]);
        let fly = arcball.to_fly();
        let arcball_dir = arcball.forward_direction();
        let fly_dir = fly.forward_vector();
        for i in 0..3 {
            assert!((arcball_dir[i] - fly_dir[i]).abs() < 1e-6,
                "view direction mismatch at {i}: {} vs {}", arcball_dir[i], fly_dir[i]);
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
        assert!(json.contains("\"mode\":\"fly\""), "should contain fly mode tag");
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
        assert!(arcball.distance > 0.0, "distance should be positive: {}", arcball.distance);
        // theta and phi should be finite
        assert!(arcball.theta.is_finite(), "theta should be finite");
        assert!(arcball.phi.is_finite(), "phi should be finite");
        // fov should be preserved
        assert!((arcball.fov - fly.fov).abs() < 1e-10, "fov should be preserved");
        // viewport should be preserved
        assert_eq!(arcball.viewport, fly.viewport, "viewport should be preserved");
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
        let dot = original_dir[0] * rt_dir[0]
            + original_dir[1] * rt_dir[1]
            + original_dir[2] * rt_dir[2];
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
                assert!((v.orientation[i] - fly.orientation[i]).abs() < 1e-12,
                    "orientation mismatch at {i}");
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
}
