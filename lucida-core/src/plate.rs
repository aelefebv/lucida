/// Plate FOV positioning computation.
///
/// Computes [X, Y] pixel-space positions for each FOV within a plate,
/// using either stage coordinates (translations) or a uniform grid layout.

use crate::scene::{PlateFov, PlateWell, PositioningMode};

/// Gap between FOV fields within a well, as a fraction of FOV width.
const FIELD_GAP_FRACTION: f64 = 0.08;

/// Gap between wells, as a fraction of FOV width.
const WELL_GAP_FRACTION: f64 = 0.20;

/// Compute positions for all FOVs in a plate.
///
/// `fov_shape` is [Z, Y, X] — only X and Y are used for positioning.
/// Modifies each `PlateFov.position` in place.
pub fn compute_fov_positions(
    wells: &mut [PlateWell],
    fov_shape: [u32; 3],
    mode: PositioningMode,
) {
    let fov_w = fov_shape[2] as f64; // X
    let fov_h = fov_shape[1] as f64; // Y
    let field_gap = fov_w * FIELD_GAP_FRACTION;
    let well_gap = fov_w * WELL_GAP_FRACTION;

    // Find the max number of FOVs in any well (for uniform well cell sizing).
    let max_fovs = wells.iter().map(|w| w.fovs.len()).max().unwrap_or(1).max(1);
    let fov_cols = (max_fovs as f64).sqrt().ceil() as u32;
    let fov_rows = ((max_fovs as u32) + fov_cols - 1) / fov_cols;

    // Well cell dimensions (in pixels).
    let well_cell_w = fov_cols as f64 * fov_w + (fov_cols.saturating_sub(1)) as f64 * field_gap;
    let well_cell_h = fov_rows as f64 * fov_h + (fov_rows.saturating_sub(1)) as f64 * field_gap;

    for well in wells.iter_mut() {
        let well_origin_x = well.column_index as f64 * (well_cell_w + well_gap);
        let well_origin_y = well.row_index as f64 * (well_cell_h + well_gap);

        match mode {
            PositioningMode::Grid => {
                compute_grid_positions(&mut well.fovs, well_origin_x, well_origin_y, fov_w, fov_h, field_gap);
            }
            PositioningMode::Stage => {
                compute_stage_positions(&mut well.fovs, well_origin_x, well_origin_y, fov_w, fov_h, field_gap);
            }
        }
    }
}

/// Position FOVs in a uniform grid within the well.
fn compute_grid_positions(
    fovs: &mut [PlateFov],
    well_x: f64,
    well_y: f64,
    fov_w: f64,
    fov_h: f64,
    gap: f64,
) {
    let n = fovs.len().max(1);
    let cols = (n as f64).sqrt().ceil() as usize;

    for (i, fov) in fovs.iter_mut().enumerate() {
        let col = i % cols;
        let row = i / cols;
        fov.position = [
            well_x + col as f64 * (fov_w + gap),
            well_y + row as f64 * (fov_h + gap),
        ];
    }
}

/// Position FOVs using stage translations, normalized to well-local coordinates.
/// Falls back to grid layout if no translations are available.
fn compute_stage_positions(
    fovs: &mut [PlateFov],
    well_x: f64,
    well_y: f64,
    fov_w: f64,
    fov_h: f64,
    gap: f64,
) {
    // Check if any FOV has translation data.
    let has_translations = fovs.iter().any(|f| f.translation.is_some());
    if !has_translations {
        return compute_grid_positions(fovs, well_x, well_y, fov_w, fov_h, gap);
    }

    // Collect translations (X, Y). Translations are in physical units,
    // but we normalize relative positions, so units cancel out.
    // OME axes order: translations match the axes array, so for [t,c,z,y,x]
    // we want the last two values (Y, X).
    let positions: Vec<Option<[f64; 2]>> = fovs
        .iter()
        .map(|f| {
            f.translation.as_ref().map(|t| {
                let len = t.len();
                if len >= 2 {
                    // Last value is X, second-to-last is Y
                    [t[len - 1], t[len - 2]]
                } else {
                    [0.0, 0.0]
                }
            })
        })
        .collect();

    // Find min X and Y to normalize to well-local origin.
    let (mut min_x, mut min_y) = (f64::MAX, f64::MAX);
    for pos in &positions {
        if let Some([x, y]) = pos {
            min_x = min_x.min(*x);
            min_y = min_y.min(*y);
        }
    }
    if min_x == f64::MAX {
        min_x = 0.0;
    }
    if min_y == f64::MAX {
        min_y = 0.0;
    }

    for (fov, pos) in fovs.iter_mut().zip(positions.iter()) {
        if let Some([x, y]) = pos {
            // Convert from physical units to pixel space.
            // The translation is in the same units as the voxel scale,
            // so the pixel offset = translation / voxel_scale.
            // Since we don't have the scale here, we treat translations
            // as already in pixel space (the caller can pre-convert if needed).
            fov.position = [
                well_x + (x - min_x),
                well_y + (y - min_y),
            ];
        } else {
            // FOV without translation: place at well origin
            fov.position = [well_x, well_y];
        }
    }
}

/// Compute the bounding box of the entire plate in pixel space.
/// Returns [width, height].
pub fn plate_extent(wells: &[PlateWell], fov_shape: [u32; 3]) -> [f64; 2] {
    let fov_w = fov_shape[2] as f64;
    let fov_h = fov_shape[1] as f64;

    let mut max_x = 0.0_f64;
    let mut max_y = 0.0_f64;

    for well in wells {
        for fov in &well.fovs {
            max_x = max_x.max(fov.position[0] + fov_w);
            max_y = max_y.max(fov.position[1] + fov_h);
        }
    }

    [max_x, max_y]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_well(row: u32, col: u32, num_fovs: usize) -> PlateWell {
        let fovs = (0..num_fovs)
            .map(|i| PlateFov {
                path: i.to_string(),
                store_prefix: format!("{}/{}/{}", (b'A' + row as u8) as char, col + 1, i),
                position: [0.0, 0.0],
                translation: None,
            })
            .collect();
        PlateWell {
            path: format!("{}/{}", (b'A' + row as u8) as char, col + 1),
            row_index: row,
            column_index: col,
            fovs,
        }
    }

    #[test]
    fn grid_single_fov_per_well() {
        let mut wells = vec![
            make_well(0, 0, 1),
            make_well(0, 1, 1),
            make_well(1, 0, 1),
        ];
        compute_fov_positions(&mut wells, [10, 512, 512], PositioningMode::Grid);

        // A/1 at (0, 0)
        assert!((wells[0].fovs[0].position[0]).abs() < 1e-5);
        assert!((wells[0].fovs[0].position[1]).abs() < 1e-5);

        // A/2 at (512 + gap, 0)
        let well_gap = 512.0 * WELL_GAP_FRACTION;
        assert!((wells[1].fovs[0].position[0] - (512.0 + well_gap)).abs() < 1e-5);
        assert!((wells[1].fovs[0].position[1]).abs() < 1e-5);

        // B/1 at (0, 512 + gap)
        assert!((wells[2].fovs[0].position[0]).abs() < 1e-5);
        assert!((wells[2].fovs[0].position[1] - (512.0 + well_gap)).abs() < 1e-5);
    }

    #[test]
    fn grid_four_fovs_in_2x2() {
        let mut wells = vec![make_well(0, 0, 4)];
        compute_fov_positions(&mut wells, [10, 256, 256], PositioningMode::Grid);

        let gap = 256.0 * FIELD_GAP_FRACTION;
        let fovs = &wells[0].fovs;
        // FOV 0: (0, 0)
        assert!((fovs[0].position[0]).abs() < 1e-5);
        assert!((fovs[0].position[1]).abs() < 1e-5);
        // FOV 1: (256+gap, 0)
        assert!((fovs[1].position[0] - (256.0 + gap)).abs() < 1e-5);
        assert!((fovs[1].position[1]).abs() < 1e-5);
        // FOV 2: (0, 256+gap)
        assert!((fovs[2].position[0]).abs() < 1e-5);
        assert!((fovs[2].position[1] - (256.0 + gap)).abs() < 1e-5);
        // FOV 3: (256+gap, 256+gap)
        assert!((fovs[3].position[0] - (256.0 + gap)).abs() < 1e-5);
        assert!((fovs[3].position[1] - (256.0 + gap)).abs() < 1e-5);
    }

    #[test]
    fn stage_positions_normalize_to_origin() {
        let mut wells = vec![PlateWell {
            path: "A/1".into(),
            row_index: 0,
            column_index: 0,
            fovs: vec![
                PlateFov {
                    path: "0".into(),
                    store_prefix: "A/1/0".into(),
                    position: [0.0, 0.0],
                    translation: Some(vec![0.0, 0.0, 0.0, 100.0, 200.0]), // [t,c,z,y,x]
                },
                PlateFov {
                    path: "1".into(),
                    store_prefix: "A/1/1".into(),
                    position: [0.0, 0.0],
                    translation: Some(vec![0.0, 0.0, 0.0, 300.0, 600.0]),
                },
            ],
        }];
        compute_fov_positions(&mut wells, [10, 512, 512], PositioningMode::Stage);

        // Normalized: FOV 0 at (0, 0), FOV 1 at (400, 200)
        assert!((wells[0].fovs[0].position[0]).abs() < 1e-5);
        assert!((wells[0].fovs[0].position[1]).abs() < 1e-5);
        assert!((wells[0].fovs[1].position[0] - 400.0).abs() < 1e-5);
        assert!((wells[0].fovs[1].position[1] - 200.0).abs() < 1e-5);
    }

    #[test]
    fn stage_falls_back_to_grid_without_translations() {
        let mut wells = vec![make_well(0, 0, 4)];
        // No translations → should fall back to grid
        compute_fov_positions(&mut wells, [10, 256, 256], PositioningMode::Stage);

        // Should produce the same layout as grid mode
        let gap = 256.0 * FIELD_GAP_FRACTION;
        assert!((wells[0].fovs[1].position[0] - (256.0 + gap)).abs() < 1e-5);
    }

    #[test]
    fn plate_extent_computes_bounding_box() {
        let mut wells = vec![
            make_well(0, 0, 1),
            make_well(0, 1, 1),
        ];
        compute_fov_positions(&mut wells, [10, 256, 512], PositioningMode::Grid);
        let extent = plate_extent(&wells, [10, 256, 512]);

        let well_gap = 512.0 * WELL_GAP_FRACTION;
        assert!((extent[0] - (512.0 * 2.0 + well_gap)).abs() < 1e-5);
        assert!((extent[1] - 256.0).abs() < 1e-5);
    }
}
