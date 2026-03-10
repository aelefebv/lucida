/// Volume model transform that maps voxel space to normalized world space,
/// accounting for anisotropic voxel spacing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeTransform {
    pub model: [f32; 16],
    pub inv_model: [f32; 16],
}

/// Compute a model matrix that maps the volume into a normalized coordinate space
/// where the longest physical axis has length 1.0, with corner at the origin.
///
/// `shape` is [Z, Y, X] in voxels.
/// `scale` is [Z, Y, X] physical spacing per voxel.
pub fn compute_volume_transform(shape: [u32; 3], scale: [f64; 3]) -> VolumeTransform {
    // Physical extent per axis
    let phys = [
        scale[0] * shape[0] as f64,
        scale[1] * shape[1] as f64,
        scale[2] * shape[2] as f64,
    ];

    // Normalize so max physical extent = 1.0
    let max_phys = phys[0].max(phys[1]).max(phys[2]);
    let norm = if max_phys > 0.0 { max_phys } else { 1.0 };

    let sx = (phys[2] / norm) as f32; // X
    let sy = (phys[1] / norm) as f32; // Y
    let sz = (phys[0] / norm) as f32; // Z

    // Model = Scale(sx, sy, sz) with corner at origin
    // In column-major:
    //   [sx  0   0   0]
    //   [0   sy  0   0]
    //   [0   0   sz  0]
    //   [0   0   0   1]
    let model = [
        sx,  0.0, 0.0, 0.0,
        0.0, sy,  0.0, 0.0,
        0.0, 0.0, sz,  0.0,
        0.0, 0.0, 0.0, 1.0,
    ];

    // Inverse: Scale(1/sx, 1/sy, 1/sz), corner at origin
    //   [1/sx  0     0     0]
    //   [0     1/sy  0     0]
    //   [0     0     1/sz  0]
    //   [0     0     0     1]
    let isx = if sx.abs() > 1e-12 { 1.0 / sx } else { 0.0 };
    let isy = if sy.abs() > 1e-12 { 1.0 / sy } else { 0.0 };
    let isz = if sz.abs() > 1e-12 { 1.0 / sz } else { 0.0 };

    let inv_model = [
        isx, 0.0, 0.0, 0.0,
        0.0, isy, 0.0, 0.0,
        0.0, 0.0, isz, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];

    VolumeTransform { model, inv_model }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isotropic_cube() {
        let t = compute_volume_transform([100, 100, 100], [1.0, 1.0, 1.0]);
        // All axes equal → all scale factors = 1.0
        assert!((t.model[0] - 1.0).abs() < 1e-5);
        assert!((t.model[5] - 1.0).abs() < 1e-5);
        assert!((t.model[10] - 1.0).abs() < 1e-5);
        // Corner at origin — no translation
        assert!((t.model[12]).abs() < 1e-5);
        assert!((t.model[13]).abs() < 1e-5);
        assert!((t.model[14]).abs() < 1e-5);
    }

    #[test]
    fn anisotropic_flat_slab() {
        // 279x192x17 voxels, isotropic voxel spacing
        let t = compute_volume_transform([17, 192, 279], [1.0, 1.0, 1.0]);
        // X is longest (279), so sx = 1.0
        assert!((t.model[0] - 1.0).abs() < 1e-5);
        // Y = 192/279
        assert!((t.model[5] - 192.0 / 279.0).abs() < 1e-4);
        // Z = 17/279 — much smaller, slab shape
        assert!((t.model[10] - 17.0 / 279.0).abs() < 1e-4);
        // Corner at origin — no translation
        assert!((t.model[12]).abs() < 1e-5);
        assert!((t.model[13]).abs() < 1e-5);
        assert!((t.model[14]).abs() < 1e-5);
    }

    #[test]
    fn inv_model_round_trip() {
        let t = compute_volume_transform([17, 192, 279], [0.5, 0.3, 0.1]);
        // Corner at origin: inv_model has no translation
        let ox = t.inv_model[12];
        let oy = t.inv_model[13];
        let oz = t.inv_model[14];
        assert!((ox).abs() < 1e-5);
        assert!((oy).abs() < 1e-5);
        assert!((oz).abs() < 1e-5);
    }
}
