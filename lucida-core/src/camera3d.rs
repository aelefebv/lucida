/// 3D arcball camera for volume rendering.
///
/// Uses spherical coordinates (theta, phi, distance) around a target point.
/// Provides view-projection matrix computation with no external dependencies.

pub struct Camera3D {
    pub target: [f64; 3],
    pub theta: f64,           // azimuth angle
    pub phi: f64,             // elevation angle (clamped 0.01..PI-0.01)
    pub distance: f64,        // distance from target
    pub fov: f64,             // vertical FOV in radians
    pub viewport: [u32; 2],   // [width, height]
    pub near: f64,
    pub far: f64,
}

impl std::fmt::Debug for Camera3D {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Camera3D")
            .field("target", &self.target)
            .field("theta", &self.theta)
            .field("phi", &self.phi)
            .field("distance", &self.distance)
            .finish()
    }
}

impl Camera3D {
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

    pub fn inv_view_proj(&self) -> [f32; 16] {
        let aspect = self.viewport[0] as f64 / self.viewport[1] as f64;
        let proj = perspective(self.fov, aspect, self.near, self.far);
        let eye = self.eye_position();
        let view = look_at(eye, self.target, [0.0, 1.0, 0.0]);
        let vp = mul4(proj, view);
        invert4(vp)
    }
}

// --- Private mat4 helpers (column-major, f64 internally, output f32) ---

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

fn invert4(m: [f64; 16]) -> [f32; 16] {
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

    let mut out = [0.0f32; 16];
    for i in 0..16 {
        out[i] = (inv[i] * inv_det) as f32;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_eye_position() {
        let cam = Camera3D::new([800, 600]);
        let eye = cam.eye_position();
        // Should be at distance 1.8 from origin
        let dist = (eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]).sqrt();
        assert!((dist - 1.8).abs() < 1e-10);
    }

    #[test]
    fn rotate_clamps_phi() {
        let mut cam = Camera3D::new([800, 600]);
        cam.rotate(0.0, 100.0);
        assert!(cam.phi < std::f64::consts::PI);
        cam.rotate(0.0, -200.0);
        assert!(cam.phi > 0.0);
    }

    #[test]
    fn zoom_clamps_min() {
        let mut cam = Camera3D::new([800, 600]);
        cam.zoom(-0.99);
        assert!(cam.distance >= 0.1);
    }

    #[test]
    fn pan_moves_target() {
        let mut cam = Camera3D::new([800, 600]);
        let orig = cam.target;
        cam.pan(10.0, 10.0);
        assert!(cam.target != orig);
    }

    #[test]
    fn inv_view_proj_is_finite() {
        let cam = Camera3D::new([800, 600]);
        let m = cam.inv_view_proj();
        for val in &m {
            assert!(val.is_finite(), "Matrix contains non-finite value: {}", val);
        }
    }
}
