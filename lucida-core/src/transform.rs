/// Volume model transform that maps voxel space to normalized world space,
/// accounting for anisotropic voxel spacing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeTransform {
    pub model: [f32; 16],
    pub inv_model: [f32; 16],
    /// The dataset's largest physical axis extent (before normalization).
    #[serde(default)]
    pub max_physical_extent: f64,
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

    VolumeTransform { model, inv_model, max_physical_extent: max_phys }
}

/// Compute a model matrix like `compute_volume_transform`, but with an XY
/// position offset baked into the translation column.
///
/// `shape` is [Z, Y, X] in voxels.
/// `scale` is [Z, Y, X] physical spacing per voxel.
/// `offset` is [X, Y] in voxel space.
/// `max_phys` is the global normalization divisor (from
/// `Scene::global_max_physical_extent` or the dataset's own max).
pub fn compute_member_transform(
    shape: [u32; 3],
    scale: [f64; 3],
    offset: [f64; 2],
    max_phys: f64,
) -> VolumeTransform {
    // Physical extent per axis
    let phys = [
        scale[0] * shape[0] as f64,
        scale[1] * shape[1] as f64,
        scale[2] * shape[2] as f64,
    ];

    let norm = if max_phys > 0.0 { max_phys } else { 1.0 };

    let sx = (phys[2] / norm) as f32; // X
    let sy = (phys[1] / norm) as f32; // Y
    let sz = (phys[0] / norm) as f32; // Z

    // Convert voxel-space offset to normalized world space.
    // offset is [X, Y] in voxels; multiply by voxel spacing and divide by norm.
    let tx = (offset[0] * scale[2] / norm) as f32;
    let ty = (offset[1] * scale[1] / norm) as f32;

    // Column-major:
    //   [sx  0   0   0]
    //   [0   sy  0   0]
    //   [0   0   sz  0]
    //   [tx  ty  0   1]
    let model = [
        sx,  0.0, 0.0, 0.0,
        0.0, sy,  0.0, 0.0,
        0.0, 0.0, sz,  0.0,
        tx,  ty,  0.0, 1.0,
    ];

    let isx = if sx.abs() > 1e-12 { 1.0 / sx } else { 0.0 };
    let isy = if sy.abs() > 1e-12 { 1.0 / sy } else { 0.0 };
    let isz = if sz.abs() > 1e-12 { 1.0 / sz } else { 0.0 };

    // Inverse: Scale^-1 * Translate^-1
    //   [1/sx  0     0     0]
    //   [0     1/sy  0     0]
    //   [0     0     1/sz  0]
    //   [-tx/sx -ty/sy 0   1]
    let inv_model = [
        isx, 0.0, 0.0, 0.0,
        0.0, isy, 0.0, 0.0,
        0.0, 0.0, isz, 0.0,
        -tx * isx, -ty * isy, 0.0, 1.0,
    ];

    VolumeTransform { model, inv_model, max_physical_extent: phys[0].max(phys[1]).max(phys[2]) }
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
        // max_physical_extent = 100
        assert!((t.max_physical_extent - 100.0).abs() < 1e-5);
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
        // max_physical_extent = 279
        assert!((t.max_physical_extent - 279.0).abs() < 1e-5);
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

    #[test]
    fn member_transform_zero_offset_matches_volume_transform() {
        let shape = [17, 192, 279];
        let scale = [1.0, 1.0, 1.0];
        let vt = compute_volume_transform(shape, scale);
        let mt = compute_member_transform(shape, scale, [0.0, 0.0], vt.max_physical_extent);
        for i in 0..16 {
            assert!(
                (vt.model[i] - mt.model[i]).abs() < 1e-5,
                "model[{i}] differs: {} vs {}",
                vt.model[i],
                mt.model[i],
            );
        }
    }

    #[test]
    fn member_transform_with_offset() {
        // 100x100x10 volume, isotropic spacing, max_phys = 100
        let shape = [10, 100, 100];
        let scale = [1.0, 1.0, 1.0];
        let max_phys = 100.0;
        let mt = compute_member_transform(shape, scale, [200.0, 50.0], max_phys);
        // tx = 200 * 1.0 / 100 = 2.0
        assert!((mt.model[12] - 2.0).abs() < 1e-5);
        // ty = 50 * 1.0 / 100 = 0.5
        assert!((mt.model[13] - 0.5).abs() < 1e-5);
        // Scale factors should be same as compute_volume_transform with max_phys = 100
        assert!((mt.model[0] - 1.0).abs() < 1e-5); // sx = 100/100 = 1.0
        assert!((mt.model[5] - 1.0).abs() < 1e-5); // sy = 100/100 = 1.0
        assert!((mt.model[10] - 0.1).abs() < 1e-5); // sz = 10/100 = 0.1
    }

    #[test]
    fn member_transform_inv_round_trip() {
        let shape = [10, 100, 100];
        let scale = [1.0, 1.0, 1.0];
        let max_phys = 100.0;
        let mt = compute_member_transform(shape, scale, [200.0, 50.0], max_phys);
        // Apply model then inv_model to a test point and check round-trip.
        // Point in unit space: (0.5, 0.5, 0.5)
        // After model: (0.5*sx + tx, 0.5*sy + ty, 0.5*sz)
        let px = 0.5 * mt.model[0] as f64 + mt.model[12] as f64;
        let py = 0.5 * mt.model[5] as f64 + mt.model[13] as f64;
        let pz = 0.5 * mt.model[10] as f64;
        // After inv_model: should be back to (0.5, 0.5, 0.5)
        let rx = px * mt.inv_model[0] as f64 + mt.inv_model[12] as f64;
        let ry = py * mt.inv_model[5] as f64 + mt.inv_model[13] as f64;
        let rz = pz * mt.inv_model[10] as f64;
        assert!((rx - 0.5).abs() < 1e-5);
        assert!((ry - 0.5).abs() < 1e-5);
        assert!((rz - 0.5).abs() < 1e-5);
    }
}
