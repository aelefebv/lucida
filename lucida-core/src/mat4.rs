// --- Column-major mat4/vec3 helpers (f64 internally) ---

pub(crate) fn perspective(fov_y: f64, aspect: f64, near: f64, far: f64) -> [f64; 16] {
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

pub(crate) fn look_at(eye: [f64; 3], target: [f64; 3], up: [f64; 3]) -> [f64; 16] {
    let z = normalize3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
    let x = normalize3(cross3(up, z));
    let y = cross3(z, x);

    let mut m = [0.0; 16];
    m[0] = x[0];
    m[1] = y[0];
    m[2] = z[0];
    m[4] = x[1];
    m[5] = y[1];
    m[6] = z[1];
    m[8] = x[2];
    m[9] = y[2];
    m[10] = z[2];
    m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
    m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
    m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
    m[15] = 1.0;
    m
}

pub(crate) fn mul4(a: [f64; 16], b: [f64; 16]) -> [f64; 16] {
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
pub(crate) fn invert4_f32(m: [f64; 16]) -> [f32; 16] {
    let inv = invert4_f64(m);
    let mut out = [0.0f32; 16];
    for i in 0..16 {
        out[i] = inv[i] as f32;
    }
    out
}

/// Invert a 4x4 matrix in f64 (for internal precision).
pub(crate) fn invert4_f64(m: [f64; 16]) -> [f64; 16] {
    let s = m;
    let mut inv = [0.0f64; 16];

    inv[0] = s[5] * s[10] * s[15] - s[5] * s[11] * s[14] - s[9] * s[6] * s[15]
        + s[9] * s[7] * s[14]
        + s[13] * s[6] * s[11]
        - s[13] * s[7] * s[10];
    inv[4] = -s[4] * s[10] * s[15] + s[4] * s[11] * s[14] + s[8] * s[6] * s[15]
        - s[8] * s[7] * s[14]
        - s[12] * s[6] * s[11]
        + s[12] * s[7] * s[10];
    inv[8] = s[4] * s[9] * s[15] - s[4] * s[11] * s[13] - s[8] * s[5] * s[15]
        + s[8] * s[7] * s[13]
        + s[12] * s[5] * s[11]
        - s[12] * s[7] * s[9];
    inv[12] = -s[4] * s[9] * s[14] + s[4] * s[10] * s[13] + s[8] * s[5] * s[14]
        - s[8] * s[6] * s[13]
        - s[12] * s[5] * s[10]
        + s[12] * s[6] * s[9];

    inv[1] = -s[1] * s[10] * s[15] + s[1] * s[11] * s[14] + s[9] * s[2] * s[15]
        - s[9] * s[3] * s[14]
        - s[13] * s[2] * s[11]
        + s[13] * s[3] * s[10];
    inv[5] = s[0] * s[10] * s[15] - s[0] * s[11] * s[14] - s[8] * s[2] * s[15]
        + s[8] * s[3] * s[14]
        + s[12] * s[2] * s[11]
        - s[12] * s[3] * s[10];
    inv[9] = -s[0] * s[9] * s[15] + s[0] * s[11] * s[13] + s[8] * s[1] * s[15]
        - s[8] * s[3] * s[13]
        - s[12] * s[1] * s[11]
        + s[12] * s[3] * s[9];
    inv[13] = s[0] * s[9] * s[14] - s[0] * s[10] * s[13] - s[8] * s[1] * s[14]
        + s[8] * s[2] * s[13]
        + s[12] * s[1] * s[10]
        - s[12] * s[2] * s[9];

    inv[2] = s[1] * s[6] * s[15] - s[1] * s[7] * s[14] - s[5] * s[2] * s[15]
        + s[5] * s[3] * s[14]
        + s[13] * s[2] * s[7]
        - s[13] * s[3] * s[6];
    inv[6] = -s[0] * s[6] * s[15] + s[0] * s[7] * s[14] + s[4] * s[2] * s[15]
        - s[4] * s[3] * s[14]
        - s[12] * s[2] * s[7]
        + s[12] * s[3] * s[6];
    inv[10] = s[0] * s[5] * s[15] - s[0] * s[7] * s[13] - s[4] * s[1] * s[15]
        + s[4] * s[3] * s[13]
        + s[12] * s[1] * s[7]
        - s[12] * s[3] * s[5];
    inv[14] = -s[0] * s[5] * s[14] + s[0] * s[6] * s[13] + s[4] * s[1] * s[14]
        - s[4] * s[2] * s[13]
        - s[12] * s[1] * s[6]
        + s[12] * s[2] * s[5];

    inv[3] = -s[1] * s[6] * s[11] + s[1] * s[7] * s[10] + s[5] * s[2] * s[11]
        - s[5] * s[3] * s[10]
        - s[9] * s[2] * s[7]
        + s[9] * s[3] * s[6];
    inv[7] = s[0] * s[6] * s[11] - s[0] * s[7] * s[10] - s[4] * s[2] * s[11]
        + s[4] * s[3] * s[10]
        + s[8] * s[2] * s[7]
        - s[8] * s[3] * s[6];
    inv[11] = -s[0] * s[5] * s[11] + s[0] * s[7] * s[9] + s[4] * s[1] * s[11]
        - s[4] * s[3] * s[9]
        - s[8] * s[1] * s[7]
        + s[8] * s[3] * s[5];
    inv[15] = s[0] * s[5] * s[10] - s[0] * s[6] * s[9] - s[4] * s[1] * s[10]
        + s[4] * s[2] * s[9]
        + s[8] * s[1] * s[6]
        - s[8] * s[2] * s[5];

    let det = s[0] * inv[0] + s[1] * inv[4] + s[2] * inv[8] + s[3] * inv[12];
    let inv_det = 1.0 / det;

    let mut out = [0.0f64; 16];
    for i in 0..16 {
        out[i] = inv[i] * inv_det;
    }
    out
}

pub(crate) fn normalize3(v: [f64; 3]) -> [f64; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len < 1e-12 {
        return [0.0, 0.0, 0.0];
    }
    [v[0] / len, v[1] / len, v[2] / len]
}

pub(crate) fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Unproject an NDC point through an inverse view-projection matrix.
pub(crate) fn unproject(ndc: &[f64; 3], inv_vp: &[f64; 16]) -> [f64; 3] {
    let x = inv_vp[0] * ndc[0] + inv_vp[4] * ndc[1] + inv_vp[8] * ndc[2] + inv_vp[12];
    let y = inv_vp[1] * ndc[0] + inv_vp[5] * ndc[1] + inv_vp[9] * ndc[2] + inv_vp[13];
    let z = inv_vp[2] * ndc[0] + inv_vp[6] * ndc[1] + inv_vp[10] * ndc[2] + inv_vp[14];
    let w = inv_vp[3] * ndc[0] + inv_vp[7] * ndc[1] + inv_vp[11] * ndc[2] + inv_vp[15];
    [x / w, y / w, z / w]
}

/// Transform a 3D point by a 4x4 column-major matrix (assuming w=1).
pub(crate) fn transform_point(p: [f64; 3], m: &[f64; 16]) -> [f64; 3] {
    let x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    let y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    let z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    [x / w, y / w, z / w]
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];

    #[test]
    fn mul4_identity() {
        let a = [
            2.0, 0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 4.0, 0.0, 1.0, 2.0, 3.0, 1.0,
        ];
        let result = mul4(a, IDENTITY);
        for i in 0..16 {
            assert!((result[i] - a[i]).abs() < 1e-12, "mismatch at index {i}");
        }
        let result2 = mul4(IDENTITY, a);
        for i in 0..16 {
            assert!((result2[i] - a[i]).abs() < 1e-12, "mismatch at index {i}");
        }
    }

    #[test]
    fn invert4_identity() {
        let inv = invert4_f64(IDENTITY);
        for i in 0..16 {
            assert!(
                (inv[i] - IDENTITY[i]).abs() < 1e-12,
                "mismatch at index {i}"
            );
        }
    }

    #[test]
    fn normalize3_unit() {
        let v = normalize3([3.0, 0.0, 0.0]);
        assert!((v[0] - 1.0).abs() < 1e-12);
        assert!(v[1].abs() < 1e-12);
        assert!(v[2].abs() < 1e-12);

        let v2 = normalize3([1.0, 1.0, 1.0]);
        let len = (v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]).sqrt();
        assert!((len - 1.0).abs() < 1e-12);
    }

    #[test]
    fn cross3_orthogonal() {
        let x = [1.0, 0.0, 0.0];
        let y = [0.0, 1.0, 0.0];
        let z = cross3(x, y);
        assert!((z[0]).abs() < 1e-12);
        assert!((z[1]).abs() < 1e-12);
        assert!((z[2] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn transform_point_identity() {
        let p = [1.0, 2.0, 3.0];
        let result = transform_point(p, &IDENTITY);
        assert!((result[0] - 1.0).abs() < 1e-12);
        assert!((result[1] - 2.0).abs() < 1e-12);
        assert!((result[2] - 3.0).abs() < 1e-12);
    }
}
