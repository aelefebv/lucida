//! Planning for `lucida dataset montage` — the agent-facing contact sheet.
//!
//! Pure logic: given a dataset's shape, decide which axis to sample, which
//! cells (z/t/c) to render, and the montage grid layout. Kept free of I/O and
//! the browser so it is unit-testable; the command wires this to the headless
//! render + image stitching.

/// Which dataset axis the montage sweeps. Picked from the dataset's shape: a
/// multi-field plate samples fields; otherwise a depth stack samples Z, a
/// timeseries samples T, and a flat single image yields one cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MontageAxis {
    Field,
    Z,
    T,
    Single,
}

/// One montage cell: the view it renders + a short human label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MontageCell {
    pub z: u32,
    pub t: u32,
    pub c: u32,
    /// Member/field index (0 for a single-image dataset).
    pub field: usize,
    pub label: String,
}

/// The full montage plan: the sampled cells and the grid they tile into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MontagePlan {
    pub axis: MontageAxis,
    pub cells: Vec<MontageCell>,
    pub cols: u32,
    pub rows: u32,
}

/// Evenly-spaced sample indices across `[0, extent)`, inclusive of both ends.
/// `n` samples (clamped to `extent`); `extent` 0/1 yields `[0]`.
fn even_samples(extent: u64, n: usize) -> Vec<u32> {
    if extent <= 1 {
        return vec![0];
    }
    let n = n.clamp(1, extent as usize);
    if n == 1 {
        return vec![0];
    }
    (0..n)
        .map(|i| ((i as u64 * (extent - 1)) / (n as u64 - 1)) as u32)
        .collect()
}

/// Grid columns for `n` cells: a roughly-square layout capped at `max_cols`
/// wide (4 by default), so a 16-cell montage is 4×4 and a 3-cell one is 3×1.
fn grid_cols(n: usize, max_cols: u32) -> u32 {
    if n == 0 {
        return 1;
    }
    let sqrt_ceil = (n as f64).sqrt().ceil() as u32;
    sqrt_ceil.clamp(1, max_cols.max(1))
}

/// Plan a montage for a dataset of shape `dims = [T, C, Z, Y, X]` with
/// `image_count` members (fields), sampling at most `max_cells` positions.
///
/// Axis priority: a multi-field plate samples fields; else a Z>1 stack samples
/// Z; else a T>1 series samples T; else a single cell. The mid Z (and t=0,
/// c=0) anchor the non-Z axes. `max_cols` caps the grid width.
pub fn plan_montage(
    dims: [u64; 5],
    image_count: usize,
    max_cells: usize,
    max_cols: u32,
) -> MontagePlan {
    let [t_n, _c_n, z_n, _y, _x] = dims;
    let max_cells = max_cells.max(1);
    let mid_z = (z_n.saturating_sub(1) / 2) as u32;

    let (axis, cells) = if image_count > 1 {
        // Plate / multi-field: one cell per field (capped), at mid-Z.
        let n = image_count.min(max_cells);
        let cells = (0..n)
            .map(|f| MontageCell {
                z: mid_z,
                t: 0,
                c: 0,
                field: f,
                label: format!("field {f}"),
            })
            .collect();
        (MontageAxis::Field, cells)
    } else if z_n > 1 {
        let cells = even_samples(z_n, max_cells)
            .into_iter()
            .map(|z| MontageCell { z, t: 0, c: 0, field: 0, label: format!("z={z}") })
            .collect();
        (MontageAxis::Z, cells)
    } else if t_n > 1 {
        let cells = even_samples(t_n, max_cells)
            .into_iter()
            .map(|t| MontageCell { z: 0, t, c: 0, field: 0, label: format!("t={t}") })
            .collect();
        (MontageAxis::T, cells)
    } else {
        (
            MontageAxis::Single,
            vec![MontageCell { z: 0, t: 0, c: 0, field: 0, label: "z=0".into() }],
        )
    };

    let cols = grid_cols(cells.len(), max_cols);
    let rows = (cells.len() as u32).div_ceil(cols.max(1));
    MontagePlan { axis, cells, cols, rows }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_z_for_a_3d_volume() {
        // [T,C,Z,Y,X] = 1 timepoint, 1 channel, 340 z, single image.
        let plan = plan_montage([1, 1, 340, 512, 512], 1, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Z);
        assert_eq!(plan.cells.len(), 16);
        // Evenly spaced, inclusive of both ends.
        assert_eq!(plan.cells.first().unwrap().z, 0);
        assert_eq!(plan.cells.last().unwrap().z, 339);
        assert_eq!(plan.cols, 4);
        assert_eq!(plan.rows, 4);
    }

    #[test]
    fn samples_fields_for_a_plate() {
        // 64-field plate (image_count 64); fields win over Z.
        let plan = plan_montage([1, 4, 9, 256, 256], 64, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Field);
        assert_eq!(plan.cells.len(), 16);
        assert_eq!(plan.cells[0].field, 0);
        assert_eq!(plan.cells[15].field, 15);
        // Plate cells anchor at mid-Z.
        assert_eq!(plan.cells[0].z, 4);
    }

    #[test]
    fn samples_t_for_a_timeseries() {
        // 30 timepoints, flat (Z=1), single image → sample T.
        let plan = plan_montage([30, 2, 1, 256, 256], 1, 16, 4);
        assert_eq!(plan.axis, MontageAxis::T);
        assert_eq!(plan.cells.len(), 16);
        assert_eq!(plan.cells.first().unwrap().t, 0);
        assert_eq!(plan.cells.last().unwrap().t, 29);
    }

    #[test]
    fn single_cell_for_a_flat_2d_image() {
        let plan = plan_montage([1, 1, 1, 1024, 1024], 1, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Single);
        assert_eq!(plan.cells.len(), 1);
        assert_eq!(plan.cols, 1);
        assert_eq!(plan.rows, 1);
    }

    #[test]
    fn clamps_samples_to_extent() {
        // Only 5 z-slices but asked for 16 → 5 cells, no out-of-range index.
        let plan = plan_montage([1, 1, 5, 64, 64], 1, 16, 4);
        assert_eq!(plan.cells.len(), 5);
        assert!(plan.cells.iter().all(|cell| cell.z < 5));
        assert_eq!(plan.cells.last().unwrap().z, 4);
    }
}
