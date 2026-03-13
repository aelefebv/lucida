/// Physical voxel size per axis, used for anisotropy-aware downsampling.
#[derive(Debug, Clone, Copy)]
pub struct VoxelSize {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Default for VoxelSize {
    fn default() -> Self {
        Self {
            x: 1.0,
            y: 1.0,
            z: 1.0,
        }
    }
}

/// Describes the dimensions and downsampling decisions for one pyramid level.
#[derive(Debug, Clone)]
pub struct LevelSpec {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    /// Cumulative scale factors [x, y, z] relative to level 0.
    pub scale: [f64; 3],
    /// Whether XY was downsampled to produce this level from the previous one.
    pub downsample_xy: bool,
    /// Whether Z was downsampled to produce this level from the previous one.
    pub downsample_z: bool,
}

/// Compute the full downsample schedule, respecting voxel anisotropy.
///
/// At each level, an axis is skipped only if it is the **uniquely coarsest**
/// (strictly greater effective voxel size than all others). If multiple axes
/// tie for coarsest, all are downsampled.
pub fn compute_downsample_schedule(
    w: u32,
    h: u32,
    d: u32,
    voxel_size: VoxelSize,
    min_size: u32,
) -> Vec<LevelSpec> {
    let mut specs = vec![LevelSpec {
        width: w,
        height: h,
        depth: d,
        scale: [1.0, 1.0, 1.0],
        downsample_xy: false,
        downsample_z: false,
    }];

    loop {
        let prev = specs.last().unwrap();
        if prev.width <= min_size && prev.height <= min_size && prev.depth <= min_size {
            break;
        }

        let eff_x = voxel_size.x * prev.scale[0];
        let eff_y = voxel_size.y * prev.scale[1];
        let eff_z = voxel_size.z * prev.scale[2];

        let max_eff = eff_x.max(eff_y).max(eff_z);

        // An axis is "uniquely coarsest" if it alone equals the max
        // (all other axes are strictly less).
        let z_uniquely_coarsest =
            eff_z == max_eff && eff_x < max_eff && eff_y < max_eff;
        let x_uniquely_coarsest =
            eff_x == max_eff && eff_y < max_eff && eff_z < max_eff;
        let y_uniquely_coarsest =
            eff_y == max_eff && eff_x < max_eff && eff_z < max_eff;

        let can_xy = prev.width > min_size || prev.height > min_size;
        let can_z = prev.depth > min_size;

        // Only skip an axis if the other axes can still catch up.
        let skip_z = z_uniquely_coarsest && can_xy;
        let skip_xy = (x_uniquely_coarsest || y_uniquely_coarsest) && can_z;

        let do_xy = !skip_xy && can_xy;
        let do_z = !skip_z && can_z;

        if !do_xy && !do_z {
            break;
        }

        let new_w = if do_xy { (prev.width + 1) / 2 } else { prev.width };
        let new_h = if do_xy { (prev.height + 1) / 2 } else { prev.height };
        let new_d = if do_z { (prev.depth + 1) / 2 } else { prev.depth };

        let new_scale = [
            if do_xy { prev.scale[0] * 2.0 } else { prev.scale[0] },
            if do_xy { prev.scale[1] * 2.0 } else { prev.scale[1] },
            if do_z { prev.scale[2] * 2.0 } else { prev.scale[2] },
        ];

        specs.push(LevelSpec {
            width: new_w,
            height: new_h,
            depth: new_d,
            scale: new_scale,
            downsample_xy: do_xy,
            downsample_z: do_z,
        });
    }

    specs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_isotropic() {
        let schedule = compute_downsample_schedule(64, 64, 64, VoxelSize::default(), 16);
        // Early levels should downsample all axes
        assert!(schedule[1].downsample_xy);
        assert!(schedule[1].downsample_z);
        assert!(schedule[2].downsample_xy);
        assert!(schedule[2].downsample_z);
        // All dimensions should be ≤ min_size at the last level
        let last = schedule.last().unwrap();
        assert!(last.width <= 16 && last.height <= 16);
        assert!(last.depth <= 16);
    }

    #[test]
    fn schedule_5x_anisotropic() {
        // Z is 5x coarser than XY: skip Z until XY catches up
        let voxel = VoxelSize { x: 0.2, y: 0.2, z: 1.0 };
        let schedule = compute_downsample_schedule(512, 512, 200, voxel, 16);
        // First few levels should be XY-only (Z uniquely coarsest)
        assert!(schedule[1].downsample_xy);
        assert!(!schedule[1].downsample_z);
        assert!(schedule[2].downsample_xy);
        assert!(!schedule[2].downsample_z);
        // Eventually Z should start downsampling too
        let z_starts = schedule.iter().position(|s| s.downsample_z).unwrap();
        assert!(z_starts > 1);
        // After Z starts, Z continues to downsample at every level
        for spec in &schedule[z_starts..] {
            assert!(spec.downsample_z);
        }
    }

    #[test]
    fn schedule_z_fine() {
        // Z is finer than XY (only works when x != y so one is uniquely coarsest)
        let voxel = VoxelSize { x: 1.0, y: 0.5, z: 0.2 };
        let schedule = compute_downsample_schedule(64, 64, 512, voxel, 16);
        // X is uniquely coarsest → skip XY, Z-only initially
        assert!(!schedule[1].downsample_xy);
        assert!(schedule[1].downsample_z);
        // Eventually XY should start downsampling too
        let xy_starts = schedule.iter().position(|s| s.downsample_xy).unwrap();
        assert!(xy_starts > 1);
    }

    #[test]
    fn schedule_symmetric_voxels_all_axes() {
        // When x == y, neither is uniquely coarsest → all axes from the start
        let voxel = VoxelSize { x: 1.0, y: 1.0, z: 0.2 };
        let schedule = compute_downsample_schedule(64, 64, 512, voxel, 16);
        // All axes downsample from the start (no single axis is uniquely coarsest)
        assert!(schedule[1].downsample_xy);
        assert!(schedule[1].downsample_z);
    }
}
