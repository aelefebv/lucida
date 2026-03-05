use std::ops::Range;

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
}

/// Unified camera: either 2D slice viewing or 3D volume rendering.
#[derive(Debug, Clone)]
pub enum Camera {
    View2D(View2D),
    View3D(View3D),
}

/// 2D pan/zoom camera for slice viewing.
#[derive(Debug, Clone, PartialEq)]
pub struct View2D {
    /// Center of the viewport in world coordinates.
    pub center: [f64; 2],
    /// Zoom level. 1.0 = native resolution, 2.0 = 2x magnification.
    pub zoom: f64,
    /// Viewport size in screen pixels.
    pub viewport: [u32; 2],
}

/// 3D arcball camera for volume rendering.
/// Uses spherical coordinates (theta, phi, distance) around a target point.
#[derive(Clone)]
pub struct View3D {
    pub target: [f64; 3],
    pub theta: f64,
    pub phi: f64,
    pub distance: f64,
    pub fov: f64,
    pub viewport: [u32; 2],
    pub near: f64,
    pub far: f64,
}

impl std::fmt::Debug for View3D {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("View3D")
            .field("target", &self.target)
            .field("theta", &self.theta)
            .field("phi", &self.phi)
            .field("distance", &self.distance)
            .finish()
    }
}

impl Camera {
    pub fn new_2d(viewport: [u32; 2]) -> Self {
        Camera::View2D(View2D::new(viewport))
    }

    pub fn new_3d(viewport: [u32; 2]) -> Self {
        Camera::View3D(View3D::new(viewport))
    }

    pub fn viewport(&self) -> [u32; 2] {
        match self {
            Camera::View2D(v) => v.viewport,
            Camera::View3D(v) => v.viewport,
        }
    }

    pub fn set_viewport(&mut self, w: u32, h: u32) {
        match self {
            Camera::View2D(v) => v.viewport = [w, h],
            Camera::View3D(v) => v.viewport = [w, h],
        }
    }

    pub fn effective_zoom(&self) -> f64 {
        match self {
            Camera::View2D(v) => v.zoom,
            Camera::View3D(v) => v.effective_zoom(),
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
            Camera::View2D(v) => {
                let bounds = v.world_bounds();
                VisibleRegion {
                    xy_bounds: bounds,
                    z_range: view_z_range.clone(),
                    effective_zoom: v.zoom,
                }
            }
            Camera::View3D(v) => {
                v.frustum_visible_region(volume_transform, volume_shape)
            }
        }
    }
}

// --- View2D implementation ---

impl View2D {
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

// --- View3D implementation ---

impl View3D {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            target: [0.0, 0.0, 0.0],
            theta: 0.5,
            phi: 0.8,
            distance: 1.8,
            fov: std::f64::consts::FRAC_PI_4,
            viewport,
            near: 0.01,
            far: 100.0,
        }
    }

    pub fn rotate(&mut self, d_theta: f64, d_phi: f64) {
        self.theta += d_theta;
        self.phi = (self.phi + d_phi).clamp(0.01, std::f64::consts::PI - 0.01);
    }

    pub fn zoom(&mut self, delta: f64) {
        self.distance = (self.distance * (1.0 + delta)).max(0.1);
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        let eye = self.eye_position();
        let forward = normalize3([
            self.target[0] - eye[0],
            self.target[1] - eye[1],
            self.target[2] - eye[2],
        ]);
        let right = normalize3(cross3(forward, [0.0, 1.0, 0.0]));
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

    /// Effective zoom: screen pixels per world unit at the target plane.
    pub fn effective_zoom(&self) -> f64 {
        self.viewport[1] as f64 / (2.0 * self.distance * (self.fov / 2.0).tan())
    }

    /// Inverse view-projection matrix as f32 for the GPU.
    pub fn inv_view_proj(&self) -> [f32; 16] {
        let vp = self.view_proj_f64();
        invert4_f32(vp)
    }

    /// View-projection matrix in f64 for internal use.
    fn view_proj_f64(&self) -> [f64; 16] {
        let aspect = self.viewport[0] as f64 / self.viewport[1] as f64;
        let proj = perspective(self.fov, aspect, self.near, self.far);
        let eye = self.eye_position();
        let view = look_at(eye, self.target, [0.0, 1.0, 0.0]);
        mul4(proj, view)
    }

    /// Compute the visible region in voxel coordinates by unprojecting the frustum.
    fn frustum_visible_region(
        &self,
        volume_transform: Option<&VolumeTransform>,
        volume_shape: Option<&[u32; 3]>,
    ) -> VisibleRegion {
        let shape = volume_shape.copied().unwrap_or([1, 1, 1]);
        let inv_vp = invert4_f64(self.view_proj_f64());

        // Unproject 8 NDC corners through inv_view_proj → world AABB
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

        let mut world_min = [f64::MAX; 3];
        let mut world_max = [f64::MIN; 3];

        for corner in &ndc_corners {
            let world = unproject(corner, &inv_vp);
            for i in 0..3 {
                world_min[i] = world_min[i].min(world[i]);
                world_max[i] = world_max[i].max(world[i]);
            }
        }

        // Transform world AABB corners through inv_model → voxel [0,1]^3 space
        let inv_model: [f64; 16] = match volume_transform {
            Some(t) => t.inv_model.map(|v| v as f64),
            None => [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };

        // Build 8 corners of the world AABB and transform each
        let mut voxel_min = [f64::MAX; 3];
        let mut voxel_max = [f64::MIN; 3];

        for &cx in &[world_min[0], world_max[0]] {
            for &cy in &[world_min[1], world_max[1]] {
                for &cz in &[world_min[2], world_max[2]] {
                    let unit = transform_point([cx, cy, cz], &inv_model);
                    // unit is in [0,1]^3; scale to voxel coords
                    // shape is [Z, Y, X]
                    let vx = unit[0] * shape[2] as f64;
                    let vy = unit[1] * shape[1] as f64;
                    let vz = unit[2] * shape[0] as f64;
                    voxel_min[0] = voxel_min[0].min(vx);
                    voxel_min[1] = voxel_min[1].min(vy);
                    voxel_min[2] = voxel_min[2].min(vz);
                    voxel_max[0] = voxel_max[0].max(vx);
                    voxel_max[1] = voxel_max[1].max(vy);
                    voxel_max[2] = voxel_max[2].max(vz);
                }
            }
        }

        // Clamp to volume bounds
        voxel_min[0] = voxel_min[0].max(0.0);
        voxel_min[1] = voxel_min[1].max(0.0);
        voxel_min[2] = voxel_min[2].max(0.0);
        voxel_max[0] = voxel_max[0].min(shape[2] as f64);
        voxel_max[1] = voxel_max[1].min(shape[1] as f64);
        voxel_max[2] = voxel_max[2].min(shape[0] as f64);

        let z_start = voxel_min[2].floor().max(0.0) as u32;
        let z_end = voxel_max[2].ceil().max(0.0) as u32;

        // Convert effective_zoom from pixels-per-world-unit to pixels-per-voxel.
        // The model matrix scales each axis: model[0]=sx, model[5]=sy, model[10]=sz.
        // Voxels per world unit in each axis = shape[i] / model_scale[i].
        // Use the max to get the most conservative (finest) LOD selection.
        let (sx, sy, sz) = match volume_transform {
            Some(t) => (t.model[0] as f64, t.model[5] as f64, t.model[10] as f64),
            None => (1.0, 1.0, 1.0),
        };
        let vpw_x = shape[2] as f64 / sx.abs().max(1e-12);
        let vpw_y = shape[1] as f64 / sy.abs().max(1e-12);
        let vpw_z = shape[0] as f64 / sz.abs().max(1e-12);
        let max_vpw = vpw_x.max(vpw_y).max(vpw_z);
        let zoom_per_voxel = self.effective_zoom() / max_vpw;

        VisibleRegion {
            xy_bounds: [voxel_min[0], voxel_min[1], voxel_max[0], voxel_max[1]],
            z_range: z_start..z_end.max(z_start),
            effective_zoom: zoom_per_voxel,
        }
    }
}

// --- Private mat4 helpers (column-major, f64 internally) ---

fn perspective(fov_y: f64, aspect: f64, near: f64, far: f64) -> [f64; 16] {
    let f = 1.0 / (fov_y / 2.0).tan();
    let nf = 1.0 / (near - far);
    let mut m = [0.0; 16];
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1.0;
    m[14] = 2.0 * far * near * nf;
    m
}

fn look_at(eye: [f64; 3], target: [f64; 3], up: [f64; 3]) -> [f64; 16] {
    let z = normalize3([
        eye[0] - target[0],
        eye[1] - target[1],
        eye[2] - target[2],
    ]);
    let x = normalize3(cross3(up, z));
    let y = cross3(z, x);

    let mut m = [0.0; 16];
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
    m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
    m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
    m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
    m[15] = 1.0;
    m
}

fn mul4(a: [f64; 16], b: [f64; 16]) -> [f64; 16] {
    let mut out = [0.0; 16];
    for i in 0..4 {
        for j in 0..4 {
            out[j * 4 + i] = a[i] * b[j * 4]
                + a[4 + i] * b[j * 4 + 1]
                + a[8 + i] * b[j * 4 + 2]
                + a[12 + i] * b[j * 4 + 3];
        }
    }
    out
}

/// Invert a 4x4 matrix, returning f32 (for GPU).
fn invert4_f32(m: [f64; 16]) -> [f32; 16] {
    let inv = invert4_f64(m);
    let mut out = [0.0f32; 16];
    for i in 0..16 {
        out[i] = inv[i] as f32;
    }
    out
}

/// Invert a 4x4 matrix in f64 (for internal precision).
fn invert4_f64(m: [f64; 16]) -> [f64; 16] {
    let s = m;
    let mut inv = [0.0f64; 16];

    inv[0]  =  s[5]*s[10]*s[15] - s[5]*s[11]*s[14] - s[9]*s[6]*s[15] + s[9]*s[7]*s[14] + s[13]*s[6]*s[11] - s[13]*s[7]*s[10];
    inv[4]  = -s[4]*s[10]*s[15] + s[4]*s[11]*s[14] + s[8]*s[6]*s[15] - s[8]*s[7]*s[14] - s[12]*s[6]*s[11] + s[12]*s[7]*s[10];
    inv[8]  =  s[4]*s[9]*s[15]  - s[4]*s[11]*s[13] - s[8]*s[5]*s[15] + s[8]*s[7]*s[13] + s[12]*s[5]*s[11] - s[12]*s[7]*s[9];
    inv[12] = -s[4]*s[9]*s[14]  + s[4]*s[10]*s[13] + s[8]*s[5]*s[14] - s[8]*s[6]*s[13] - s[12]*s[5]*s[10] + s[12]*s[6]*s[9];

    inv[1]  = -s[1]*s[10]*s[15] + s[1]*s[11]*s[14] + s[9]*s[2]*s[15] - s[9]*s[3]*s[14] - s[13]*s[2]*s[11] + s[13]*s[3]*s[10];
    inv[5]  =  s[0]*s[10]*s[15] - s[0]*s[11]*s[14] - s[8]*s[2]*s[15] + s[8]*s[3]*s[14] + s[12]*s[2]*s[11] - s[12]*s[3]*s[10];
    inv[9]  = -s[0]*s[9]*s[15]  + s[0]*s[11]*s[13] + s[8]*s[1]*s[15] - s[8]*s[3]*s[13] - s[12]*s[1]*s[11] + s[12]*s[3]*s[9];
    inv[13] =  s[0]*s[9]*s[14]  - s[0]*s[10]*s[13] - s[8]*s[1]*s[14] + s[8]*s[2]*s[13] + s[12]*s[1]*s[10] - s[12]*s[2]*s[9];

    inv[2]  =  s[1]*s[6]*s[15] - s[1]*s[7]*s[14] - s[5]*s[2]*s[15] + s[5]*s[3]*s[14] + s[13]*s[2]*s[7] - s[13]*s[3]*s[6];
    inv[6]  = -s[0]*s[6]*s[15] + s[0]*s[7]*s[14] + s[4]*s[2]*s[15] - s[4]*s[3]*s[14] - s[12]*s[2]*s[7] + s[12]*s[3]*s[6];
    inv[10] =  s[0]*s[5]*s[15] - s[0]*s[7]*s[13] - s[4]*s[1]*s[15] + s[4]*s[3]*s[13] + s[12]*s[1]*s[7] - s[12]*s[3]*s[5];
    inv[14] = -s[0]*s[5]*s[14] + s[0]*s[6]*s[13] + s[4]*s[1]*s[14] - s[4]*s[2]*s[13] - s[12]*s[1]*s[6] + s[12]*s[2]*s[5];

    inv[3]  = -s[1]*s[6]*s[11] + s[1]*s[7]*s[10] + s[5]*s[2]*s[11] - s[5]*s[3]*s[10] - s[9]*s[2]*s[7] + s[9]*s[3]*s[6];
    inv[7]  =  s[0]*s[6]*s[11] - s[0]*s[7]*s[10] - s[4]*s[2]*s[11] + s[4]*s[3]*s[10] + s[8]*s[2]*s[7] - s[8]*s[3]*s[6];
    inv[11] = -s[0]*s[5]*s[11] + s[0]*s[7]*s[9]  + s[4]*s[1]*s[11] - s[4]*s[3]*s[9]  - s[8]*s[1]*s[7] + s[8]*s[3]*s[5];
    inv[15] =  s[0]*s[5]*s[10] - s[0]*s[6]*s[9]  - s[4]*s[1]*s[10] + s[4]*s[2]*s[9]  + s[8]*s[1]*s[6] - s[8]*s[2]*s[5];

    let det = s[0]*inv[0] + s[1]*inv[4] + s[2]*inv[8] + s[3]*inv[12];
    let inv_det = 1.0 / det;

    let mut out = [0.0f64; 16];
    for i in 0..16 {
        out[i] = inv[i] * inv_det;
    }
    out
}

fn normalize3(v: [f64; 3]) -> [f64; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len < 1e-12 {
        return [0.0, 0.0, 0.0];
    }
    [v[0] / len, v[1] / len, v[2] / len]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Unproject an NDC point through an inverse view-projection matrix.
fn unproject(ndc: &[f64; 3], inv_vp: &[f64; 16]) -> [f64; 3] {
    let x = inv_vp[0] * ndc[0] + inv_vp[4] * ndc[1] + inv_vp[8]  * ndc[2] + inv_vp[12];
    let y = inv_vp[1] * ndc[0] + inv_vp[5] * ndc[1] + inv_vp[9]  * ndc[2] + inv_vp[13];
    let z = inv_vp[2] * ndc[0] + inv_vp[6] * ndc[1] + inv_vp[10] * ndc[2] + inv_vp[14];
    let w = inv_vp[3] * ndc[0] + inv_vp[7] * ndc[1] + inv_vp[11] * ndc[2] + inv_vp[15];
    [x / w, y / w, z / w]
}

/// Transform a 3D point by a 4x4 column-major matrix (assuming w=1).
fn transform_point(p: [f64; 3], m: &[f64; 16]) -> [f64; 3] {
    let x = m[0] * p[0] + m[4] * p[1] + m[8]  * p[2] + m[12];
    let y = m[1] * p[0] + m[5] * p[1] + m[9]  * p[2] + m[13];
    let z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    [x / w, y / w, z / w]
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- View2D tests (preserved from original Camera tests) ---

    #[test]
    fn initial_camera_centered_at_origin() {
        let cam = Camera::new_2d([800, 600]);
        if let Camera::View2D(v) = &cam {
            assert_eq!(v.center, [0.0, 0.0]);
            assert_eq!(v.zoom, 1.0);
        } else {
            panic!("expected View2D");
        }
    }

    #[test]
    fn pan_moves_center_in_world_space() {
        let cam = Camera::new_2d([800, 600]);
        if let Camera::View2D(mut v) = cam {
            v.pan(100.0, -50.0);
            assert_eq!(v.center, [100.0, -50.0]);
        }
    }

    #[test]
    fn pan_is_scaled_by_zoom() {
        let cam = Camera::new_2d([800, 600]);
        if let Camera::View2D(mut v) = cam {
            v.zoom = 2.0;
            v.pan(100.0, 0.0);
            assert_eq!(v.center[0], 50.0);
        }
    }

    #[test]
    fn world_bounds_at_default_zoom() {
        let v = View2D::new([800, 600]);
        let [min_x, min_y, max_x, max_y] = v.world_bounds();
        assert_eq!(min_x, -400.0);
        assert_eq!(min_y, -300.0);
        assert_eq!(max_x, 400.0);
        assert_eq!(max_y, 300.0);
    }

    #[test]
    fn world_bounds_shrink_when_zoomed_in() {
        let mut v = View2D::new([800, 600]);
        v.zoom_by(2.0);
        let [min_x, min_y, max_x, max_y] = v.world_bounds();
        assert_eq!(min_x, -200.0);
        assert_eq!(min_y, -150.0);
        assert_eq!(max_x, 200.0);
        assert_eq!(max_y, 150.0);
    }

    // --- View3D tests (preserved from original Camera3D tests) ---

    #[test]
    fn default_eye_position() {
        let cam = View3D::new([800, 600]);
        let eye = cam.eye_position();
        let dist = (eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]).sqrt();
        assert!((dist - 1.8).abs() < 1e-10);
    }

    #[test]
    fn rotate_clamps_phi() {
        let mut cam = View3D::new([800, 600]);
        cam.rotate(0.0, 100.0);
        assert!(cam.phi < std::f64::consts::PI);
        cam.rotate(0.0, -200.0);
        assert!(cam.phi > 0.0);
    }

    #[test]
    fn zoom_clamps_min() {
        let mut cam = View3D::new([800, 600]);
        cam.zoom(-0.99);
        assert!(cam.distance >= 0.1);
    }

    #[test]
    fn pan_moves_target() {
        let mut cam = View3D::new([800, 600]);
        let orig = cam.target;
        cam.pan(10.0, 10.0);
        assert!(cam.target != orig);
    }

    #[test]
    fn inv_view_proj_is_finite() {
        let cam = View3D::new([800, 600]);
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
        let cam = View3D::new([800, 600]);
        let expected = 600.0 / (2.0 * 1.8 * (std::f64::consts::FRAC_PI_4 / 2.0).tan());
        assert!((cam.effective_zoom() - expected).abs() < 1e-10);
    }

    #[test]
    fn frustum_visible_region_identity_returns_sensible_aabb() {
        let cam = View3D::new([800, 600]);
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
}
